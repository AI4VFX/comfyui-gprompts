// Loads backend state + library into the store and notifies subscribers.
import { API } from "./api.js";
import { store } from "./store.js";

export async function refreshState() {
  const s = await API.state();
  if (s && s.ok) {
    store.configured = !!s.configured;
    store.root = s.root;
    store.suggested = s.suggested;
    store.skipOverwriteWarning = !!s.skipOverwriteWarning;
    store.autoClose = !!s.autoClose;
    store.captureShortcut = s.captureShortcut || "Alt+Q";
  }
  return s;
}

export async function refreshLibrary() {
  const r = await API.library();
  if (r && r.ok) {
    store.configured = !!r.configured;
    store.prompts = r.prompts || [];
    store.folders = r.folders || [];
    store.registryTags = r.registry || [];
    store.emit();
  }
  return r;
}
