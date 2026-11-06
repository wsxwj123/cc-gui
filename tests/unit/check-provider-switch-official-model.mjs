#!/usr/bin/env node
// provider-default-model:「官方 → 第三方 → 再切回官方」后 env.ANTHROPIC_MODEL 不再一律被打回
// claude-sonnet-4-6。取值顺序:显式选的 Claude 模型 > env 里已有的 Claude 非 haiku 值 >
// 顶层 model(Claude 且非 haiku) > claude-sonnet-4-6。haiku 防线保留。
// 对外接口 = POST /api/provider/switch(body { id, model? })+ 它写的 ~/.claude/settings.json。
// 写法同 check-r145-settings-corrupt-nowrite.mjs:临时 HOME(先于 import)+ express 只挂 settings 路由。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateHome, writeFakeCommand, listenInRange, makeChecker } from './r145-helpers/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
void root;
const { home, bin, cleanup } = isolateHome('provider-default-model');
writeFakeCommand(bin, 'security', 'process.exit(1);\n');
const CLAUDE_DIR = join(home, '.claude');
const GUI_DIR = join(home, '.claude-gui');
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
mkdirSync(CLAUDE_DIR, { recursive: true });
mkdirSync(GUI_DIR, { recursive: true });

// 没有任何 cc-switch 库 → dbRows 为空,withBuiltinOfficial 补合成官方行,bid 用 builtin-official。
const settingsRouter = (await import('../../server/routes/settings.js')).default;
const express = (await import('express')).default;
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api', settingsRouter);
const httpServer = createServer(app);
const apiPort = await listenInRange(httpServer);
const BASE = `http://127.0.0.1:${apiPort}`;

const S = 'claude-sonnet-4-6';
// 第三方切走时残留的 env(基座)。
const RESIDUE = {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'sk-residue',
  ANTHROPIC_MODEL: 'deepseek-chat',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-chat',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
};
const RESIDUE_KEYS = Object.keys(RESIDUE).filter((k) => k !== 'ANTHROPIC_MODEL');

async function switchOfficial(body = {}) {
  const r = await fetch(`${BASE}/api/provider/switch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'builtin-official', ...body }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保持 null */ }
  return { status: r.status, json, text };
}
function seed(settings) { writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); }
function read() { return JSON.parse(readFileSync(SETTINGS, 'utf8')); }

const { check, finish } = makeChecker('check-provider-switch-official-model');
let exitCode = 1;
try {
  await check('1 全局 opus + 第三方残留 → env.ANTHROPIC_MODEL = opus,残留清空,顶层 model 不变', async () => {
    seed({ model: 'claude-opus-4-6', env: { ...RESIDUE } });
    const r = await switchOfficial();
    assert.equal(r.status, 200, `应 200,实际 ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.json?.via, 'official');
    const after = read();
    assert.equal(after.env?.ANTHROPIC_MODEL, 'claude-opus-4-6', `env.ANTHROPIC_MODEL 实际为 ${after.env?.ANTHROPIC_MODEL}`);
    for (const k of RESIDUE_KEYS) assert.ok(!(k in after.env), `残留 ${k} 未被清掉`);
    assert.equal(after.model, 'claude-opus-4-6', '顶层 model 不该被改');
  });

  await check('2 全局是别名 opus → env.ANTHROPIC_MODEL = opus', async () => {
    seed({ model: 'opus', env: { ...RESIDUE } });
    await switchOfficial();
    assert.equal(read().env?.ANTHROPIC_MODEL, 'opus');
  });

  await check('3 全局带 1M 后缀 → 原样写入 env.ANTHROPIC_MODEL', async () => {
    seed({ model: 'claude-opus-4-6[1m]', env: { ...RESIDUE } });
    await switchOfficial();
    assert.equal(read().env?.ANTHROPIC_MODEL, 'claude-opus-4-6[1m]');
  });

  await check('4 env 被钉成 haiku + 全局 opus(无残留)→ env.ANTHROPIC_MODEL = opus', async () => {
    seed({ model: 'claude-opus-4-6', env: { ANTHROPIC_MODEL: 'claude-haiku-4-5' } });
    await switchOfficial();
    assert.equal(read().env?.ANTHROPIC_MODEL, 'claude-opus-4-6');
  });

  await check('5 连着切两次 → 两次都是 opus(稳定,不回退 sonnet)', async () => {
    seed({ model: 'claude-opus-4-6', env: { ...RESIDUE } });
    await switchOfficial();
    assert.equal(read().env?.ANTHROPIC_MODEL, 'claude-opus-4-6', '第一次切换后被打了回去');
    await switchOfficial();
    assert.equal(read().env?.ANTHROPIC_MODEL, 'claude-opus-4-6', '第二次切换后被打了回去');
  });

  await check('6 显式选择优先:model=sonnet → env = sonnet,顶层 model 也变 sonnet', async () => {
    seed({ model: 'claude-opus-4-6', env: { ...RESIDUE } });
    await switchOfficial({ model: S });
    const after = read();
    assert.equal(after.env?.ANTHROPIC_MODEL, S);
    assert.equal(after.model, S);
  });

  await check('7 已钉的 Claude 模型保留:env = sonnet + 全局 opus → 仍是 sonnet', async () => {
    seed({ model: 'claude-opus-4-6', env: { ANTHROPIC_MODEL: S } });
    await switchOfficial();
    assert.equal(read().env?.ANTHROPIC_MODEL, S);
  });

  await check('8 全局是 haiku 不采用(含别名 haiku)→ env = sonnet,顶层 model 不被改', async () => {
    for (const m of ['claude-haiku-4-5', 'haiku']) {
      seed({ model: m, env: { ...RESIDUE } });
      await switchOfficial();
      const after = read();
      assert.equal(after.env?.ANTHROPIC_MODEL, S, `顶层 model=${m} 时 env 应为 sonnet,实际 ${after.env?.ANTHROPIC_MODEL}`);
      assert.equal(after.model, m, `顶层 model=${m} 不该被改`);
    }
  });

  await check('9 全局不是 Claude 模型不采用 → env = sonnet,顶层 model 保持原值', async () => {
    seed({ model: 'deepseek-chat', env: { ...RESIDUE } });
    await switchOfficial();
    const after = read();
    assert.equal(after.env?.ANTHROPIC_MODEL, S);
    assert.equal(after.model, 'deepseek-chat');
  });

  await check('10 两者都没有 → env = sonnet', async () => {
    seed({ env: { ...RESIDUE } });
    await switchOfficial();
    assert.equal(read().env?.ANTHROPIC_MODEL, S);
  });

  await check('11 别的设置不丢:hooks / permissions / FOO 原样保留', async () => {
    const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep' }] }] };
    const permissions = { allow: ['Bash(ls:*)'] };
    seed({ model: 'claude-opus-4-6', hooks, permissions, env: { ...RESIDUE, FOO: 'bar' } });
    await switchOfficial();
    const after = read();
    assert.deepEqual(after.hooks, hooks, 'hooks 丢了');
    assert.deepEqual(after.permissions, permissions, 'permissions 丢了');
    assert.equal(after.env?.FOO, 'bar', '不相关的 env 键丢了');
    assert.equal(after.env?.ANTHROPIC_MODEL, 'claude-opus-4-6');
  });

  exitCode = finish();
} finally {
  cleanup();
}
// settings.js / 代理模块有未 unref 的定时器与监听:显式退出。
process.exit(exitCode);
