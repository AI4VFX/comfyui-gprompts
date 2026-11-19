// Settings panel (gear). Storage location, capture shortcut, behavior toggles.
// Changes take effect immediately; the gear toggles back to the card view.
import { el, clear, toast } from "../dom.js";
import { store } from "../store.js";
import { API } from "../api.js";
import { refreshState, refreshLibrary } from "../data.js";
import { renderPicker } from "./picker.js";
import { comboFromEvent, shortcutConflict } from "../shortcut.js";

function toggleRow(label, desc, get, onChange) {
  const cb = el("input", { type: "checkbox" });
  cb.checked = !!get();
  cb.addEventListener("change", () => onChange(cb.checked));
  return el("label", { class: "gp-set-row", style: "cursor:pointer" }, [
    cb, el("div", {}, [el("div", { text: label, style: "font-weight:600" }),
      el("div", { class: "gp-muted", text: desc })]),
  ]);
}

export function renderSettings(container) {
  let pickerOpen = false;

  function draw() {
    clear(container);
    const wrap = el("div", { class: "gp-setup" });
    wrap.appendChild(el("h3", { text: "Settings" }));

    // ── prompt storage location ──
    wrap.appendChild(el("div", { class: "gp-set-row" }, [
      el("div", {}, [
        el("div", { text: "Prompt Storage location", style: "font-weight:600" }),
        el("div", { class: "gp-pick-path", text: store.root || "(not set)" }),
      ]),
      el("div", { class: "gp-spacer" }),
      el("button", { class: "gp-btn", text: pickerOpen ? "Close" : "Change…",
        onclick: () => { pickerOpen = !pickerOpen; draw(); } }),
    ]));
    if (pickerOpen) {
      const host = el("div");
      wrap.appendChild(host);
      renderPicker(host, store.root || store.suggested, async (path) => {
        const r = await API.setRoot(path);
        if (r.ok) { await refreshState(); await refreshLibrary(); pickerOpen = false; toast("Storage location set", "ok"); draw(); }
        else toast(r.error || "Failed", "error");
      });
    }

    // ── capture shortcut ──
    const warn = el("div", { class: "gp-muted", style: "color:#e0a030;margin-top:2px" });
    const shortcutInput = el("input", { class: "gp-input", readonly: "", style: "width:150px;text-align:center;cursor:pointer",
      value: store.captureShortcut || "Alt+Q", title: "Click, then press a key combo" });
    const updateWarn = (combo) => {
      const c = shortcutConflict(combo);
      warn.textContent = c ? `⚠ "${combo}" may already be bound to ${c}.` : "";
    };
    shortcutInput.addEventListener("keydown", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { shortcutInput.blur(); return; }
      const combo = comboFromEvent(e);
      if (!combo) return;
      shortcutInput.value = combo;
      store.captureShortcut = combo;
      await API.setConfig({ captureShortcut: combo });
      updateWarn(combo);
    });
    wrap.appendChild(el("h3", { text: "Shortcut", style: "margin-top:6px" }));
    wrap.appendChild(el("div", { class: "gp-set-row" }, [
      el("div", {}, [el("div", { text: "Capture shortcut", style: "font-weight:600" }),
        el("div", { class: "gp-muted", text: "Click the box, then press a key combo." })]),
      el("div", { class: "gp-spacer" }),
      shortcutInput,
    ]));
    wrap.appendChild(warn);
    updateWarn(store.captureShortcut || "Alt+Q");

    // ── behavior toggle (immediate) ──
    wrap.appendChild(el("h3", { text: "Behavior", style: "margin-top:6px" }));
    wrap.appendChild(toggleRow(
      "Auto-close panel", "Close G-Prompts when you click inside the ComfyUI canvas.",
      () => store.autoClose, async (v) => { store.autoClose = v; await API.setConfig({ autoClose: v }); }));
    wrap.appendChild(toggleRow(
      "Remember selected folder", "Reopen G-Prompts in the folder you last selected.",
      () => store.rememberFolder, async (v) => {
        store.rememberFolder = v;
        await API.setConfig({ rememberFolder: v, lastFolder: v ? store.currentFolder : null });
      }));
    wrap.appendChild(toggleRow(
      "Capture input assets", "On capture, zip the input images/video/audio the workflow references beside the card (.assets.zip).",
      () => store.captureAssets, async (v) => { store.captureAssets = v; await API.setConfig({ captureAssets: v }); }));
    wrap.appendChild(toggleRow(
      "Include captured assets in packs", "Pack the .assets.zip together with everything else.",
      () => store.packIncludeAssets, async (v) => { store.packIncludeAssets = v; await API.setConfig({ packIncludeAssets: v }); }));
    wrap.appendChild(toggleRow(
      "Restore missing input assets", "When a card is dropped on the canvas, copy its captured input files back into ComfyUI's input folder if they are missing. Existing files are never overwritten.",
      () => store.restoreAssets, async (v) => { store.restoreAssets = v; await API.setConfig({ restoreAssets: v }); }));

    // ── pack toast duration (1–15 s) ──
    const secLabel = el("span", { class: "gp-muted", style: "min-width:32px;text-align:right",
      text: (store.packToastSeconds || 2) + " s" });
    const secSlider = el("input", { type: "range", class: "gp-slider", min: "1", max: "15",
      step: "1", value: String(store.packToastSeconds || 2) });
    let secT = null;
    secSlider.addEventListener("input", () => {
      const v = Number(secSlider.value);
      secLabel.textContent = v + " s";
      store.packToastSeconds = v;
      clearTimeout(secT);   // debounce: one config write per drag, not per tick
      secT = setTimeout(() => API.setConfig({ packToastSeconds: v }).catch(() => {}), 300);
    });
    wrap.appendChild(el("div", { class: "gp-set-row" }, [
      el("div", {}, [el("div", { text: "Pack notification duration", style: "font-weight:600" }),
        el("div", { class: "gp-muted", text: "How long the \"Packed — path copied\" popup stays on screen." })]),
      el("div", { class: "gp-spacer" }),
      secSlider, secLabel,
    ]));

    wrap.appendChild(el("div", { class: "gp-muted", style: "margin-top:8px",
      text: "Click the ⚙ gear again to return to your prompts." }));
    container.appendChild(wrap);
  }
  draw();
}
