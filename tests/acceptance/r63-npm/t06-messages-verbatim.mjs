#!/usr/bin/env node
// r63-npm【契约检查(静态)】§2.6 用户可见文案逐字齐全。
// 场景:本机只能跑到 mac 的一部分分支;Windows 文案、回滚双失败文案这类"最需要说人话"的
//      句子恰恰最跑不到。这里按字面量核对一遍,漏一句就报一句,免得线上才发现文案是空的。
// 注意:只核对不含变量的静态片段;带变量的句子只取变量前后的固定部分。
// Run: node tests/acceptance/r63-npm/t06-messages-verbatim.mjs
import assert from 'node:assert/strict';
import { P, read, t, done } from './lib.mjs';

const bin = read(P.bin, 'npm/bin/cc-gui.js');
const src = bin + '\n' + read(P.lib, 'npm/lib/main.js');

const CASES = {
  'S0 Node 版本过低(必须在薄壳里)': ['CC-GUI 需要 Node.js 20 或更高版本，当前是 v', '请升级 Node.js 后重试：https://nodejs.org/en/download'],
  'S1 平台不支持': ['CC-GUI 暂不支持当前系统：', '目前支持：macOS（Apple Silicon）与 Windows（x64）。'],
  'S2 平台包缺失': ['没找到当前平台的安装包（', '安装时跳过了可选依赖', 'npm i -g @wsxwj123/cc-gui@latest',
    'npm cache clean --force', '镜像源上还没有这个版本的平台包',
    // 镜像按需同步、可能一直缺,所以必须给出可执行的自救命令,不能只让用户"过一会儿再试"
    '--registry=https://registry.npmjs.org', 'https://github.com/wsxwj123/claude-gui/releases'],
  'S3 包内产物损坏': ['安装包文件缺失或不完整：'],
  'S5b 应用正在运行': ['检测到 CC-GUI 正在运行，无法升级到 v',
    '请先完全退出 CC-GUI（macOS 按 Cmd+Q，注意关闭窗口只是最小化到托盘），然后重新执行 cc-gui。'],
  'S6 安装中/成功': ['正在安装 CC-GUI v', '已安装到 '],
  'S4 无需安装': ['已是最新，正在打开…'],
  'S7 安装失败': ['安装失败：', '已保留原有版本，可继续使用。', '可到 https://github.com/wsxwj123/claude-gui/releases 手动下载安装。'],
  'S7 回滚也失败(mac 第 6 步双失败)': ['新版本换入失败，且旧版本没能自动改回原位。',
    '你的旧版本仍完整保存在：', '手动恢复：把该目录改名为 ~/Applications/CC-GUI.app 即可继续使用。'],
  'S5 排他锁': ['另一个 cc-gui 安装正在进行中，请等它结束后再试。',
    '若确认没有其它 cc-gui 在跑，删掉 ~/Applications/.cc-gui-lock-* 后重试。'],
  '码 7 启动失败': ['，但没能启动起来：', '可以手动打开它；若反复失败，请到 https://github.com/wsxwj123/claude-gui/issues 反馈。'],
  '码 1 兜底': ['CC-GUI 启动失败：', '请到 https://github.com/wsxwj123/claude-gui/issues 反馈，附上上面这行信息。'],
  'pgrep 不可用时的 fail-open 提示': ['无法确认 CC-GUI 是否正在运行，继续安装。'],
  '/Applications 下另有一份的提示': ['提示：/Applications 下另有一份 CC-GUI。', '两者互不影响；同时打开会争用同一个端口，建议只开一份。'],
  'marker 写入失败(仍算安装成功)': ['已安装成功，但更新提示标记写入失败：'],
  '【待双平台】Windows 复核失败': ['安装器已退出但没找到安装目录（已检查：'],
  // exe 名不写死:主程序名 = mainBinaryName ?? Cargo 包名(claude-gui),不是 productName。
  '【待双平台】Windows 已装应用不完整': ["安装目录里没找到 ' + WIN_MAIN_EXE + '：",
    '请重新安装：npm i -g @wsxwj123/cc-gui@latest，或从 GitHub Release 下载安装包。'],
};

for (const [name, frags] of Object.entries(CASES)) {
  await t('文案齐全 — ' + name, () => {
    const missing = frags.filter((f) => !src.includes(f));
    assert.deepEqual(missing, [], '缺这些片段(逐字比对):\n  ' + missing.join('\n  '));
  });
}

await t('S0 文案必须落在薄壳里(落在 lib 就永远打不出来)', () => {
  assert.ok(bin.includes('CC-GUI 需要 Node.js 20 或更高版本，当前是 v'),
    'Node 版本文案写在 lib/main.js 里 = 老 Node 先 SyntaxError,用户只看到一堆栈');
});

done('t06 文案逐字');
