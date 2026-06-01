@echo off
REM Claude GUI launcher with a restart watchdog (Windows).
REM
REM Double-click this to start the GUI. If the server exits — crash or the in-app
REM "restart" — this loop relaunches it. CGUI_WATCHDOG=1 tells the server the
REM watchdog is present so /api/restart may exit cleanly. CGUI_OPEN_BROWSER=1 pops
REM the default browser once on first start (flipped to 0 for restarts).
setlocal
cd /d "%~dp0"

REM Build the frontend once if it hasn't been built yet.
if not exist "client\dist" (
  echo [gui] building frontend ^(first run^)...
  call npm run build:local || exit /b 1
)

echo [gui] starting with restart watchdog (close this window to stop)...
set CGUI_OPEN_BROWSER=1
:loop
set CGUI_WATCHDOG=1
set NODE_ENV=production
node server/index.js
set CGUI_OPEN_BROWSER=0
echo [gui] server exited - relaunching in 1s...
timeout /t 1 /nobreak >nul
goto loop
