// Modal dialogs: generic confirm/prompt, save-or-discard, and the overwrite warning.
import { el } from "../dom.js";

function modal(buildBody) {
  return new Promise((resolve) => {
    const close = (val) => { ov.remove(); document.removeEventListener("keydown", onKey); resolve(val); };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    const box = el("div", { class: "gp-modal" });
    const ov = el("div", { class: "gp-overlay", onclick: (e) => { if (e.target === ov) close(null); } }, [box]);
    buildBody(box, close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
  });
}

export function confirmDialog(message, okLabel = "OK", danger = false) {
  return modal((box, close) => {
    box.appendChild(el("div", { text: message, style: "white-space:pre-wrap" }));
    box.appendChild(el("div", { class: "gp-row" }, [
      el("div", { class: "gp-spacer" }),
      el("button", { class: "gp-btn", text: "Cancel", onclick: () => close(false) }),
      el("button", { class: "gp-btn " + (danger ? "" : "gp-primary"), text: okLabel,
        style: danger ? "background:#b71c1c;border-color:#b71c1c;color:#fff" : "",
        onclick: () => close(true) }),
    ]));
  });
}

export function saveDiscardDialog(message) {
  return modal((box, close) => {
    box.appendChild(el("div", { text: message, style: "white-space:pre-wrap" }));
    box.appendChild(el("div", { class: "gp-row" }, [
      el("div", { class: "gp-spacer" }),
      el("button", { class: "gp-btn", text: "Discard", onclick: () => close("discard") }),
      el("button", { class: "gp-btn gp-primary", text: "Save", onclick: () => close("save") }),
    ]));
  });
}

export function promptDialog(message, def = "") {
  return modal((box, close) => {
    box.appendChild(el("div", { text: message }));
    const input = el("input", { class: "gp-input", value: def, style: "width:100%" });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") close(input.value.trim() || null); });
    box.appendChild(input);
    box.appendChild(el("div", { class: "gp-row" }, [
      el("div", { class: "gp-spacer" }),
      el("button", { class: "gp-btn", text: "Cancel", onclick: () => close(null) }),
      el("button", { class: "gp-btn gp-primary", text: "OK", onclick: () => close(input.value.trim() || null) }),
    ]));
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

function overwrite(conflicts) {
  return modal((box, close) => {
    box.appendChild(el("h3", { text: "Overwrite existing prompt" + (conflicts.length > 1 ? "s" : "") + "?" }));
    const list = el("div", { class: "gp-muted" });
    for (const c of conflicts) list.appendChild(el("div", { text: "• " + (c.title || c.existingName || c.error) }));
    box.appendChild(list);
    box.appendChild(el("div", { text: "These came from the same workflow + node and already exist in this folder." , class: "gp-muted"}));
    const skip = el("input", { type: "checkbox" });
    box.appendChild(el("label", { class: "gp-row", style: "cursor:pointer" }, [skip, el("span", { text: "Don't ask again (overwrite instantly next time)" })]));
    box.appendChild(el("div", { class: "gp-row" }, [
      el("div", { class: "gp-spacer" }),
      el("button", { class: "gp-btn", text: "Skip", onclick: () => close(false) }),
      el("button", { class: "gp-btn gp-primary", text: "Overwrite", onclick: () => close({ skip: skip.checked }) }),
    ]));
  });
}

export const openConfirm = { overwrite };
