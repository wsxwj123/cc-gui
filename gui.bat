@echo off
REM Claude GUI launcher (Windows). Double-click to start; close the window to stop.
REM If the server process exits for any reason, the loop below relaunches it.
setlocal
cd /d "%~dp0"

REM First run: install dependencies if missing (root + client). Without the
REM client deps, the build would pull a stray vite from the npx cache whose
REM native binding can fail to load.
if not exist "node_modules" (
  echo [gui] installing dependencies ^(first run, may take a few minutes^)...
  call npm install || exit /b 1
)
if not exist "client\node_modules" (
  echo [gui] installing client dependencies...
  call npm --prefix client install || exit /b 1
)

REM Fail early with a clear hint if this node can't load native modules.
node scripts/check-node.cjs || exit /b 1

REM Build the frontend once if it hasn't been built yet.
if not exist "client\dist" (
  echo [gui] building frontend ^(first run^)...
  call npm run build:local || exit /b 1
)

echo [gui] starting (close this window to stop)...
set CGUI_OPEN_BROWSER=1
:loop
set CGUI_WATCHDOG=1
set NODE_ENV=production
node server/index.js
set CGUI_OPEN_BROWSER=0
echo [gui] server exited - relaunching in 1s...
timeout /t 1 /nobreak >nul
goto loop
