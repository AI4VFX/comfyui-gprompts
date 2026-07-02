// In-memory UI state + a tiny pub/sub. Persistent UI prefs live in localStorage.
const LS_KEY = "comfyui_gprompts_ui";

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || {};
  } catch (_) {
    return {};
  }
}
const prefs = loadPrefs();

export const store = {
  configured: false,
  root: null,
  prompts: [],
  folders: [],
  currentFolder: null,        // null = All, "" = unfiled root, "Foo/Bar" = a folder
  selectedId: null,           // primary selection (drives the detail pane)
  selectedIds: [],            // multi-selection (context-menu / pack ops)
  clipboard: null,            // { ids:[...], mode:"cut"|"copy" }
  // selectedTags (below) doubles as the active tag filter (OR-any).
  autoClose: false,           // close panel when the canvas is clicked
  search: "",
  cardSize: prefs.cardSize || 1,      // 1.0 .. 2.5
  detailOn: prefs.detailOn || false,  // detail pane on/off
  detailScale: prefs.detailScale || 1,// detail font scale 1.0 .. 2.5
  detailSplit: prefs.detailSplit || 0.42,   // detail pane height fraction of main
  detailNegRatio: prefs.detailNegRatio || 0.3,  // negative box height fraction (positive fills the rest)
  foldersSplit: prefs.foldersSplit || 0.58, // folders vs tags split in left column
  tagSort: prefs.tagSort || "name",   // tag pane sort: name | count
  tagScale: prefs.tagScale || 1,      // tag list font scale
  tagClipboard: null,                 // copied tag name(s) (for Paste tag)
  registryTags: [],                   // declared tags (incl. empty ones)
  captureShortcut: "Alt+Q",           // keyboard shortcut for Capture
  selectedTags: [],                   // multi-selected tags
  folderClipboard: null,              // { folder, mode:"cut"|"copy" }
  skipOverwriteWarning: false,

  _subs: new Set(),
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
  emit() { for (const fn of this._subs) { try { fn(); } catch (e) { console.error(e); } } },

  // Selection changes go through their own light channel so they DON'T rebuild
  // the whole grid — the grid is expensive to rebuild and, worse, detaching a
  // card's <img> between the two clicks of a double-click breaks it. Selection
  // listeners just toggle the highlight + refresh the detail pane.
  _selSubs: new Set(),
  subscribeSelection(fn) { this._selSubs.add(fn); return () => this._selSubs.delete(fn); },
  setSelection(patch) {
    Object.assign(this, patch);
    for (const fn of this._selSubs) { try { fn(); } catch (e) { console.error(e); } }
  },

  set(patch) {
    Object.assign(this, patch);
    if ("cardSize" in patch || "detailOn" in patch
      || "detailScale" in patch || "tagSort" in patch || "tagScale" in patch)
      this._savePrefs();
    this.emit();
  },
  _savePrefs() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        cardSize: this.cardSize,
        detailOn: this.detailOn, detailScale: this.detailScale,
        detailSplit: this.detailSplit, detailNegRatio: this.detailNegRatio,
        foldersSplit: this.foldersSplit, tagSort: this.tagSort, tagScale: this.tagScale,
      }));
    } catch (_) {}
  },
};

export function selectedPrompt() {
  return store.prompts.find((p) => p.id === store.selectedId) || null;
}

export function isSelected(id) {
  return store.selectedIds.includes(id);
}

// Click selection: plain = single; ctrl/meta = toggle; shift = range from anchor.
let cardAnchor = null;
export function selectCard(id, opts = {}) {
  const ctrl = opts === true || opts.ctrl;   // tolerate legacy boolean arg
  const shift = opts && opts.shift;
  if (shift && cardAnchor) {
    const order = visiblePrompts().map((p) => p.id);
    const a = order.indexOf(cardAnchor), b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      store.setSelection({ selectedIds: order.slice(Math.min(a, b), Math.max(a, b) + 1), selectedId: id });
      return;
    }
  }
  cardAnchor = id;
  if (ctrl) {
    const ids = store.selectedIds.includes(id)
      ? store.selectedIds.filter((x) => x !== id) : store.selectedIds.concat(id);
    store.setSelection({ selectedIds: ids, selectedId: id });
  } else {
    store.setSelection({ selectedIds: [id], selectedId: id });
  }
}

export function selectedPromptObjs() {
  const ids = store.selectedIds.length ? store.selectedIds : (store.selectedId ? [store.selectedId] : []);
  return ids.map((id) => store.prompts.find((p) => p.id === id)).filter(Boolean);
}

// Prompts after folder scope + filters, ready to render.
export function visiblePrompts() {
  const s = store;
  const q = s.search.trim().toLowerCase();
  return s.prompts.filter((p) => {
    if (s.currentFolder != null && p.folder !== s.currentFolder) {
      if (!(s.currentFolder && p.folder.startsWith(s.currentFolder + "/"))) return false;
    }
    if (s.selectedTags.length && !(p.tags || []).some((t) => s.selectedTags.includes(t))) return false;
    if (q) {
      const hay = (p.title + " " + p.positive + " " + p.negative + " " + (p.tags || []).join(" ")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function allTags() {
  const set = new Set();
  for (const p of store.prompts) for (const t of p.tags || []) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function tagCounts() {
  const m = new Map();
  for (const t of store.registryTags || []) m.set(t, 0);   // declared/empty tags
  for (const p of store.prompts) for (const t of p.tags || []) m.set(t, (m.get(t) || 0) + 1);
  const arr = [...m.entries()].map(([tag, count]) => ({ tag, count }));
  if (store.tagSort === "count") arr.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  else arr.sort((a, b) => a.tag.localeCompare(b.tag));
  return arr;
}

export function folderCount(folder) {
  return store.prompts.filter((p) => p.folder === folder || (folder && p.folder.startsWith(folder + "/"))).length;
}
