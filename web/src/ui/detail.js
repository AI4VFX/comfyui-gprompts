// Bottom detail pane: the selected card's Positive (top) and Negative (bottom),
// each EDITABLE and INDEPENDENTLY resizable (drag the bar under each box). Each
// block has Fill · Save · Copy; the two Save buttons are mirrored (both light
// red on any edit, both disabled when clean), plus an unsaved-edit guard and a
// font slider.
import { el, clear, toast, attachSplitter } from "../dom.js";
import { store, selectedPrompt } from "../store.js";
import { applyText, copyText } from "../reinject.js";
import { API } from "../api.js";
import { saveDiscardDialog } from "./confirm.js";

let modalOpen = false;

export function renderDetail(container) {
  clear(container);
  container.style.setProperty("--gp-detail-scale", store.detailScale);
  const p = selectedPrompt();

  const slider = el("input", { type: "range", class: "gp-slider", min: "100", max: "250", step: "1",
    value: String(Math.round(store.detailScale * 100)), title: "Text size" });
  slider.addEventListener("input", (e) => {
    const v = e.target.value / 100;
    store.detailScale = v; store._savePrefs();
    container.style.setProperty("--gp-detail-scale", v);
  });

  container.appendChild(el("div", { class: "gp-detail-head" }, [
    el("div", { class: "gp-detail-title", text: p ? p.title : "No prompt selected" }),
    el("div", { class: "gp-spacer" }),
    el("span", { class: "gp-muted", text: "Aa" }), slider,
  ]));

  if (!p) {
    container.appendChild(el("div", { class: "gp-muted", style: "padding:10px", text: "Click a card to view its prompt here." }));
    return;
  }

  const dirty = { positive: false, negative: false };
  const orig = { positive: p.positive || "", negative: p.negative || "" };
  const tas = {};
  const saveBtns = [];

  const isDirty = () => dirty.positive || dirty.negative;
  function updateSave() {
    const on = isDirty();
    for (const b of saveBtns) { b.classList.toggle("gp-save-on", on); b.classList.toggle("gp-dis", !on); }
  }
  async function saveAll() {
    const patch = {};
    for (const f of ["positive", "negative"]) if (dirty[f]) patch[f] = tas[f].value;
    if (!Object.keys(patch).length) return;
    const r = await API.updatePrompt(p.folder, p.name, patch);
    if (r && r.ok) {
      for (const f of Object.keys(patch)) { p[f] = patch[f]; orig[f] = patch[f]; dirty[f] = false; }
      updateSave(); toast("Saved", "ok");
    } else toast("Save failed", "error");
  }
  function revertAll() {
    for (const f of ["positive", "negative"]) { tas[f].value = orig[f]; dirty[f] = false; }
    updateSave();
  }

  const body = el("div", { class: "gp-detail-body" });

  function makeBlock(field, label, cls) {
    const ta = el("textarea", { class: "gp-detail-text", spellcheck: "false", placeholder: "(empty)" });
    ta.value = orig[field];
    tas[field] = ta;
    ta.addEventListener("input", () => { dirty[field] = ta.value !== orig[field]; updateSave(); });
    ta.addEventListener("blur", (e) => {
      if (!isDirty() || modalOpen) return;
      if (e.relatedTarget && container.contains(e.relatedTarget)) return;
      modalOpen = true;
      saveDiscardDialog("You have unsaved prompt edits. Save or discard?").then((r) => {
        modalOpen = false;
        if (r === "save") saveAll(); else if (r === "discard") revertAll();
      });
    });
    const act = (lbl, fn, tip) => el("span", { class: "gp-act", text: lbl, title: tip, onclick: () => fn(ta.value) });
    // mousedown preventDefault keeps the textarea focused (no blur → no guard modal).
    const save = el("span", { class: "gp-act gp-save gp-dis", text: "Save", title: "Save edits" });
    save.addEventListener("mousedown", (e) => e.preventDefault());
    save.addEventListener("click", () => { if (isDirty()) saveAll(); });
    saveBtns.push(save);
    return el("div", { class: "gp-detail-block" }, [
      el("div", { class: "gp-row", style: "gap:6px" }, [
        el("span", { class: "gp-badge " + cls, text: label, style: "position:static" }),
        el("div", { class: "gp-spacer" }),
        act("Fill", applyText, "Fill selected node, or spawn one if nothing is selected"),
        save,
        act("Copy", copyText, "Copy"),
      ]),
      ta,
    ]);
  }

  const posBlock = makeBlock("positive", "positive", "pos");
  posBlock.style.flex = "1";
  const divider = el("div", { class: "gp-vdiv", title: "Drag to resize the Negative box" });
  const negBlock = makeBlock("negative", "negative", "neg");
  negBlock.style.flex = "0 0 " + (store.detailNegRatio * 100) + "%";
  body.append(posBlock, divider, negBlock);
  container.appendChild(body);
  attachSplitter(divider, body, negBlock, "bottom", (r) => { store.detailNegRatio = r; store._savePrefs(); }, 70);
}
