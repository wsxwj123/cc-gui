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

// ① SDK 自带的每平台 claude 二进制(@anthropic-ai/claude-agent-sdk-<platform>,~210MB)是
//    死重:GUI 始终用 pathToClaudeCodeExecutable 指向用户已装的 claude(chat.js resolveUserClaude),
//    从不跑自带的。非 Windows 上 `which claude` 解析可靠 → 删自带省体积(287MB→~50MB app)。
//    Windows 保留:用户可能只有 claude.cmd(非 .exe),resolveUserClaude 会返回 null,此时 SDK
//    需自带二进制兜底。npm 只装当前平台的那一个,故只需删 darwin/linux。
if (process.platform !== 'win32') {
  const scope = path.join(__dirname, '..', 'node_modules', '@anthropic-ai');
  try {
    for (const d of fs.readdirSync(scope)) {
      if (/^claude-agent-sdk-(darwin|linux)-/.test(d)) {
        fs.rmSync(path.join(scope, d), { recursive: true, force: true });
      }
    }
  } catch {}
}

// ② node-pty 预构建清理(原逻辑)。
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
