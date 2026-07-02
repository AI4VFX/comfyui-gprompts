// Tiny DOM helper + one-time CSS injection. No framework.

export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(n.dataset, v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastHost = null;
export function toast(msg, kind = "info") {
  if (!toastHost) {
    toastHost = el("div", { style: "position:fixed;bottom:16px;right:16px;z-index:100000;display:flex;flex-direction:column;gap:6px;pointer-events:none" });
    document.body.appendChild(toastHost);
  }
  const bg = kind === "error" ? "#b71c1c" : kind === "ok" ? "#2e7d32" : "#2d6cdf";
  const t = el("div", { text: msg, style: `background:${bg};color:#fff;padding:8px 12px;border-radius:7px;font-size:12px;box-shadow:0 4px 14px #0008;max-width:340px` });
  toastHost.appendChild(t);
  setTimeout(() => { t.style.transition = "opacity .4s"; t.style.opacity = "0"; }, 2600);
  setTimeout(() => t.remove(), 3100);
}

// Draggable divider. `fixedEl` is the element whose size the drag sets; the
// sibling must be flex:1. mode "bottom" = fixedEl is below the divider,
// "top" = above. onChange(ratio) is called with the new fraction of container.
export function attachSplitter(divider, container, fixedEl, mode, onChange, min = 60) {
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    let basis = mode === "bottom" ? rect.bottom - e.clientY : e.clientY - rect.top;
    basis = Math.max(min, Math.min(rect.height - min, basis));
    fixedEl.style.flex = "0 0 " + basis + "px";
    if (onChange) onChange(basis / rect.height);
    e.preventDefault();
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.body.style.userSelect = "";
  };
  divider.addEventListener("pointerdown", (e) => {
    dragging = true;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
}

// Resize a single element's height by dragging a handle below it — independent
// of any sibling (the container scrolls). onChange(px) fires with the new height.
export function attachResizer(handle, block, onChange, min = 70) {
  let dragging = false, startY = 0, startH = 0;
  const onMove = (e) => {
    if (!dragging) return;
    const h = Math.max(min, startH + (e.clientY - startY));
    block.style.height = h + "px";
    if (onChange) onChange(h);
    e.preventDefault();
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.body.style.userSelect = "";
  };
  handle.addEventListener("pointerdown", (e) => {
    dragging = true; startY = e.clientY; startH = block.getBoundingClientRect().height;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
}

let cssDone = false;
export function injectCSS() {
  if (cssDone) return;
  cssDone = true;
  const style = document.createElement("style");
  style.id = "gprompts-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.gp-root{display:flex;flex-direction:column;height:100%;font-size:13px;color:var(--fg-color,#ccc);overflow:hidden}
.gp-toolbar{display:flex;flex-wrap:wrap;gap:6px;padding:8px;border-bottom:1px solid var(--border-color,#333);align-items:center}
.gp-btn{background:var(--comfy-input-bg,#333);color:var(--fg-color,#ddd);border:1px solid var(--border-color,#444);border-radius:6px;padding:5px 9px;cursor:pointer;font-size:12px;display:inline-flex;align-items:center;gap:5px}
.gp-btn:hover{filter:brightness(1.2)}
.gp-btn.gp-primary{background:#2d6cdf;border-color:#2d6cdf;color:#fff}
.gp-btn.gp-accent{background:#3a8f4a;border-color:#3a8f4a;color:#fff}
.gp-input,.gp-select{background:var(--comfy-input-bg,#222);color:var(--fg-color,#ddd);border:1px solid var(--border-color,#444);border-radius:6px;padding:4px 7px;font-size:12px}
.gp-search{flex:1;min-width:90px}
.gp-body{display:flex;flex:1;min-height:0}
.gp-leftcol{width:165px;min-width:130px;display:flex;flex-direction:column;border-right:1px solid var(--border-color,#333)}
.gp-folders{flex:1 1 58%;overflow:auto;padding:6px;min-height:60px}
.gp-folder{padding:4px 6px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;justify-content:space-between;gap:4px}
.gp-folder:hover{background:rgba(255,255,255,.06)}
.gp-folder.gp-active{background:#2d6cdf33;color:#fff}
.gp-folder.gp-drop{outline:2px solid #4f9bff;outline-offset:-2px;background:#2d6cdf33}
.gp-folder .gp-fcount{opacity:.5;font-size:11px}
.gp-tags{flex:1 1 42%;display:flex;flex-direction:column;border-top:1px solid var(--border-color,#333);min-height:70px}
.gp-tags-head{display:flex;align-items:center;gap:4px;padding:6px 6px 4px;flex:0 0 auto}
.gp-tags-title{font-size:10px;letter-spacing:.5px;opacity:.6;font-weight:700;white-space:nowrap}
.gp-mini{font-size:10px;padding:1px 7px;border-radius:5px;background:var(--comfy-input-bg,#333);border:1px solid var(--border-color,#444);color:#ccc;cursor:pointer;line-height:1.4}
.gp-mini:hover{filter:brightness(1.3)}
.gp-tags-list{flex:1;overflow:auto;padding:0 4px 6px;font-size:calc(13px * var(--gp-tag-scale,1))}
.gp-tags-foot{flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:4px 6px;border-top:1px solid var(--border-color,#2c2c2c)}
.gp-trow{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:5px;cursor:pointer;white-space:nowrap}
.gp-trow:hover{background:rgba(255,255,255,.06)}
.gp-trow.gp-active{background:#2d6cdf33;color:#fff}
.gp-trow.gp-drop{outline:2px solid #4f9bff;outline-offset:-2px;background:#2d6cdf44}
.gp-tname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.gp-tcount{opacity:.5;font-size:.85em;flex:0 0 auto}
.gp-rename-input{width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #4f9bff;border-radius:4px;padding:2px 5px;font-size:12px}
.gp-grid-wrap{flex:1;overflow:auto;padding:8px}
.gp-grid{display:grid;grid-template-columns:repeat(auto-fill,calc(150px * var(--gp-scale,1)));gap:10px;justify-content:start}
.gp-card{background:var(--comfy-menu-bg,#1e1e1e);border:1px solid var(--border-color,#383838);border-radius:8px;overflow:hidden;cursor:pointer;position:relative;display:flex;flex-direction:column}
.gp-card:hover{border-color:#2d6cdf}
.gp-card.gp-sel{border-color:#4f9bff;box-shadow:0 0 0 2px #4f9bff66}
.gp-card.gp-drag{outline:2px dashed #2d6cdf}
.gp-thumb{width:100%;aspect-ratio:16/9;object-fit:cover;background:#111;display:block}
.gp-card-body{padding:6px 7px;display:flex;flex-direction:column;gap:4px}
.gp-card-title{font-size:12px;font-weight:600;line-height:1.2;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.gp-badges{position:absolute;top:6px;left:6px;display:flex;gap:3px;z-index:2}
.gp-badge{font-size:10px;padding:1px 6px;border-radius:10px;font-weight:700;text-transform:uppercase}
.gp-badge.pos{background:#2e7d32cc;color:#fff}
.gp-badge.neg{background:#b71c1ccc;color:#fff}
.gp-badge.unknown{background:#5a5a5acc;color:#ddd}
.gp-mtype{position:absolute;top:6px;right:6px;font-size:15px;line-height:1;background:#000b;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;z-index:2}
.gp-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.gp-detail{flex:0 0 45%;min-height:120px;border-top:2px solid var(--border-color,#444);overflow:hidden;display:flex;flex-direction:column;padding:8px}
.gp-detail-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex:0 0 auto}
.gp-detail-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-detail-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.gp-detail-block{display:flex;flex-direction:column;gap:4px;flex:0 0 auto;min-height:0;overflow:hidden}
.gp-detail-text{flex:1;width:100%;box-sizing:border-box;resize:none;color:#ddd;font-family:inherit;word-break:break-word;background:#141414;border:1px solid #2c2c2c;border-radius:6px;padding:7px;font-size:calc(13px * var(--gp-detail-scale,1));line-height:1.35}
.gp-btn.gp-on{background:#2d6cdf;border-color:#2d6cdf;color:#fff}
.gp-btn[disabled]{opacity:.4;pointer-events:none}
.gp-vdiv{flex:0 0 8px;cursor:row-resize;position:relative;touch-action:none}
.gp-vdiv::after{content:"";position:absolute;left:6px;right:6px;top:3px;height:2px;border-radius:2px;background:var(--border-color,#454545)}
.gp-vdiv:hover::after{background:#4f9bff}
.gp-save-on{background:#c0392b !important;border-color:#c0392b !important;color:#fff !important}
.gp-capture-btn{font-size:14px;font-weight:700;padding:4px 11px;letter-spacing:.3px}
.gp-icon-btn{font-size:20px;line-height:1;padding:1px 7px}
.gp-detail-block .gp-act{font-size:15px;padding:6px 14px;border-radius:6px}
.gp-detail-block .gp-act.gp-dis{opacity:.4;pointer-events:none}
.gp-detail-block .gp-act.gp-save-on{background:#c0392b;border-color:#c0392b;color:#fff}
.gp-card-tags{display:flex;flex-wrap:wrap;gap:3px}
.gp-tag{font-size:10px;background:#3a3a44;border-radius:8px;padding:1px 6px;opacity:.85}
.gp-acts{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}
.gp-act{font-size:10px;padding:2px 5px;border-radius:5px;background:#2a2a30;border:1px solid #444;cursor:pointer;color:#ccc}
.gp-act:hover{background:#2d6cdf;color:#fff;border-color:#2d6cdf}
.gp-empty{opacity:.6;text-align:center;padding:40px 10px;line-height:1.6}
.gp-slider{width:90px}
.gp-setup{padding:18px;display:flex;flex-direction:column;gap:12px;max-width:520px}
.gp-setup h3{margin:0}
.gp-picker{border:1px solid var(--border-color,#444);border-radius:8px;max-height:260px;overflow:auto;background:#161616}
.gp-pick-row{padding:5px 9px;cursor:pointer;display:flex;gap:6px;align-items:center}
.gp-pick-row:hover{background:rgba(255,255,255,.06)}
.gp-pick-path{font-family:monospace;font-size:12px;opacity:.8;word-break:break-all}
.gp-overlay{position:fixed;inset:0;background:#000d;z-index:99999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px}
.gp-overlay img,.gp-overlay video{max-width:92vw;max-height:88vh;border-radius:6px}
.gp-modal{background:var(--comfy-menu-bg,#222);border:1px solid var(--border-color,#444);border-radius:10px;padding:16px;max-width:560px;max-height:80vh;overflow:auto;display:flex;flex-direction:column;gap:10px}
.gp-check-row{display:flex;gap:8px;align-items:flex-start;padding:6px;border-radius:6px;background:#1c1c22}
.gp-check-row textarea{flex:1;background:#111;color:#ccc;border:1px solid #333;border-radius:5px;font-size:11px;min-height:40px}
.gp-row{display:flex;gap:8px;align-items:center}
.gp-spacer{flex:1}
.gp-muted{opacity:.6;font-size:11px}
.gp-set-row{display:flex;gap:10px;align-items:flex-start;padding:8px;border:1px solid var(--border-color,#3a3a3a);border-radius:8px;background:#181818}
.gp-menu{background:var(--comfy-menu-bg,#232323);border:1px solid var(--border-color,#4a4a4a);border-radius:8px;padding:4px;min-width:180px;box-shadow:0 8px 24px #000b}
.gp-menu-item{padding:6px 10px;border-radius:5px;cursor:pointer;font-size:12px;white-space:nowrap}
.gp-menu-item:hover{background:#2d6cdf;color:#fff}
.gp-menu-item.gp-dis{opacity:.4;pointer-events:none}
.gp-menu-item.gp-danger:hover{background:#b71c1c}
.gp-menu-sep{height:1px;background:var(--border-color,#444);margin:4px 2px}
`;
