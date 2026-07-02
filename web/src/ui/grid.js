// Renders the flat prompt grid for the current folder + filters.
import { el, clear } from "../dom.js";
import { store, visiblePrompts } from "../store.js";
import { buildCard } from "./card.js";

export function renderGrid(container) {
  clear(container);
  container.style.setProperty("--gp-scale", store.cardSize);
  const prompts = visiblePrompts();

  if (!prompts.length) {
    container.appendChild(el("div", { class: "gp-empty" }, [
      "No prompts here yet.", el("br"),
      "Run a workflow, then hit ", el("b", { text: "⚡ Capture" }), "."]));
    return;
  }
  const grid = el("div", { class: "gp-grid" });
  for (const p of prompts) grid.appendChild(buildCard(p));
  container.appendChild(grid);
}
