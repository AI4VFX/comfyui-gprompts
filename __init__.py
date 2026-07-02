"""G-Prompts — clean-slate rewrite.

Capture the text prompt that produced a result, review the library, and feed
prompts back into workflows. UI + server routes only; registers no graph nodes.

Storage = real sidecar files on disk in a user-chosen library root:
    <root>/<Folder>/<name>.txt          the prompt text
    <root>/<Folder>/<name>.json         metadata
    <root>/<Folder>/<name>.<ext>        result media (image/video/audio)
    <root>/<Folder>/<name>.thumb.jpg    800x450 card poster
The filesystem IS the database, so manual replace/remove/delete behave predictably.
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

# Registering the aiohttp routes is the whole backend.
from .gp import routes  # noqa: E402,F401

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
