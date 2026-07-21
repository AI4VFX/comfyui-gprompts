// The sidebar tab shell: toolbar over a body that shows first-run setup, the
// Settings panel, or [folders | (cards on top, detail pane on bottom)].
import { app } from "../comfy.js";
import { el, clear, injectCSS, toast, attachSplitter } from "../dom.js";
import { store, allTags, selectedPromptObjs } from "../store.js";
import { captureWorkflow } from "../capture.js";
import { API } from "../api.js";
import { refreshState, refreshLibrary } from "../data.js";
import { renderGrid } from "./grid.js";
import { renderFolders } from "./folders.js";
import { renderTags } from "./tags.js";
import { showEmptyMenu } from "./contextmenu.js";
import { renderDetail } from "./detail.js";
import { renderSettings } from "./settings.js";
import { renderPicker } from "./picker.js";

let unsub = null;
let selUnsub = null;
let autoCloseAttached = false;
let mountedRoot = null;

function closeSidebar() {
  // Click the active sidebar-tab button — ComfyUI collapses the panel when you
  // click the already-selected tab (the public extension API has no close call).
  try {
    const btn = document.querySelector(".side-bar-button-selected");
    if (btn) btn.click();
  } catch (e) { console.warn("[G-Prompts] close failed", e); }
}

function attachAutoClose() {
  if (autoCloseAttached) return;
  const canvas = app.canvas && app.canvas.canvas;
  if (!canvas) return;
  autoCloseAttached = true;
  // Capture phase so we get it before litegraph consumes the event.
  canvas.addEventListener("pointerdown", () => {
    if (store.autoClose && mountedRoot && mountedRoot.offsetParent !== null) closeSidebar();
  }, true);
}

async function packSelected() {
  const objs = selectedPromptObjs();
  if (!objs.length) { toast("Select one or more cards first", "error"); return; }
  const r = await API.pack(objs.map((o) => ({ folder: o.folder, name: o.name })));
  if (r.ok) toast("Packed — opening Explorer", "ok"); else toast(r.error || "Pack failed", "error");
}

export function mountSidebar(rootEl) {
  injectCSS();
  rootEl.style.height = "100%";
  clear(rootEl);
  mountedRoot = rootEl;
  attachAutoClose();

  const root = el("div", { class: "gp-root" });
  const toolbar = el("div", { class: "gp-toolbar" });
  const body = el("div", { class: "gp-body" });
  root.append(toolbar, body);
  rootEl.appendChild(root);

  let view = store.configured ? "library" : "setup";
  let foldersEl = null, tagsEl = null, gridWrap = null, detailEl = null, vdiv = null, tagSel = null, detailBtn = null;

  // ── toolbar (built once) ──
  toolbar.append(
    el("button", { class: "gp-btn gp-primary gp-capture-btn", text: "Capture", title: "Capture the workflow's prompts", onclick: captureWorkflow }),
  );
  toolbar.appendChild(el("input", { class: "gp-input gp-search", placeholder: "Search…",
    oninput: (e) => store.set({ search: e.target.value }) }));
  detailBtn = el("button", { class: "gp-btn", text: "▤ Details",
    onclick: () => store.set({ detailOn: !store.detailOn }) });
  toolbar.appendChild(detailBtn);
  // Card sort: one button cycling Newest → Oldest → A→Z → Z→A (persisted pref).
  const SORT_CYCLE = ["new", "old", "az", "za"];
  const SORT_LABEL = { new: "↓ Newest", old: "↑ Oldest", az: "A→Z", za: "Z→A" };
  const sortBtn = el("button", { class: "gp-btn", title: "Sort cards — click to cycle",
    text: SORT_LABEL[store.sortMode] || SORT_LABEL.new,
    onclick: () => {
      const i = SORT_CYCLE.indexOf(store.sortMode);
      store.set({ sortMode: SORT_CYCLE[(i + 1) % SORT_CYCLE.length] });
    } });
  toolbar.appendChild(sortBtn);
  tagSel = el("select", { class: "gp-select", onchange: (e) => store.set({ selectedTags: e.target.value ? [e.target.value] : [] }) });
  toolbar.appendChild(tagSel);
  const cardSlider = el("input", { type: "range", class: "gp-slider", min: "100", max: "250", step: "1",
    value: String(Math.round(store.cardSize * 100)), title: "Card size" });
  cardSlider.addEventListener("input", (e) => {
    const v = e.target.value / 100;
    store.cardSize = v; store._savePrefs();
    if (gridWrap) gridWrap.style.setProperty("--gp-scale", v);
  });
  toolbar.appendChild(cardSlider);
  toolbar.appendChild(el("button", { class: "gp-btn gp-icon-btn", text: "📦", title: "Pack selected (zip + open in Explorer)", onclick: packSelected }));
  // Manual re-scan: picks up files added/changed directly in the library folder
  // (e.g. a hand-placed .thumb.jpg or preview media) — rev busts the img cache.
  toolbar.appendChild(el("button", { class: "gp-btn gp-icon-btn", text: "⟳", title: "Refresh — re-scan the library folder",
    onclick: async () => { await refreshLibrary(); toast("Library refreshed", "ok"); } }));
  const gearBtn = el("button", { class: "gp-btn gp-icon-btn", text: "⚙", title: "Settings",
    onclick: () => { if (!store.configured) return; view = (view === "settings") ? "library" : "settings"; body._mode = null; renderBody(); } });
  toolbar.appendChild(gearBtn);

  function refreshTagOptions() {
    const want = store.selectedTags.length === 1 ? store.selectedTags[0] : "";
    clear(tagSel);
    tagSel.appendChild(el("option", { value: "", text: "All tags" }));
    for (const t of allTags()) tagSel.appendChild(el("option", { value: t, text: t }));
    tagSel.value = want;
  }

  function ensureLibraryLayout() {
    if (body._mode === "library" && foldersEl && body.contains(foldersEl)) return;
    body._mode = "library";
    clear(body);
    foldersEl = el("div", { class: "gp-folders" });
    foldersEl.style.flex = "0 0 " + (store.foldersSplit * 100) + "%";
    tagsEl = el("div", { class: "gp-tags" });
    const ldiv = el("div", { class: "gp-vdiv", title: "Drag to resize folders vs tags" });
    const leftcol = el("div", { class: "gp-leftcol" }, [foldersEl, ldiv, tagsEl]);
    attachSplitter(ldiv, leftcol, foldersEl, "top", (ratio) => { store.foldersSplit = ratio; store._savePrefs(); }, 60);
    gridWrap = el("div", { class: "gp-grid-wrap",
      onclick: (e) => { if (!e.target.closest(".gp-card")) store.setSelection({ selectedId: null, selectedIds: [] }); },
      oncontextmenu: (e) => { if (!e.target.closest(".gp-card")) showEmptyMenu(e); } });
    vdiv = el("div", { class: "gp-vdiv", title: "Drag to resize cards vs detail" });
    detailEl = el("div", { class: "gp-detail" });
    detailEl.style.flex = "0 0 " + (store.detailSplit * 100) + "%";
    const mainEl = el("div", { class: "gp-main" }, [gridWrap, vdiv, detailEl]);
    body.append(leftcol, mainEl);
    attachSplitter(vdiv, mainEl, detailEl, "bottom", (ratio) => { store.detailSplit = ratio; store._savePrefs(); }, 120);
  }

  function renderBody() {
    if (!store.configured) view = "setup";
    gearBtn.classList.toggle("gp-on", view === "settings");

    if (view === "setup") {
      if (body._mode !== "setup") {
        body._mode = "setup"; foldersEl = null;
        clear(body);
        const host = el("div", { style: "overflow:auto;flex:1" });
        body.appendChild(host);
        renderPicker(host, store.root || store.suggested, async (path) => {
          const r = await API.setRoot(path);
          if (r.ok) { await refreshState(); await refreshLibrary(); view = "library"; body._mode = null; renderBody(); toast("Library folder set", "ok"); }
          else toast(r.error || "Failed", "error");
        });
      }
      return;
    }
    if (view === "settings") {
      if (body._mode !== "settings") {
        body._mode = "settings"; foldersEl = null;
        clear(body);
        const host = el("div", { style: "overflow:auto;flex:1" });
        body.appendChild(host);
        renderSettings(host);
      }
      return;
    }

    ensureLibraryLayout();
    sortBtn.textContent = SORT_LABEL[store.sortMode] || SORT_LABEL.new;
    detailBtn.classList.toggle("gp-on", store.detailOn);
    detailEl.style.display = store.detailOn ? "" : "none";
    vdiv.style.display = store.detailOn ? "" : "none";
    renderFolders(foldersEl);
    renderTags(tagsEl);
    renderGrid(gridWrap);
    if (store.detailOn) renderDetail(detailEl);
    refreshTagOptions();
  }

  // Selection-only update: toggle card highlights in place (no grid rebuild, so
  // thumbnails aren't detached mid double-click) and refresh the detail pane.
  function renderSelection() {
    if (body._mode !== "library" || !gridWrap) return;
    const sel = store.selectedIds || [];
    for (const cardEl of gridWrap.querySelectorAll(".gp-card"))
      cardEl.classList.toggle("gp-sel", sel.includes(cardEl.dataset.gpid));
    if (store.detailOn) renderDetail(detailEl);
  }

  if (unsub) unsub();
  unsub = store.subscribe(renderBody);
  if (selUnsub) selUnsub();
  selUnsub = store.subscribeSelection(renderSelection);
  renderBody();
}
