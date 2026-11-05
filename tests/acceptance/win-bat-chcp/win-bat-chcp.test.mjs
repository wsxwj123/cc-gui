// 验收测试(黑盒):Windows 安装脚本(.bat)必须在 "@echo off" 之后立刻带 "chcp 65001 >nul"。
//
// 依据:.devflow/win-bat-chcp-接口.md(唯一输入)。
// 做法:把后端路由模块挂到本地 express 上,只通过 HTTP 调用
//   POST /api/claude-install、POST /api/env-check/install;
// 用 PATH 最前面的假 cmd / 假 open / 假终端截获"后端启动了什么程序、传了什么参数",
// 再读被启动的脚本文件的原始字节做断言。不 import 其他服务端模块,不 mock 内部层。
//
// 行为编号:W1-W5 修复点(修复前应红),W6-W10 相邻回归,P1/P2 其他平台不变。
// 所有失败信息都以行为编号开头,看到 "W3 ..." 就知道是接口文件里的 W3 没满足。
//
// 请求次数:Windows 三个入口各只请求一次(第一次用到时才发,结果只读缓存,用例顺序无关),
// W1-W4、W6-W10 共用这三份脚本;W5(要改代理环境变量)、P1、P2 各自单独请求。共 6 次请求。
//
// 运行:node --test tests/acceptance/win-bat-chcp/win-bat-chcp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import router from '../../../server/routes/version-check.js';

// ───────────────────────────── 常量(全部来自接口文件) ─────────────────────────────

const TMP = os.tmpdir();
const REAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const LAUNCH_WAIT_MS = 10_000; // 接口文件建议 4s;本机实测新建脚本首次执行偶发 3s,放宽以防误报
const LAUNCH_POLL_MS = 50;
const LAUNCH_SCRIPT_NAME = /^cgui-cc-\d+-\d+\.(bat|command|sh)$/;
const TEST_TIMEOUT_MS = 60_000;

const CHCP_LINE = 'chcp 65001 >nul\r\n';
const BAT_HEAD = `@echo off\r\n${CHCP_LINE}`;
const BAT_TAIL = 'echo.\r\necho ===== 完成,按任意键关闭 =====\r\npause >nul\r\n';
const WINGET_NOTICE = 'echo winget 不可用,正在打开官方下载页...';
const NODE_INSTALL_COMMAND =
  'where winget >nul 2>nul & if errorlevel 1 ( echo winget 不可用,正在打开官方下载页... & start "" "https://nodejs.org/en/download/" ) else ( winget install -e --id OpenJS.NodeJS.LTS )';
const SHEBANG = '#!/bin/bash\n';

// Windows 下的三个入口。mayHaveProxyBlock:该入口的 .bat 里是否可能出现代理三行
// (native 永远没有;npm / node 取决于运行机器上有没有代理,断言必须两种都认)。
const NPM = {
  name: 'claude-install npm',
  route: '/api/claude-install',
  body: { method: 'npm' },
  title: '安装 Claude Code (npm)',
  mayHaveProxyBlock: true,
  commandStartsWith: 'call npm install -g @anthropic-ai/claude-code',
};
const NATIVE = {
  name: 'claude-install native',
  route: '/api/claude-install',
  body: { method: 'native' },
  title: '安装 Claude Code (官方安装器)',
  mayHaveProxyBlock: false,
  commandStartsWith: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "',
};
const NODE = {
  name: 'env-check/install node',
  route: '/api/env-check/install',
  body: { target: 'node' },
  title: '安装 Node.js',
  mayHaveProxyBlock: true,
  commandEquals: NODE_INSTALL_COMMAND,
};
const WIN_SCENARIOS = [NPM, NATIVE, NODE];

// ───────────────────────────── 夹具:假程序 + 本地路由服务 ─────────────────────────────

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// 假程序:把收到的每个参数各占一行写进抓取文件(空字符串参数也占一行),先写临时文件再 mv。
function fakeProgramSource(captureFile) {
  const tmp = shellQuote(`${captureFile}.tmp`);
  const out = shellQuote(captureFile);
  return [
    '#!/bin/sh',
    `for a in "$@"; do printf '%s\\n' "$a"; done > ${tmp}`,
    `mv ${tmp} ${out}`,
    '',
  ].join('\n');
}

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function restorePlatform() {
  if (REAL_PLATFORM_DESCRIPTOR) Object.defineProperty(process, 'platform', REAL_PLATFORM_DESCRIPTOR);
}

function setEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitForFile(file) {
  const deadline = Date.now() + LAUNCH_WAIT_MS;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
  }
  return true;
}

// 按换行切,去掉末尾那个空元素;不能用 trim()(会吃掉空字符串参数)。
function splitArgs(raw) {
  const parts = raw.split('\n');
  parts.pop();
  return parts;
}

function scriptPathFromArgs(platform, args) {
  if (platform === 'win32') return args[3] ?? null;
  if (platform === 'darwin') return args[0] ?? null;
  const m = /^bash "(.+)"$/.exec(args[1] ?? '');
  return m ? m[1] : null;
}

// 只删"位于 os.tmpdir() 且名字形如 cgui-cc-N-N.<ext>"的脚本,绝不删别的路径。
function removeLaunchScript(file) {
  if (!file || path.dirname(file) !== TMP || !LAUNCH_SCRIPT_NAME.test(path.basename(file))) return false;
  fs.rmSync(file, { force: true });
  return true;
}

// 兜底(只在没能按启动参数删掉脚本时走,比如假程序没被调用):
// 删掉本次请求开始之后才冒出来的 cgui-cc-N-N.* 脚本。tmpdir 里文件很多,所以平时不扫描。
function removeLaunchScriptsCreatedSince(startedAtMs) {
  for (const name of fs.readdirSync(TMP)) {
    if (!LAUNCH_SCRIPT_NAME.test(name)) continue;
    const file = path.join(TMP, name);
    try {
      if (fs.statSync(file).mtimeMs >= startedAtMs) fs.rmSync(file, { force: true });
    } catch {
      // 期间被别人删掉了,不管
    }
  }
}

// 只删自己建的几个文件,再删空目录;不做递归删除。
function removeBinDir(dir, files) {
  for (const f of files) fs.rmSync(f, { force: true });
  try {
    fs.rmdirSync(dir);
  } catch {
    // 目录里若还有别的东西就留着
  }
}

/**
 * 伪装平台发一次 POST,截获后端启动的假程序收到的参数,并读出被启动的脚本字节。
 * platform: 'win32' | 'darwin' | 'linux'(win32→假 cmd,darwin→假 open,linux→假终端并设 TERMINAL)
 * httpsProxy: 仅 W5 传入,设为测试进程的 HTTPS_PROXY(用完恢复)
 * 返回 { status, rawBody, json, args, scriptPath, scriptExisted, script }
 *   args 为 null 表示没等到假程序被调用;script 为 null 表示读不到脚本。
 */
async function launch({ platform, route, body, httpsProxy }) {
  const binDir = fs.mkdtempSync(path.join(TMP, 'cgui-wbc-test-'));
  const captureFile = path.join(binDir, 'captured-args.txt');
  const programPath = path.join(binDir, { win32: 'cmd', darwin: 'open', linux: 'fake-terminal' }[platform]);
  fs.writeFileSync(programPath, fakeProgramSource(captureFile));
  fs.chmodSync(programPath, 0o755);

  const savedEnv = {
    PATH: process.env.PATH,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    TERMINAL: process.env.TERMINAL,
  };
  const startedAt = Date.now() - 100;
  let server = null;
  let scriptRemoved = false;
  try {
    process.env.PATH = `${binDir}${path.delimiter}${savedEnv.PATH ?? ''}`;
    if (httpsProxy !== undefined) process.env.HTTPS_PROXY = httpsProxy;
    if (platform === 'linux') process.env.TERMINAL = programPath;

    server = await startServer();
    const url = `http://127.0.0.1:${server.address().port}${route}`;

    let status;
    let rawBody;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      status = res.status;
      rawBody = await res.text();
    } finally {
      restorePlatform();
    }
    let json = null;
    try {
      json = JSON.parse(rawBody);
    } catch {
      // 留给具体断言去报告
    }

    let args = null;
    if (status === 200 && (await waitForFile(captureFile))) {
      args = splitArgs(fs.readFileSync(captureFile, 'utf8'));
    }
    const scriptPath = args ? scriptPathFromArgs(platform, args) : null;
    const scriptExisted = scriptPath !== null && fs.existsSync(scriptPath);
    const script = scriptExisted ? fs.readFileSync(scriptPath) : null;
    scriptRemoved = removeLaunchScript(scriptPath);
    return { status, rawBody, json, args, scriptPath, scriptExisted, script };
  } finally {
    restorePlatform();
    setEnv('PATH', savedEnv.PATH);
    setEnv('HTTPS_PROXY', savedEnv.HTTPS_PROXY);
    setEnv('TERMINAL', savedEnv.TERMINAL);
    if (server) await stopServer(server);
    if (!scriptRemoved) removeLaunchScriptsCreatedSince(startedAt);
    removeBinDir(binDir, [programPath, captureFile, `${captureFile}.tmp`]);
  }
}

// Windows 三个入口各请求一次并缓存(只读)。谁先用到谁触发请求,用例顺序无关;
// 用例是串行执行的,所以不会出现两次 launch 同时改 process.platform / PATH。
const winRuns = new Map();
function winRun(scenario) {
  if (!winRuns.has(scenario.name)) {
    winRuns.set(scenario.name, launch({ platform: 'win32', route: scenario.route, body: scenario.body }));
  }
  return winRuns.get(scenario.name);
}

// ───────────────────────────── 断言辅助 ─────────────────────────────

const headOf = (buf, n = 70) => JSON.stringify(buf.subarray(0, n).toString('utf8'));
const hexOf = (buf, n = 3) => Array.from(buf.subarray(0, n), (b) => b.toString(16).padStart(2, '0')).join(' ');

function requireScript(r, label) {
  assert.ok(
    r.args !== null,
    `${label} 前置条件:后端没有在 ${LAUNCH_WAIT_MS}ms 内启动假程序(HTTP ${r.status},响应体 ${r.rawBody})`,
  );
  assert.ok(
    r.script !== null,
    `${label} 前置条件:读不到启动参数指向的脚本文件,启动参数 ${JSON.stringify(r.args)}`,
  );
  return r.script;
}

function assertBatStartsWithChcp(label, script) {
  const actual = script.subarray(0, Buffer.byteLength(BAT_HEAD)).toString('utf8');
  assert.equal(
    actual,
    BAT_HEAD,
    `${label} 脚本应以 ${JSON.stringify(BAT_HEAD)} 开头,实际开头是 ${headOf(script)}`,
  );
}

// W8:标题行紧跟在 "@echo off"(+ chcp 行)之后;标题行/代理块与结尾三行之间恰好是一行命令;
// 全文以三行收尾、其后无内容。chcp 行有没有都能判(修复前后都应绿),chcp 行的位置由 W1-W5 把关。
function assertBatStructure(label, s, script) {
  const text = script.toString('utf8');
  assert.ok(
    text.endsWith(BAT_TAIL),
    `${label} 全文应以 ${JSON.stringify(BAT_TAIL)} 结尾且其后无内容,实际结尾是 ${JSON.stringify(text.slice(-90))}`,
  );
  const beforeTail = text.slice(0, text.length - BAT_TAIL.length);
  assert.ok(
    beforeTail.endsWith('\r\n'),
    `${label} 命令行后面应以 \\r\\n 换行再接结尾三行,实际 ${JSON.stringify(beforeTail.slice(-40))}`,
  );
  const lines = beforeTail.slice(0, -2).split('\r\n');

  assert.equal(lines[0], '@echo off', `${label} 第 1 行应为 "@echo off",实际 ${JSON.stringify(lines[0])}`);
  const titleAt = lines[1] === 'chcp 65001 >nul' ? 2 : 1;
  const expectedTitle = `echo ▶ ${s.title}`;
  assert.equal(
    lines[titleAt],
    expectedTitle,
    `${label} 第 ${titleAt + 1} 行(chcp 行之后)应为标题行 ${JSON.stringify(expectedTitle)},实际 ${JSON.stringify(lines[titleAt])}`,
  );

  const middle = lines.slice(titleAt + 1);
  let command;
  if (middle.length === 1) {
    command = middle[0];
  } else {
    assert.ok(
      s.mayHaveProxyBlock && middle.length === 4,
      s.mayHaveProxyBlock
        ? `${label} 标题行与结尾三行之间应是 1 行命令(有代理时是 3 行代理块 + 1 行命令),实际 ${middle.length} 行: ${JSON.stringify(middle)}`
        : `${label} 该入口在 Windows 下永远不应有代理块,标题行与结尾三行之间应只有 1 行命令,实际 ${middle.length} 行: ${JSON.stringify(middle)}`,
    );
    const m = /^set HTTP_PROXY=(.+)$/.exec(middle[0]);
    assert.ok(m, `${label} 代理块第 1 行应形如 "set HTTP_PROXY=<代理地址>",实际 ${JSON.stringify(middle[0])}`);
    const addr = m[1];
    assert.deepEqual(
      middle.slice(0, 3),
      [`set HTTP_PROXY=${addr}`, `set HTTPS_PROXY=${addr}`, `echo (代理: ${addr})`],
      `${label} 代理块应是 set HTTP_PROXY / set HTTPS_PROXY / echo (代理: ...) 三行且地址一致,实际 ${JSON.stringify(middle.slice(0, 3))}`,
    );
    command = middle[3];
  }

  if (s.commandEquals !== undefined) {
    assert.equal(command, s.commandEquals, `${label} 命令行应恰好是 ${JSON.stringify(s.commandEquals)},实际 ${JSON.stringify(command)}`);
  } else {
    assert.ok(
      command.startsWith(s.commandStartsWith),
      `${label} 命令行应以 ${JSON.stringify(s.commandStartsWith)} 开头,实际 ${JSON.stringify(command.slice(0, 120))}`,
    );
  }
}

// ───────────────────────────── 修复点 W1-W5(修复前应红) ─────────────────────────────

test(
  'W1 win32 + claude-install(npm):脚本以 "@echo off" + "chcp 65001 >nul" 两行开头',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const r = await winRun(NPM);
    assertBatStartsWithChcp('W1', requireScript(r, 'W1'));
  },
);

test(
  'W2 win32 + claude-install(native):脚本以 "@echo off" + "chcp 65001 >nul" 两行开头',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const r = await winRun(NATIVE);
    assertBatStartsWithChcp('W2', requireScript(r, 'W2'));
  },
);

test(
  'W3 win32 + env-check/install(node):脚本以 chcp 开头,且 winget 不可用的提示行在 chcp 行之后',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const r = await winRun(NODE);
    const script = requireScript(r, 'W3');
    assertBatStartsWithChcp('W3', script);
    const text = script.toString('utf8');
    const chcpAt = text.indexOf(CHCP_LINE);
    const noticeAt = text.indexOf(WINGET_NOTICE);
    assert.notEqual(noticeAt, -1, `W3 脚本里应含 ${JSON.stringify(WINGET_NOTICE)},实际脚本 ${JSON.stringify(text)}`);
    assert.ok(
      noticeAt > chcpAt,
      `W3 winget 提示行(字符偏移 ${noticeAt})应出现在 chcp 行(字符偏移 ${chcpAt})之后`,
    );
  },
);

test(
  'W4 三份 Windows 脚本:第一个非 ASCII 字节在 chcp 行之后,且 chcp 恰好出现 1 次',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    for (const s of WIN_SCENARIOS) {
      const label = `W4 [${s.name}]`;
      const r = await winRun(s);
      const script = requireScript(r, label);
      const chcpAt = script.indexOf(CHCP_LINE);
      assert.notEqual(chcpAt, -1, `${label} 脚本里找不到 "chcp 65001 >nul\\r\\n" 这一行,脚本开头是 ${headOf(script)}`);
      const chcpEnd = chcpAt + Buffer.byteLength(CHCP_LINE);
      const firstHigh = script.findIndex((b) => b >= 0x80);
      assert.notEqual(firstHigh, -1, `${label} 脚本里应有非 ASCII 字节(标题行的 ▶ 与中文),实际一个都没有`);
      assert.ok(
        firstHigh >= chcpEnd,
        `${label} 第一个 >= 0x80 的字节在偏移 ${firstHigh},早于 chcp 行结束的偏移 ${chcpEnd}:中文会在切换代码页之前被 cmd 读到`,
      );
      const chcpCount = (script.toString('utf8').match(/chcp/gi) ?? []).length;
      assert.equal(chcpCount, 1, `${label} 整份脚本里 chcp 应恰好出现 1 次,实际 ${chcpCount} 次`);
    }
  },
);

test(
  'W5 设了代理时:脚本前 7 行依次是 @echo off / chcp / 标题 / 代理三行 / npm 命令',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const proxy = 'http://proxy.test.invalid:8080';
    const r = await launch({
      platform: 'win32',
      route: '/api/claude-install',
      body: { method: 'npm' },
      httpsProxy: proxy,
    });
    const script = requireScript(r, 'W5');
    const lines = script.toString('utf8').split('\r\n');
    const expected = [
      '@echo off',
      'chcp 65001 >nul',
      'echo ▶ 安装 Claude Code (npm)',
      `set HTTP_PROXY=${proxy}`,
      `set HTTPS_PROXY=${proxy}`,
      `echo (代理: ${proxy})`,
    ];
    assert.deepEqual(
      lines.slice(0, 6),
      expected,
      `W5 前 6 行应依次为 ${JSON.stringify(expected)},实际 ${JSON.stringify(lines.slice(0, 6))}`,
    );
    assert.ok(
      typeof lines[6] === 'string' && lines[6].startsWith('call npm install -g @anthropic-ai/claude-code'),
      `W5 第 7 行应以 "call npm install -g @anthropic-ai/claude-code" 开头,实际 ${JSON.stringify(lines[6])}`,
    );
  },
);

// ───────────────────────────── 相邻回归 W6-W10(修复前后都应绿) ─────────────────────────────

test(
  'W6 三份 Windows 脚本:第一个字节是 0x40("@"),没有 UTF-8 BOM',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    for (const s of WIN_SCENARIOS) {
      const label = `W6 [${s.name}]`;
      const r = await winRun(s);
      const script = requireScript(r, label);
      const hasBom = script[0] === 0xef && script[1] === 0xbb && script[2] === 0xbf;
      assert.equal(hasBom, false, `${label} 脚本不应带 UTF-8 BOM(EF BB BF),实际前 3 字节 ${hexOf(script)}`);
      assert.equal(script[0], 0x40, `${label} 第一个字节应为 0x40("@"),实际前 3 字节 ${hexOf(script)}`);
    }
  },
);

test(
  'W7 三份 Windows 脚本:每个换行都是 \\r\\n,没有单独的 \\n',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    for (const s of WIN_SCENARIOS) {
      const label = `W7 [${s.name}]`;
      const r = await winRun(s);
      const text = requireScript(r, label).toString('utf8');
      const crlf = (text.match(/\r\n/g) ?? []).length;
      const lf = (text.match(/\n/g) ?? []).length;
      assert.ok(crlf >= 6, `${label} 脚本至少应有 6 个 \\r\\n 换行(标题/命令/结尾三行等),实际 ${crlf} 个`);
      assert.equal(lf, crlf, `${label} 删掉所有 \\r\\n 后仍剩 ${lf - crlf} 个单独的 \\n`);
    }
  },
);

test(
  'W8 三份 Windows 脚本:标题行紧跟 chcp 行,命令行夹在标题/代理块与结尾三行之间,结尾后无内容',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    for (const s of WIN_SCENARIOS) {
      const label = `W8 [${s.name}]`;
      const r = await winRun(s);
      assertBatStructure(label, s, requireScript(r, label));
    }
  },
);

test(
  'W9 三份 Windows 脚本:假 cmd 恰好收到 4 个参数 /c、start、空字符串、tmpdir 下的 cgui-cc-N-N.bat',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    for (const s of WIN_SCENARIOS) {
      const label = `W9 [${s.name}]`;
      const r = await winRun(s);
      assert.ok(
        r.args !== null,
        `${label} 后端没有在 ${LAUNCH_WAIT_MS}ms 内启动假 cmd(HTTP ${r.status},响应体 ${r.rawBody})`,
      );
      assert.equal(r.args.length, 4, `${label} 假 cmd 应恰好收到 4 个参数,实际 ${r.args.length} 个: ${JSON.stringify(r.args)}`);
      assert.deepEqual(
        r.args.slice(0, 3),
        ['/c', 'start', ''],
        `${label} 前 3 个参数应依次为 "/c"、"start"、空字符串,实际 ${JSON.stringify(r.args.slice(0, 3))}`,
      );
      assert.match(
        path.basename(r.args[3]),
        /^cgui-cc-\d+-\d+\.bat$/,
        `${label} 第 4 个参数的文件名应形如 cgui-cc-<数字>-<数字>.bat,实际 ${JSON.stringify(r.args[3])}`,
      );
      assert.equal(
        path.dirname(r.args[3]),
        TMP,
        `${label} 第 4 个参数所在目录应恰为 os.tmpdir()(${TMP}),实际 ${JSON.stringify(r.args[3])}`,
      );
      assert.equal(r.scriptExisted, true, `${label} 第 4 个参数指向的脚本文件应存在,路径 ${JSON.stringify(r.args[3])}`);
    }
  },
);

test(
  'W10 三份 Windows 脚本:接口回 HTTP 200,JSON 里 ok / launched 为 true、platform 为 "win32"',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    for (const s of WIN_SCENARIOS) {
      const label = `W10 [${s.name}]`;
      const r = await winRun(s);
      assert.equal(r.status, 200, `${label} HTTP 状态码应为 200,实际 ${r.status},响应体 ${r.rawBody}`);
      assert.ok(r.json !== null && typeof r.json === 'object', `${label} 响应体应是 JSON 对象,实际 ${r.rawBody}`);
      assert.equal(r.json.ok, true, `${label} ok 应为 true,实际 ${JSON.stringify(r.json.ok)},响应体 ${r.rawBody}`);
      assert.equal(r.json.launched, true, `${label} launched 应为 true,实际 ${JSON.stringify(r.json.launched)},响应体 ${r.rawBody}`);
      assert.equal(r.json.platform, 'win32', `${label} platform 应为 "win32",实际 ${JSON.stringify(r.json.platform)},响应体 ${r.rawBody}`);
    }
  },
);

// ───────────────────────────── 其他平台不变 P1 / P2 ─────────────────────────────

test(
  'P1 darwin + claude-install(native):open 只收到 1 个 .command 参数,脚本以 #!/bin/bash 开头且不含 chcp',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const r = await launch({ platform: 'darwin', route: '/api/claude-install', body: { method: 'native' } });
    const script = requireScript(r, 'P1');
    assert.equal(r.args.length, 1, `P1 假 open 应恰好收到 1 个参数,实际 ${r.args.length} 个: ${JSON.stringify(r.args)}`);
    assert.ok(r.args[0].endsWith('.command'), `P1 唯一的参数应是以 .command 结尾的文件,实际 ${JSON.stringify(r.args[0])}`);
    assert.equal(
      script.subarray(0, Buffer.byteLength(SHEBANG)).toString('utf8'),
      SHEBANG,
      `P1 脚本应以 ${JSON.stringify(SHEBANG)} 开头,实际开头是 ${headOf(script)}`,
    );
    assert.equal(/chcp/i.test(script.toString('utf8')), false, 'P1 macOS 脚本全文不应含 chcp');
  },
);

test(
  'P2 linux + claude-install(native):终端收到 -e 和 bash "<.sh 路径>",脚本以 #!/bin/bash 开头且不含 chcp',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const r = await launch({ platform: 'linux', route: '/api/claude-install', body: { method: 'native' } });
    const script = requireScript(r, 'P2');
    assert.equal(r.args.length, 2, `P2 假终端应恰好收到 2 个参数,实际 ${r.args.length} 个: ${JSON.stringify(r.args)}`);
    assert.equal(r.args[0], '-e', `P2 第 1 个参数应为 "-e",实际 ${JSON.stringify(r.args[0])}`);
    assert.match(
      r.args[1],
      /^bash ".+\.sh"$/,
      `P2 第 2 个参数应形如 bash "<以 .sh 结尾的文件路径>",实际 ${JSON.stringify(r.args[1])}`,
    );
    assert.equal(
      script.subarray(0, Buffer.byteLength(SHEBANG)).toString('utf8'),
      SHEBANG,
      `P2 脚本应以 ${JSON.stringify(SHEBANG)} 开头,实际开头是 ${headOf(script)}`,
    );
    assert.equal(/chcp/i.test(script.toString('utf8')), false, 'P2 Linux 脚本全文不应含 chcp');
  },
);
