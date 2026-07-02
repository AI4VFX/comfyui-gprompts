// Single-click result viewer: opens the image / plays the video or audio over
// everything. Click the backdrop or Esc to close.
import { el } from "../dom.js";
import { mediaUrl, posterUrl } from "../api.js";

export function openMedia(prompt) {
  if (!prompt) return;
  const url = mediaUrl(prompt);
  let inner;
  if (prompt.mediaKind === "video") {
    inner = el("video", { src: url, controls: "", autoplay: "", loop: "" });
  } else if (prompt.mediaKind === "audio") {
    inner = el("div", { style: "display:flex;flex-direction:column;align-items:center;gap:14px" }, [
      el("div", { text: "🎵 " + prompt.title, style: "color:#fff;font-size:16px" }),
      el("audio", { src: url, controls: "", autoplay: "" }),
    ]);
  } else {
    // A real image opens its full media; a card with no result media shows the
    // type placeholder (default_thumb) full-screen instead of doing nothing.
    inner = el("img", { src: prompt.mediaKind === "none" ? posterUrl(prompt) : url, alt: prompt.title });
  }
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const ov = el("div", { class: "gp-overlay", onclick: (e) => { if (e.target === ov) close(); } }, [
    inner,
    el("div", { class: "gp-muted", text: "click outside or press Esc to close" }),
  ]);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(ov);
}
