#!/usr/bin/env node
const { execFileSync } = require('child_process');
const { existsSync, readdirSync, readFileSync, statSync } = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

function rel(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

const tracked = git(['ls-files']).trim().split('\n').filter(Boolean);
for (const file of tracked) {
  if (file === 'AGENTS.md') failures.push('AGENTS.md is tracked');
  if (file.startsWith('client/dist/')) failures.push(`${file} is tracked`);
  if (file.startsWith('.claude/')) failures.push(`${file} is tracked`);
  if (/\.local\.(js|jsx)$/.test(file)) failures.push(`${file} is tracked`);
}

for (const target of [
  'AGENTS.md',
  'server/routes/bots.local.js',
  'client/src/components/BotControl.local.jsx',
]) {
  if (!existsSync(path.join(root, target))) continue;
  try {
    git(['check-ignore', '-q', target]);
  } catch {
    failures.push(`${target} is not ignored by git`);
  }
}

const distDir = path.join(root, 'client', 'dist');
const blockedDistPath = /(?:botcontrol\.local|bots\.local|\.local\.(?:js|jsx))/i;
const blockedDistText = [
  '/api/bots/',
  '/bots/restart',
  'restart-bots.command',
  'stop-bots.command',
  'BotControl.local',
  '重启 bot',
  '停止 bot',
];
const blockedSourceText = [
  "join(CLAUDE_DIR, 'channels', 'bot2'",
  "join(CLAUDE_DIR, 'channels', 'bot3'",
  "join(CLAUDE_DIR, 'channels', 'telegram'",
  "join(CLAUDE_DIR, 'plugins', 'local', 'telegram'",
];

for (const file of walk(distDir)) {
  const relative = rel(file);
  if (blockedDistPath.test(relative)) {
    failures.push(`${relative} should not exist in public dist`);
    continue;
  }
  const st = statSync(file);
  if (st.size > 5 * 1024 * 1024) continue;
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  for (const needle of blockedDistText) {
    if (text.includes(needle)) {
      failures.push(`${relative} contains local-only marker: ${needle}`);
      break;
    }
  }
}

for (const file of tracked) {
  if (file === 'scripts/audit-public.cjs') continue;
  if (!/\.(?:js|jsx|cjs|mjs|ts|tsx)$/.test(file)) continue;
  const full = path.join(root, file);
  let text = '';
  try { text = readFileSync(full, 'utf8'); } catch { continue; }
  for (const needle of blockedSourceText) {
    if (text.includes(needle)) {
      failures.push(`${file} contains local-only source marker: ${needle}`);
      break;
    }
  }
}

if (failures.length) {
  console.error('[audit:public] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[audit:public] ok');
