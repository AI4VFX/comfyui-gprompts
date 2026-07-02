// Tags pane (left column, under folders): all tags in use with counts. Plain
// click filters; Ctrl/Shift multi-select; drag selected tags onto cards to
// assign; drag cards onto a tag to assign it; right-click for New/Rename/Copy/
// Delete; size slider in the footer.
import { el, clear, toast } from "../dom.js";
import { store, tagCounts } from "../store.js";
import { API } from "../api.js";
import { refreshLibrary } from "../data.js";
import { confirmDialog, promptDialog } from "./confirm.js";

let anchor = null;

export async function assignTags(tags, prompts) {
  tags = tags.filter(Boolean);
  for (const p of prompts) {
    const merged = [...new Set([...(p.tags || []), ...tags])];
    if (merged.length !== (p.tags || []).length) await API.updatePrompt(p.folder, p.name, { tags: merged });
  }
  await refreshLibrary();
}

const selected = () => store.selectedTags;
const isSel = (t) => store.selectedTags.includes(t);

function clickTag(tag, e, ordered) {
  if (e.ctrlKey || e.metaKey) {
    anchor = tag;
    store.set({ selectedTags: isSel(tag) ? selected().filter((x) => x !== tag) : selected().concat(tag) });
  } else if (e.shiftKey && anchor) {
    const a = ordered.indexOf(anchor), b = ordered.indexOf(tag);
    if (a >= 0 && b >= 0) store.set({ selectedTags: ordered.slice(Math.min(a, b), Math.max(a, b) + 1) });
  } else {
    anchor = tag;
    const only = store.selectedTags.length === 1 && store.selectedTags[0] === tag;
    store.set({ selectedTags: only ? [] : [tag] });
  }
}

export function filterByTag(tag) { anchor = tag; store.set({ selectedTags: [tag] }); }

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

// tag may be null (right-clicked empty pane area).
function showTagMenu(ev, tag) {
  ev.preventDefault(); ev.stopPropagation();
  if (tag && !isSel(tag)) store.set({ selectedTags: [tag] });
  const tags = tag ? (selected().length ? selected() : [tag]) : selected();
  const multi = tags.length > 1;
  const items = [
    ["New tag…", async () => {
      const n = await promptDialog("New tag name", "");
      if (n && n.trim()) { await API.tagCreate(n.trim()); await refreshLibrary(); toast("Tag created — drag cards onto it to assign", "ok"); }
    }],
  ];
  if (tags.length) {
    items.push(
      ["Rename…", async () => {
        const n = await promptDialog("Rename tag", tags[0]);
        if (n && n !== tags[0]) { const r = await API.tagRename(tags[0], n); if (r.ok) { store.selectedTags = store.selectedTags.map((t) => t === tags[0] ? n : t); await refreshLibrary(); } }
      }, multi],
      ["Copy tag" + (multi ? `s (${tags.length})` : ""), () => { store.tagClipboard = tags.slice(); toast(`Copied ${tags.length} tag(s)`); }],
      ["sep"],
      ["Delete" + (multi ? ` (${tags.length})` : ""), async () => {
        if (await confirmDialog(`Delete ${tags.length} tag(s) from all prompts?`, "Delete", true)) {
          for (const t of tags) await API.tagDelete(t);
          store.selectedTags = store.selectedTags.filter((t) => !tags.includes(t));
          await refreshLibrary();
        }
      }, false, true],
    );
  }
  openMenu(ev, items);
}

export function renderTags(container) {
  clear(container);
  // Right-click empty pane space → custom menu (never the native one).
  container.oncontextmenu = (e) => { if (!e.target.closest(".gp-trow")) showTagMenu(e, null); };
  const counts = tagCounts();
  const ordered = counts.map((c) => c.tag);

  container.appendChild(el("div", { class: "gp-tags-head" }, [
    el("span", { class: "gp-tags-title", text: `TAGS · ${counts.length} IN USE` }),
    el("div", { class: "gp-spacer" }),
    el("button", { class: "gp-mini", text: store.tagSort === "name" ? "NAME" : "COUNT",
      title: "Toggle sort", onclick: () => store.set({ tagSort: store.tagSort === "name" ? "count" : "name" }) }),
  ]));

  const list = el("div", { class: "gp-tags-list",
    onclick: (e) => { if (!e.target.closest(".gp-trow") && store.selectedTags.length) store.set({ selectedTags: [] }); } });
  list.style.setProperty("--gp-tag-scale", store.tagScale);

  if (!counts.length) list.appendChild(el("div", { class: "gp-muted", style: "padding:6px", text: "No tags yet." }));
  for (const { tag, count } of counts) {
    const row = el("div", {
      class: "gp-trow" + (isSel(tag) ? " gp-active" : ""),
      draggable: "true", title: tag,
      onclick: (e) => clickTag(tag, e, ordered),
      oncontextmenu: (e) => showTagMenu(e, tag),
    }, [
      el("span", { class: "gp-tname", text: tag }),
      el("span", { class: "gp-tcount", text: String(count) }),
    ]);
    // drag SOURCE: assign these tag(s) to a card
    row.addEventListener("dragstart", (e) => {
      const tags = isSel(tag) && selected().length ? selected() : [tag];
      e.dataTransfer.setData("application/x-gp-tags", JSON.stringify(tags));
      e.dataTransfer.setData("application/x-gp-tag", tag);
      e.dataTransfer.effectAllowed = "copy";
    });
    // drop TARGET: drop card(s) here to assign this tag to them
    row.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-gp-ids")) return;
      e.preventDefault(); row.classList.add("gp-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("gp-drop"));
    row.addEventListener("drop", (e) => {
      row.classList.remove("gp-drop");
      const raw = e.dataTransfer.getData("application/x-gp-ids");
      if (!raw) return;
      e.preventDefault();
      try {
        const objs = JSON.parse(raw).map((id) => store.prompts.find((p) => p.id === id)).filter(Boolean);
        assignTags([tag], objs).then(() => toast(`Tagged ${objs.length} card(s) “${tag}”`, "ok"));
      } catch (_) {}
    });
    list.appendChild(row);
  }
  container.appendChild(list);

  // Footer: size slider (updates the CSS var directly — no re-render).
  const slider = el("input", { type: "range", class: "gp-slider", min: "70", max: "200", step: "1",
    value: String(Math.round(store.tagScale * 100)), title: "Tag size", style: "flex:1" });
  slider.addEventListener("input", (e) => {
    const v = e.target.value / 100;
    store.tagScale = v; store._savePrefs();
    list.style.setProperty("--gp-tag-scale", v);
  });
  container.appendChild(el("div", { class: "gp-tags-foot" }, [
    el("span", { class: "gp-muted", text: "size" }), slider,
  ]));
}
