// Feed a stored prompt back into the active workflow.
import { app } from "./comfy.js";
import { toast } from "./dom.js";
import { store } from "./store.js";
import { polarityForNodes } from "./capture.js";

const LG = () => (window.LiteGraph || (app && app.LiteGraph));
const TEXTY = new Set(["text", "customtext", "string"]);
const NAMEY = new Set(["text", "value", "string", "prompt", "positive", "negative",
  "wildcard_text", "text_g", "text_l", "content"]);

function textWidget(node) {
  if (!node || !Array.isArray(node.widgets)) return null;
  for (const w of node.widgets)
    if (TEXTY.has(String(w.type || "").toLowerCase()) && typeof w.value === "string") return w;
  for (const w of node.widgets)
    if (NAMEY.has(String(w.name || "").toLowerCase()) && typeof w.value === "string") return w;
  for (const w of node.widgets) if (typeof w.value === "string") return w;
  return null;
}

function setWidget(w, text) {
  try { w.value = text; if (typeof w.callback === "function") w.callback(text); }
  catch (_) { try { w.value = text; } catch (__) {} }
}

function selectedTextNodes() {
  const sel = (app.canvas && app.canvas.selected_nodes) ? Object.values(app.canvas.selected_nodes) : [];
  return sel.filter((n) => textWidget(n));
}

// Combined Fill/Spawn for one text value (used by the detail-pane blocks):
// fill the first selected node, or spawn a node if nothing is selected.
export function applyText(text) {
  const sel = selectedTextNodes();
  if (!sel.length) { spawnNode(text); return; }
  setWidget(textWidget(sel[0]), text);
  try { app.graph.setDirtyCanvas(true, true); } catch (_) {}
  toast("Filled " + (sel[0].title || sel[0].comfyClass || sel[0].type), "ok");
}

function placeNode(node, idx) {
  let pos = [80, 80];
  try {
    const c = app.canvas;
    const rect = c && c.canvas && c.canvas.getBoundingClientRect();
    const conv = c && (c.convertCanvasToOffset
      || (c.ds && c.ds.convertCanvasToOffset && ((v) => c.ds.convertCanvasToOffset(v))));
    if (rect && conv) {
      const p = conv.call(c, [rect.width / 2, rect.height / 2]);
      if (p && isFinite(p[0]) && isFinite(p[1])) pos = [Math.round(p[0]), Math.round(p[1])];
    }
  } catch (_) {}
  node.pos = [pos[0] + idx * 30, pos[1] + idx * 230];
}

function spawnOne(text, idx) {
  const lg = LG();
  if (!lg || !app.graph) { toast("Canvas not ready", "error"); return null; }
  let node = null;
  for (const ty of ["CLIPTextEncode", "PrimitiveString", "PrimitiveStringMultiline", "Note"]) {
    try { node = lg.createNode(ty); } catch (_) { node = null; }
    if (node) break;
  }
  if (!node) { toast("Could not create a text node", "error"); return null; }
  placeNode(node, idx);
  app.graph.add(node);
  const w = textWidget(node);
  if (w) setWidget(w, text);
  return node;
}

// Detail-pane "Spawn": a single node with this text.
export function spawnNode(text) {
  const n = spawnOne(text, (app.graph._nodes || []).length % 6);
  if (n) { try { app.canvas.selectNode(n); app.graph.setDirtyCanvas(true, true); } catch (_) {} toast("Spawned node", "ok"); }
}

// Card "Spawn (both)": one node for positive, one for negative.
export function spawnBoth(prompt) {
  let i = 0, any = false;
  if (prompt.positive && prompt.positive.trim()) { spawnOne(prompt.positive, i++); any = true; }
  if (prompt.negative && prompt.negative.trim()) { spawnOne(prompt.negative, i++); any = true; }
  if (!any) spawnOne(prompt.positive || prompt.negative || "", 0);
  try { app.graph.setDirtyCanvas(true, true); } catch (_) {}
  toast(any ? "Spawned prompt nodes" : "Spawned node", "ok");
}

// Card "Fill": if nodes are selected, fill each by its polarity (pos node gets
// the positive, neg node gets the negative); a single selected node gets the
// matching side (or positive if undetermined). With nothing selected, spawn both.
export async function applyToCanvas(prompt) {
  const sel = selectedTextNodes();
  if (!sel.length) { spawnBoth(prompt); return; }

  let map = {};
  try { map = await polarityForNodes(sel); } catch (_) {}
  // A node detected as negative gets the negative; everything else (positive or
  // undetectable) gets the positive — so the LTX master (unknown) takes the
  // positive while the titled/wired "Negative" node takes the negative.
  let didPos = false, didNeg = false;
  for (const n of sel) {
    const w = textWidget(n);
    if (!w) continue;
    if (map[String(n.id)] === "neg" && prompt.negative) { setWidget(w, prompt.negative); didNeg = true; }
    else { setWidget(w, prompt.positive || prompt.negative); didPos = true; }
  }
  try { app.graph.setDirtyCanvas(true, true); } catch (_) {}
  const parts = [didPos && "positive", didNeg && "negative"].filter(Boolean);
  toast("Filled " + (parts.join(" + ") || "node"), "ok");
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied to clipboard", "ok"); }
  catch (_) { toast("Clipboard blocked by browser", "error"); }
}

// Swap an exact original prompt string for the edited one across every node
// widget value in a serialized workflow (top-level + subgraph internals), so a
// card whose text was edited after capture rebuilds with the EDITED prompt
// rather than the original baked into the sidecar. Returns true if anything
// changed.
function patchWorkflowText(wf, original, edited) {
  if (!original || edited == null || original === edited) return false;
  let changed = false;
  const visit = (nodes) => {
    for (const n of (nodes || [])) {
      const wv = n && n.widgets_values;
      if (Array.isArray(wv)) {
        for (let i = 0; i < wv.length; i++) if (wv[i] === original) { wv[i] = edited; changed = true; }
      } else if (wv && typeof wv === "object") {
        for (const k of Object.keys(wv)) if (wv[k] === original) { wv[k] = edited; changed = true; }
      }
    }
  };
  visit(wf.nodes);
  if (wf.definitions && Array.isArray(wf.definitions.subgraphs))
    for (const sg of wf.definitions.subgraphs) visit(sg.nodes);
  return changed;
}

// Drag a card onto the canvas → rebuild the workflow that produced it.
export async function loadWorkflowOnCanvas(prompt) {
  if (!prompt.hasWorkflow) { toast("No stored workflow for this prompt", "error"); return; }
  const { API } = await import("./api.js");
  let wf;
  try { wf = await API.workflow(prompt.folder, prompt.name); } catch (_) {}
  if (!wf || wf.error || wf.ok === false || !(wf.nodes || wf.last_node_id !== undefined)) {
    toast("Could not load workflow", "error"); return;
  }
  // Put the card's captured input files back BEFORE loading, so Load Image /
  // Video / Audio nodes find them. Never fatal: a failure just loads as before.
  let restoreNote = "";
  if (prompt.hasAssets && store.restoreAssets) {
    try {
      const r = await API.restoreAssets(prompt.folder, prompt.name);
      if (r && r.ok !== false) {
        const n = (r.restored || []).length, d = (r.differ || []).length;
        if (n) {
          restoreNote = ` · restored ${n} input file${n > 1 ? "s" : ""}`;
          // New files: refresh the nodes' file dropdowns so they list them.
          try { if (app.refreshComboInNodes) await app.refreshComboInNodes(); } catch (_) {}
        }
        if (d) toast(`${d} input file${d > 1 ? "s" : ""} in the input folder differ from the captured one${d > 1 ? "s" : ""}: kept yours (${r.differ.slice(0, 3).join(", ")}${d > 3 ? "…" : ""})`, "error", 6000);
      }
    } catch (e) { console.warn("[G-Prompts] asset restore failed", e); }
  }
  try {
    await app.loadGraphData(wf);
    // The sidecar holds the prompt as it was AT CAPTURE. If the card was edited
    // since, trace the just-loaded graph to recover the original text and swap
    // in the card's current positive/negative, then reload the patched graph.
    let patched = false;
    try {
      const { trace } = await import("./capture.js");
      const orig = await trace();
      patched = patchWorkflowText(wf, orig.positive, prompt.positive);
      patched = patchWorkflowText(wf, orig.negative, prompt.negative) || patched;
    } catch (_) {}
    if (patched) await app.loadGraphData(wf);
    toast("Loaded workflow: " + prompt.title + restoreNote, "ok");
  }
  catch (e) { toast("Load failed: " + e.message, "error"); }
}
