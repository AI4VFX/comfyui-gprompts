// Right-click menus for cards and for the empty grid area.
import { el, toast } from "../dom.js";
import { API } from "../api.js";
import { store, selectCard, isSelected, selectedPromptObjs, visiblePrompts } from "../store.js";
import { refreshLibrary } from "../data.js";
import { overwriteCard } from "../capture.js";
import { assignTags } from "./tags.js";
import { confirmDialog, promptDialog } from "./confirm.js";

let menuEl = null;
export function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
document.addEventListener("click", closeMenu);
document.addEventListener("contextmenu", (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });

function renderMenu(ev, items) {
  closeMenu();
  menuEl = el("div", { class: "gp-menu" });
  for (const it of items) {
    if (it[0] === "sep") { menuEl.appendChild(el("div", { class: "gp-menu-sep" })); continue; }
    const [label, fn, disabled, danger] = it;
    menuEl.appendChild(el("div", {
      class: "gp-menu-item" + (disabled ? " gp-dis" : "") + (danger ? " gp-danger" : ""),
      text: label, onclick: (e) => { e.stopPropagation(); if (disabled) return; closeMenu(); fn(); },
    }));
  }
  menuEl.style.cssText = `position:fixed;z-index:100001;left:${ev.clientX}px;top:${ev.clientY}px`;
  document.body.appendChild(menuEl);
  const r = menuEl.getBoundingClientRect();
  if (r.right > innerWidth) menuEl.style.left = (ev.clientX - r.width) + "px";
  if (r.bottom > innerHeight) menuEl.style.top = (ev.clientY - r.height) + "px";
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = el("input", { type: "file", accept, style: "display:none" });
    inp.addEventListener("change", () => resolve(inp.files && inp.files[0]));
    document.body.appendChild(inp); inp.click();
    setTimeout(() => inp.remove(), 60000);
  });
}
const fileKind = (f) => f.type.startsWith("video") ? "video" : f.type.startsWith("audio") ? "audio" : "image";
const readDataUrl = (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
const pasteFolder = () => (store.currentFolder != null ? store.currentFolder : "");

async function doForEach(targets, fn) { for (const t of targets) await fn(t); await refreshLibrary(); }

async function newFolder() {
  const parent = (store.currentFolder && store.currentFolder !== "") ? store.currentFolder : "";
  const name = await promptDialog("New folder name", "");
  if (name) { await API.folderCreate(parent, name); await refreshLibrary(); toast("Folder created", "ok"); }
}

async function pasteCards(dest) {
  const cb = store.clipboard;
  if (!cb || !cb.ids.length) { toast("Clipboard empty", "error"); return; }
  const objs = cb.ids.map((id) => store.prompts.find((p) => p.id === id)).filter(Boolean);
  await doForEach(objs, (o) => cb.mode === "cut" ? API.move(o.folder, o.name, dest) : API.copy(o.folder, o.name, dest));
  if (cb.mode === "cut") store.clipboard = null;
  toast("Pasted", "ok");
}

export function showCardMenu(ev, prompt) {
  ev.preventDefault(); ev.stopPropagation();
  if (!isSelected(prompt.id)) selectCard(prompt.id, {});
  const targets = selectedPromptObjs();
  const multi = targets.length > 1;
  const one = targets[0] || prompt;

  renderMenu(ev, [
    ["New folder…", newFolder],
    ["sep"],
    ["Rename…", async () => {
      const title = await promptDialog("Rename", one.title);
      if (title) { await API.updatePrompt(one.folder, one.name, { title }); await refreshLibrary(); }
    }, multi],
    ["Add / Edit Tags…", async () => {
      const s = await promptDialog("Tags (comma separated)", (one.tags || []).join(", "));
      if (s == null) return;
      const tags = s.split(",").map((t) => t.trim()).filter(Boolean);
      await API.updatePrompt(one.folder, one.name, { tags }); await refreshLibrary();
    }, multi],
    ["Copy tags", () => {
      const t = [...new Set(targets.flatMap((o) => o.tags || []))];
      store.tagClipboard = t; toast(`Copied ${t.length} tag(s)`);
    }],
    ["Paste tags", () => assignTags(store.tagClipboard || [], targets).then(() => toast("Tags pasted", "ok")),
      !(store.tagClipboard && store.tagClipboard.length)],
    ["Clear tags", () => doForEach(targets, (t) => API.updatePrompt(t.folder, t.name, { tags: [] })).then(() => toast("Tags cleared", "ok"))],
    ["Overwrite from current workflow", () => overwriteCard(one), multi],
    ["sep"],
    ["Cut", () => { store.clipboard = { ids: targets.map((t) => t.id), mode: "cut" }; toast(`Cut ${targets.length}`); }],
    ["Copy", () => { store.clipboard = { ids: targets.map((t) => t.id), mode: "copy" }; toast(`Copied ${targets.length}`); }],
    ["Paste", () => pasteCards(pasteFolder()), !store.clipboard],
    ["Duplicate", () => doForEach(targets, (t) => API.copy(t.folder, t.name)).then(() => toast("Duplicated", "ok"))],
    ["sep"],
    ["Add / Replace Thumbnail", async () => {
      const f = await pickFile("image/*,video/*,audio/*"); if (!f) return;
      await API.setMedia(one.folder, one.name, await readDataUrl(f), fileKind(f)); await refreshLibrary(); toast("Thumbnail set", "ok");
    }, multi],
    ["Remove Thumbnail", () => doForEach(targets, (t) => API.thumbRemove(t.folder, t.name)).then(() => toast("Thumbnail removed", "ok"))],
    ["Delete Thumbnail", () => doForEach(targets, (t) => API.thumbDelete(t.folder, t.name)).then(() => toast("Thumbnail deleted", "ok"))],
    ["sep"],
    ["Pack" + (multi ? ` (${targets.length})` : ""), async () => {
      const r = await API.pack(targets.map((t) => ({ folder: t.folder, name: t.name })));
      if (r.ok) toast("Packed — opening Explorer", "ok"); else toast(r.error || "Pack failed", "error");
    }],
    ["sep"],
    ["Delete" + (multi ? ` (${targets.length})` : ""), async () => {
      if (await confirmDialog(`Delete ${targets.length} prompt(s) to the Recycle Bin?`, "Delete", true))
        await doForEach(targets, (t) => API.del(t.folder, t.name)).then(() => toast("Deleted", "ok"));
    }, false, true],
  ]);
}

export function showEmptyMenu(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const cb = store.clipboard;
  const pasteLabel = "Paste" + (cb && cb.ids.length ? ` (${cb.ids.length})` : "");
  renderMenu(ev, [
    ["New folder…", newFolder],
    ["sep"],
    [pasteLabel, () => pasteCards(pasteFolder()), !(cb && cb.ids.length)],
    ["sep"],
    ["Select all", () => store.set({ selectedIds: visiblePrompts().map((p) => p.id) })],
    ["Deselect all", () => store.set({ selectedIds: [], selectedId: null }), !store.selectedIds.length],
    ["sep"],
    ["Refresh", () => refreshLibrary()],
  ]);
}
