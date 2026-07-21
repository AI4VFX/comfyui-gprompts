// Right-click menus for cards and for the empty grid area.
import { el, toast, copyText } from "../dom.js";
import { API } from "../api.js";
import { store, selectCard, isSelected, selectedPromptObjs, visiblePrompts, TRASH, inTrash } from "../store.js";
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

  // Trashed cards get a reduced menu: Restore (reverse of the trash-move —
  // strips the Trash/ prefix, so files return to their original folder) plus
  // Cut/Copy (Paste into a normal folder doubles as restore-to-anywhere).
  if (inTrash(one.folder)) {
    renderMenu(ev, [
      ["Restore" + (multi ? ` (${targets.length})` : ""), async () => {
        await doForEach(targets, (t) =>
          API.move(t.folder, t.name, t.folder === TRASH ? "" : t.folder.slice(TRASH.length + 1)));
        toast(`Restored ${targets.length} prompt${multi ? "s" : ""}`, "ok");
      }],
      ["sep"],
      ["Cut", () => { store.clipboard = { ids: targets.map((t) => t.id), mode: "cut" }; toast(`Cut ${targets.length}`); }],
      ["Copy", () => { store.clipboard = { ids: targets.map((t) => t.id), mode: "copy" }; toast(`Copied ${targets.length}`); }],
    ]);
    return;
  }

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
    ["Move Thumbnail to Trash", () => doForEach(targets, (t) => API.thumbDelete(t.folder, t.name)).then(() => toast("Thumbnail moved to Trash", "ok"))],
    // Non-destructive: keep the custom thumb on disk, just show the default.
    ...(one.hasThumb ? [[
      one.hideThumb ? "Use custom thumbnail" : "Use default thumbnail",
      async () => {
        await API.updatePrompt(one.folder, one.name, { hideThumb: !one.hideThumb });
        await refreshLibrary();
        toast(one.hideThumb ? "Custom thumbnail shown" : "Default thumbnail shown", "ok");
      }, multi]] : []),
    // Which of the four defaults this card uses (only when a default is showing).
    ...(!one.hasThumb || one.hideThumb ? [[
      "Default thumbnail…",
      () => {
        const cur = one.thumbChoice || null;
        const pick = (cat) => async () => {
          await API.updatePrompt(one.folder, one.name, { thumbChoice: cat });
          await refreshLibrary();
        };
        renderMenu(ev, [
          [(cur === null ? "✓ " : "") + "Auto (by type)", pick(null)],
          ...["Image", "Video", "Audio", "Other"].map((c) => [(cur === c ? "✓ " : "") + c, pick(c)]),
        ]);
      }, multi]] : []),
    ["sep"],
    ...(one.hasWorkflow ? [[
      "Capture input assets",
      async () => {
        const r = await API.captureAssets(one.folder, one.name);
        if (r.ok) {
          await refreshLibrary();
          toast(r.count ? `Captured ${r.count} input asset(s)` : "No input assets found in workflow", "ok");
        } else toast(r.error || "Failed", "error");
      }, multi], ["sep"]] : []),
    ["Pack" + (multi ? ` (${targets.length})` : ""), async () => {
      const r = await API.pack(targets.map((t) => ({ folder: t.folder, name: t.name })));
      if (r.ok) {
        const name = r.zip.split(/[\\/]/).pop();
        const copied = await copyText(r.zip);
        toast(copied ? `Packed: ${name} — path copied to clipboard` : `Packed: ${r.zip}`,
          "ok", store.packToastSeconds * 1000);
      } else toast(r.error || "Pack failed", "error");
    }],
    ["sep"],
    // Reversible, so a single card moves instantly; multi still confirms.
    ["Move to Trash" + (multi ? ` (${targets.length})` : ""), async () => {
      if (multi && !(await confirmDialog(`Move ${targets.length} prompts to Trash?`, "Move to Trash", true)))
        return;
      await doForEach(targets, (t) => API.del(t.folder, t.name));
      toast("Moved to Trash", "ok");
    }, false, true],
  ]);
}

export function showEmptyMenu(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const cb = store.clipboard;
  const pasteLabel = "Paste" + (cb && cb.ids.length ? ` (${cb.ids.length})` : "");
  // Trash scope: nothing can be created or pasted INTO Trash (backend rejects).
  const trashScope = store.currentFolder != null && inTrash(store.currentFolder);
  renderMenu(ev, [
    ["New folder…", newFolder, trashScope],
    ["sep"],
    [pasteLabel, () => pasteCards(pasteFolder()), trashScope || !(cb && cb.ids.length)],
    ["sep"],
    ["Select all", () => store.set({ selectedIds: visiblePrompts().map((p) => p.id) })],
    ["Deselect all", () => store.set({ selectedIds: [], selectedId: null }), !store.selectedIds.length],
    ["sep"],
    ["Refresh", () => refreshLibrary()],
  ]);
}
