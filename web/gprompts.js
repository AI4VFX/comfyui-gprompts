// G-Prompts entry — registers the sidebar tab, capture commands + keybindings,
// and starts the session output tracker. This is the only file that registers
// an extension; every src/*.js module is side-effect-free on import.
import { app } from "./src/comfy.js";
import { mountSidebar } from "./src/ui/sidebar.js";
import { captureWorkflow } from "./src/capture.js";
import { startOutputTracker } from "./src/outputs.js";
import { attachCanvasDrop } from "./src/canvasdrop.js";
import { attachShortcut } from "./src/shortcut.js";
import { refreshState, refreshLibrary } from "./src/data.js";
import { store } from "./src/store.js";
import { API } from "./src/api.js";

// Restore the remembered folder once library data is in (needs store.folders
// for validation). A vanished folder falls back to All and clears the config.
function restoreFolder() {
  if (!store.rememberFolder || store.savedFolder == null) return;
  const f = store.savedFolder;
  if (f === "" || store.folders.includes(f)) store.set({ currentFolder: f });
  else API.setConfig({ lastFolder: null }).catch(() => {});
}

app.registerExtension({
  name: "GPrompts",
  commands: [
    { id: "gprompts.capture", label: "G-Prompts: Capture", function: captureWorkflow },
  ],
  async setup() {
    startOutputTracker();
    attachCanvasDrop();
    attachShortcut();
    try { await refreshState(); await refreshLibrary(); restoreFolder(); } catch (e) { console.warn("[G-Prompts]", e); }
    try {
      app.extensionManager.registerSidebarTab({
        id: "gprompts",
        icon: "pi pi-images",
        title: "Prompts",   // sidebar button label only — node name stays "G-Prompts"
        tooltip: "G-Prompts — capture & reuse prompts",
        type: "custom",
        render: (el) => mountSidebar(el),
      });
    } catch (e) {
      console.error("[G-Prompts] sidebar tab registration failed", e);
    }
  },
});
