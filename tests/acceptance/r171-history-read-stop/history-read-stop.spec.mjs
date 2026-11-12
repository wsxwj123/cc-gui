// r171 历史读取超时后停止读文件 —— 接口验收。依据 .devflow/r171-history-read-stop-接口.md 行为 1–4。
// 行为 1 在未修复代码上应因 EPIPE 断言而红;行为 2–4 修复前后都应通过。
// 每个用例自起一个一次性隔离后端、自己收尾;不 import 产品代码,只走 HTTP 与文件系统。
// 运行:tests/acceptance/r171-history-read-stop/run.sh
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  startBackend, seedNormalSession, startStuckSession, getHistory, waitFor, sleep, messageText,
} from './helpers/kit.mjs';

const NO_FIFO = process.platform === 'win32' ? 'Windows 没有 mkfifo,行为 1–3 跳过' : false;
const CASE_TIMEOUT = 120_000;

/** 等写入进程出现写入错误(最多 ms 毫秒),返回最终状态。 */
async function stateAfterWaiting(stuck, ms) {
  await waitFor(() => stuck.readState().error, ms, 100);
  return stuck.readState();
}

test('B1 行为1 读不完的会话:15–17 秒返回 504(HISTORY_READ_TIMEOUT),返回后 5 秒内写入进程收到 EPIPE', { skip: NO_FIFO, timeout: CASE_TIMEOUT }, async () => {
  const inst = await startBackend('b1');
  let stuck;
  try {
    stuck = startStuckSession(inst, 'stuck-b1');
    const r = await getHistory(inst.base, stuck.sid, stuck.projectHash, { limit: 120 });
    assert.equal(r.status, 504, `读取超时应返回 504(应答原文:${r.text.slice(0, 300)})`);
    assert.equal(r.body?.ok, false, `504 应答 ok 应为 false(原文:${r.text.slice(0, 300)})`);
    assert.equal(r.body?.code, 'HISTORY_READ_TIMEOUT', `504 应答 code(原文:${r.text.slice(0, 300)})`);
    assert.equal(r.body?.error, '读取会话历史超时', `504 应答 error(原文:${r.text.slice(0, 300)})`);
    assert.ok(r.elapsedMs >= 14_900 && r.elapsedMs <= 17_000, `504 应在请求发出后 15–17 秒返回,实测 ${r.elapsedMs}ms`);
    assert.equal(stuck.readState().opened, true, '前提:后端应已打开过这个会话文件(写入进程的 open 已返回)');
    const state = await stateAfterWaiting(stuck, 5_000);
    assert.equal(state.error, 'EPIPE', `返回 504 之后 5 秒内写入进程应收到 EPIPE:期望 EPIPE,实测 ${state.error === null ? '写入一直成功(后端仍在读),共写入 ' + state.writes + ' 行' : state.error}`);
  } finally {
    if (stuck) await stuck.stop();
    await inst.stop();
  }
});

test('B2 行为2 超时之后:/api/health 仍 200,另一个 2 条消息的会话 1 秒内 200 且 messages 长度为 2,错误输出无 unhandledRejection / uncaughtException', { skip: NO_FIFO, timeout: CASE_TIMEOUT }, async () => {
  const inst = await startBackend('b2');
  let stuck;
  try {
    const small = seedNormalSession(inst, 'small-b2', 2);
    stuck = startStuckSession(inst, 'stuck-b2');
    const timedOut = await getHistory(inst.base, stuck.sid, stuck.projectHash, { limit: 120 });
    assert.equal(timedOut.status, 504, `前提:卡住的会话应先返回 504(应答原文:${timedOut.text.slice(0, 300)})`);
    await sleep(3_000); // 给"停止读取"之后可能冒出的未捕获异常留出发生的时间

    const health = await fetch(`${inst.base}/api/health`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(health.status, 200, `/api/health 应 200,实测 ${health.status}`);

    const r = await getHistory(inst.base, small.sid, small.projectHash, { limit: 120 });
    assert.equal(r.status, 200, `普通会话应 200(应答原文:${r.text.slice(0, 300)})`);
    assert.ok(r.elapsedMs < 1_000, `普通会话应在 1 秒内返回,实测 ${r.elapsedMs}ms`);
    assert.equal(Array.isArray(r.body?.messages) ? r.body.messages.length : -1, 2, `普通会话 messages 长度应为 2(应答原文:${r.text.slice(0, 300)})`);

    const errText = fs.readFileSync(inst.errLog, 'utf8');
    assert.equal(errText.includes('unhandledRejection'), false, `后端错误输出不应含 unhandledRejection:\n${errText.slice(-600)}`);
    assert.equal(errText.includes('uncaughtException'), false, `后端错误输出不应含 uncaughtException:\n${errText.slice(-600)}`);
  } finally {
    if (stuck) await stuck.stop();
    await inst.stop();
  }
});

test('B3 行为3 请求方 1 秒后主动断开:断开之后 5 秒内写入进程收到 EPIPE', { skip: NO_FIFO, timeout: CASE_TIMEOUT }, async () => {
  const inst = await startBackend('b3');
  let stuck;
  try {
    stuck = startStuckSession(inst, 'stuck-b3');
    const controller = new AbortController();
    const pending = getHistory(inst.base, stuck.sid, stuck.projectHash, { limit: 120, signal: controller.signal });
    const outcome = pending.then(() => 'responded', (e) => e?.name);
    await sleep(1_000);
    controller.abort();
    assert.equal(await outcome, 'AbortError', '请求方主动断开后,请求应以 AbortError 结束(而不是 1 秒内就拿到应答)');
    assert.equal(stuck.readState().opened, true, '前提:断开前后端应已打开过这个会话文件');
    const state = await stateAfterWaiting(stuck, 5_000);
    assert.equal(state.error, 'EPIPE', `请求方断开之后 5 秒内写入进程应收到 EPIPE:期望 EPIPE,实测 ${state.error === null ? '写入一直成功(后端仍在读),共写入 ' + state.writes + ' 行' : state.error}`);
  } finally {
    if (stuck) await stuck.stop();
    await inst.stop();
  }
});

test('B4 行为4 300 条普通会话:limit=120 → 最后 120 条 + 全部字段 + hasMore=true + total=300;不带 limit → 300 条 + hasMore=false', { timeout: CASE_TIMEOUT }, async () => {
  const inst = await startBackend('b4');
  try {
    const S = seedNormalSession(inst, 'full-b4', 300);

    const paged = await getHistory(inst.base, S.sid, S.projectHash, { limit: 120 });
    assert.equal(paged.status, 200, `limit=120 应 200(应答原文:${paged.text.slice(0, 300)})`);
    for (const field of ['messages', 'usageTotals', 'historyStats', 'owner', 'view', 'hasMore', 'beforeCursor', 'total']) {
      assert.equal(Object.prototype.hasOwnProperty.call(paged.body || {}, field), true, `limit=120 应答缺少字段 ${field}(字段:${Object.keys(paged.body || {}).join(',')})`);
    }
    assert.deepEqual(paged.body.messages.map(messageText), S.texts.slice(180), 'limit=120 的 messages 应正好是最后 120 条(第 180..299 条,顺序一致)');
    assert.equal(paged.body.hasMore, true, 'limit=120 的 hasMore 应为 true');
    assert.equal(paged.body.total, 300, 'limit=120 的 total 应为 300');

    const full = await getHistory(inst.base, S.sid, S.projectHash);
    assert.equal(full.status, 200, `不带 limit 应 200(应答原文:${full.text.slice(0, 300)})`);
    assert.deepEqual(full.body?.messages?.map(messageText), S.texts, '不带 limit 的 messages 应是全部 300 条(顺序一致)');
    assert.equal(full.body?.hasMore, false, '不带 limit 的 hasMore 应为 false');
  } finally {
    await inst.stop();
  }
});
