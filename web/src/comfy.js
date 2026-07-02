// Single place that reaches into ComfyUI's globals, so the relative path lives
// in exactly one file. Side-effect free (safe to be auto-imported).
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
export { app, api };
