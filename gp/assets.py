"""Input-asset capture: find the media files a workflow loads from ComfyUI's
input directory and zip them beside the card (<name>.assets.zip).

Detection is heuristic by design: any string widget value that resolves to an
existing media file inside the input directory counts. Extension whitelist +
containment guard keep it to input media only (never LoRAs/models, never a
path outside the input dir).
"""

import os
import re
import shutil
import zipfile
import zlib

from . import config as C

# "flower.png [input]" style annotations some widgets carry.
_ANNOT = re.compile(r"\s*\[(input|temp|output)\]\s*$")
_MEDIA_EXTS = tuple(e.lower() for e in C.IMAGE_EXTS + C.VIDEO_EXTS + C.AUDIO_EXTS)


def _iter_widget_strings(workflow):
    for node in (workflow or {}).get("nodes", []) or []:
        wv = node.get("widgets_values")
        if isinstance(wv, dict):
            vals = wv.values()
        elif isinstance(wv, (list, tuple)):
            vals = wv
        else:
            continue
        for v in vals:
            if isinstance(v, str) and v.strip():
                yield v.strip()


def collect_input_refs(workflow):
    """[(abs_path, arcname)] for every input-dir media file the graph references."""
    import folder_paths
    input_dir = os.path.normpath(folder_paths.get_input_directory())
    seen, refs = set(), []
    for raw in _iter_widget_strings(workflow):
        m = _ANNOT.search(raw)
        if m:
            if m.group(1) != "input":
                continue            # explicitly temp/output — not ours
            raw = raw[: m.start()]
        rel = raw.strip().replace("\\", "/").strip("/")
        if not rel or not rel.lower().endswith(_MEDIA_EXTS):
            continue
        p = os.path.normpath(os.path.join(input_dir, rel))
        try:
            if os.path.commonpath([p, input_dir]) != input_dir:
                continue            # escapes the input dir
        except ValueError:
            continue                # different drive
        if not os.path.isfile(p) or p in seen:
            continue
        seen.add(p)
        refs.append((p, os.path.relpath(p, input_dir).replace("\\", "/")))
    return refs


def write_assets_zip(abs_dir, stem, refs):
    """Write <stem>.assets.zip atomically. Returns the zip path."""
    zp = os.path.join(abs_dir, stem + C.ASSETS_SUFFIX)
    tmp = zp + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for p, arc in refs:
            z.write(p, arc)
    os.replace(tmp, zp)
    return zp


def _file_crc(path):
    crc = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            crc = zlib.crc32(chunk, crc)
    return crc & 0xFFFFFFFF


def restore_missing(abs_dir, stem):
    """Copy the card's captured input assets back into ComfyUI's input directory
    where they are missing. An existing file is NEVER overwritten: identical
    ones are skipped, different ones are reported in "differ"."""
    import folder_paths
    out = {"hasZip": False, "restored": [], "differ": [], "present": 0}
    zp = os.path.join(abs_dir, stem + C.ASSETS_SUFFIX)
    if not os.path.isfile(zp):
        return out
    out["hasZip"] = True
    input_dir = os.path.normpath(folder_paths.get_input_directory())
    with zipfile.ZipFile(zp, "r") as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            rel = info.filename.strip("/")
            if not rel or not rel.lower().endswith(_MEDIA_EXTS):
                continue            # media only, same whitelist as capture
            dst = os.path.normpath(os.path.join(input_dir, rel))
            try:
                if os.path.commonpath([dst, input_dir]) != input_dir:
                    continue        # would land outside the input dir
            except ValueError:
                continue            # different drive
            if os.path.exists(dst):
                same = (os.path.isfile(dst) and os.path.getsize(dst) == info.file_size
                        and _file_crc(dst) == info.CRC)
                if same:
                    out["present"] += 1
                else:
                    out["differ"].append(rel)
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            tmp = dst + ".gptmp"
            with z.open(info) as src, open(tmp, "wb") as f:
                shutil.copyfileobj(src, f)
            os.rename(tmp, dst)
            out["restored"].append(rel)
    return out
