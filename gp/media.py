"""Result-media processing: store the generated image/video/audio for a prompt
and build an 800x450 card poster. Images via PIL, video/audio via ffmpeg.
"""

import asyncio
import base64
import io
import os
import shutil

from . import config as C

# ── shared image helpers ────────────────────────────────────────────────────

def _cover_poster(src_img):
    """PIL image -> 800x450 cover-cropped RGB poster (JPEG bytes)."""
    from PIL import Image, ImageOps
    src = ImageOps.exif_transpose(src_img).convert("RGBA")
    bg = Image.new("RGBA", src.size, C.THUMB_FILL + (255,))
    src = Image.alpha_composite(bg, src).convert("RGB")
    w, h = src.size
    scale = max(C.THUMB_W / w, C.THUMB_H / h)
    new = (max(1, round(w * scale)), max(1, round(h * scale)))
    src = src.resize(new, Image.LANCZOS)
    left = (new[0] - C.THUMB_W) // 2
    top = (new[1] - C.THUMB_H) // 2
    src = src.crop((left, top, left + C.THUMB_W, top + C.THUMB_H))
    out = io.BytesIO()
    src.save(out, format="JPEG", quality=C.THUMB_JPEG_QUALITY, optimize=True)
    return out.getvalue()


def _write_poster_from_image(pil_img, base_path):
    with open(base_path + C.THUMB_SUFFIX + ".tmp", "wb") as f:
        f.write(_cover_poster(pil_img))
    os.replace(base_path + C.THUMB_SUFFIX + ".tmp", base_path + C.THUMB_SUFFIX)


def decode_data_url(data_url):
    if not data_url:
        return None
    raw = data_url.split(",", 1)[1] if "," in data_url else data_url
    return base64.b64decode(raw)


# ── ffmpeg ──────────────────────────────────────────────────────────────────
_FFMPEG = None


def ffmpeg_exe():
    global _FFMPEG
    if _FFMPEG:
        return _FFMPEG
    cand = shutil.which("ffmpeg")
    if not cand:
        for p in ("/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"):
            if os.path.isfile(p):
                cand = p
                break
    _FFMPEG = cand
    return cand


async def _run_ffmpeg(args):
    exe = ffmpeg_exe()
    if not exe:
        raise RuntimeError("ffmpeg not found (install it / add to PATH)")
    proc = await asyncio.create_subprocess_exec(
        exe, "-hide_banner", "-loglevel", "error", "-y", *args,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _out, err = await proc.communicate()
    if proc.returncode != 0:
        msg = (err or b"").decode("utf-8", "replace").strip()
        raise RuntimeError("ffmpeg error: " + (msg[-400:] if msg else "exit %d" % proc.returncode))


# The played clip PRESERVES the source aspect (fits inside a 960 box, even dims),
# so a 9:16 portrait video plays portrait in the preview.
_VFILTER_VIDEO = "scale='min(960,iw)':'min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
# The poster (card thumbnail) is always 16:9 cover-cropped so the grid stays unified.
_VFILTER_POSTER = (
    "scale=w=%d:h=%d:force_original_aspect_ratio=increase,crop=%d:%d"
    % (C.THUMB_W, C.THUMB_H, C.THUMB_W, C.THUMB_H)
)


# ── public: process a result file into the prompt's sidecars ────────────────

def process_image_bytes(raw, base_path):
    """Store full-res image at 80% JPEG (<base>.jpg) + 800x450 poster."""
    from PIL import Image, ImageOps
    src = Image.open(io.BytesIO(raw))
    src = ImageOps.exif_transpose(src)
    rgb = src.convert("RGB")
    out_path = base_path + ".jpg"
    tmp = out_path + ".tmp"
    rgb.save(tmp, format="JPEG", quality=C.IMAGE_JPEG_QUALITY, optimize=True)
    os.replace(tmp, out_path)
    _write_poster_from_image(src, base_path)
    return {"mediaKind": "image", "mediaExt": "jpg", "hasThumb": True}


async def process_video_file(src_path, base_path):
    """Re-encode preserving aspect (<4MB), mp4 (<base>.mp4) + 16:9 frame-1 poster."""
    out_path = base_path + ".mp4"
    tmp = out_path + ".tmp.mp4"
    # Two-pass-ish single shot: CRF 30 + capped bitrate keeps small clips tiny
    # and long clips under the ceiling without a probe.
    await _run_ffmpeg([
        "-i", src_path,
        "-vf", _VFILTER_VIDEO,
        "-c:v", "libx264", "-preset", "medium", "-crf", "30",
        "-maxrate", "2M", "-bufsize", "4M",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "96k", "-ac", "2",  # keep audio (compressed)
        tmp,
    ])
    # If still over the ceiling, re-encode harder.
    try:
        if os.path.getsize(tmp) > C.VIDEO_MAX_BYTES:
            tmp2 = out_path + ".tmp2.mp4"
            await _run_ffmpeg([
                "-i", src_path, "-vf", _VFILTER_VIDEO,
                "-c:v", "libx264", "-preset", "medium", "-crf", "34",
                "-maxrate", "1M", "-bufsize", "2M",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                "-c:a", "aac", "-b:a", "64k", "-ac", "2", tmp2,
            ])
            os.replace(tmp2, tmp)
    except OSError:
        pass
    os.replace(tmp, out_path)
    # frame-1 poster — 16:9 cover-crop (from the SOURCE, at full quality)
    poster_tmp = base_path + C.THUMB_SUFFIX + ".tmp.jpg"
    try:
        await _run_ffmpeg([
            "-i", src_path, "-vf", _VFILTER_POSTER,
            "-frames:v", "1", "-q:v", "3", poster_tmp,
        ])
        os.replace(poster_tmp, base_path + C.THUMB_SUFFIX)
        has_thumb = True
    except Exception:
        has_thumb = False
    return {"mediaKind": "video", "mediaExt": "mp4", "hasThumb": has_thumb}


async def process_audio_file(src_path, base_path):
    """Re-encode audio to a compressed ogg (<base>.ogg). No per-prompt poster
    (the card falls back to the type-default thumbnail)."""
    out_path = base_path + ".ogg"
    tmp = out_path + ".tmp.ogg"
    await _run_ffmpeg([
        "-i", src_path, "-vn", "-c:a", "libvorbis", "-q:a", "3", tmp,
    ])
    os.replace(tmp, out_path)
    return {"mediaKind": "audio", "mediaExt": "ogg", "hasThumb": False}


def clear_media(base_path):
    """Remove any existing media + poster for a prompt stem (before replace)."""
    for ext in C.IMAGE_EXTS + C.VIDEO_EXTS + C.AUDIO_EXTS:
        p = base_path + ext
        if os.path.isfile(p):
            try:
                os.remove(p)
            except OSError:
                pass
    th = base_path + C.THUMB_SUFFIX
    if os.path.isfile(th):
        try:
            os.remove(th)
        except OSError:
            pass


# ── default type-thumbnails ─────────────────────────────────────────────────

# Art that ships with the node, used when the library root supplies none.
PACKAGED_DEFAULTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "defaults")


def default_thumb_path(root, wf_type, category=None):
    """category (a DEFAULT_CATEGORIES name) overrides the type mapping — used
    for a card's per-prompt default-thumbnail choice.

    The library root is searched first, so dropping your own
    Generic-<Category>.png into <root>/defaults replaces the packaged art."""
    if category in C.DEFAULT_CATEGORIES:
        cat = category
    else:
        cat = C.TYPE_TO_CATEGORY.get(wf_type, "Other")
    dirs = [os.path.join(root, "defaults")] if root else []
    dirs.append(PACKAGED_DEFAULTS)
    for ddir in dirs:
        for ext in C.DEFAULT_EXTS:
            p = os.path.join(ddir, "Generic-%s%s" % (cat, ext))
            if os.path.isfile(p):
                return p
    return None


_PLACEHOLDER_CACHE = {}


def placeholder_bytes(wf_type):
    """A generated placeholder so the grid isn't broken before the user supplies
    their own default thumbnails."""
    if wf_type in _PLACEHOLDER_CACHE:
        return _PLACEHOLDER_CACHE[wf_type]
    from PIL import Image, ImageDraw
    colors = {
        "t2i": (44, 62, 99), "t2v": (78, 44, 99), "i2i": (44, 99, 84),
        "v2v": (99, 71, 44), "editing": (60, 60, 68), "audio": (99, 44, 60),
    }
    col = colors.get(wf_type, (50, 52, 60))
    img = Image.new("RGB", (C.THUMB_W, C.THUMB_H), col)
    d = ImageDraw.Draw(img)
    label = wf_type.upper()
    d.text((C.THUMB_W // 2 - 6 * len(label), C.THUMB_H // 2 - 8), label,
           fill=(220, 222, 230))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=80)
    data = out.getvalue()
    _PLACEHOLDER_CACHE[wf_type] = data
    return data
