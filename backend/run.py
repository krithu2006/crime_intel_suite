"""
Crime Intel Suite — Server launcher.
Run this file to start the FastAPI backend.

Locally : listens on port 8000.
AppSail : listens on the port Catalyst injects via X_ZOHO_CATALYST_LISTEN_PORT.
"""

import os
import sys

# When deployed to Catalyst AppSail, the predeploy/preserve scripts (see
# app-config.json) vendor dependencies into backend/vendor/ rather than into
# backend/ itself. Vendoring straight into backend/ repeatedly shadowed local
# dev's own .venv (backend/ is the launcher's cwd, and cwd wins on sys.path
# for a `python -m module` invocation), causing
# "ModuleNotFoundError: No module named 'pydantic_core._pydantic_core'"
# every time deployment prep was run and its cleanup was forgotten. A
# dedicated subdirectory can't collide with anything local dev uses, so this
# class of bug can't recur. Locally, backend/vendor/ doesn't exist and this
# is a no-op — the .venv's own packages resolve normally.
_VENDOR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
if os.path.isdir(_VENDOR_DIR):
    sys.path.insert(0, _VENDOR_DIR)

import uvicorn

# Catalyst AppSail assigns the listen port at runtime and expects the process to
# bind to it. Binding a hard-coded port makes the health check fail and the
# instance is reported as "startup failed".
PORT = int(os.environ.get("X_ZOHO_CATALYST_LISTEN_PORT") or os.environ.get("PORT") or 8000)

# reload=True is development-only: it spawns a second watcher process (doubling
# memory) and re-execs sys.executable. Never enable it inside AppSail.
RELOAD = os.environ.get("DEV_RELOAD") == "1"

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=PORT, reload=RELOAD)
