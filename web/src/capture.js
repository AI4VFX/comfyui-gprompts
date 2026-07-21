// The capture engine: trace the active workflow graph for prompts that feed a
// text encoder, label pos/neg, bond the latest result media, and save.
import { app } from "./comfy.js";
import { API } from "./api.js";
import { store, inTrash } from "./store.js";
import { classify } from "./classify.js";
import { getLatestMedia } from "./outputs.js";
import { toast } from "./dom.js";
import { refreshLibrary } from "./data.js";
import { openConfirm } from "./ui/confirm.js";

const ENCODER_RE = /CLIPTextEncode/i;
const SAMPLER_RE = /Sampler/i;

// An input that carries a prompt (covers CLIPTextEncode, samplers, and custom
// nodes like LTX/video that hold text/positive/negative widgets directly).
const KEY_EXCLUDE = /(filename|file_name|prefix|path|url|format|extension|ckpt|lora|vae|unet|model|sampler|scheduler|seed|width|height|steps|cfg|denoise|ratio|strength|_name$|^name$|guidance|fps|frames|duration|noise|control_after|preset|handler|mode|chat_)/;
// Media-reference inputs (voice-clone audio, IP-adapter image, control image,
// latent, mask, …) are often named like "audio_prompt"/"image_prompt". The bare
// substring "prompt" must NOT make them count as a text prompt — otherwise the
// trace follows the media link back to a Load* node and grabs its filename.
const MEDIA_REF = /audio|voice|image|img|video|latent|mask|ipadapter|clip_vision|sound|music|pixels/;
function isPromptKey(key) {
  const k = key.toLowerCase();
  if (KEY_EXCLUDE.test(k)) return false;
  if (MEDIA_REF.test(k)) return false;
  return k === "text" || k === "prompt" || k === "positive" || k === "negative"
    || k === "text_g" || k === "text_l" || k === "t5xxl" || k === "clip_l"
    || k === "wildcard_text" || k.includes("positive") || k.includes("negative")
    || k.includes("prompt") || k.endsWith("_text") || k.startsWith("text_")
    || k.includes("instruction") || k.includes("system") || k.includes("query");
}
const polFromKey = (key) => {
  const k = key.toLowerCase();
  return k.includes("negativ") ? "neg" : k.includes("positiv") ? "pos" : null;
};
const polFromTitle = (t) => !t ? null : (t.includes("negativ") ? "neg" : t.includes("positiv") ? "pos" : null);
const looksLikeFile = (t) => /^[^\s]+\.(safetensors|sft|ckpt|pt|pth|gguf|bin|onnx|npy|npz|png|jpe?g|webp|gif|bmp|tiff?|mp4|mov|avi|mkv|webm|m4v|mp3|wav|ogg|flac|m4a|aac|opus|wma|json)$/i.test(t.trim());

function nodeTitles() {
  const m = {};
  try { for (const n of (app.graph._nodes || [])) m[String(n.id)] = String(n.title || "").toLowerCase(); }
  catch (_) {}
  return m;
}

// Non-prompt string params that must never be mistaken for a prompt.
const VALUE_EXCLUDE = /weight|strength|scale|ratio|seed|index|per_layer|multiplier|delimiter|_name|^name$|^type$|device|format|prefix|control|_mode$|^mode$/;

// Resolve an input value to its underlying prompt text, following links back
// through conditioning / primitive / text nodes.
function resolveText(val, output, depth = 0) {
  if (typeof val === "string") return val;
  if (!Array.isArray(val) || depth > 8) return null;
  const node = output[val[0]];
  if (!node || !node.inputs) return null;
  if (/ZeroOut/i.test(node.class_type || "")) return null;   // zeroed conditioning = empty
  // 1. a prompt-NAMED string literal.
  for (const [k, v] of Object.entries(node.inputs))
    if (typeof v === "string" && v.trim() && isPromptKey(k)) return v;
  // 2. follow links upstream to the real text (before grabbing any loose string).
  for (const v of Object.values(node.inputs)) {
    if (Array.isArray(v)) {
      const t = resolveText(v, output, depth + 1);
      if (t != null) return t;
    }
  }
  // 3. last resort: any non-param string literal.
  for (const [k, v] of Object.entries(node.inputs)) {
    if (typeof v === "string" && v.trim() && !VALUE_EXCLUDE.test(k.toLowerCase())) return v;
  }
  return null;
}

// Sampler-branch polarity for the nodes reachable from positive/negative
// conditioning inputs — keyed by node id.
function polarityMap(output) {
  const pos = new Set(), neg = new Set();
  const walk = (link, set) => {
    if (!Array.isArray(link)) return;
    const stack = [link[0]], seen = new Set();
    while (stack.length) {
      const id = String(stack.pop());
      if (seen.has(id)) continue;
      seen.add(id);
      set.add(id);
      const node = output[id];
      if (!node) continue;
      for (const v of Object.values(node.inputs || {})) if (Array.isArray(v)) stack.push(v[0]);
    }
  };
  for (const [, node] of Object.entries(output)) {
    if (!SAMPLER_RE.test(node.class_type || "")) continue;
    walk(node.inputs && node.inputs.positive, pos);
    walk(node.inputs && node.inputs.negative, neg);
  }
  const map = {};
  for (const id of new Set([...pos, ...neg]))
    map[id] = pos.has(id) && !neg.has(id) ? "pos" : neg.has(id) && !pos.has(id) ? "neg" : "unknown";
  return map;
}

function workflowName() {
  try {
    const w = app.workflowManager && app.workflowManager.activeWorkflow;
    if (w) return (w.filename || w.name || w.path || "untitled").replace(/\.json$/i, "");
  } catch (_) {}
  try {
    const n = app.graph && app.graph.extra && app.graph.extra.workspace_info;
    if (n && n.name) return n.name;
  } catch (_) {}
  return "untitled";
}

function suggestTitle(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "Prompt";
  const words = t.split(" ").slice(0, 7).join(" ");
  return words.length > 48 ? words.slice(0, 48).trim() : words;
}

// Live per-node polarity map (nodeId -> "pos"|"neg"|"unknown") for the active
// graph — used by re-inject to fill the right selected node.
export async function livePolarities() {
  const { output } = await app.graphToPrompt();
  return polarityMap(output);
}

const liveNodes = () => { try { return app.graph._nodes || []; } catch (_) { return []; } };
function liveById() { const m = {}; for (const n of liveNodes()) m[String(n.id)] = n; return m; }

// Media output/save nodes (NOT text-preview nodes) and text-display outputs.
const MEDIA_OUT = /Save(Image|Video|WEBM|Animated|Audio|Latent|Glb|Gif)|VideoCombine|VHS_Video|Preview(Image|Audio|Video|3D|Any)/i;
const TEXT_OUT = /(Show|Preview|Display).*(Text|String)|Text.*(Show|Preview|Display)/i;

function bfsBack(output, rootIds) {
  const active = new Set();
  const stack = rootIds.slice();
  while (stack.length) {
    const id = String(stack.pop());
    if (active.has(id)) continue;
    active.add(id);
    const node = output[id];
    if (!node) continue;
    for (const v of Object.values(node.inputs || {})) if (Array.isArray(v)) stack.push(v[0]);
  }
  return active;
}

// The node ids reachable BACKWARD from the workflow's terminal nodes — i.e. the
// prompts actually wired into the result. Prefers media outputs (so an image/
// video pipeline ignores stray text boxes that only feed a Show-Text node); if
// there's no media output, uses text-display outputs (so LLM/VLLM workflows,
// whose result is text, still capture the prompts fed into the model).
function activePipeline(output) {
  const entries = Object.entries(output);
  const media = entries
    .filter(([, n]) => MEDIA_OUT.test(n.class_type || "") && !TEXT_OUT.test(n.class_type || ""))
    .map(([id]) => id);
  if (media.length) return bfsBack(output, media);
  const text = entries.filter(([, n]) => TEXT_OUT.test(n.class_type || "")).map(([id]) => id);
  if (text.length) return bfsBack(output, text);
  return new Set(Object.keys(output));
}

function selectedTextNodes() {
  let sel = [];
  try { sel = (app.canvas && app.canvas.selected_nodes) ? Object.values(app.canvas.selected_nodes) : []; } catch (_) {}
  return sel.filter((n) => nodeTextValue(n) != null);
}
function nodeTextValue(n) {
  if (!n || !Array.isArray(n.widgets)) return null;
  for (const w of n.widgets)
    if (typeof w.value === "string" && w.value.trim() && /text|prompt|string|positive|negative|value|content/i.test(w.name || "")) return w.value;
  for (const w of n.widgets) if (typeof w.value === "string" && w.value.trim()) return w.value;
  return null;
}
// Polarity from where a node's OUTPUT goes (feeds a positive/negative input?).
function polFromOutputs(n) {
  try {
    for (const out of (n.outputs || [])) {
      for (const lid of (out.links || [])) {
        const link = app.graph.links[lid];
        if (!link) continue;
        const tgt = app.graph.getNodeById ? app.graph.getNodeById(link.target_id) : null;
        const inp = tgt && tgt.inputs && tgt.inputs[link.target_slot];
        const p = polFromKey((inp && inp.name) || "");
        if (p) return p;
      }
    }
  } catch (_) {}
  return null;
}

// Robust per-node polarity for re-inject (output-wiring → title → sampler).
// Returns { nodeId: "pos"|"neg"|"unknown" }.
export async function polarityForNodes(nodes) {
  const { output } = await app.graphToPrompt();
  const sampler = polarityMap(output);
  const titles = nodeTitles();
  const m = {};
  for (const n of nodes) {
    const id = String(n.id);
    m[id] = polFromOutputs(n) || polFromTitle(titles[id])
      || (sampler[id] && sampler[id] !== "unknown" ? sampler[id] : null) || "unknown";
  }
  return m;
}

// Trace the active graph → one combined {positive, negative} set.
// • Nothing selected → only prompts feeding GENERATION nodes (samplers / nodes
//   that output IMAGE/LATENT/VIDEO/CONDITIONING/AUDIO); stray text boxes ignored.
// • Nodes selected → capture those boxes, splitting pos/neg by input-name →
//   output-wiring → node-title → sampler branch (undetectable → positive).
export async function trace() {
  const { output } = await app.graphToPrompt();
  const sampler = polarityMap(output);
  const titles = nodeTitles();
  const wfType = classify(output);
  const live = liveById();
  const sel = selectedTextNodes();

  const records = [];
  const scanInputs = (id, node, fallbackNode) => {
    for (const [key, val] of Object.entries(node.inputs || {})) {
      if (!isPromptKey(key)) continue;
      const text = resolveText(val, output);
      if (!text || text.trim().length <= 1 || looksLikeFile(text)) continue;   // skip 1-char noise
      const srcId = Array.isArray(val) ? String(val[0]) : id;
      let pol = polFromKey(key)
        || (sampler[srcId] && sampler[srcId] !== "unknown" ? sampler[srcId] : null)
        || polFromTitle(titles[srcId]) || polFromTitle(titles[id])
        || (fallbackNode ? polFromOutputs(fallbackNode) : null);
      records.push({ text: text.trim(), pol, nodeId: srcId });
    }
  };

  if (sel.length) {
    for (const n of sel) {
      const id = String(n.id);
      if (output[id]) scanInputs(id, output[id], n);
      else {
        const text = nodeTextValue(n);   // disconnected selected box
        if (text && text.trim())
          records.push({ text: text.trim(), pol: polFromOutputs(n) || polFromTitle(titles[id]), nodeId: id });
      }
    }
  } else {
    // Prefer the sampler's own positive/negative conditioning — resolves back to
    // the real prompt while skipping enhancement-subgraph internals and param
    // strings (weights, etc.). Fall back to a full pipeline scan when a workflow
    // has no standard sampler (LTX / custom / VLLM).
    const samplers = Object.entries(output).filter(([, n]) => SAMPLER_RE.test(n.class_type || ""));
    for (const [sid, snode] of samplers) {
      const ins = snode.inputs || {};
      for (const [key, pol] of [["positive", "pos"], ["negative", "neg"]]) {
        if (!(key in ins)) continue;
        const text = resolveText(ins[key], output);
        if (text && text.trim().length > 1 && !looksLikeFile(text)) records.push({ text: text.trim(), pol, nodeId: sid });
      }
    }
    if (!records.length) {
      const active = activePipeline(output);
      for (const [id, node] of Object.entries(output)) {
        if (!active.has(id)) continue;
        scanInputs(id, node, live[id]);
      }
    }
  }

  // Dedup by text (the same literal can be reached directly and via a link);
  // prefer the copy that carries an explicit polarity.
  const byText = new Map();
  for (const r of records) {
    const ex = byText.get(r.text);
    if (!ex || (!ex.pol && r.pol)) byText.set(r.text, r);
  }
  const uniq = [...byText.values()];
  const pos = uniq.filter((r) => r.pol === "pos");
  const neg = uniq.filter((r) => r.pol === "neg");
  const unknown = uniq.filter((r) => !r.pol);

  const positives = pos.length ? pos : unknown;   // undetectable → positive
  const positive = positives.map((r) => r.text).join("\n\n").trim();
  const negative = neg.map((r) => r.text).join("\n\n").trim();
  return {
    positive, negative, wfType, wfName: workflowName(),
    posNodeId: positives[0] && positives[0].nodeId,
    negNodeId: neg[0] && neg[0].nodeId,
  };
}

function currentWorkflow() {
  // The full UI graph that produced this result, so dragging the card onto the
  // canvas can rebuild the original workflow.
  try { return app.graph.serialize(); } catch (_) { return null; }
}

function buildPayload(traced, positive, negative, target) {
  const media = getLatestMedia();
  return {
    // Capturing while browsing Trash lands at the root (never INTO Trash).
    folder: inTrash(store.currentFolder || "") ? "" : (store.currentFolder || ""),
    title: suggestTitle(positive || negative),
    positive, negative,
    workflowType: traced.wfType,
    source: { workflowName: traced.wfName, posNodeId: traced.posNodeId, negNodeId: traced.negNodeId },
    media: media ? { ...media.ref, kind: media.kind } : null,
    workflow: currentWorkflow(),
    target: target || null,   // set only by the explicit "overwrite this card" action
  };
}

async function send(payload) {
  let res = await API.capture([payload]);
  if (res.conflicts && res.conflicts.length && !store.skipOverwriteWarning) {
    const ok = await openConfirm.overwrite(res.conflicts);
    if (ok) {
      if (ok.skip) { await API.setConfig({ skipOverwriteWarning: true }); store.skipOverwriteWarning = true; }
      const r2 = await API.capture([{ ...payload, overwrite: true }]);
      res.created = (res.created || []).concat(r2.created || []);
    }
  }
  await refreshLibrary();
  const made = (res.created || [])[0];
  if (made) { store.set({ selectedId: made.id }); toast("Prompt captured", "ok"); }
  else toast("Nothing captured", "info");
}

export async function captureWorkflow() {
  if (!store.configured) { toast("Choose a library folder first", "error"); return; }
  let t;
  try { t = await trace(); }
  catch (e) { toast("Trace failed: " + e.message, "error"); return; }
  if (!t.positive && !t.negative) { toast("No prompts found to capture", "error"); return; }
  await send(buildPayload(t, t.positive, t.negative));
}

// Explicit right-click action: re-capture the active workflow INTO this card
// (replaces text/media/workflow, keeps the card's title + tags).
export async function overwriteCard(promptObj) {
  if (!store.configured) { toast("Choose a library folder first", "error"); return; }
  let t;
  try { t = await trace(); }
  catch (e) { toast("Trace failed: " + e.message, "error"); return; }
  if (!t.positive && !t.negative) { toast("No prompts found to capture", "error"); return; }
  const payload = buildPayload(t, t.positive, t.negative, { folder: promptObj.folder, name: promptObj.name });
  payload.overwrite = true;   // explicit → no warning
  const res = await API.capture([payload]);
  await refreshLibrary();
  const made = (res.created || [])[0];
  if (made) { store.set({ selectedId: made.id }); toast("Card updated from workflow", "ok"); }
  else toast(res.error || "Update failed", "error");
}
