"""aiohttp routes for G-Prompts, registered on PromptServer."""

import os

from aiohttp import web

from server import PromptServer

from . import config as C
from . import media as M
from . import store as S

routes = PromptServer.instance.routes
PREFIX = "/gprompts"


def _ok(data=None):
    return web.json_response({"ok": True, **(data or {})})


def _bad(msg, status=400):
    return web.json_response({"ok": False, "error": str(msg)}, status=status)


# ── config / setup ──────────────────────────────────────────────────────────

@routes.get(PREFIX + "/state")
async def r_state(request):
    cfg = C.load_config()
    return _ok({
        "configured": C.is_configured(),
        "root": C.get_root(),
        "suggested": C.suggested_default_root(),
        "skipOverwriteWarning": cfg.get("skipOverwriteWarning", False),
        "autoClose": cfg.get("autoClose", False),
        "captureShortcut": cfg.get("captureShortcut", "Alt+Q"),
        "rememberFolder": cfg.get("rememberFolder", True),
        "lastFolder": cfg.get("lastFolder"),
        "captureAssets": cfg.get("captureAssets", False),
        "packIncludeAssets": cfg.get("packIncludeAssets", True),
        "restoreAssets": cfg.get("restoreAssets", True),
        "packToastSeconds": cfg.get("packToastSeconds", 2),
    })


@routes.get(PREFIX + "/fs_roots")
async def r_fs_roots(request):
    return _ok(C.fs_roots())


@routes.get(PREFIX + "/fs_list")
async def r_fs_list(request):
    return _ok(C.fs_list(request.query.get("path", "")))


@routes.post(PREFIX + "/set_root")
async def r_set_root(request):
    try:
        data = await request.json()
        root = C.set_root(data.get("path", ""))
        return _ok({"root": root})
    except Exception as e:
        return _bad(e)


@routes.post(PREFIX + "/set_config")
async def r_set_config(request):
    data = await request.json()
    cfg = C.update_settings(data)
    return _ok({k: cfg.get(k) for k in C.SETTABLE_KEYS})


# ── library ─────────────────────────────────────────────────────────────────

@routes.get(PREFIX + "/library")
async def r_library(request):
    if not C.is_configured():
        return _ok({"configured": False, "folders": [], "prompts": []})
    try:
        data = S.scan()
        data["configured"] = True
        return _ok(data)
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/capture")
async def r_capture(request):
    if not C.is_configured():
        return _bad("library not configured")
    try:
        data = await request.json()
        items = data.get("prompts", [])
        skip = C.load_config().get("skipOverwriteWarning", False)
        result = await S.capture(items, skip)
        return _ok(result)
    except Exception as e:
        return _bad(e, 500)


# ── serving media / posters / default thumbnails ────────────────────────────

def _media_path(folder, name):
    abs_dir = S._safe_dir(folder)
    name = S._safe_name(name)
    kind, ext = S._media_for_stem(abs_dir, name)
    if ext:
        return os.path.join(abs_dir, name + "." + ext)
    return None


@routes.get(PREFIX + "/media")
async def r_media(request):
    try:
        p = _media_path(request.query.get("folder", ""), request.query.get("name", ""))
        if p and os.path.isfile(p):
            return web.FileResponse(p)
        return _bad("not found", 404)
    except Exception as e:
        return _bad(e, 400)


@routes.get(PREFIX + "/poster")
async def r_poster(request):
    try:
        abs_dir = S._safe_dir(request.query.get("folder", ""))
        p = os.path.join(abs_dir, S._safe_name(request.query.get("name", "")) + C.THUMB_SUFFIX)
        if os.path.isfile(p):
            return web.FileResponse(p, headers={"Cache-Control": "no-cache"})
        return _bad("not found", 404)
    except Exception as e:
        return _bad(e, 400)


@routes.get(PREFIX + "/workflow")
async def r_workflow(request):
    try:
        abs_dir = S._safe_dir(request.query.get("folder", ""))
        p = os.path.join(abs_dir, S._safe_name(request.query.get("name", "")) + C.WORKFLOW_SUFFIX)
        if os.path.isfile(p):
            return web.FileResponse(p)
        return _bad("not found", 404)
    except Exception as e:
        return _bad(e, 400)


@routes.get(PREFIX + "/default_thumb")
async def r_default_thumb(request):
    wf_type = request.query.get("type", "t2i")
    category = request.query.get("category")   # per-card override (thumbChoice)
    p = M.default_thumb_path(C.get_root(), wf_type, category)
    if p:
        # no-cache = revalidate via Last-Modified/ETag, so re-exported default
        # art shows after a normal refresh without a full re-download each time.
        return web.FileResponse(p, headers={"Cache-Control": "no-cache"})
    # Only reachable if the packaged art is missing too.
    return web.Response(body=M.placeholder_bytes(wf_type), content_type="image/jpeg")


# ── mutations ───────────────────────────────────────────────────────────────

@routes.post(PREFIX + "/update_prompt")
async def r_update_prompt(request):
    try:
        d = await request.json()
        p = await S.update_prompt(d.get("folder", ""), d["name"], d.get("patch", {}))
        return _ok({"prompt": p})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/move")
async def r_move(request):
    try:
        d = await request.json()
        p = await S.move_prompt(d.get("folder", ""), d["name"], d.get("toFolder", ""))
        return _ok({"prompt": p})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/set_media")
async def r_set_media(request):
    try:
        d = await request.json()
        p = await S.set_media(d.get("folder", ""), d["name"], d["dataUrl"], d.get("kind", "image"))
        return _ok({"prompt": p})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/remove")
async def r_remove(request):
    try:
        d = await request.json()
        await S.remove_prompt(d.get("folder", ""), d["name"])
        return _ok()
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/delete")
async def r_delete(request):
    try:
        d = await request.json()
        if not d.get("confirm"):
            return _bad("confirm required")
        await S.delete_prompt(d.get("folder", ""), d["name"])
        return _ok()
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/copy")
async def r_copy(request):
    try:
        d = await request.json()
        p = await S.copy_prompt(d.get("folder", ""), d["name"], d.get("toFolder"))
        return _ok({"prompt": p})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/thumb_remove")
async def r_thumb_remove(request):
    try:
        d = await request.json()
        p = await S.thumb_remove(d.get("folder", ""), d["name"])
        return _ok({"prompt": p})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/thumb_delete")
async def r_thumb_delete(request):
    try:
        d = await request.json()
        p = await S.thumb_delete(d.get("folder", ""), d["name"])
        return _ok({"prompt": p})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/capture_assets")
async def r_capture_assets(request):
    try:
        d = await request.json()
        result = await S.capture_assets_now(d.get("folder", ""), d["name"])
        return _ok(result)
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/restore_assets")
async def r_restore_assets(request):
    try:
        d = await request.json()
        result = await S.restore_assets(d.get("folder", ""), d["name"])
        return _ok(result)
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/pack")
async def r_pack(request):
    try:
        d = await request.json()
        zip_path = await S.pack(d.get("items", []))
        return _ok({"zip": zip_path})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/tag_rename")
async def r_tag_rename(request):
    try:
        d = await request.json()
        n = await S.tag_rename(d["old"], d["new"])
        return _ok({"changed": n})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/tag_delete")
async def r_tag_delete(request):
    try:
        d = await request.json()
        n = await S.tag_delete(d["tag"])
        return _ok({"changed": n})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/tag_create")
async def r_tag_create(request):
    try:
        d = await request.json()
        reg = await S.tag_create(d.get("name", ""))
        return _ok({"registry": reg})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/folder_move")
async def r_folder_move(request):
    try:
        d = await request.json()
        rel = await S.folder_move(d["folder"], d.get("toParent", ""))
        return _ok({"folder": rel})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/folder_copy")
async def r_folder_copy(request):
    try:
        d = await request.json()
        rel = await S.folder_copy(d["folder"], d.get("toParent", ""))
        return _ok({"folder": rel})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/folder_pack")
async def r_folder_pack(request):
    try:
        d = await request.json()
        items = S.folder_pack_items(d["folder"])
        if not items:
            return _bad("folder is empty")
        zip_path = await S.pack(items)
        return _ok({"zip": zip_path})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/folder_create")
async def r_folder_create(request):
    try:
        d = await request.json()
        rel = await S.folder_create(d.get("parent", ""), d["name"])
        return _ok({"folder": rel})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/folder_rename")
async def r_folder_rename(request):
    try:
        d = await request.json()
        rel = await S.folder_rename(d["folder"], d["name"])
        return _ok({"folder": rel})
    except Exception as e:
        return _bad(e, 500)


@routes.post(PREFIX + "/folder_delete")
async def r_folder_delete(request):
    try:
        d = await request.json()
        if not d.get("confirm"):
            return _bad("confirm required")
        await S.folder_delete(d["folder"])
        return _ok()
    except Exception as e:
        return _bad(e, 500)


print("[G-Prompts] routes registered at", PREFIX)
