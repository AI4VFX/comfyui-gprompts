// Dropping a prompt card onto the canvas rebuilds the workflow that produced it.
import { app } from "./comfy.js";
import { store } from "./store.js";
import { loadWorkflowOnCanvas } from "./reinject.js";

let attached = false;

export function attachCanvasDrop() {
  if (attached) return;
  const canvas = app.canvas && app.canvas.canvas;
  if (!canvas) return;
  attached = true;
  // Capture phase so we win over litegraph's own drop handling.
  canvas.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("application/x-gp-ids")) {
      e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    }
  }, true);
  canvas.addEventListener("drop", (e) => {
    const raw = e.dataTransfer.getData("application/x-gp-ids");
    if (!raw) return;
    e.preventDefault(); e.stopPropagation();
    try {
      const ids = JSON.parse(raw);
      const p = store.prompts.find((x) => x.id === ids[0]);
      if (p) loadWorkflowOnCanvas(p);
    } catch (_) {}
  }, true);
}
