// One prompt card (holds positive + negative). Single-click selects (fills the
// detail pane); double-click opens the result; middle-click spawns both nodes;
// right-click opens the menu.
import { el, toast } from "../dom.js";
import { posterUrl } from "../api.js";
import { API } from "../api.js";
import { store, selectCard, isSelected, selectedPromptObjs } from "../store.js";
import { applyToCanvas, spawnBoth, copyText } from "../reinject.js";
import { openMedia } from "./overlay.js";
import { showCardMenu } from "./contextmenu.js";
import { assignTags, filterByTag } from "./tags.js";
import { promptDialog } from "./confirm.js";
import { refreshLibrary } from "../data.js";

const MTYPE_ICON = { image: "🖼️", video: "📽️", audio: "🔊", none: "📖" };
// When no result media exists, fall back to an icon for what the workflow PRODUCES.
const WTYPE_ICON = { t2i: "🖼️", i2i: "🖼️", t2v: "📽️", v2v: "📽️", audio: "🔊", editing: "📖" };
const cardIcon = (p) => p.mediaKind && p.mediaKind !== "none"
  ? MTYPE_ICON[p.mediaKind] : (WTYPE_ICON[p.workflowType] || MTYPE_ICON.none);

// Copy positive + negative (labeled) in one go.
function copyBoth(p) {
  const parts = [];
  if (p.positive && p.positive.trim()) parts.push(p.positive.trim());
  if (p.negative && p.negative.trim()) parts.push("Negative: " + p.negative.trim());
  copyText(parts.join("\n\n"));
}

function fileKind(file) {
  if (file.type.startsWith("video")) return "video";
  if (file.type.startsWith("audio")) return "audio";
  return "image";
}

async function dropMedia(prompt, file) {
  const kind = fileKind(file);
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  toast("Replacing thumbnail…");
  const r = await API.setMedia(prompt.folder, prompt.name, dataUrl, kind);
  if (r.ok) { await refreshLibrary(); toast("Thumbnail replaced", "ok"); }
  else toast(r.error || "Failed", "error");
}

async function editTags(prompt) {
  const s = await promptDialog("Tags (comma separated)", (prompt.tags || []).join(", "));
  if (s == null) return;
  const tags = s.split(",").map((t) => t.trim()).filter(Boolean);
  const r = await API.updatePrompt(prompt.folder, prompt.name, { tags });
  if (r.ok) { await refreshLibrary(); toast("Tags updated", "ok"); }
}

// Rename the card title in place (double-click the title).
function startCardRename(prompt, titleEl) {
  const input = el("input", { class: "gp-rename-input", value: prompt.title });
  titleEl.replaceWith(input);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v && v !== prompt.title) await API.updatePrompt(prompt.folder, prompt.name, { title: v });
    await refreshLibrary();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

// Double-click detection that survives the grid re-render a single select
// triggers. Selecting rebuilds every card's DOM, so the native `dblclick` (which
// needs BOTH clicks on the same element) breaks whenever the two clicks are more
// than the select delay apart. Instead we track the last click by prompt id +
// which part was hit, at module scope, so the second click — even on the freshly
// rebuilt element — still recognises the double. A cancelable module-level select
// timer lets a fast double-click open without first flashing a selection.
const DBL_MS = 450;
let lastTap = { id: null, part: null, t: 0 };

function isDoubleTap(id, part) {
  const now = performance.now();
  const hit = lastTap.id === id && lastTap.part === part && (now - lastTap.t) < DBL_MS;
  lastTap = hit ? { id: null, part: null, t: 0 } : { id, part, t: now };
  return hit;
}

// Selecting no longer rebuilds the grid (store.setSelection just toggles the
// highlight), so a single click can select INSTANTLY without breaking the
// double-click — the element is never detached between the two clicks. The
// second tap on the same part runs `onDouble` (open media / rename); ctrl/meta/
// shift route straight to multi-select.
function tapHandler(prompt, part, onDouble) {
  return (e) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      selectCard(prompt.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
      return;
    }
    if (isDoubleTap(prompt.id, part)) { onDouble(); return; }
    selectCard(prompt.id, {});
  };
}

export function buildCard(prompt) {
  const img = el("img", { class: "gp-thumb", src: posterUrl(prompt), loading: "lazy", alt: "" });
  img.addEventListener("click", tapHandler(prompt, "thumb", () => openMedia(prompt)));

  const badges = el("div", { class: "gp-badges" }, [
    prompt.positive && prompt.positive.trim() ? el("span", { class: "gp-badge pos", text: "P" }) : null,
    prompt.negative && prompt.negative.trim() ? el("span", { class: "gp-badge neg", text: "N" }) : null,
    prompt.hasThumb && prompt.hideThumb ? el("span", { class: "gp-badge info", text: "!", title: "Custom thumbnail hidden" }) : null,
    prompt.hasAssets ? el("span", { class: "gp-badge assets", text: "A", title: "Input assets captured" }) : null,
  ]);
  const mtype = cardIcon(prompt);
  const title = el("div", { class: "gp-card-title", text: prompt.title, title: "double-click to rename",
    onclick: tapHandler(prompt, "title", () => startCardRename(prompt, title)) });
  // Chip: click = filter by this tag (same as the pane); double-click = edit tags.
  const chip = (t) => {
    let ct = null;
    return el("span", { class: "gp-tag", text: t, title: "click = filter · double-click = edit tags",
      onclick: (e) => { e.stopPropagation(); clearTimeout(ct); ct = setTimeout(() => filterByTag(t), 200); },
      ondblclick: (e) => { e.stopPropagation(); clearTimeout(ct); editTags(prompt); } });
  };
  const tags = el("div", { class: "gp-card-tags" }, (prompt.tags || []).map(chip));

  const act = (label, fn, tip) => el("span", { class: "gp-act", text: label, title: tip || label,
    onclick: (e) => { e.stopPropagation(); fn(); } });

  const acts = el("div", { class: "gp-acts" }, [
    act("Fill", () => applyToCanvas(prompt), "Fill selected node(s) by polarity — or spawn both if nothing is selected"),
    act("Copy", () => copyBoth(prompt), "Copy positive + negative"),
  ]);

  const card = el("div", {
    class: "gp-card" + (isSelected(prompt.id) ? " gp-sel" : ""),
    draggable: "true",
    dataset: { gpid: String(prompt.id) },
    title: "click = select · double-click thumb = open · double-click name = rename · middle-click = spawn · drag to folder = move · right-click = menu",
    onclick: (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) { selectCard(prompt.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }); return; }
      selectCard(prompt.id, {});
    },
    oncontextmenu: (e) => showCardMenu(e, prompt),
  }, [
    badges,
    el("span", { class: "gp-mtype", text: mtype }),
    img,
    el("div", { class: "gp-card-body" }, [title, tags, acts]),
  ]);

  // middle-click anywhere on the card = spawn both nodes
  card.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); spawnBoth(prompt); } });
  card.addEventListener("pointerdown", (e) => { if (e.button === 1) e.preventDefault(); }); // suppress autoscroll

  // drag SOURCE: move this prompt (or the whole selection) into a folder
  card.addEventListener("dragstart", (e) => {
    const ids = (isSelected(prompt.id) && store.selectedIds.length) ? store.selectedIds : [prompt.id];
    e.dataTransfer.setData("application/x-gp-ids", JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "copyMove";
  });

  // drop TARGET: a tag (assign), or a media file (replace thumbnail)
  card.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("application/x-gp-ids")) return; // don't accept cards onto cards
    e.preventDefault(); card.classList.add("gp-drag");
  });
  card.addEventListener("dragleave", () => card.classList.remove("gp-drag"));
  card.addEventListener("drop", (e) => {
    card.classList.remove("gp-drag");
    const rawTags = e.dataTransfer.getData("application/x-gp-tags");
    const single = e.dataTransfer.getData("application/x-gp-tag");
    const tags = rawTags ? JSON.parse(rawTags) : (single ? [single] : null);
    if (tags && tags.length) {
      e.preventDefault();
      const targets = isSelected(prompt.id) ? selectedPromptObjs() : [prompt];
      assignTags(tags, targets).then(() => toast(`Tagged ${tags.length} tag(s)`, "ok"));
      return;
    }
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) { e.preventDefault(); dropMedia(prompt, file); }
  });

  return card;
}
