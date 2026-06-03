#!/usr/bin/env node
// Probe whether THIS node can load native addons before we try to build/run.
//
// Some app-bundled node binaries (shipped inside another .app and pushed to the
// front of PATH) enable macOS "library validation", which refuses to dlopen any
// third-party *.node whose code signature has a different Team ID. That breaks
// the vite/rollup build AND node-pty at runtime with a wall of confusing stack
// traces ("Cannot find module @rollup/...", "different Team IDs").
//
// Catch it here and print one clear, actionable hint instead. Exit 0 on success
// or on any UNRELATED error (so the real build/run still surfaces those).
try {
  require('node-pty'); // a native dep that the launcher has already installed
  process.exit(0);
} catch (e) {
  const msg = String((e && (e.message + ' ' + (e.cause && e.cause.message || ''))) || e);
  const isSigning = /Team ID|library validation|code signature|ERR_DLOPEN|not valid for use in process/i.test(msg);
  if (!isSigning) process.exit(0); // unrelated (e.g. not installed) — let build report it

  const line = (s) => process.stderr.write(s + '\n');
  line('');
  line('  ✗ 这个 Node 无法加载原生模块（被 macOS 库签名校验拦截）。');
  line('    当前 node: ' + process.execPath);
  line('');
  line('    原因：这通常是某个 App 自带的 node 抢占了你的 PATH，它带了严格的');
  line('    代码签名校验，会拒绝 rollup / node-pty 这类第三方原生模块。');
  line('');
  line('    修复（用一个正常安装的 node 即可，一次性，所有项目都受益）：');
  line('      • brew install node        （推荐，Homebrew）');
  line('      • 或去 https://nodejs.org 下 LTS 安装包');
  line('      • 或用 nvm: nvm install 22 && nvm use 22 && nvm alias default 22');
  line('');
  line('    然后确认 `which node` 不再指向某个 .app 内部，删掉 node_modules 和');
  line('    client/node_modules，重新双击启动脚本即可。');
  line('');
  process.exit(2);
}
