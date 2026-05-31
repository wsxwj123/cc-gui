#!/usr/bin/env node
// Cross-platform node-pty prebuild housekeeping. (.cjs because the package is
// "type": "module" — this script needs CommonJS require/__dirname.)
//
// Replaces an inline unix one-liner (`rm -rf .../win32-* ; chmod +x ...`) that
// broke `npm ci` on Windows CI (no `rm`/`chmod`, no `/dev/null`).
//
//   - Off Windows: win32 prebuilds are dead weight (and would bloat the .app),
//     so drop them; and node-pty's `spawn-helper` must be executable on unix.
//   - On Windows: KEEP win32 prebuilds (node-pty needs them) and skip chmod.
const fs = require('fs');
const path = require('path');

const pre = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
if (!fs.existsSync(pre)) process.exit(0);

if (process.platform !== 'win32') {
  for (const d of ['win32-arm64', 'win32-x64']) {
    try { fs.rmSync(path.join(pre, d), { recursive: true, force: true }); } catch {}
  }
  try {
    for (const d of fs.readdirSync(pre)) {
      const h = path.join(pre, d, 'spawn-helper');
      if (fs.existsSync(h)) fs.chmodSync(h, 0o755);
    }
  } catch {}
}
