// Thin wrappers over the /gprompts backend routes.
const BASE = "/gprompts";

async function jget(path) {
  // no-store: the library/state/fs endpoints are dynamic — never let the
  // browser serve a stale cached copy (e.g. a just-captured card missing after
  // refreshLibrary). Media <img>/<video> URLs are cache-busted separately by rev.
  const r = await fetch(BASE + path, { cache: "no-store" });
  return r.json();
}
async function jpost(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

export const API = {
  state: () => jget("/state"),
  fsRoots: () => jget("/fs_roots"),
  fsList: (path) => jget("/fs_list?path=" + encodeURIComponent(path)),
  setRoot: (path) => jpost("/set_root", { path }),
  setConfig: (patch) => jpost("/set_config", patch),
  library: () => jget("/library"),
  capture: (prompts) => jpost("/capture", { prompts }),
  updatePrompt: (folder, name, patch) => jpost("/update_prompt", { folder, name, patch }),
  move: (folder, name, toFolder) => jpost("/move", { folder, name, toFolder }),
  setMedia: (folder, name, dataUrl, kind) => jpost("/set_media", { folder, name, dataUrl, kind }),
  remove: (folder, name) => jpost("/remove", { folder, name }),
  del: (folder, name) => jpost("/delete", { folder, name, confirm: true }),
  copy: (folder, name, toFolder) => jpost("/copy", { folder, name, toFolder }),
  thumbRemove: (folder, name) => jpost("/thumb_remove", { folder, name }),
  thumbDelete: (folder, name) => jpost("/thumb_delete", { folder, name }),
  pack: (items) => jpost("/pack", { items }),
  tagRename: (oldName, newName) => jpost("/tag_rename", { old: oldName, new: newName }),
  tagDelete: (tag) => jpost("/tag_delete", { tag }),
  tagCreate: (name) => jpost("/tag_create", { name }),
  folderCreate: (parent, name) => jpost("/folder_create", { parent, name }),
  folderRename: (folder, name) => jpost("/folder_rename", { folder, name }),
  folderDelete: (folder) => jpost("/folder_delete", { folder, confirm: true }),
  folderMove: (folder, toParent) => jpost("/folder_move", { folder, toParent }),
  folderCopy: (folder, toParent) => jpost("/folder_copy", { folder, toParent }),
  folderPack: (folder) => jpost("/folder_pack", { folder }),
  workflow: (folder, name) => jget("/workflow?" + q({ folder, name })),
};

// URLs for <img>/<video>/<audio> src. Cache-busted by mtime where it matters.
const q = (o) => Object.entries(o).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
// `rev` (newest file mtime) busts the browser cache whenever the media changes.
export const posterUrl = (p) =>
  p.hasThumb
    ? BASE + "/poster?" + q({ folder: p.folder, name: p.name }) + "&t=" + (p.rev || 0)
    : BASE + "/default_thumb?type=" + encodeURIComponent(p.workflowType || "t2i");
export const mediaUrl = (p) =>
  BASE + "/media?" + q({ folder: p.folder, name: p.name }) + "&t=" + (p.rev || 0);
