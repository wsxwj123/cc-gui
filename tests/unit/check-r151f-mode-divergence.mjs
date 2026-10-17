#!/usr/bin/env node
// r151f 切档没切成时怎么处理(任务文件 .devflow/r151f-mode-divergence.md 修法 1–5 的服务端部分)。
//   ① 修法 1–3(切档接口 applyPermissionModeToSlots):只给可用进程(存活、不在关闭中、输入没关)发切档请求、只按它们计数,
//      没有可用进程 → attempted 0;没回应的中止(failed 那一项带 aborted:true),档位字段不改(撤掉 r151e 判官修复的回写);
//      回 200 时被命令行明确拒绝的也中止,回 409 时被拒的照旧保留、一个字段都不改(r49b①)。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身;临时 HOME。
// node tests/unit/check-r151f-mode-divergence.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151f-unit-')));
const HOME = join(TMP, 'home');
mkdirSync(join(HOME, '.claude'), { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
registerR151bSdkStub();
globalThis.__r151bSdkControl = {};
const chat = await import('../../server/routes/chat.js');

const eq = (a, b, msg) => assert.deepEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 切档限时的定时器是 unref 的(不拖住服务退出):没有别的活动句柄时事件循环会提前退出,这里用一个常驻定时器撑住,结尾 process.exit
setInterval(() => {}, 1_000);

// ── ① 切档接口:可用进程判据、没回应就中止、撤掉回写、被拒按整体结果定去留 ──
{
  const SID = 'sid-r151f-1';
  const mkInput = (closed = false) => ({ close() { closed = true; }, isClosed: () => closed });
  const seen = [];
  const answering = (tag) => ({ setPermissionMode: async (m) => { seen.push([tag, m]); } });
  const refusing = (tag) => ({ setPermissionMode: async () => { seen.push([tag, 'refused']); throw new Error('Cannot set permission mode to auto'); } });
  const hanging = (tag, onLate) => ({ setPermissionMode: () => { seen.push([tag, 'hung']); return new Promise((r) => { onLate?.(r); }); } });
  const mk = (query, over = {}) => ({
    sessionId: SID, exitCode: null, guiMode: 'bypassPermissions', permissionMode: 'bypassPermissions', sdkMode: 'default',
    input: mkInput(), abort: new AbortController(), runtimeTurn: { stopRequested: false }, query, ...over,
  });
  const fields = (s) => [s.guiMode, s.permissionMode, s.sdkMode];
  const untouched = ['bypassPermissions', 'bypassPermissions', 'default'];
  const killed = (s) => [!!s.closing, s.abort.signal.aborted, s.input.isClosed(), s.runtimeTurn.stopRequested];

  // 1a) 输入已关、关闭中、泵已收尾的进程:不发请求、不计数、档位字段不动;只有它们 → attempted 0(接口回 200)
  {
    seen.length = 0;
    const closedIn = mk(answering('closedIn'), { input: mkInput(true) });
    const closing = mk(answering('closing'), { closing: true });
    const ended = mk(answering('ended'), { pumpEnded: true });
    const r = await chat.applyPermissionModeToSlots(new Map([[1, closedIn], [2, closing], [3, ended]]), SID, 'default', { timeoutMs: 200 });
    eq(r, { attempted: 0, delivered: 0, failed: [] }, '1a 没有可用进程:attempted 0、delivered 0、failed 空(不算收下)');
    eq(seen, [], '1a 不可用的进程一个切档请求都不发');
    for (const s of [closedIn, closing, ended]) eq(fields(s), untouched, '1a 不可用进程的档位字段不动(不再"只改本地档位")');
    eq(closedIn.abort.signal.aborted || closing.abort.signal.aborted || ended.abort.signal.aborted, false, '1a 不可用的进程不被中止');
  }

  // 1b) 一个切成、一个没回应(回 200):没回应的被中止,failed 那一项带 aborted:true,档位字段不改(没有回写),晚到的结果也不改
  {
    seen.length = 0;
    let late = null;
    const closedIn = mk(answering('closedIn'), { input: mkInput(true) });
    const fine = mk(answering('fine'));
    const hung = mk(hanging('hung', (r) => { late = r; }));
    const t0 = Date.now();
    const r = await chat.applyPermissionModeToSlots(new Map([[1, closedIn], [2, fine], [3, hung]]), SID, 'plan', { timeoutMs: 200 });
    ok(Date.now() - t0 < 1_500, `1b 超时之后就返回(${Date.now() - t0}ms)`);
    eq([r.attempted, r.delivered, r.failed.length], [2, 1, 1], '1b 只数两个可用进程:一个切成、一个没回应(接口回 200)');
    eq([r.failed[0].sessionId, /超时/.test(r.failed[0].error), r.failed[0].aborted], [SID, true, true], `1b 没回应的那一项写明超时并带 aborted:true(${JSON.stringify(r.failed[0])})`);
    eq(fields(fine), ['plan', 'plan', 'plan'], '1b 按时回应的照常切过去');
    eq(fields(hung), untouched, '1b 没回应的进程档位字段不改(撤掉 r151e 判官修复的回写)');
    eq(killed(hung), [true, true, true, true], '1b 没回应的进程:置关闭中、中止 SDK、关输入、本回合按收到停止请求结束');
    eq(killed(fine), [false, false, false, false], '1b 切成的进程照常可用');
    eq(fields(closedIn), untouched, '1b 输入已关的进程不跟随切档(不算收下)');
    eq(seen.some(([t]) => t === 'closedIn'), false, '1b 输入已关的进程没收到切档请求');
    late();
    await sleep(50);
    eq(fields(hung), untouched, '1b 超时之后才到的结果不改档位字段');
  }

  // 1c) 一个切成、一个被明确拒绝(回 200):被拒的同样中止(与界面不一致),failed 那一项带 aborted:true,档位字段不改
  {
    const fine = mk(answering('fine'));
    const bad = mk(refusing('bad'));
    const r = await chat.applyPermissionModeToSlots(new Map([[1, bad], [2, fine]]), SID, 'auto', { timeoutMs: 200 });
    eq([r.attempted, r.delivered, r.failed.length], [2, 1, 1], '1c 一个切成、一个被拒(接口回 200)');
    eq([r.failed[0].error, r.failed[0].aborted], ['Cannot set permission mode to auto', true], '1c 被拒的那一项带命令行原文与 aborted:true');
    eq(fields(bad), untouched, '1c 被拒的进程档位字段不改');
    eq(killed(bad), [true, true, true, true], '1c 回 200 时被拒的进程被中止');
    eq(fields(fine), ['auto', 'auto', 'auto'], '1c 切成的照常落位');
  }

  // 1d) 只有被明确拒绝的(回 409):照旧保留、一个字段都不改、不中止,failed 那一项没有 aborted(r49b①)
  {
    const bad = mk(refusing('bad'));
    const r = await chat.applyPermissionModeToSlots(new Map([[1, bad]]), SID, 'auto', { timeoutMs: 200 });
    eq(r, { attempted: 1, delivered: 0, failed: [{ sessionId: SID, error: 'Cannot set permission mode to auto' }] }, '1d 全部被拒:409,failed 原样、没有 aborted');
    eq(fields(bad), untouched, '1d 被拒的进程档位不变');
    eq(killed(bad), [false, false, false, false], '1d 被拒的进程照旧可用(不中止、不关输入)');
  }

  // 1e) 一个没回应 + 一个被拒(都没切成,回 409):没回应的照样中止,被拒的照旧保留;failed 按进程顺序记
  {
    const hung = mk(hanging('hung'));
    const bad = mk(refusing('bad'));
    const r = await chat.applyPermissionModeToSlots(new Map([[1, hung], [2, bad]]), SID, 'acceptEdits', { timeoutMs: 200 });
    eq([r.attempted, r.delivered], [2, 0], '1e 两个都没切成(接口回 409)');
    eq([/超时/.test(r.failed[0].error), r.failed[0].aborted, r.failed[1].error, 'aborted' in r.failed[1]], [true, true, 'Cannot set permission mode to auto', false], '1e failed 按进程顺序:没回应的带 aborted,被拒的没有');
    eq(killed(hung), [true, true, true, true], '1e 回 409 时没回应的照样中止');
    eq(killed(bad), [false, false, false, false], '1e 回 409 时被拒的照旧保留');
    eq([fields(hung), fields(bad)], [untouched, untouched], '1e 两个的档位字段都不改');
  }
}

console.log('✓ check-r151f-mode-divergence 全部通过');
process.exit(0);
