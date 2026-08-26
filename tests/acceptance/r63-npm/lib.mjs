// r63-npm 验收测试公共库(零依赖)。只依据 .devflow/INTERFACE-r63-npm.md 的对外约定,
// 不 import 任何实现模块;所有断言都走"外部入口":bin 命令、包结构文件、CLI、HTTP。
//
// ⚠️ 安全:凡是会写盘的用例一律把子进程的 HOME 指到临时目录,并在跑之前/之后核对
//    真实 ~/Applications 与 ~/.claude-gui 没被动过(guardRealHome)。HOME 隔离失效时
//    立刻抛错,绝不允许测试把用户真正装着的 CC-GUI.app 换掉。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const P = {
  bin: path.join(ROOT, 'npm/bin/cc-gui.js'),
  lib: path.join(ROOT, 'npm/lib/main.js'),
  mainPkg: path.join(ROOT, 'npm/package.json'),
  build: path.join(ROOT, 'scripts/build-npm-packages.mjs'),
  workflow: path.join(ROOT, '.github/workflows/tauri.yml'),
};
export const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const MAIN = '@wsxwj123/cc-gui';
export const MACPKG = '@wsxwj123/cc-gui-darwin-arm64';
export const WINPKG = '@wsxwj123/cc-gui-win32-x64';

/** 未实现即失败,并说清缺的是哪个交付物(而不是抛一个费解的 ENOENT)。 */
export function need(p, what) {
  if (!fs.existsSync(p)) throw new Error(`缺少交付物:${what}\n  期望路径:${p}\n  (功能尚未实现时本条必然红,属预期)`);
  return p;
}
export function read(p, what) { return fs.readFileSync(need(p, what), 'utf8'); }
export function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

const TMPS = [];
export function mkTmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cgui-r63-${tag}-`));
  TMPS.push(d);
  return d;
}
export function cleanupTmps() { for (const d of TMPS.splice(0)) rmrf(d); }

/** 同步跑一条命令,永不抛。返回 {code, stdout, stderr, signal}。 */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts });
  return {
    code: r.status, signal: r.signal,
    stdout: r.stdout || '', stderr: r.stderr || '',
    all: (r.stdout || '') + (r.stderr || ''),
    err: r.error,
  };
}
export function node(args, opts) { return run(process.execPath, args, opts); }

// ── 产物 fixture(缓存复用,首次生成约 1 秒;体积必须过 §2.2 S3 的下限:mac 14MB / win 50MB)
const CACHE = path.join(os.tmpdir(), `cgui-r63-fixtures-${V}`);
export const MAC_MIN = 14 * 1024 * 1024;
export const WIN_MIN = 50 * 1024 * 1024;

function bigBlob(p, bytes) {
  const fd = fs.openSync(p, 'w');
  // 随机字节:确保 gzip 压不动,tgz 成品仍 > 14MB(可压缩的零填充会缩到几 KB)
  for (let i = 0; i < bytes; i += 1 << 20) fs.writeSync(fd, crypto.randomBytes(Math.min(1 << 20, bytes - i)));
  fs.closeSync(fd);
}

/** 造一个形似 Tauri 产物的 .app 目录。variant: 'good' | 'no-exec' */
export function makeApp(dir, appName, version, variant = 'good') {
  const app = path.join(dir, appName);
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources/_up_'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Resources/_up_/package.json'),
    JSON.stringify({ name: 'claude-gui', version }));
  if (variant !== 'no-exec') {
    fs.writeFileSync(path.join(app, 'Contents/MacOS/CC-GUI'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(app, 'Contents/MacOS/CC-GUI'), 0o755);
  }
  return app;
}

/**
 * 缓存版 mac 载荷。kind:
 *  good-<ver>  正常(内含 <ver> 版 .app,>14MB)
 *  badgz       体积够但不是合法 gzip
 *  noapp       合法 tgz 但里面没有 *.app 目录
 *  noexec      有 .app 但 Contents/MacOS 下没有可执行文件
 *  twoapp      里面有两个 *.app 目录
 */
export function macPayload(kind) {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, `${kind}.app.tar.gz`);
  if (fs.existsSync(out) && fs.statSync(out).size > MAC_MIN) return out;
  if (kind === 'badgz') { bigBlob(out, MAC_MIN + (1 << 20)); return out; }
  const stage = fs.mkdtempSync(path.join(CACHE, 'stage-'));
  if (kind === 'noapp') fs.mkdirSync(path.join(stage, 'CC-GUI-not-an-app'), { recursive: true });
  else {
    const ver = kind.startsWith('good-') ? kind.slice(5) : V;
    makeApp(stage, 'CC-GUI.app', ver, kind === 'noexec' ? 'no-exec' : 'good');
    if (kind === 'twoapp') makeApp(stage, 'Other.app', ver);
    if (kind.startsWith('priv-')) { // 模拟本机带 bot 的私有构建混进 CI 产物,如 priv-local.js
      const d = path.join(stage, 'CC-GUI.app/Contents/Resources/_up_/server/routes');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'bots.' + kind.slice(5)), '// 私有产物\n');
    }
  }
  bigBlob(path.join(stage, kind === 'noapp' ? 'CC-GUI-not-an-app/blob.bin' : 'CC-GUI.app/Contents/Resources/blob.bin'), MAC_MIN + (1 << 20));
  const r = run('/usr/bin/tar', ['-czf', out, '-C', stage, '.']);
  rmrf(stage);
  if (r.code !== 0) throw new Error('fixture 打包失败:' + r.all);
  return out;
}

// ── 假装"npm 已经把包装好了"的目录树。启动器从这里被真实调用。
/**
 * opts: { version, payload:<路径|null>, payloadName, platformPkg:true, home, makeApplications:true }
 * 返回 { dir, home, appRoot, marker, bin }
 */
export function fakeInstall(opts = {}) {
  const version = opts.version || V;
  const home = opts.home || mkTmp('home');
  if (opts.makeApplications !== false) fs.mkdirSync(path.join(home, 'Applications'), { recursive: true });
  const dir = mkTmp('inst');
  fs.cpSync(path.dirname(need(P.bin, 'npm/bin/cc-gui.js 启动器薄壳')), path.join(dir, 'bin'), { recursive: true });
  fs.cpSync(path.dirname(need(P.lib, 'npm/lib/main.js 启动器主体')), path.join(dir, 'lib'), { recursive: true });
  const pkg = JSON.parse(read(P.mainPkg, 'npm/package.json 主包清单'));
  pkg.version = version;
  if (pkg.optionalDependencies) for (const k of Object.keys(pkg.optionalDependencies)) pkg.optionalDependencies[k] = version;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  if (opts.platformPkg !== false) {
    const pd = path.join(dir, 'node_modules', MACPKG);
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, 'package.json'),
      JSON.stringify({ name: MACPKG, version, os: ['darwin'], cpu: ['arm64'] }));
    if (opts.payload) fs.symlinkSync(opts.payload, path.join(pd, opts.payloadName || 'CC-GUI.app.tar.gz'));
  }
  return { dir, home, bin: path.join(dir, 'bin/cc-gui.js'),
    appRoot: path.join(home, 'Applications/CC-GUI.app'),
    marker: path.join(home, '.claude-gui/npm-install.json') };
}

/** 以隔离 HOME 跑启动器。preflight 会确认子进程真的认这个 HOME。 */
export function runLauncher(inst, extra = {}) {
  const probe = node(['-p', 'require("os").homedir()'], { env: { ...process.env, HOME: inst.home } });
  if (probe.stdout.trim() !== inst.home) throw new Error('HOME 隔离失效,拒绝继续(否则会动到真实 ~/Applications)');
  const before = guardRealHome();
  const r = node([inst.bin, ...(extra.args || [])], {
    env: { ...process.env, HOME: inst.home, USERPROFILE: inst.home, ...(extra.env || {}) },
    cwd: extra.cwd || inst.dir, timeout: extra.timeout || 120000,
  });
  guardRealHome(before);
  return r;
}

/** 真实用户目录的关键位点快照/比对——测试绝不允许碰它们。 */
export function guardRealHome(before) {
  const h = os.homedir();
  const app = path.join(h, 'Applications/CC-GUI.app');
  const mk = path.join(h, '.claude-gui/npm-install.json');
  const now = {
    apps: fs.existsSync(path.join(h, 'Applications')) ? fs.readdirSync(path.join(h, 'Applications')).sort().join('|') : '<none>',
    app: fs.existsSync(app) ? String(fs.statSync(app).mtimeMs) : '<none>',
    marker: fs.existsSync(mk) ? fs.readFileSync(mk, 'utf8') : '<none>',
  };
  if (before) for (const k of Object.keys(now)) {
    if (before[k] !== now[k]) throw new Error(`测试污染了真实用户目录(${k})!before=${before[k]} after=${now[k]}`);
  }
  return now;
}

/** 缓存版 win 载荷(内容无意义,只用于体积/命名契约)。 */
export function winPayload(bytes = WIN_MIN + (1 << 20)) {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, `setup-${bytes}.exe`);
  if (!fs.existsSync(out) || fs.statSync(out).size !== bytes) bigBlob(out, bytes);
  return out;
}

/** 在隔离 HOME 里预置一份"已装好的应用"。 */
export function preinstallApp(inst, version) {
  rmrf(inst.appRoot);
  fs.mkdirSync(path.dirname(inst.appRoot), { recursive: true });
  makeApp(path.dirname(inst.appRoot), 'CC-GUI.app', version);
  fs.writeFileSync(path.join(inst.appRoot, 'MINE.txt'), 'preinstalled'); // 用来判断有没有被换掉
  return inst.appRoot;
}
export function appVersion(appRoot) {
  return JSON.parse(fs.readFileSync(path.join(appRoot, 'Contents/Resources/_up_/package.json'), 'utf8')).version;
}
/** ~/Applications 下遗留的 .cc-gui-* 中间目录(正常收尾后必须为空)。 */
export function strays(inst) {
  const d = path.join(inst.home, 'Applications');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => n.startsWith('.cc-gui-')).sort();
}

/**
 * 造 CI 那样的 dist-artifacts 目录(刻意放进多层嵌套子目录,验证脚本不硬编码 artifact 目录名)。
 * opts: { version, mac:<路径|null>, win:<路径|null>, winName }
 */
export function makeArtifacts(opts = {}) {
  const version = opts.version || V;
  const root = path.join(mkTmp('art'), 'dist-artifacts');
  const macDir = path.join(root, 'cc-gui-macos-latest', 'nested');
  const winDir = path.join(root, 'cc-gui-windows-latest');
  fs.mkdirSync(macDir, { recursive: true });
  fs.mkdirSync(winDir, { recursive: true });
  const mac = opts.mac === null ? null : (opts.mac || macPayload('good-' + version));
  if (mac) fs.copyFileSync(mac, path.join(macDir, 'CC-GUI.app.tar.gz'));
  const win = opts.win === null ? null : (opts.win || winPayload());
  if (win) fs.copyFileSync(win, path.join(winDir, opts.winName || `CC-GUI_${version}_x64-setup.exe`));
  return root;
}

/** 跑一次组装脚本。opts 同 makeArtifacts,外加 { out, version, args, env }。 */
export function assemble(opts = {}) {
  const version = opts.version || V;
  const artifacts = opts.artifacts || makeArtifacts(opts);
  const out = opts.out || path.join(mkTmp('out'), 'npm-dist');
  const args = opts.args || ['--artifacts', artifacts, '--out', out, '--version', version];
  const r = node([need(P.build, 'scripts/build-npm-packages.mjs 组装脚本'), ...args],
    { env: { ...process.env, GITHUB_ACTIONS: '', ...(opts.env || {}) } });
  return { out, artifacts, r, version };
}

// 交付物还没实现时,顶层 read/need 会抛。这里把它变成一行人话,而不是一屏栈。
process.on('uncaughtException', (e) => {
  console.log('FAIL - 测试文件无法启动');
  console.log('       ' + String(e && e.message || e).split('\n').join('\n       '));
  process.exit(1);
});

// ── 极简用例壳(不引框架):每条用例只测一件事,互不依赖,失败不中断后面的用例
let pass = 0, fail = 0, skipped = 0;
export async function t(name, fn) {
  try { await fn(); pass++; console.log('ok   - ' + name); }
  catch (e) {
    fail++;
    console.log('FAIL - ' + name);
    console.log('       ' + String(e && e.message || e).split('\n').join('\n       '));
  }
}
export function skip(name, why) { skipped++; console.log('skip - ' + name + '  ← ' + why); }
export function done(label) {
  cleanupTmps();
  console.log(`\n[${label}] 通过 ${pass} / 失败 ${fail} / 跳过 ${skipped}`);
  process.exit(fail ? 1 : 0);
}
