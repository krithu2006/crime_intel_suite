"""
Crime Intel Suite — Server launcher.
Run this file to start the FastAPI backend.

Locally : listens on port 8000.
AppSail : listens on the port Catalyst injects via X_ZOHO_CATALYST_LISTEN_PORT.
"""

import os

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
