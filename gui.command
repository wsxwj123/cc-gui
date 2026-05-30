#!/bin/bash
# Claude GUI launcher with a restart watchdog.
#
# Double-click this (or run it) to start the GUI. If the server exits — whether
# it crashed or the in-app "重启" button asked it to — this loop relaunches it.
# The CGUI_WATCHDOG=1 flag tells the server the watchdog is present, so the
# /api/restart endpoint is allowed to exit cleanly (it refuses otherwise, to
# avoid stranding a phone client when started bare).
cd "$(dirname "$0")" || exit 1

# Build the frontend once if it hasn't been built yet.
if [ ! -d client/dist ]; then
  echo "[gui] building frontend (first run)…"
  npm run build || { echo "[gui] build failed"; exit 1; }
fi

echo "[gui] starting with restart watchdog (Ctrl-C twice to fully stop)…"
while true; do
  CGUI_WATCHDOG=1 NODE_ENV=production node server/index.js
  code=$?
  # Exit code 0 = deliberate restart; anything else = crash. Relaunch either way,
  # but pause briefly so a tight crash loop (e.g. port held) doesn't spin the CPU.
  echo "[gui] server exited (code $code) — relaunching in 1s…"
  sleep 1
done
