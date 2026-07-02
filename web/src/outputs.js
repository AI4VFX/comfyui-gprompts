// Reads the result currently produced by the active workflow's output nodes, so
// a capture can bond the prompt to the image/video/audio it made. Reading from
// the LIVE graph (per-node) means switching workflows away and back keeps each
// one's own result, and a not-yet-generated workflow yields nothing (no stale
// thumbnail from a different run).
import { app } from "./comfy.js";

const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v|avi)$/i;
const AUDIO_EXT = /\.(mp3|ogg|wav|flac|m4a|aac|opus)$/i;
const RANK = { video: 3, audio: 2, image: 1 };

function kindOf(item, key) {
  const fn = String(item.filename || "").toLowerCase();
  const k = String(key || "").toLowerCase();
  if (VIDEO_EXT.test(fn) || k.includes("gif") || k.includes("video") || k.includes("webm")) return "video";
  if (AUDIO_EXT.test(fn) || k.includes("audio")) return "audio";
  return "image";
}

// Best media candidate inside one output dict (a node's images / nodeOutputs entry).
function scanOutput(out) {
  if (!out || typeof out !== "object") return null;
  let best = null;
  for (const [key, val] of Object.entries(out)) {
    if (!Array.isArray(val)) continue;
    for (const item of val) {
      if (!item || !item.filename) continue;
      const kind = kindOf(item, key);
      const rank = RANK[kind];
      if (!best || rank > best.rank) {
        best = { kind, rank, ref: { filename: item.filename, subfolder: item.subfolder || "", type: item.type || "output" } };
      }
    }
  }
  return best;
}

// Kept for entry compatibility — results are read live at capture time now.
export function startOutputTracker() {}

// A node that PRODUCES the result (Save/Preview/Combine…) — never an input node
// like Load Image, whose `.images` is the loaded source, not a generated result.
const RESULT_RE = /(Save|Preview|Combine|VideoCombine|VHS_Video|OutputImage|SaveAudio)/i;
const INPUT_RE = /^(Load|Input)/i;
function isResultNode(n) {
  const t = String(n.type || n.comfyClass || "");
  if (!t || INPUT_RE.test(t)) return false;
  if (RESULT_RE.test(t)) return true;
  try { if (n.constructor && n.constructor.nodeData && n.constructor.nodeData.output_node) return true; } catch (_) {}
  return false;
}

// The result shown by THIS workflow's OUTPUT nodes right now, or null.
export function getLatestMedia() {
  try {
    const no = app.nodeOutputs || {};
    let top = null;
    for (const n of (app.graph._nodes || [])) {
      if (!isResultNode(n)) continue;
      const id = String(n.id);
      const cands = [];
      if (Array.isArray(n.images) && n.images.length) cands.push({ images: n.images });
      if (no[id]) cands.push(no[id]);
      for (const out of cands) {
        const c = scanOutput(out);
        if (c && (!top || c.rank >= top.rank)) top = c;
      }
    }
    return top ? { kind: top.kind, ref: top.ref } : null;
  } catch (_) {
    return null;
  }
}
