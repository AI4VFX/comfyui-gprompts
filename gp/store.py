"""The library store: scan folders, capture prompts, edit/move/remove/trash
(move into <root>/Trash — nothing is ever deleted from disk), and folder CRUD.
The filesystem under the chosen root IS the database.

One card = one prompt set: a positive (<name>.txt) and/or negative
(<name>.neg.txt), with metadata in <name>.json (the scan anchor).
"""

import asyncio
import json
import os
import re
import time

from . import assets as A
from . import config as C
from . import media as M

_LOCK = asyncio.Lock()

_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# The atomic rename/overwrite primitive used everywhere below, under one name.
_replace_file = os.replace


def _posix(p):
    """Path with forward slashes (library-relative paths are always POSIX-style)."""
    return (p or "").replace("\\", "/")


def _is_meta_file(fn):
    """A prompt anchor: <name>.json, but NOT hidden (.gp-tags.json),
    <name>.workflow.json, or *.removed."""
    return (fn.endswith(C.META_EXT) and not fn.startswith(".")
            and not fn.endswith(C.WORKFLOW_SUFFIX) and not fn.endswith(C.REMOVED_SUFFIX))


# ── path safety ─────────────────────────────────────────────────────────────

def _root():
    r = C.get_root()
    if not r:
        raise RuntimeError("library root not configured")
    return r


def _safe_dir(folder_rel):
    root = _root()
    folder_rel = _posix(folder_rel).strip().strip("/")
    abs_dir = os.path.normpath(os.path.join(root, folder_rel))
    if os.path.commonpath([abs_dir, root]) != root:
        raise ValueError("path escapes library root")
    top = folder_rel.split("/", 1)[0].lower() if folder_rel else ""
    if top in C.RESERVED_DIRS:
        raise ValueError("reserved folder")
    return abs_dir


def _safe_name(stem):
    """A client-supplied file stem must never contain a path separator, drive
    colon, or control char — otherwise `os.path.join(dir, stem + suffix)` could
    escape the library root (path traversal). Reject rather than silently strip
    so we never operate on the wrong file. `_INVALID` already covers / \\ : and
    control chars, which is exactly what's needed to block traversal."""
    stem = (stem or "").strip()
    if not stem or _INVALID.search(stem):
        raise ValueError("invalid name")
    return stem


def sanitize_name(title):
    name = _INVALID.sub("", (title or "").strip()).strip(" .")
    name = re.sub(r"\s+", " ", name)
    if len(name) > 60:
        name = name[:60].strip()
    return name or "prompt"


def _unique_stem(abs_dir, stem):
    if not os.path.exists(os.path.join(abs_dir, stem + C.META_EXT)):
        return stem
    i = 2
    while os.path.exists(os.path.join(abs_dir, "%s (%d)%s" % (stem, i, C.META_EXT))):
        i += 1
    return "%s (%d)" % (stem, i)


# ── reading ─────────────────────────────────────────────────────────────────

def _media_for_stem(abs_dir, stem):
    for ext in C.VIDEO_EXTS:
        if os.path.isfile(os.path.join(abs_dir, stem + ext)):
            return "video", ext.lstrip(".")
    for ext in C.AUDIO_EXTS:
        if os.path.isfile(os.path.join(abs_dir, stem + ext)):
            return "audio", ext.lstrip(".")
    for ext in C.IMAGE_EXTS:
        if os.path.isfile(os.path.join(abs_dir, stem + ext)):
            return "image", ext.lstrip(".")
    return "none", None


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip("\n")
    except OSError:
        return ""


def _read_prompt(folder_rel, abs_dir, stem):
    meta_path = os.path.join(abs_dir, stem + C.META_EXT)
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f) or {}
    except (OSError, ValueError):
        meta = {}
    positive = _read_text(os.path.join(abs_dir, stem + C.PROMPT_EXT))
    negative = _read_text(os.path.join(abs_dir, stem + C.NEG_EXT))
    media_kind, media_ext = _media_for_stem(abs_dir, stem)
    has_thumb = os.path.isfile(os.path.join(abs_dir, stem + C.THUMB_SUFFIX))
    has_workflow = os.path.isfile(os.path.join(abs_dir, stem + C.WORKFLOW_SUFFIX))
    has_assets = os.path.isfile(os.path.join(abs_dir, stem + C.ASSETS_SUFFIX))
    thumb_choice = meta.get("thumbChoice")
    if thumb_choice not in C.DEFAULT_CATEGORIES:
        thumb_choice = None
    try:
        created = meta.get("createdAt") or os.path.getmtime(meta_path)
    except OSError:
        created = time.time()
    # rev = newest mtime among the prompt's files → cache-buster that changes on
    # any overwrite/replace, so the browser re-fetches the thumbnail.
    rev = 0
    rev_paths = [meta_path]
    if has_thumb:
        rev_paths.append(os.path.join(abs_dir, stem + C.THUMB_SUFFIX))
    if media_ext:
        rev_paths.append(os.path.join(abs_dir, stem + "." + media_ext))
    for rp in rev_paths:
        try:
            rev = max(rev, int(os.path.getmtime(rp)))
        except OSError:
            pass
    return {
        "id": (folder_rel + "/" + stem) if folder_rel else stem,
        "folder": folder_rel,
        "name": stem,
        "title": meta.get("title") or stem,
        "positive": positive,
        "negative": negative,
        "tags": meta.get("tags", []) if isinstance(meta.get("tags"), list) else [],
        "source": meta.get("source", {}),
        "workflowType": meta.get("workflowType", "t2i"),
        "mediaKind": media_kind,
        "mediaExt": media_ext,
        "hasThumb": has_thumb,
        "hasWorkflow": has_workflow,
        "hasAssets": has_assets,
        "hideThumb": bool(meta.get("hideThumb")),
        "thumbChoice": thumb_choice,
        "createdAt": created,
        "rev": rev,
    }


def scan():
    root = _root()
    C.ensure_trash(root)
    folders, prompts = [], []
    trash_bytes = 0
    for cur, dirs, files in os.walk(root):
        rel = _posix(os.path.relpath(cur, root))
        if rel == ".":
            rel = ""
        dirs[:] = [d for d in dirs
                   if d.lower() not in C.RESERVED_DIRS and not d.startswith(".")]
        if rel:
            folders.append(rel)
        in_trash = rel == C.TRASH_DIR or rel.startswith(C.TRASH_DIR + "/")
        for fn in files:
            if in_trash:
                # size badge counts EVERY trashed file, incl. loose media
                try:
                    trash_bytes += os.path.getsize(os.path.join(cur, fn))
                except OSError:
                    pass
            if fn.startswith(".") or not _is_meta_file(fn):
                continue
            stem = fn[: -len(C.META_EXT)]
            p = _read_prompt(rel, cur, stem)
            if p:
                prompts.append(p)
    folders.sort(key=lambda s: s.lower())
    prompts.sort(key=lambda p: p["createdAt"], reverse=True)
    return {"root": root, "folders": folders, "prompts": prompts,
            "registry": load_registry(), "trashBytes": trash_bytes}


# ── tag registry (declared tags, incl. empty ones not yet on any prompt) ─────

def _registry_path():
    return os.path.join(_root(), ".gp-tags.json")


def load_registry():
    try:
        with open(_registry_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return [str(t) for t in data if str(t).strip()] if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_registry(tags):
    tags = sorted({t.strip() for t in tags if t and t.strip()}, key=str.lower)
    p = _registry_path()
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(tags, f, indent=2)
    _replace_file(tmp, p)


async def tag_create(name):
    async with _LOCK:
        reg = load_registry()
        if name and name.strip() and name.strip() not in reg:
            reg.append(name.strip())
            _save_registry(reg)
        return load_registry()


_NO_MATCH_NAMES = {"", "untitled", "unsaved workflow", "unsaved"}


def _find_match(abs_dir, source):
    """Existing prompt stem in abs_dir from the same source workflow, or None.
    Unsaved/untitled workflows never match (each capture is a new card)."""
    wf = (source or {}).get("workflowName")
    if not wf or wf.strip().lower() in _NO_MATCH_NAMES or not os.path.isdir(abs_dir):
        return None
    try:
        names = os.listdir(abs_dir)
    except OSError:
        return None
    for fn in names:
        if not _is_meta_file(fn):
            continue
        try:
            with open(os.path.join(abs_dir, fn), "r", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        if (meta.get("source", {}) or {}).get("workflowName") == wf:
            return fn[: -len(C.META_EXT)]
    return None


# ── ComfyUI output reference resolution ─────────────────────────────────────

def resolve_output_ref(ref):
    if not ref or not ref.get("filename"):
        return None
    import folder_paths
    typ = ref.get("type", "output")
    if typ == "temp":
        base = folder_paths.get_temp_directory()
    elif typ == "input":
        base = folder_paths.get_input_directory()
    else:
        base = folder_paths.get_output_directory()
    sub = _posix(ref.get("subfolder"))
    path = os.path.normpath(os.path.join(base, sub, ref["filename"]))
    base = os.path.normpath(base)
    if os.path.commonpath([path, base]) != base or not os.path.isfile(path):
        return None
    return path


# ── writing ─────────────────────────────────────────────────────────────────

def _write_text_file(path, text):
    if text and text.strip():
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        _replace_file(tmp, path)
    elif os.path.isfile(path):
        try:
            os.remove(path)
        except OSError:
            pass


def _write_record(abs_dir, stem, positive, negative, meta):
    mp = os.path.join(abs_dir, stem + C.META_EXT)
    tmp = mp + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    _replace_file(tmp, mp)
    _write_text_file(os.path.join(abs_dir, stem + C.PROMPT_EXT), positive)
    _write_text_file(os.path.join(abs_dir, stem + C.NEG_EXT), negative)


async def _apply_media(abs_dir, stem, ref):
    base = os.path.join(abs_dir, stem)
    M.clear_media(base)
    src = resolve_output_ref(ref)
    if not src:
        return
    kind = (ref or {}).get("kind", "image")
    try:
        if kind == "video":
            await M.process_video_file(src, base)
        elif kind == "audio":
            await M.process_audio_file(src, base)
        else:
            with open(src, "rb") as f:
                M.process_image_bytes(f.read(), base)
    except Exception as e:
        print("[G-Prompts] media processing failed:", e)


def _read_meta(abs_dir, stem):
    try:
        with open(os.path.join(abs_dir, stem + C.META_EXT), "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except (OSError, ValueError):
        return {}


def _refresh_assets(abs_dir, stem, wf, enabled):
    """Sync <stem>.assets.zip with the (re)captured workflow. The old zip is
    always dropped first so an overwrite never leaves stale assets behind; a
    failure here must never fail the capture itself."""
    zp = os.path.join(abs_dir, stem + C.ASSETS_SUFFIX)
    try:
        if os.path.isfile(zp):
            os.remove(zp)
        if enabled and wf:
            refs = A.collect_input_refs(wf)
            if refs:
                A.write_assets_zip(abs_dir, stem, refs)
            return len(refs)
    except Exception as e:
        print("[G-Prompts] asset capture failed:", e)
    return 0


async def capture_assets_now(folder_rel, name):
    """Retro-capture: rebuild the assets zip from the card's stored workflow."""
    async with _LOCK:
        name = _safe_name(name)
        abs_dir = _safe_dir(folder_rel)
        wfp = os.path.join(abs_dir, name + C.WORKFLOW_SUFFIX)
        try:
            with open(wfp, "r", encoding="utf-8") as f:
                wf = json.load(f)
        except (OSError, ValueError):
            raise ValueError("no stored workflow for this card")
        count = _refresh_assets(abs_dir, name, wf, enabled=True)
        return {"count": count, "prompt": _read_prompt(folder_rel, abs_dir, name)}


async def capture(items, skip_overwrite):
    """items: capture dicts {folder,title,positive,negative,workflowType,source,
    media,workflow,target,overwrite}. A `target` {folder,name} overwrites that
    exact card (preserving its title+tags); otherwise a new card is created.
    Returns {created:[...], conflicts:[...]}."""
    created, conflicts = [], []
    async with _LOCK:
        for idx, it in enumerate(items):
            positive = it.get("positive", "") or ""
            negative = it.get("negative", "") or ""
            if not positive.strip() and not negative.strip():
                continue
            source = it.get("source", {}) or {}
            overwrite = bool(it.get("overwrite"))
            target = it.get("target") if isinstance(it.get("target"), dict) else None

            if target and target.get("name"):
                folder_rel = target.get("folder") or ""
                try:
                    _deny_trash_dest(folder_rel)
                    abs_dir = _safe_dir(folder_rel)
                except (ValueError, RuntimeError) as e:
                    conflicts.append({"index": idx, "error": str(e)})
                    continue
                try:
                    stem = _safe_name(target["name"])
                except ValueError as e:
                    conflicts.append({"index": idx, "error": str(e)})
                    continue
                exists = os.path.isfile(os.path.join(abs_dir, stem + C.META_EXT))
                old = _read_meta(abs_dir, stem) if exists else {}
                if exists and not overwrite and not skip_overwrite:
                    conflicts.append({"index": idx, "existingName": stem,
                                      "title": old.get("title", stem)})
                    continue
                meta = {
                    "title": old.get("title") or it.get("title") or stem,
                    "tags": old.get("tags") if isinstance(old.get("tags"), list) else (it.get("tags") or []),
                    "source": source,
                    "workflowType": it.get("workflowType", "t2i"),
                    "createdAt": old.get("createdAt") or time.time(),
                }
                # Thumbnail prefs survive an overwrite (meta is rebuilt from scratch).
                for k in ("hideThumb", "thumbChoice"):
                    if old.get(k):
                        meta[k] = old[k]
            else:
                folder_rel = it.get("folder") or ""
                try:
                    _deny_trash_dest(folder_rel)
                    abs_dir = _safe_dir(folder_rel)
                except (ValueError, RuntimeError) as e:
                    conflicts.append({"index": idx, "error": str(e)})
                    continue
                stem = _unique_stem(abs_dir, sanitize_name(it.get("title")))
                meta = {
                    "title": it.get("title") or stem,
                    "tags": it.get("tags", []) or [],
                    "source": source,
                    "workflowType": it.get("workflowType", "t2i"),
                    "createdAt": time.time(),
                }

            os.makedirs(abs_dir, exist_ok=True)
            _write_record(abs_dir, stem, positive, negative, meta)
            wf = it.get("workflow")
            if wf:
                wfp = os.path.join(abs_dir, stem + C.WORKFLOW_SUFFIX)
                tmp = wfp + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(wf, f)
                _replace_file(tmp, wfp)
                _refresh_assets(abs_dir, stem, wf,
                                enabled=bool(C.load_config().get("captureAssets")))
            if it.get("media"):
                await _apply_media(abs_dir, stem, it.get("media"))
            p = _read_prompt(folder_rel, abs_dir, stem)
            if p:
                created.append(p)
    return {"created": created, "conflicts": conflicts}


def _stem_files(abs_dir, stem):
    stem = _safe_name(stem)
    out = []
    for suffix in (C.META_EXT, C.PROMPT_EXT, C.NEG_EXT, C.WORKFLOW_SUFFIX,
                   C.THUMB_SUFFIX, C.ASSETS_SUFFIX):
        p = os.path.join(abs_dir, stem + suffix)
        if os.path.isfile(p):
            out.append(p)
    for ext in C.IMAGE_EXTS + C.VIDEO_EXTS + C.AUDIO_EXTS:
        p = os.path.join(abs_dir, stem + ext)
        if os.path.isfile(p):
            out.append(p)
    return out


async def update_prompt(folder_rel, name, patch):
    async with _LOCK:
        name = _safe_name(name)
        abs_dir = _safe_dir(folder_rel)
        mp = os.path.join(abs_dir, name + C.META_EXT)
        try:
            with open(mp, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            meta = {}
        for k in ("title", "tags"):
            if k in patch:
                meta[k] = patch[k]
        # Thumbnail prefs: falsy/invalid values delete the key (keeps meta clean).
        if "hideThumb" in patch:
            if patch["hideThumb"]:
                meta["hideThumb"] = True
            else:
                meta.pop("hideThumb", None)
        if "thumbChoice" in patch:
            if patch["thumbChoice"] in C.DEFAULT_CATEGORIES:
                meta["thumbChoice"] = patch["thumbChoice"]
            else:
                meta.pop("thumbChoice", None)
        new_stem = name
        if "title" in patch:
            desired = sanitize_name(patch["title"])
            if desired and desired != name:
                new_stem = _unique_stem(abs_dir, desired)
                for p in _stem_files(abs_dir, name):
                    suffix = os.path.basename(p)[len(name):]
                    _replace_file(p, os.path.join(abs_dir, new_stem + suffix))
        tmp = os.path.join(abs_dir, new_stem + C.META_EXT) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        _replace_file(tmp, os.path.join(abs_dir, new_stem + C.META_EXT))
        # text edits (positive / negative) when provided
        if "positive" in patch:
            _write_text_file(os.path.join(abs_dir, new_stem + C.PROMPT_EXT), patch["positive"])
        if "negative" in patch:
            _write_text_file(os.path.join(abs_dir, new_stem + C.NEG_EXT), patch["negative"])
        return _read_prompt(folder_rel, abs_dir, new_stem)


async def set_media(folder_rel, name, data_url, kind):
    async with _LOCK:
        name = _safe_name(name)
        abs_dir = _safe_dir(folder_rel)
        base = os.path.join(abs_dir, name)
        raw = M.decode_data_url(data_url)
        if raw is None:
            raise ValueError("no data")
        if kind in ("video", "audio"):
            tmp = base + ".srcupload"
            with open(tmp, "wb") as f:
                f.write(raw)
            try:
                M.clear_media(base)
                if kind == "video":
                    await M.process_video_file(tmp, base)
                else:
                    await M.process_audio_file(tmp, base)
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        else:
            M.clear_media(base)
            M.process_image_bytes(raw, base)
        return _read_prompt(folder_rel, abs_dir, name)


async def move_prompt(folder_rel, name, to_folder):
    async with _LOCK:
        name = _safe_name(name)
        _deny_trash_dest(to_folder)  # moving OUT of Trash (restore) is fine
        src_dir = _safe_dir(folder_rel)
        dst_dir = _safe_dir(to_folder)
        os.makedirs(dst_dir, exist_ok=True)
        stem = _unique_stem(dst_dir, name)
        for p in _stem_files(src_dir, name):
            suffix = os.path.basename(p)[len(name):]
            _replace_file(p, os.path.join(dst_dir, stem + suffix))
        return _read_prompt(to_folder, dst_dir, stem)


async def remove_prompt(folder_rel, name):
    async with _LOCK:
        abs_dir = _safe_dir(folder_rel)
        for p in _stem_files(abs_dir, name):
            try:
                _replace_file(p, p + C.REMOVED_SUFFIX)
            except OSError:
                pass
        return True


async def delete_prompt(folder_rel, name):
    """Move a card's files into <root>/Trash (mirrored path). Restore = /move back."""
    async with _LOCK:
        name = _safe_name(name)
        if _in_trash(folder_rel):
            raise ValueError("already in Trash")
        abs_dir = _safe_dir(folder_rel)
        _move_files_to_trash(_stem_files(abs_dir, name), folder_rel, name)
        return True


def _media_files(abs_dir, stem):
    stem = _safe_name(stem)
    out = []
    th = os.path.join(abs_dir, stem + C.THUMB_SUFFIX)
    if os.path.isfile(th):
        out.append(th)
    for ext in C.IMAGE_EXTS + C.VIDEO_EXTS + C.AUDIO_EXTS:
        p = os.path.join(abs_dir, stem + ext)
        if os.path.isfile(p):
            out.append(p)
    return out


async def copy_prompt(folder_rel, name, to_folder=None):
    """Duplicate a prompt (same folder) or copy into another folder."""
    import shutil
    async with _LOCK:
        _deny_trash_dest(to_folder if to_folder is not None else folder_rel)
        src_dir = _safe_dir(folder_rel)
        dst_dir = _safe_dir(to_folder if to_folder is not None else folder_rel)
        os.makedirs(dst_dir, exist_ok=True)
        same = os.path.normpath(src_dir) == os.path.normpath(dst_dir)
        base = name + " copy" if same else name
        stem = _unique_stem(dst_dir, sanitize_name(base))
        for p in _stem_files(src_dir, name):
            suffix = os.path.basename(p)[len(name):]
            shutil.copy2(p, os.path.join(dst_dir, stem + suffix))
        rel = _posix(os.path.relpath(dst_dir, _root()))
        return _read_prompt("" if rel == "." else rel, dst_dir, stem)


async def thumb_remove(folder_rel, name):
    """Soft-remove only the media + poster (keep text/meta)."""
    async with _LOCK:
        abs_dir = _safe_dir(folder_rel)
        for p in _media_files(abs_dir, name):
            try:
                _replace_file(p, p + C.REMOVED_SUFFIX)
            except OSError:
                pass
        return _read_prompt(folder_rel, abs_dir, name)


async def thumb_delete(folder_rel, name):
    """Move only the card's media + poster into Trash (text/meta stay)."""
    async with _LOCK:
        name = _safe_name(name)
        if _in_trash(folder_rel):
            raise ValueError("already in Trash")
        abs_dir = _safe_dir(folder_rel)
        _move_files_to_trash(_media_files(abs_dir, name), folder_rel, name)
        return _read_prompt(folder_rel, abs_dir, name)


async def pack(items):
    """Zip each card's files. Single -> <stem>.zip beside it; multiple -> one
    combined zip in the root. Returns the zip path (the frontend copies it to
    the clipboard and shows it in a toast)."""
    import zipfile
    async with _LOCK:
        root = _root()
        if not items:
            raise ValueError("nothing to pack")
        include_assets = bool(C.load_config().get("packIncludeAssets", True))

        def _pack_files(abs_dir, stem):
            return [p for p in _stem_files(abs_dir, stem)
                    if include_assets or not p.endswith(C.ASSETS_SUFFIX)]

        if len(items) == 1:
            it = items[0]
            abs_dir = _safe_dir(it.get("folder", ""))
            stem = it["name"]
            zip_path = os.path.join(abs_dir, stem + ".zip")
            zip_path = _unique_path(zip_path)
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
                for p in _pack_files(abs_dir, stem):
                    z.write(p, os.path.basename(p))
        else:
            zip_path = _unique_path(os.path.join(root, "G-Prompts Pack.zip"))
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
                for it in items:
                    abs_dir = _safe_dir(it.get("folder", ""))
                    stem = it["name"]
                    arc = (it.get("folder") or "_unfiled").replace("/", "_")
                    for p in _pack_files(abs_dir, stem):
                        z.write(p, os.path.join(arc, os.path.basename(p)))
        return zip_path


def _unique_path(path):
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    i = 2
    while os.path.exists("%s (%d)%s" % (base, i, ext)):
        i += 1
    return "%s (%d)%s" % (base, i, ext)


async def _rewrite_all_metas(transform):
    """Apply transform(meta)->meta|None to every prompt's .json across the root.
    Returns the number changed."""
    root = _root()
    changed = 0
    for cur, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d.lower() not in C.RESERVED_DIRS and not d.startswith(".")]
        for fn in files:
            if not _is_meta_file(fn):
                continue
            mp = os.path.join(cur, fn)
            try:
                with open(mp, "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except (OSError, ValueError):
                continue
            new = transform(dict(meta))
            if new is not None and new != meta:
                tmp = mp + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(new, f, indent=2)
                _replace_file(tmp, mp)
                changed += 1
    return changed


async def tag_rename(old, new):
    def tx(meta):
        tags = meta.get("tags", []) or []
        if old not in tags:
            return None
        out, seen = [], set()
        for t in tags:
            t2 = new if t == old else t
            if t2 not in seen:
                seen.add(t2)
                out.append(t2)
        meta["tags"] = out
        return meta
    async with _LOCK:
        n = await _rewrite_all_metas(tx)
        reg = load_registry()
        if old in reg:
            _save_registry([new if t == old else t for t in reg])
        return n


async def tag_delete(tag):
    def tx(meta):
        tags = meta.get("tags", []) or []
        if tag not in tags:
            return None
        meta["tags"] = [t for t in tags if t != tag]
        return meta
    async with _LOCK:
        n = await _rewrite_all_metas(tx)
        reg = load_registry()
        if tag in reg:
            _save_registry([t for t in reg if t != tag])
        return n


# ── folders ─────────────────────────────────────────────────────────────────

async def folder_create(parent, name):
    async with _LOCK:
        name = sanitize_name(name)
        rel = (parent + "/" + name) if parent else name
        _deny_trash_dest(rel)  # also blocks creating a root "trash" (any case)
        abs_dir = _safe_dir(rel)
        os.makedirs(abs_dir, exist_ok=True)
        return _posix(os.path.relpath(abs_dir, _root()))


async def folder_rename(folder_rel, new_name):
    async with _LOCK:
        if _in_trash(folder_rel):
            raise ValueError("Trash cannot be renamed")
        abs_dir = _safe_dir(folder_rel)
        parent = os.path.dirname(abs_dir)
        new_abs = os.path.join(parent, sanitize_name(new_name))
        _deny_trash_dest(_rel(new_abs))  # blocks renaming a folder to "Trash"
        _replace_file(abs_dir, new_abs)
        return _posix(os.path.relpath(new_abs, _root()))


async def folder_delete(folder_rel):
    """Move a folder (and contents) into <root>/Trash under its parent's path."""
    async with _LOCK:
        if _in_trash(folder_rel):
            raise ValueError("Trash cannot be deleted")
        abs_dir = _safe_dir(folder_rel)
        if abs_dir == _root():
            raise ValueError("cannot delete root")
        parent_rel = _rel(os.path.dirname(abs_dir))
        dst_parent = os.path.join(_root(), C.TRASH_DIR, parent_rel) if parent_rel \
            else os.path.join(_root(), C.TRASH_DIR)
        os.makedirs(dst_parent, exist_ok=True)
        dst = _unique_dir(os.path.join(dst_parent, os.path.basename(abs_dir)))
        _replace_file(abs_dir, dst)
        return True


def _unique_dir(path):
    if not os.path.exists(path):
        return path
    i = 2
    while os.path.exists("%s (%d)" % (path, i)):
        i += 1
    return "%s (%d)" % (path, i)


def _rel(abs_dir):
    r = _posix(os.path.relpath(abs_dir, _root()))
    return "" if r == "." else r


async def folder_move(folder_rel, to_parent):
    """Move a folder (and all its contents) into another folder ('' = root)."""
    async with _LOCK:
        if _in_trash(folder_rel):
            raise ValueError("Trash cannot be moved")
        _deny_trash_dest(to_parent or "")
        src = _safe_dir(folder_rel)
        if src == _root():
            raise ValueError("cannot move root")
        dst_parent = _safe_dir(to_parent or "")
        dst = os.path.normpath(os.path.join(dst_parent, os.path.basename(src)))
        sp = os.path.normpath(src)
        if dst == sp or dst.startswith(sp + os.sep):
            raise ValueError("cannot move a folder into itself")
        dst = _unique_dir(dst)
        _replace_file(src, dst)
        return _rel(dst)


async def folder_copy(folder_rel, to_parent):
    """Copy a folder (and all its contents) into another folder ('' = root)."""
    import shutil
    async with _LOCK:
        if _in_trash(folder_rel):
            raise ValueError("Trash cannot be copied")
        _deny_trash_dest(to_parent or "")
        src = _safe_dir(folder_rel)
        if src == _root():
            raise ValueError("cannot copy root")
        dst_parent = _safe_dir(to_parent or "")
        dst = _unique_dir(os.path.join(dst_parent, os.path.basename(src)))
        shutil.copytree(src, dst)
        return _rel(dst)


def folder_pack_items(folder_rel):
    """[{folder,name}] for every prompt under a folder (for packing)."""
    items = []
    abs_dir = _safe_dir(folder_rel)
    for cur, dirs, files in os.walk(abs_dir):
        dirs[:] = [d for d in dirs if d.lower() not in C.RESERVED_DIRS and not d.startswith(".")]
        rel = _rel(cur)
        for fn in files:
            if _is_meta_file(fn):
                items.append({"folder": rel, "name": fn[: -len(C.META_EXT)]})
    return items


# ── Trash ───────────────────────────────────────────────────────────────────
# "Delete" never deletes: files MOVE into <root>/Trash, mirroring their
# original folder path so Restore is just the reverse move. The app ships no
# deletion primitives — the user empties <root>/Trash manually in Explorer.

def _in_trash(folder_rel):
    top = _posix(folder_rel).strip().strip("/").split("/", 1)[0]
    return top.lower() == C.TRASH_DIR.lower()


def _deny_trash_dest(folder_rel):
    if _in_trash(folder_rel):
        raise ValueError("Trash is managed via Move to Trash / Restore")


def _move_files_to_trash(src_files, folder_rel, stem):
    if not src_files:
        return
    sub = _posix(folder_rel).strip().strip("/")
    dst_dir = os.path.join(_root(), C.TRASH_DIR, sub) if sub \
        else os.path.join(_root(), C.TRASH_DIR)
    os.makedirs(dst_dir, exist_ok=True)
    suffixes = [os.path.basename(p)[len(stem):] for p in src_files]
    # os.replace clobbers, so the stem must be free for EVERY incoming suffix
    # (plus the meta a previous trashing of the same stem may have left here).
    cand, i = stem, 2
    while any(os.path.exists(os.path.join(dst_dir, cand + s))
              for s in suffixes + [C.META_EXT]):
        cand = "%s (%d)" % (stem, i)
        i += 1
    for p, s in zip(src_files, suffixes):
        _replace_file(p, os.path.join(dst_dir, cand + s))
