// Project-folder tree (real directories). Click to scope; double-click a name to
// rename in place; right-click for cut/copy/paste/duplicate/pack/delete (which
// act on the whole folder and its contents). Drop prompt cards to move them.
import { el, clear, toast, copyText, formatBytes, sizeTier } from "../dom.js";
import { store, folderCount, libraryCount, TRASH, inTrash } from "../store.js";
import { API } from "../api.js";
import { refreshLibrary } from "../data.js";
import { confirmDialog, promptDialog } from "./confirm.js";

const parentOf = (f) => f.split("/").slice(0, -1).join("/");

async function dropPromptsInto(ids, targetFolder) {
  const objs = ids.map((id) => store.prompts.find((p) => p.id === id)).filter(Boolean);
  let moved = 0;
  // Dropping on the Trash row trashes (server mirrors the original path —
  // a plain move to "Trash" would flatten the hierarchy and break Restore).
  if (targetFolder === TRASH) {
    for (const o of objs) {
      if (inTrash(o.folder)) continue;
      const r = await API.del(o.folder, o.name);
      if (r.ok) moved++;
    }
    await refreshLibrary();
    if (moved) toast(`Moved ${moved} prompt${moved > 1 ? "s" : ""} to Trash`, "ok");
    return;
  }
  for (const o of objs) {
    if (o.folder === targetFolder) continue;
    const r = await API.move(o.folder, o.name, targetFolder);
    if (r.ok) moved++;
  }
  await refreshLibrary();
  if (moved) toast(`Moved ${moved} prompt${moved > 1 ? "s" : ""}`, "ok");
}

function startRename(folderVal, labelSpan) {
  const cur = folderVal.split("/").pop();
  const input = el("input", { class: "gp-rename-input", value: cur });
  labelSpan.replaceWith(input);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const name = input.value.trim();
    if (save && name && name !== cur) {
      const r = await API.folderRename(folderVal, name);
      if (r.ok && store.currentFolder === folderVal) store.set({ currentFolder: r.folder });
    }
    await refreshLibrary();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
document.addEventListener("click", closeMenu);

function openMenu(ev, items) {
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

function showFolderEmptyMenu(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const cb = store.folderClipboard;
  openMenu(ev, [
    ["New folder…", newFolder],
    ["Paste folder" + (cb ? ` (${cb.mode})` : ""), async () => {
      if (!cb) return;
      const dest = (store.currentFolder && store.currentFolder !== "") ? store.currentFolder : "";
      const r = cb.mode === "cut" ? await API.folderMove(cb.folder, dest) : await API.folderCopy(cb.folder, dest);
      if (r.ok) { if (cb.mode === "cut") store.folderClipboard = null; await refreshLibrary(); toast("Pasted folder", "ok"); }
      else toast(r.error || "Failed", "error");
    }, !cb],
    ["sep"],
    ["Refresh", () => refreshLibrary()],
  ]);
}

function showFolderMenu(ev, folderVal) {
  ev.preventDefault(); ev.stopPropagation();
  const cb = store.folderClipboard;
  const items = [
    ["Rename…", () => {
      const span = document.querySelector(`.gp-folder[data-f="${CSS.escape(folderVal)}"] .gp-fname`);
      if (span) startRename(folderVal, span);
    }],
    ["sep"],
    ["Cut", () => { store.folderClipboard = { folder: folderVal, mode: "cut" }; toast("Cut folder"); }],
    ["Copy", () => { store.folderClipboard = { folder: folderVal, mode: "copy" }; toast("Copied folder"); }],
    ["Paste into", async () => {
      if (!cb) return;
      const r = cb.mode === "cut" ? await API.folderMove(cb.folder, folderVal) : await API.folderCopy(cb.folder, folderVal);
      if (r.ok) { if (cb.mode === "cut") store.folderClipboard = null; await refreshLibrary(); toast("Pasted folder", "ok"); }
      else toast(r.error || "Failed", "error");
    }, !cb],
    ["Duplicate", async () => {
      const r = await API.folderCopy(folderVal, parentOf(folderVal));
      if (r.ok) { await refreshLibrary(); toast("Duplicated folder", "ok"); } else toast(r.error || "Failed", "error");
    }],
    ["sep"],
    ["Pack", async () => {
      const r = await API.folderPack(folderVal);
      if (r.ok) {
        const name = r.zip.split(/[\\/]/).pop();
        const copied = await copyText(r.zip);
        toast(copied ? `Packed: ${name} — path copied to clipboard` : `Packed: ${r.zip}`,
          "ok", store.packToastSeconds * 1000);
      } else toast(r.error || "Pack failed", "error");
    }],
    ["sep"],
    ["Move to Trash", async () => {
      if (await confirmDialog(`Move folder "${folderVal}" and its contents to Trash?`, "Move to Trash", true)) {
        const r = await API.folderDelete(folderVal);
        if (r.ok) { if (store.currentFolder === folderVal) store.set({ currentFolder: null }); await refreshLibrary(); toast("Folder moved to Trash", "ok"); }
        else toast(r.error || "Failed", "error");
      }
    }, false, true],
  ];
  openMenu(ev, items);
}

function row(label, folderVal, depth, count, opts = {}) {
  const active = store.currentFolder === folderVal;
  const real = opts.real;
  const trash = opts.trash;
  const labelSpan = el("span", { class: "gp-fname", text: label, style: "overflow:hidden;text-overflow:ellipsis" });
  // Defer single-click select so a double-click (rename) can cancel it.
  let clickT = null;
  const r = el("div", {
    class: "gp-folder" + (active ? " gp-active" : "") + (trash ? " gp-trash" : ""),
    style: `padding-left:${6 + depth * 12}px`,
    dataset: real ? { f: folderVal } : {},
    onclick: () => { clearTimeout(clickT); clickT = setTimeout(() => store.set({ currentFolder: folderVal }), 200); },
    ondblclick: real ? () => { clearTimeout(clickT); startRename(folderVal, labelSpan); } : null,
    // Trash is permanent: no rename, no folder menu (and no native menu either).
    oncontextmenu: real ? (e) => showFolderMenu(e, folderVal)
      : trash ? (e) => { e.preventDefault(); e.stopPropagation(); } : null,
  });
  r.appendChild(labelSpan);
  const right = el("span", { class: "gp-row", style: "gap:4px" });
  if (count != null) right.appendChild(el("span", { class: "gp-fcount", text: String(count) }));
  if (trash) right.appendChild(el("span", {
    class: "gp-fsize gp-sz-" + sizeTier(store.trashBytes),
    text: formatBytes(store.trashBytes),
    title: "Size of the Trash folder on disk — empty it manually in Explorer",
  }));
  r.appendChild(right);

  // Every row is a drop target for prompts. "All" (folderVal null) moves to root.
  r.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-gp-ids")) return;
    e.preventDefault(); r.classList.add("gp-drop");
  });
  r.addEventListener("dragleave", () => r.classList.remove("gp-drop"));
  r.addEventListener("drop", (e) => {
    r.classList.remove("gp-drop");
    const raw = e.dataTransfer.getData("application/x-gp-ids");
    if (!raw) return;
    e.preventDefault();
    try { dropPromptsInto(JSON.parse(raw), folderVal === null ? "" : folderVal); } catch (_) {}
  });
  return r;
}

async function newFolder() {
  const parent = (store.currentFolder && store.currentFolder !== "") ? store.currentFolder : "";
  const name = await promptDialog("New folder name", "");
  if (!name) return;
  const r = await API.folderCreate(parent, name);
  if (r.ok) { await refreshLibrary(); toast("Folder created", "ok"); }
  else toast(r.error || "Failed", "error");
}

export function renderFolders(container) {
  clear(container);
  // Real folder rows stop propagation in their own handler; everything else in
  // the pane (empty space, All, Unfiled) gets the custom menu — never the native.
  container.oncontextmenu = (e) => showFolderEmptyMenu(e);
  container.appendChild(el("div", { class: "gp-row", style: "margin-bottom:6px" }, [
    el("button", { class: "gp-btn", style: "flex:1", text: "+ Folder", onclick: newFolder }),
  ]));
  container.appendChild(row("All", null, 0, libraryCount()));
  for (const f of store.folders) {
    if (inTrash(f)) continue;   // Trash gets its own pinned row below
    const depth = f.split("/").length;
    container.appendChild(row(f.split("/").pop(), f, depth, folderCount(f), { real: true }));
  }
  container.appendChild(row("🗑 Trash", TRASH, 0, folderCount(TRASH), { trash: true }));
}
