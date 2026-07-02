// User-configurable Capture keyboard shortcut. Uses a document-level listener
// (not a static ComfyUI keybinding) so it can be reassigned live from Settings.
import { app } from "./comfy.js";
import { store } from "./store.js";
import { captureWorkflow } from "./capture.js";

// Normalized combo string from a keydown event ("Alt+Q", "Ctrl+Shift+P"), or
// null while only a modifier is held.
export function comboFromEvent(e) {
  const key = e.key;
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

let attached = false;
export function attachShortcut() {
  if (attached) return;
  attached = true;
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const combo = comboFromEvent(e);
    if (combo && store.captureShortcut && combo.toLowerCase() === store.captureShortcut.toLowerCase()) {
      e.preventDefault(); e.stopPropagation();
      captureWorkflow();
    }
  }, true);
}

function comboToStr(c) {
  if (typeof c === "string") return c;
  if (!c || typeof c !== "object") return "";
  const parts = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  if (c.meta) parts.push("Meta");
  if (c.key) parts.push(c.key.length === 1 ? c.key.toUpperCase() : c.key);
  return parts.join("+");
}

// Best-effort: returns the conflicting command id if ComfyUI already binds this
// combo to something else, or null. Silently returns null if the API differs.
export function shortcutConflict(combo) {
  try {
    const kb = app.extensionManager && app.extensionManager.keybinding;
    if (!kb) return null;
    const list = kb.keybindings || (typeof kb.getKeybindings === "function" ? kb.getKeybindings() : []) || [];
    for (const k of list) {
      const s = comboToStr(k.combo || k);
      const cmd = k.commandId || k.command || "";
      if (s && s.toLowerCase() === combo.toLowerCase() && cmd !== "gprompts.capture") return cmd || "another command";
    }
  } catch (_) {}
  return null;
}
