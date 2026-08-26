#!/usr/bin/env node
// r63:npm 分发通道组装脚本(INTERFACE §3.3)。
// 读 CI 产物目录 → 定位 mac tar.gz 与 win setup.exe → 生成三个待发布包目录:
//   @wsxwj123/cc-gui-darwin-arm64 / @wsxwj123/cc-gui-win32-x64 / @wsxwj123/cc-gui
// 纯 node:fs/path,零依赖。所有校验都在创建输出目录之前完成 —— 失败不产出任何半成品。
// 本地(非 GITHUB_ACTIONS)组装会在输出目录写 .local-assembly 标记,CI 发布前断言其不存在,
// 保证本地组装永远可用于测试、永远发不出去(I7 隐私机制)。
// 用法:node scripts/build-npm-packages.mjs --artifacts <dir> --out <dir> [--version <x.y.z>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAC_MIN = 14 * 1024 * 1024;
const WIN_MIN = 50 * 1024 * 1024;
const MAIN_PKG = '@wsxwj123/cc-gui';
const MAC_PKG = '@wsxwj123/cc-gui-darwin-arm64';
const WIN_PKG = '@wsxwj123/cc-gui-win32-x64';

function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--artifacts') out.artifacts = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--version') out.version = argv[++i];
    else die('未知参数：' + argv[i]);
  }
  return out;
}

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// mac tgz 版本读取:解包到专属临时目录 + node:fs 递归找 Contents/Resources/_up_/package.json。
// 不用 tar 通配参数(--wildcards 是 GNU 专有,macOS bsdtar 直接报错,I5 修订)。
function readMacAppVersion(tgz) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgui-npm-asm-'));
  try {
    const r = spawnSync('/usr/bin/tar', ['-xzf', tgz, '-C', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.error || r.status !== 0) return null;
    const hit = walkFiles(tmp).find((p) =>
      p.split(path.sep).slice(-4).join('/') === 'Contents/Resources/_up_/package.json');
    if (!hit) return null;
    try { return JSON.parse(fs.readFileSync(hit, 'utf8')).version || null; } catch { return null; }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

const args = parseArgs(process.argv.slice(2));
if (!args.artifacts || !args.out) die('用法：node scripts/build-npm-packages.mjs --artifacts <dir> --out <dir> [--version <x.y.z>]');

// ── 校验区(全部通过才动盘) ──────────────────────────────────────────
const artifactsDir = path.resolve(args.artifacts);
if (!fs.existsSync(artifactsDir) || !fs.statSync(artifactsDir).isDirectory()) {
  die('产物目录不存在：' + args.artifacts);
}
const outDir = path.resolve(args.out);
if (fs.existsSync(outDir)) {
  // 绝不递归删除已有目录 —— 清理交给调用方手动做
  die('输出目录已存在，请先手动清理：' + args.out);
}
const version = args.version !== undefined ? args.version
  : (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '');
if (!/^\d+\.\d+\.\d+$/.test(version)) die('版本号格式非法：' + version);

// 定位两个载荷:递归遍历、按后缀匹配、各取第一个(不硬编码 artifact 目录名)
const all = walkFiles(artifactsDir);
const macTgz = all.find((p) => p.endsWith('.app.tar.gz'));
if (!macTgz) die('产物目录里没有 *.app.tar.gz（macOS 构建可能失败）');
const winExe = all.find((p) => p.endsWith('-setup.exe'));
if (!winExe) die('产物目录里没有 *-setup.exe（Windows 构建可能失败）');

// Windows 安装包版本取自文件名(CC-GUI_<V>_x64-setup.exe)
const exeName = path.basename(winExe);
const exeVerMatch = /_(\d+\.\d+\.\d+)_x64-setup\.exe$/.exec(exeName);
if (!exeVerMatch || exeVerMatch[1] !== version) {
  die('Windows 安装包版本不符：文件名 ' + exeName + '，期望 ' + version);
}

// 私有产物内省(I7):tar -tzf 列文件名,命中 *.local.js|jsx|cjs 即拒绝组装
const list = spawnSync('/usr/bin/tar', ['-tzf', macTgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (list.error || list.status !== 0) {
  die('macOS 应用包结构异常，未找到 Contents/Resources/_up_/package.json');
}
const privHit = String(list.stdout).split('\n').find((l) => /\/[^/]+\.local\.(js|jsx|cjs)$/.test(l.trim()));
if (privHit) {
  die('检测到本机私有构建产物，拒绝组装 npm 包：' + privHit.trim());
}

// macOS 应用包内版本必须等于 --version
const macVer = readMacAppVersion(macTgz);
if (macVer === null) die('macOS 应用包结构异常，未找到 Contents/Resources/_up_/package.json');
if (macVer !== version) die('macOS 应用包版本不符：包内 ' + macVer + '，期望 ' + version);

// 体积下限(A4:实际产物的约 70%,截断产物必须在这里被拦住而不是装机时才炸)
const macSize = fs.statSync(macTgz).size;
if (macSize < MAC_MIN) die('产物体积异常偏小，疑似构建失败：' + path.basename(macTgz) + ' ' + macSize);
const winSize = fs.statSync(winExe).size;
if (winSize < WIN_MIN) die('产物体积异常偏小，疑似构建失败：' + exeName + ' ' + winSize);

const licensePath = path.join(ROOT, 'LICENSE');
if (!fs.existsSync(licensePath)) die('缺少 LICENSE 文件');

// ── 组装区(校验已全过) ──────────────────────────────────────────────
const pkgCommon = { license: 'MIT', publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' } };

const macDir = path.join(outDir, 'cc-gui-darwin-arm64');
fs.mkdirSync(macDir, { recursive: true });
writeJson(path.join(macDir, 'package.json'), {
  name: MAC_PKG,
  version,
  description: 'CC-GUI macOS (Apple Silicon) 应用包',
  license: pkgCommon.license,
  os: ['darwin'],
  cpu: ['arm64'],
  files: ['CC-GUI.app.tar.gz'],
  publishConfig: pkgCommon.publishConfig,
});
fs.copyFileSync(macTgz, path.join(macDir, 'CC-GUI.app.tar.gz'));

const winDir = path.join(outDir, 'cc-gui-win32-x64');
fs.mkdirSync(winDir, { recursive: true });
writeJson(path.join(winDir, 'package.json'), {
  name: WIN_PKG,
  version,
  description: 'CC-GUI Windows (x64) 安装器',
  license: pkgCommon.license,
  os: ['win32'],
  cpu: ['x64'],
  files: ['CC-GUI-setup.exe'],
  publishConfig: pkgCommon.publishConfig,
});
// 载荷改成不带版本号的固定名,启动器按常量路径取
fs.copyFileSync(winExe, path.join(winDir, 'CC-GUI-setup.exe'));

// 主包:npm/package.json 为字段模板(单一事实源),版本由本脚本注入
const mainDir = path.join(outDir, 'cc-gui');
fs.mkdirSync(mainDir, { recursive: true });
const mainPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'npm', 'package.json'), 'utf8'));
mainPkg.version = version;
mainPkg.optionalDependencies = { [MAC_PKG]: version, [WIN_PKG]: version };
writeJson(path.join(mainDir, 'package.json'), mainPkg);
fs.mkdirSync(path.join(mainDir, 'bin'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'npm', 'bin', 'cc-gui.js'), path.join(mainDir, 'bin', 'cc-gui.js'));
fs.mkdirSync(path.join(mainDir, 'lib'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'npm', 'lib', 'main.js'), path.join(mainDir, 'lib', 'main.js'));
fs.copyFileSync(path.join(ROOT, 'npm', 'README.md'), path.join(mainDir, 'README.md'));
fs.copyFileSync(licensePath, path.join(mainDir, 'LICENSE'));

// 本地组装标记(I7):非 CI 环境组装出的目录永远发不出去(CI 发布步骤断言该文件不存在)
if (process.env.GITHUB_ACTIONS !== 'true') {
  fs.writeFileSync(path.join(outDir, '.local-assembly'),
    '组装时间：' + new Date().toISOString() + '\n主机：' + os.hostname() + '\n');
  process.stdout.write('[本地组装] 此目录带 .local-assembly 标记，CI 发布步骤会拒绝发布它\n');
}

// 成功输出:最后一行 JSON,packages 顺序即发布顺序(平台包在前、主包最后)
process.stdout.write(JSON.stringify({
  version,
  packages: [
    { name: MAC_PKG, dir: macDir },
    { name: WIN_PKG, dir: winDir },
    { name: MAIN_PKG, dir: mainDir },
  ],
}) + '\n');
