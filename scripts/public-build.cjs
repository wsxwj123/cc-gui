#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { existsSync, mkdirSync, readdirSync, renameSync, statSync } = require('fs');
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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CGUI_PUBLIC_BUILD: '1' },
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
}

if (status !== 0) process.exit(status);
process.exit(run('node', ['scripts/audit-public.cjs']));
