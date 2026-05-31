#!/usr/bin/env node
if (process.env.CGUI_PUBLIC_BUILD !== '1') {
  console.error('[build:tauri] refusing to build Tauri outside npm run tauri:build');
  console.error('[build:tauri] public packaging must keep *.local.js/*.local.jsx out of bundled resources.');
  process.exit(1);
}
