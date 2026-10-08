#!/usr/bin/env node
// r145 F4:服务端主动中止回合(停止 / 关闭 / 看门狗拆进程,都走本 slot 的 abort.abort())时,SDK 泵的
// catch 只按 `e?.name !== 'AbortError'` 判 —— 而 SDK 0.3.273 抛的 AbortError 实例 name === 'Error'
// (类名被压缩,已实测),于是流里多出一条 {"type":"error","error":"Claude Code process aborted by user"},
// 前端当成报错。修好后:本 slot 的 abort 信号已触发,或异常是 SDK 的 AbortError 实例 → 不发 error 行;
// 其它异常照旧发。
//
// 为什么不端到端驱动 /chat:那要一个实现 SDK 控制协议(initialize / stream-json 往返)的假 CLI 并走完整个
// /chat 路由(会话索引、MCP 配置、权限桥),代价与风险都远超这一行判据。改为:判据抽成导出的纯函数
// isSelfAbortError(err, signal) 做行为断言(用 SDK 真实导出的 AbortError 构造异常),再加一条接线断言锁住
// 泵的 catch 确实用它决定发不发 error 行。HOME 先指临时目录再 import chat.js(模块加载期绑定路径)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import { isolateHome, makeChecker } from './r145-helpers/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { cleanup } = isolateHome('f4');
let mod = null;
let importErr = '';
try { mod = await import('../../server/routes/chat.js'); } catch (e) { importErr = String(e?.message || e); }
const fn = mod?.isSelfAbortError;
const need = () => assert.equal(typeof fn, 'function', `server/routes/chat.js 应导出 isSelfAbortError(err, signal)(import 错误:${importErr || '无'})`);
const fired = () => { const ac = new AbortController(); ac.abort(); return ac.signal; };
const idle = () => new AbortController().signal;

const { check, finish } = makeChecker('check-r145-abort-no-error-line');
let exitCode = 1;
try {
  console.log('F4 · 前提(实测 SDK 行为,修前修后都应成立)');
  await check('SDK 0.3.273 的 AbortError 实例 name 是 "Error" —— 按 name 判一定漏', () => {
    const e = new AbortError('Claude Code process aborted by user');
    assert.ok(e instanceof AbortError);
    assert.equal(e.name, 'Error');
  });

  console.log('F4 · 判据(本 slot 被主动中止 → 不发 error 行;其它异常照发)');
  await check('SDK AbortError(信号未触发)→ 视为主动中止', () => {
    need();
    assert.equal(fn(new AbortError('Claude Code process aborted by user'), idle()), true);
  });
  await check('任意异常,但本 slot 的 abort 信号已触发 → 视为主动中止', () => {
    need();
    assert.equal(fn(new Error('Claude Code process aborted by user'), fired()), true);
    assert.equal(fn(new Error('socket hang up'), fired()), true);
  });
  await check('标准 DOM AbortError(name === "AbortError")→ 仍视为中止(旧判据的兼容面不丢)', () => {
    need();
    assert.equal(fn(new DOMException('aborted', 'AbortError'), idle()), true);
  });
  await check('普通异常且信号未触发 → 不是中止(照旧发 error 行)', () => {
    need();
    assert.equal(fn(new Error('API Error: 500 upstream'), idle()), false);
    assert.equal(fn(new Error('Claude Code process exited with code 1'), idle()), false);
    assert.equal(fn(undefined, idle()), false);
  });

  console.log('F4 · 接线');
  await check('SDK 泵的 catch 用 isSelfAbortError(e, abort.signal) 决定是否发 error 行,不再只按 name 判', () => {
    const src = readFileSync(join(root, 'server', 'routes', 'chat.js'), 'utf8');
    const at = src.indexOf("deliverLine(slot, JSON.stringify({ type: 'error', error: e?.message || String(e) }))");
    assert.ok(at > 0, '找不到泵 catch 里发 error 行的那一句');
    const head = src.slice(Math.max(0, at - 600), at);
    const catchAt = head.lastIndexOf('} catch (e) {');
    assert.ok(catchAt >= 0, '发 error 行的那一句不在 catch (e) 块里');
    const guard = head.slice(catchAt);
    assert.match(guard, /isSelfAbortError\(\s*e\s*,\s*abort\.signal\s*\)/, '泵的 catch 没用本 slot 的 abort 信号判中止');
    assert.doesNotMatch(guard, /if \(e\?\.name !== 'AbortError'\)/, '仍然只按 e.name 判(SDK 的 AbortError name 是 "Error")');
  });

  exitCode = finish();
} finally {
  cleanup();
}
process.exit(exitCode);
