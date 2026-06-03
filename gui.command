#!/bin/bash
# Claude GUI launcher (macOS). Double-click to start; close the window to stop.
# If the server process exits for any reason, the loop below relaunches it.
cd "$(dirname "$0")" || exit 1

# First run: install dependencies if missing (root + client). Without the client
# deps, the build below would pull a stray vite from the npx cache whose native
# binding can fail to load (code-signature / Team-ID mismatch on macOS).
if [ ! -d node_modules ]; then
  echo "[gui] installing dependencies (first run, may take a few minutes)…"
  npm install || { echo "[gui] npm install failed"; exit 1; }
fi
if [ ! -d client/node_modules ]; then
  echo "[gui] installing client dependencies…"
  npm --prefix client install || { echo "[gui] client install failed"; exit 1; }
fi

# Build the frontend once if it hasn't been built yet.
if [ ! -d client/dist ]; then
  echo "[gui] building frontend (first run)…"
  npm run build:local || { echo "[gui] build failed"; exit 1; }
fi

echo "[gui] starting (Ctrl-C twice to fully stop)…"
# Open the default browser once on first start; flipped off for relaunches.
export CGUI_OPEN_BROWSER=1
while true; do
  CGUI_WATCHDOG=1 NODE_ENV=production node server/index.js
  code=$?
  export CGUI_OPEN_BROWSER=0
  echo "[gui] server exited (code $code) — relaunching in 1s…"
  sleep 1
done
