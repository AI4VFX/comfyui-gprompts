"""Config + library-root resolution + server-side folder browsing.

The library root is chosen by the user on first run (never hardcoded), so the
node is distributable. Config lives in ComfyUI's user dir (per install), which
means two installs can point at the same folder to share one library.
"""

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
DEFAULT_EXTS = (".png", ".jpg", ".jpeg", ".webp")

PROMPT_EXT = ".txt"          # positive prompt text
NEG_EXT = ".neg.txt"         # negative prompt text
META_EXT = ".json"           # metadata + scan anchor
WORKFLOW_SUFFIX = ".workflow.json"   # full graph that produced the result
THUMB_SUFFIX = ".thumb.jpg"
REMOVED_SUFFIX = ".removed"
RESERVED_DIRS = {"defaults", ".trash"}

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
VIDEO_EXTS = (".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v")
AUDIO_EXTS = (".ogg", ".mp3", ".wav", ".flac", ".m4a", ".aac")


def _user_dir():
    """ComfyUI per-install user directory (where our config.json lives)."""
    try:
        import folder_paths
        getu = getattr(folder_paths, "get_user_directory", None)
        if callable(getu):
            return getu()
        base = getattr(folder_paths, "base_path", None)
        if base:
            return os.path.join(base, "user")
    except Exception:
        pass
    return os.path.join(os.path.expanduser("~"), ".comfyui-gprompts")


def _config_path():
    d = _user_dir()
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        pass
    return os.path.join(d, "gprompts_config.json")


_DEFAULT_CONFIG = {"root": None, "skipOverwriteWarning": False, "autoClose": False,
                   "captureShortcut": "Alt+Q"}
# Settings the client may set via /set_config (root is set via /set_root only).
SETTABLE_KEYS = ("skipOverwriteWarning", "autoClose", "captureShortcut")
_STRING_KEYS = ("captureShortcut",)


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


def set_root(path):
    """Validate, create if needed, and persist the chosen library root."""
    if not path or not os.path.isabs(path):
        raise ValueError("absolute path required")
    path = os.path.normpath(path)
    os.makedirs(path, exist_ok=True)
    os.makedirs(os.path.join(path, "defaults"), exist_ok=True)
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
            cfg[k] = str(patch[k]) if k in _STRING_KEYS else bool(patch[k])
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
    try:
        home = os.path.normpath(os.path.expanduser("~"))
        if os.path.isdir(home):
            shortcuts.append({"label": "Home", "path": home})
    except Exception:
        pass
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
