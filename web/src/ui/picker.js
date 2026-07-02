// Reusable server-side folder picker. Used by first-run setup and by the
// Settings "Change folder" action.
import { el, clear } from "../dom.js";
import { API } from "../api.js";

export function renderPicker(container, initialPath, onChoose) {
  let cur = null, listing = null;

  async function go(path) {
    cur = path;
    listing = await API.fsList(path);
    draw();
  }

  async function draw() {
    clear(container);
    const wrap = el("div", { class: "gp-setup" });
    wrap.appendChild(el("div", { class: "gp-muted", text:
      "Pick an existing or new folder. You can change it later in Settings." }));

    const roots = await API.fsRoots();
    if (roots.ok) {
      const quick = el("div", { class: "gp-row", style: "flex-wrap:wrap" });
      for (const s of (roots.shortcuts || []))
        quick.appendChild(el("button", { class: "gp-btn", text: s.label, title: s.path, onclick: () => go(s.path) }));
      for (const d of (roots.drives || []))
        quick.appendChild(el("button", { class: "gp-btn", text: d.label, onclick: () => go(d.path) }));
      wrap.appendChild(quick);
    }

    const pathInput = el("input", { class: "gp-input", style: "flex:1",
      placeholder: "Type or browse a folder path", value: cur || (listing && listing.path) || "" });
    pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") go(pathInput.value.trim()); });
    wrap.appendChild(el("div", { class: "gp-row" }, [
      pathInput, el("button", { class: "gp-btn", text: "Go", onclick: () => go(pathInput.value.trim()) }),
    ]));

    const picker = el("div", { class: "gp-picker" });
    if (listing) {
      if (listing.error) picker.appendChild(el("div", { class: "gp-pick-row gp-muted", text: listing.error }));
      if (listing.parent)
        picker.appendChild(el("div", { class: "gp-pick-row", onclick: () => go(listing.parent) }, [el("span", { text: "⬆  .." })]));
      for (const en of (listing.entries || [])) {
        if (en.hidden) continue;
        picker.appendChild(el("div", { class: "gp-pick-row", onclick: () => go(en.path) }, [el("span", { text: "📁 " + en.name })]));
      }
    } else {
      picker.appendChild(el("div", { class: "gp-pick-row gp-muted", text: "Pick a drive or shortcut above to browse." }));
    }
    wrap.appendChild(picker);

    if (cur) {
      wrap.appendChild(el("div", { class: "gp-row" }, [
        el("div", { class: "gp-pick-path", text: cur }),
        el("div", { class: "gp-spacer" }),
        el("button", { class: "gp-btn gp-primary", text: "Use this folder", onclick: () => onChoose(cur) }),
      ]));
    }
    container.appendChild(wrap);
  }

  go(initialPath || "");
}
