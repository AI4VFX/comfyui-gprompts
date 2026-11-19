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
    store.rememberFolder = s.rememberFolder !== false;
    store.savedFolder = s.lastFolder != null ? s.lastFolder : null;
    store.captureAssets = !!s.captureAssets;
    store.packIncludeAssets = s.packIncludeAssets !== false;
    store.restoreAssets = s.restoreAssets !== false;
    store.packToastSeconds = Math.min(15, Math.max(1, Number(s.packToastSeconds) || 2));
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
    store.trashBytes = r.trashBytes || 0;
    store.emit();
  }
  return r;
}
