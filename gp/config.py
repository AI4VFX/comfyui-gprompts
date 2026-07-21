"""Config + library-root resolution + server-side folder browsing.

The library root is chosen by the user on first run (never hardcoded), so the
node is distributable. Config lives in ComfyUI's user dir (per install), which
means two installs can point at the same folder to share one library.
"""

import contextlib
import json
import os
import stat

# ── Tunables (card poster + media re-encode targets) ────────────────────────
THUMB_W = 800
THUMB_H = 450
THUMB_JPEG_QUALITY = 82      # poster quality
IMAGE_JPEG_QUALITY = 80      # full-res stored image quality
VIDEO_W = 800
VIDEO_H = 450
VIDEO_MAX_BYTES = 4 * 1024 * 1024   # 4 MB ceiling for stored video
THUMB_FILL = (32, 34, 40)    # letterbox/flatten background

# Default thumbnails: 4 categories, files <root>/defaults/Generic-<Category>.<ext>
# (Image / Video / Audio / Other) — mapped from the detected workflow type.
TYPE_TO_CATEGORY = {
    "t2i": "Image", "i2i": "Image",
    "t2v": "Video", "v2v": "Video",
    "audio": "Audio",
    "editing": "Other",
}
DEFAULT_CATEGORIES = ("Image", "Video", "Audio", "Other")
DEFAULT_EXTS = (".png", ".jpg", ".jpeg", ".webp")

PROMPT_EXT = ".txt"          # positive prompt text
NEG_EXT = ".neg.txt"         # negative prompt text
META_EXT = ".json"           # metadata + scan anchor
WORKFLOW_SUFFIX = ".workflow.json"   # full graph that produced the result
THUMB_SUFFIX = ".thumb.jpg"
ASSETS_SUFFIX = ".assets.zip"        # input media referenced by the workflow
REMOVED_SUFFIX = ".removed"
RESERVED_DIRS = {"defaults", ".trash"}
# Library-level Trash folder: "deleted" cards are MOVED here (mirroring their
# original path) and the user empties it manually — the app never deletes.
# Deliberately NOT in RESERVED_DIRS: trashed cards must stay scannable so the
# Trash view can browse/restore them and serve their thumbnails.
TRASH_DIR = "Trash"

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
VIDEO_EXTS = (".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v")
AUDIO_EXTS = (".ogg", ".mp3", ".wav", ".flac", ".m4a", ".aac")


def _user_dir():
    """ComfyUI per-install user directory (where our config.json lives)."""
    with contextlib.suppress(Exception):
        import folder_paths
        getu = getattr(folder_paths, "get_user_directory", None)
        if callable(getu):
            return getu()
        base = getattr(folder_paths, "base_path", None)
        if base:
            return os.path.join(base, "user")
    return os.path.join(os.path.expanduser("~"), ".comfyui-gprompts")


def _config_path():
    d = _user_dir()
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        pass
    return os.path.join(d, "gprompts_config.json")


_DEFAULT_CONFIG = {"root": None, "skipOverwriteWarning": False, "autoClose": False,
                   "captureShortcut": "Alt+Q",
                   "rememberFolder": True, "lastFolder": None,
                   "captureAssets": False, "packIncludeAssets": True,
                   "packToastSeconds": 2}
# Settings the client may set via /set_config (root is set via /set_root only).
SETTABLE_KEYS = ("skipOverwriteWarning", "autoClose", "captureShortcut",
                 "rememberFolder", "lastFolder", "captureAssets", "packIncludeAssets",
                 "packToastSeconds")
_STRING_KEYS = ("captureShortcut",)
# lastFolder: None = "All", "" = library root, "Foo/Bar" = a folder — the None
# must survive the round-trip, so it gets nullable-string coercion.
_NULLABLE_STRING_KEYS = ("lastFolder",)
_NUMBER_KEYS = ("packToastSeconds",)   # clamped ints


def load_config():
    p = _config_path()
    cfg = dict(_DEFAULT_CONFIG)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            cfg.update({k: data.get(k, cfg[k]) for k in cfg})
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg):
    p = _config_path()
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, p)


def get_root():
    """Absolute library root, or None when unconfigured."""
    root = load_config().get("root")
    if root and os.path.isabs(root):
        return os.path.normpath(root)
    return None


def is_configured():
    root = get_root()
    return bool(root) and os.path.isdir(root)


def suggested_default_root():
    """A sensible starting point for the first-run picker (user can change)."""
    home = os.path.expanduser("~")
    docs = os.path.join(home, "Documents")
    base = docs if os.path.isdir(docs) else home
    return os.path.join(base, "G-Prompts")


def ensure_trash(root):
    """Make sure <root>/Trash exists, adopting an existing trash/TRASH dir by
    case-renaming it (best effort — a failure just leaves it as-is)."""
    try:
        for name in os.listdir(root):
            if name.lower() == TRASH_DIR.lower() and os.path.isdir(os.path.join(root, name)):
                if name != TRASH_DIR:
                    try:
                        os.rename(os.path.join(root, name), os.path.join(root, TRASH_DIR))
                    except OSError:
                        pass
                return
        os.makedirs(os.path.join(root, TRASH_DIR), exist_ok=True)
    except OSError:
        pass


def set_root(path):
    """Validate, create if needed, and persist the chosen library root."""
    if not path or not os.path.isabs(path):
        raise ValueError("absolute path required")
    path = os.path.normpath(path)
    os.makedirs(path, exist_ok=True)
    os.makedirs(os.path.join(path, "defaults"), exist_ok=True)
    ensure_trash(path)
    if not os.path.isdir(path):
        raise ValueError("not a directory")
    cfg = load_config()
    cfg["root"] = path
    save_config(cfg)
    return path


def set_skip_overwrite(value):
    cfg = load_config()
    cfg["skipOverwriteWarning"] = bool(value)
    save_config(cfg)
    return cfg["skipOverwriteWarning"]


def update_settings(patch):
    """Apply any SETTABLE_KEYS from patch and persist. Returns the full config."""
    cfg = load_config()
    for k in SETTABLE_KEYS:
        if k in patch:
            if k in _NULLABLE_STRING_KEYS:
                cfg[k] = None if patch[k] is None else str(patch[k])
            elif k in _STRING_KEYS:
                cfg[k] = str(patch[k])
            elif k in _NUMBER_KEYS:
                try:
                    cfg[k] = min(15, max(1, int(float(patch[k]))))
                except (TypeError, ValueError):
                    cfg[k] = _DEFAULT_CONFIG[k]
            else:
                cfg[k] = bool(patch[k])
    save_config(cfg)
    return cfg


# ── Server-side folder browser (for the first-run / change-root picker) ─────

def fs_roots():
    drives = []
    if os.name == "nt":
        for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            d = c + ":\\"
            try:
                if os.path.exists(d):
                    drives.append({"label": d, "path": d})
            except OSError:
                pass
    else:
        drives.append({"label": "/", "path": "/"})
    shortcuts = []
    with contextlib.suppress(Exception):
        home = os.path.normpath(os.path.expanduser("~"))
        if os.path.isdir(home):
            shortcuts.append({"label": "Home", "path": home})
    shortcuts.append({"label": "Suggested", "path": suggested_default_root()})
    return {"drives": drives, "shortcuts": shortcuts}


def fs_list(raw):
    """Folder-only listing of an arbitrary absolute path (for choosing a root)."""
    if not raw or not os.path.isabs(raw):
        return {"error": "absolute path required", "path": raw or "", "parent": None,
                "entries": []}
    path = os.path.normpath(raw)
    parent = os.path.dirname(path)
    if not parent or parent == path:
        parent = None
    try:
        entries = []
        with os.scandir(path) as it:
            for e in it:
                try:
                    if not e.is_dir():
                        continue
                except OSError:
                    continue
                hidden = e.name.startswith(".")
                try:
                    attrs = e.stat(follow_symlinks=False).st_file_attributes
                    if attrs & (stat.FILE_ATTRIBUTE_HIDDEN | stat.FILE_ATTRIBUTE_SYSTEM):
                        hidden = True
                except (OSError, AttributeError):
                    pass
                entries.append({"name": e.name, "path": os.path.join(path, e.name),
                                "hidden": hidden})
                if len(entries) >= 5000:
                    break
        entries.sort(key=lambda x: x["name"].lower())
        return {"path": path, "parent": parent, "entries": entries}
    except PermissionError:
        return {"error": "permission denied", "path": path, "parent": parent, "entries": []}
    except (FileNotFoundError, NotADirectoryError):
        return {"error": "folder not found", "path": path, "parent": parent, "entries": []}
    except OSError as e:
        return {"error": str(e), "path": path, "parent": parent, "entries": []}
