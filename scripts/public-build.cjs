#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const stashRoot = path.join(root, '.cgui-local-disabled');

function walk(dir, matcher, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, matcher, out);
    else if (matcher.test(name)) out.push(full);
  }
  return out;
}

function moveLocalFilesOut(moved) {
  const files = [
    ...walk(path.join(root, 'server', 'routes'), /\.local\.js$/),
    ...walk(path.join(root, 'client', 'src'), /\.local\.jsx$/),
  ];
  for (const file of files) {
    const relative = path.relative(root, file);
    const dest = path.join(stashRoot, relative);
    if (existsSync(dest)) {
      throw new Error(`temporary local stash already exists: ${path.relative(root, dest)}`);
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(file, dest);
    moved.push([dest, file]);
  }
}

function restoreLocalFiles(moved) {
  for (const [from, to] of moved.reverse()) {
    if (!existsSync(from)) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
  }
}

// macOS 本地构建:若钥匙串里有持久自签证书 LocalCodeSign,用它替代 adhoc 签名。
// adhoc 的 cdhash 每次构建都变,TCC/FDA 授权随之失效;证书签名的 Designated
// Requirement 锚定证书本身,重建后授权存活。CI runner 无此证书 → 自动回落 adhoc。
function localSignEnv() {
  if (process.platform !== 'darwin' || process.env.APPLE_SIGNING_IDENTITY) return {};
  const probe = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (probe.status === 0 && /"LocalCodeSign"/.test(probe.stdout || '')) {
    console.log('[public-build] 使用持久自签证书 LocalCodeSign 签名(FDA 授权跨 build 存活)');
    return { APPLE_SIGNING_IDENTITY: 'LocalCodeSign' };
  }
  return {};
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CGUI_PUBLIC_BUILD: '1', ...(args[1] === 'build' && command === 'cargo' ? localSignEnv() : {}) },
  });
  if (result.error) throw result.error;
  if (result.signal) return 1;
  return result.status ?? 1;
}

const mode = process.argv[2] || 'build';
const command = mode === 'tauri'
  ? ['cargo', ['tauri', 'build']]
  : mode === 'build'
    ? ['npm', ['run', 'build:local']]
    : null;

if (!command) {
  console.error('usage: node scripts/public-build.cjs [build|tauri]');
  process.exit(2);
}

let moved = [];
let status = 1;
try {
  moveLocalFilesOut(moved);
  status = run(command[0], command[1]);
} finally {
  restoreLocalFiles(moved);
  // restoreLocalFiles only renames files back, leaving empty dir scaffolding in
  // the stash. Remove it so it doesn't accumulate. If a restore threw above, the
  // throw exits before this line, preserving the stash for manual recovery.
  try { rmSync(stashRoot, { recursive: true, force: true }); } catch {}
}

if (status !== 0) process.exit(status);
if (mode === 'tauri') process.env.CGUI_AUDIT_TAURI_BUNDLE = '1';
process.exit(run('node', ['scripts/audit-public.cjs']));
