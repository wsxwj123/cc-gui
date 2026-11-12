#!/usr/bin/env node
// R8-1 更新命令护栏(server/routes/version-check.js updateCmdFor):npm 渠道已被官方
// 降级为原生安装器引导壳(≥2.1.227),`npm i -g` 更新会撞慢源半途而废的整条事故链
// (npmmirror 对 81MB 平台包 16-20KB/s → 超时僵尸 → bin 链未建 → 死安装)。
// method=npm 的更新命令必须改走原生渠道 `claude update`,mac / Windows 两分支同守。
// 变异哨兵:npm 分支改回 `npm install -g` → 「不含 npm install」断言必须红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installCmdFor, updateCmdFor } from '../../server/routes/version-check.js';

// 在当前平台(darwin/linux)与伪装 win32 下各跑一遍两分支。
// process.platform 可用 defineProperty 覆写(node 官方允许,测完还原)。
const realPlatform = process.platform;
const setPlatform = (v) => Object.defineProperty(process, 'platform', { value: v, configurable: true });

try {
  // ── mac/linux 分支 ──────────────────────────────────────────────
  setPlatform('darwin');
  {
    const cmd = updateCmdFor('npm', '/Users/u/.npm-global/bin/claude');
    assert.ok(!/npm\s+i(nstall)?\s+-g/.test(cmd), `mac npm 分支不得再生成 npm i -g:${cmd}`);
    assert.ok(!/@anthropic-ai\/claude-code/.test(cmd), 'mac npm 分支不得再引用 npm 包名');
    assert.ok(/\bupdate\b/.test(cmd), `mac npm 分支走 claude update(原生渠道自更新):${cmd}`);
    assert.ok(cmd.includes(`'/Users/u/.npm-global/bin/claude'`), '用绝对路径(单引号转义)防 PATH 解析到另一个安装');
  }
  {
    // 路径含单引号的转义(与 native 分支同款防注入写法)
    const cmd = updateCmdFor('npm', `/Users/o'brien/bin/claude`);
    assert.ok(cmd.includes(`'\\''`), '单引号路径按 bash 安全转义');
  }
  assert.equal(updateCmdFor('npm', ''), 'claude update', '无路径兜底裸 claude update');
  // native 分支不动(update/upgrade 是同一命令的别名,native 沿用既有 upgrade)
  assert.ok(/\bupgrade\b/.test(updateCmdFor('native', '/usr/local/bin/claude')), 'native 分支保持既有 upgrade');

  // ── Windows 分支 ────────────────────────────────────────────────
  setPlatform('win32');
  {
    const cmd = updateCmdFor('npm', 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
    assert.ok(!/npm\s+i(nstall)?\s+-g/.test(cmd), `win npm 分支不得再生成 npm i -g:${cmd}`);
    assert.ok(!/registry\.npmmirror\.com/.test(cmd), 'win npm 分支不再需要镜像源(不走 npm 了)');
    assert.ok(/\bupdate\b/.test(cmd), `win npm 分支走 claude update:${cmd}`);
    // .bat 里直调另一个 .cmd 控制权不返回(installCmdFor 注释的经典坑)→ 必须 call
    assert.ok(/^call\s/.test(cmd), 'win npm 分支必须以 call 开头(claude.cmd 是批处理)');
    assert.ok(cmd.includes('"C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd"'), '路径双引号包裹');
  }
  assert.equal(updateCmdFor('npm', ''), 'call claude update', 'win 无路径兜底');
} finally {
  setPlatform(realPlatform);
}

// ── 源码守卫:npm 更新链路里不许再出现 npm install -g(防悄悄改回) ────────
{
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'version-check.js'),
    'utf8',
  );
  const fn = src.slice(src.indexOf('export function updateCmdFor'), src.indexOf('export function installCmdFor'));
  // r13-p2-20 推翻本条前提:R8-1 认为"npm 渠道必撞慢源"故禁 npm install。
  // 用户实测反驳 + 复测确认(2026-08-19,同机 8s 采样):慢的是 registry 元数据
  // 重定向(660 B/s),真正拉包的 cdn.npmmirror 达 2.23 MB/s,比原生二进制源经代理
  // (1.04 MB/s)快一倍 —— 对镜像源用户 npm 才是快的那条。故 npm 不再被禁,改为
  // 用户可选渠道(见 check-update-channel)。此处只保留边界:
  //  ①'npm' 分支(= 渠道选原生时 npm 安装走原生自更新)仍不许出现 npm install;
  //  ②'npm-registry' 分支(= 渠道选 npm)必须真的走 npm 且装完自检版本。
  const npmBranch = fn.slice(fn.indexOf("case 'npm': {"), fn.indexOf("case 'native':"));
  assert.ok(!/npm install -g/.test(npmBranch), "'npm' 分支(走原生自更新)不得出现 npm install -g");
  const regBranch = fn.slice(fn.indexOf("case 'npm-registry': {"), fn.indexOf("case 'npm': {"));
  assert.match(regBranch, /npm install -g @anthropic-ai\/claude-code@latest/, "'npm-registry' 分支必须真的走 npm");
  assert.match(regBranch, /claude --version/, "'npm-registry' 装完必须自检版本(防只拉到引导壳)");
  // r180:放行参数写成模块常量,名单只有 claude-code 一个包(不许通配、不许多包)
  assert.match(src, /const NPM_ALLOW_CLAUDE_SCRIPTS = '--allow-scripts=@anthropic-ai\/claude-code';/, 'r180: 放行参数常量必须只放行 claude-code 一个包');
  assert.ok(!/npm config set|\.npmrc['"`]/.test(src), 'r180: 不许改用户 npm 配置');
  assert.ok(/case 'npm'/.test(fn) && /update/.test(fn), 'npm 分支存在且走 update');
}


// ── r85:Windows 上 npm 安装器撞 PowerShell 执行策略(Restricted 拦 .ps1)────────
// 真机现象(全新 Win,只装 Node,策略默认 Restricted):GUI 选 npm 安装器装 claude,
// `npm install -g` 成功,紧接着内联 PowerShell 里的 `npm config get prefix` 被
// PowerShell 解析成 npm.ps1(脚本文件)→「无法加载文件 npm.ps1,禁止运行脚本」→
// 用户 PATH 没写成 → 装完检测不到 claude。两道修(同函数 native 路径早已如此):
//  ① 内联调用改 npm.cmd —— 绕开 .ps1 shim,PowerShell 直接执行批处理;
//  ② 该 powershell 调用补 -ExecutionPolicy Bypass —— 只作用于本进程,不碰用户机器策略。
// 变异哨兵:去掉 Bypass → 「必须带 Bypass」红;npm.cmd 改回 npm → 「不许裸 npm config」红。
const WIN_NATIVE = "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$ProgressPreference='Continue'; Write-Host 'Installing Claude Code CLI (downloading from claude.ai)...'; irm https://claude.ai/install.ps1 | iex\"";
const WIN_NATIVE_PROXY = "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$p='http://127.0.0.1:7897'; [System.Net.WebRequest]::DefaultWebProxy=New-Object System.Net.WebProxy($p); $env:HTTP_PROXY=$p; $env:HTTPS_PROXY=$p; Write-Host ('(proxy: '+$p+')'); $ProgressPreference='Continue'; Write-Host 'Installing Claude Code CLI (downloading from claude.ai)...'; irm https://claude.ai/install.ps1 | iex\"";
const NIX_NATIVE = "curl -fsSL https://claude.ai/install.sh | bash";
const MAC_NPM = "PREFIX=\"$(npm prefix -g)\" && W=\"$PREFIX/lib/node_modules\" && { [ -d \"$W\" ] || W=\"$PREFIX/lib\"; } && { [ -d \"$W\" ] || W=\"$PREFIX\"; } && { [ -w \"$W\" ] || { PREFIX=\"$HOME/.npm-global\"; echo \"npm 全局目录 $W 无写权限(permission denied 根因),改装到 $PREFIX(免 sudo)\"; }; } && npm install -g --prefix \"$PREFIX\" @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code && { \"$PREFIX/bin/claude\" --version || { echo \"Claude Code 没有装完整:npm 没有运行它的安装后脚本,$PREFIX/bin/claude 不能运行(多半只是占位文件)。请执行下面这条命令重装:\"; echo \"npm install -g --prefix \\\"$PREFIX\\\" --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code\"; echo \"如果 npm config get ignore-scripts 显示 true,请先执行 npm config delete ignore-scripts,再重装。\"; false; }; } && NPMBIN=\"$PREFIX/bin\" && { case \":$PATH:\" in *\":$NPMBIN:\"*) echo \"PATH 已包含 $NPMBIN\";; *) echo \"export PATH=\\\"$NPMBIN:\\$PATH\\\"\" >> $HOME/.zshrc && echo \"已把 $NPMBIN 写入 $HOME/.zshrc(新开终端生效)\";; esac; }";
const LINUX_NPM = "PREFIX=\"$(npm prefix -g)\" && W=\"$PREFIX/lib/node_modules\" && { [ -d \"$W\" ] || W=\"$PREFIX/lib\"; } && { [ -d \"$W\" ] || W=\"$PREFIX\"; } && { [ -w \"$W\" ] || { PREFIX=\"$HOME/.npm-global\"; echo \"npm 全局目录 $W 无写权限(permission denied 根因),改装到 $PREFIX(免 sudo)\"; }; } && npm install -g --prefix \"$PREFIX\" @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code && { \"$PREFIX/bin/claude\" --version || { echo \"Claude Code 没有装完整:npm 没有运行它的安装后脚本,$PREFIX/bin/claude 不能运行(多半只是占位文件)。请执行下面这条命令重装:\"; echo \"npm install -g --prefix \\\"$PREFIX\\\" --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code\"; echo \"如果 npm config get ignore-scripts 显示 true,请先执行 npm config delete ignore-scripts,再重装。\"; false; }; } && NPMBIN=\"$PREFIX/bin\" && { case \":$PATH:\" in *\":$NPMBIN:\"*) echo \"PATH 已包含 $NPMBIN\";; *) echo \"export PATH=\\\"$NPMBIN:\\$PATH\\\"\" >> $HOME/.bashrc && echo \"已把 $NPMBIN 写入 $HOME/.bashrc(新开终端生效)\";; esac; }";

try {
  setPlatform('win32');
  const winNpm = installCmdFor(null, 'npm');
  assert.ok(
    winNpm.startsWith('call npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code && '),
    `外层仍走 cmd.exe 的 call npm(.bat 里不加 call 控制权不返回的老坑不许回归):${winNpm}`,
  );
  assert.ok(
    winNpm.includes('powershell -NoProfile -ExecutionPolicy Bypass -Command '),
    `写 PATH 的 powershell 必须带 -ExecutionPolicy Bypass(默认 Restricted 会拦 .ps1):${winNpm}`,
  );
  assert.equal((winNpm.match(/powershell/g) || []).length, 1, '写 PATH 只此一处 PowerShell,不新增调用');
  const ps = winNpm.slice(winNpm.indexOf('-Command "') + '-Command "'.length, winNpm.lastIndexOf('"'));
  assert.ok(ps.includes('npm.cmd config get prefix'), `内联 PowerShell 必须调 npm.cmd:${ps}`);
  assert.ok(!/(^|[^.\w])npm config/.test(ps), `内联 PowerShell 里不许出现裸 npm config(会命中 npm.ps1):${ps}`);

  // ── r180:Windows 安装命令装后自检(PowerShell 段内用 npm 前缀下的 claude.cmd)──
  // 变异哨兵:去掉 Test-Path → 「必须先 Test-Path」红;自检里引入双引号 → 引号计数红。
  const psStart = winNpm.indexOf('powershell');
  const ccAt = winNpm.indexOf("Join-Path $p 'claude.cmd'", psStart);
  assert.ok(ccAt > psStart, `自检路径必须由 npm 前缀 $p 拼出(不能用裸 claude):${winNpm}`);
  assert.ok(winNpm.indexOf('--version', ccAt) > ccAt, `claude.cmd 之后必须带 --version 运行:${winNpm}`);
  assert.ok(/if\(Test-Path \$c\)\{\$v=& \$c --version; \$ok=\(\(\$LASTEXITCODE -eq 0\) -and \(\(\[string\]\$v\)\.Trim\(\) -ne ''\)\); Write-Host \$v\}/.test(ps), `先 Test-Path 再按 $LASTEXITCODE 且 --version 输出非空判断,输出仍显示给用户:${ps}`);
  // 变异哨兵:去掉「输出非空」这道判据 → 红
  assert.ok(/-and \(\(\[string\]\$v\)\.Trim\(\) -ne ''\)/.test(ps), `Windows 自检必须同时要求 --version 有非空输出:${ps}`);
  assert.ok(/if\(-not \$ok\)\{[^}]*not fully installed \(没有装完整\)[^}]*--allow-scripts=@anthropic-ai\/claude-code @anthropic-ai\/claude-code'; Write-Host '[^']*ignore-scripts[^']*'; exit 1\}/.test(ps), `失败说明 + 补救命令 + ignore-scripts 提示 + exit 1:${ps}`);
  // ignore-scripts 提示:Windows 段内用 npm.cmd(上面「不许裸 npm config」看守保持不变),其他平台写普通 npm
  const winFail = ps.slice(ps.indexOf('if(-not $ok)'), ps.indexOf('exit 1'));
  assert.ok(winFail.includes('ignore-scripts') && winFail.includes('npm.cmd config delete ignore-scripts'), `Windows 失败说明应提示 ignore-scripts 与删除命令:${winFail}`);
  assert.ok(ps.indexOf('exit 1') < ps.indexOf('SetEnvironmentVariable'), '自检在写 PATH 之前,失败不写 PATH');
  assert.equal((winNpm.match(/"/g) || []).length, 2, `整条命令只有包住 PowerShell 段的一对双引号:${winNpm}`);
  assert.ok(!/[%^!<>]|&&|\|\|/.test(ps), `PowerShell 段里不许出现 % ^ ! < > && ||:${ps}`);

  // ── r180:四条 npm 命令(安装 / 更新 × Windows / 其他平台)都放行且只放行 claude-code ──
  // 变异哨兵:任一条去掉参数 → 计数 0 红;名单加别的包或 * → 名单相等断言红。
  const allowLists = (cmd) => [...cmd.matchAll(/--allow-scripts=(\S+)/g)].map((m) => m[1]);
  const fourCmds = { 'win install': winNpm, 'win update': updateCmdFor('npm-registry', '') };
  setPlatform('darwin');
  fourCmds['mac install'] = installCmdFor(null, 'npm');
  fourCmds['mac update'] = updateCmdFor('npm-registry', '');
  setPlatform('win32');
  for (const [name, cmd] of Object.entries(fourCmds)) {
    // 真正执行的那次 npm install(到下一个 && 为止)里恰好一次;补救说明里另出现的也只许是这个包
    const at = cmd.indexOf('npm install -g');
    const invocation = cmd.slice(at, cmd.indexOf(' && ', at));
    assert.deepEqual(allowLists(invocation), ['@anthropic-ai/claude-code'], `r180 ${name}: npm install 调用里放行参数恰好一次且只放行 claude-code:${cmd}`);
    assert.deepEqual([...new Set(allowLists(cmd))], ['@anthropic-ai/claude-code'], `r180 ${name}: 整条命令里放行名单只有 claude-code:${cmd}`);
  }
  // r180:其他平台失败说明同样提示 ignore-scripts;提示行在 bash 双引号里,不得含反引号 $ ! 双引号
  const macInstall = fourCmds['mac install'];
  const nixFail = macInstall.slice(macInstall.indexOf('没有装完整'), macInstall.indexOf('false; }; }'));
  assert.ok(nixFail.includes('ignore-scripts') && nixFail.includes('npm config delete ignore-scripts'), `其他平台失败说明应提示 ignore-scripts 与删除命令:${nixFail}`);
  const hintLine = (nixFail.match(/echo "([^"]*ignore-scripts[^"]*)"/) || [])[1];
  assert.ok(hintLine && !/[`$!]/.test(hintLine), `ignore-scripts 提示行不得含反引号 $ !:${nixFail}`);

  // ── 回归锁:本轮不该动的路径逐字不变(值 = 修前实测输出) ──────────────
  assert.equal(installCmdFor(null, 'native'), WIN_NATIVE, 'win32 native 路径逐字不变');
  assert.equal(installCmdFor('http://127.0.0.1:7897', 'native'), WIN_NATIVE_PROXY, 'win32 native(带代理)逐字不变');
  setPlatform('darwin');
  assert.equal(installCmdFor(null, 'native'), NIX_NATIVE, 'mac native 路径逐字不变');
  assert.equal(installCmdFor(null, 'npm'), MAC_NPM, 'mac npm 路径逐字不变');
  setPlatform('linux');
  assert.equal(installCmdFor(null, 'native'), NIX_NATIVE, 'linux native 路径逐字不变');
  assert.equal(installCmdFor(null, 'npm'), LINUX_NPM, 'linux npm 路径逐字不变');
} finally {
  setPlatform(realPlatform);
}

// ── npmUpgradeCommand 按平台(在路由闭包内,不可 import → 源码正则锁) ──────────
// GUI「有新版」提示里给用户抄的自更新命令。Windows 上 npx 同样带 .ps1 shim,
// Restricted 策略下照样报「禁止运行脚本」,必须给 npx.cmd;mac/linux 保持 npx。
{
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'version-check.js'),
    'utf8',
  );
  const at = src.indexOf('npmUpgradeCommand:');
  assert.ok(at > 0, '未找到 npmUpgradeCommand 字面量');
  const seg = src.slice(at, at + 220);
  assert.match(
    seg,
    /process\.platform === 'win32'\s*\?\s*'npx\.cmd @wsxwj123\/cc-gui@latest'\s*:\s*'npx @wsxwj123\/cc-gui@latest'/,
    `npmUpgradeCommand 必须按平台给 npx.cmd / npx:${seg}`,
  );
}

// ── r180:Windows 终端窗口结束语不分成败,不得声称「完成」;界面两处命令文字与实际一致 ──
// 变异哨兵:结束语改回「完成」→ 两条断言都红;界面去掉放行参数 → 对应断言红。
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(join(root, 'server', 'routes', 'version-check.js'), 'utf8');
  assert.ok(src.includes('echo ===== 已结束,按任意键关闭 =====\\r\\npause >nul'), 'Windows 终端结束语应为中性的「已结束」');
  assert.ok(!src.includes('完成,按任意键关闭'), 'Windows 终端结束语不得再写「完成」(npm 失败时也会显示)');
  // Linux 终端窗口(写 .sh 的那支)同理:结束语中性,不写「完成」
  assert.ok(src.includes('read -p "已结束,回车关闭…"'), 'Linux 终端结束语应为中性的「已结束」');
  assert.ok(!src.includes('完成,回车关闭'), 'Linux 终端结束语不得再写「完成」(npm 失败时也会显示)');
  const settings = readFileSync(join(root, 'client', 'src', 'components', 'SettingsPanel.jsx'), 'utf8');
  const envCheck = readFileSync(join(root, 'client', 'src', 'components', 'EnvCheckPanel.jsx'), 'utf8');
  const uiCmd = 'npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code(';
  assert.ok(settings.includes(`'${uiCmd}需 Node ≥ 20)'`), '设置页确认框里的 npm 命令文字应带放行参数');
  assert.ok(envCheck.includes(`title="${uiCmd}走 node`), '环境检查面板 npm 安装提示应带放行参数');
}

console.log('✓ check-update-cmd-npm: npm 更新走 claude update + Win npm 安装绕开执行策略 全过');
