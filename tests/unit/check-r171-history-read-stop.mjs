#!/usr/bin/env node
// r171 白盒自检(后端):getSessionMessages 在读完会话文件之后,读附件侧车 / 读子代理用量期间
// 收到停止信号,以 AbortError 结束、不返回结果;不传信号时结果不变。
//   停止时机不靠计时:包一层 JSON.parse,解析到侧车 / 子代理转写里的标记时才 abort ——
//   这两处都在会话文件已读完之后(parseJsonl 已 resolve)。
// 临时 HOME,不起服务。node tests/unit/check-r171-history-read-stop.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r171-readstop-')));
const HOME = join(TMP, 'home');
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
const PROJECT = '-tmp-r171-readstop';
const PROJECT_DIR = join(HOME, '.claude', 'projects', PROJECT);
mkdirSync(PROJECT_DIR, { recursive: true });
mkdirSync(join(HOME, '.claude-gui', 'attachments'), { recursive: true });

const { getSessionMessages } = await import('../../server/services/session-reader.js');

const SID_SIDECAR = '11111111-2222-4333-8444-555555555551';
const SID_AGENT = '11111111-2222-4333-8444-555555555552';
const SIDECAR_MARK = 'r171-sidecar-mark';
const AGENT_MARK = 'r171-agent-mark';
const ts = (n) => new Date(Date.parse('2026-11-12T08:00:00.000Z') + n * 1000).toISOString();
const sessionLines = (sid, turns) => {
  const out = [];
  for (let i = 0; i < turns; i++) {
    out.push({ type: 'user', uuid: `u${i}`, parentUuid: i ? `a${i - 1}` : null, timestamp: ts(i * 10), sessionId: sid,
      message: { role: 'user', content: `提问 ${i}` } });
    out.push({ type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, timestamp: ts(i * 10 + 1), sessionId: sid,
      message: { id: `msg_${i}`, type: 'message', role: 'assistant', model: 'r171-chat', content: [{ type: 'text', text: `回复 ${i}` }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
  }
  return `${out.map((r) => JSON.stringify(r)).join('\n')}\n`;
};
const SESSION_LINES = 10;   // 每个会话 5 轮 = 10 行

// 会话一:带附件侧车(内容里有标记)
writeFileSync(join(PROJECT_DIR, `${SID_SIDECAR}.jsonl`), sessionLines(SID_SIDECAR, 5));
writeFileSync(join(HOME, '.claude-gui', 'attachments', `${SID_SIDECAR}.json`), JSON.stringify({ [SIDECAR_MARK]: [] }));
// 会话二:带一个子代理转写(第一行带标记)
writeFileSync(join(PROJECT_DIR, `${SID_AGENT}.jsonl`), sessionLines(SID_AGENT, 5));
const subDir = join(PROJECT_DIR, SID_AGENT, 'subagents');
mkdirSync(subDir, { recursive: true });
writeFileSync(join(subDir, 'agent-r171.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: 'x1', timestamp: ts(5), mark: AGENT_MARK,
  message: { id: 'msg_sub', model: 'r171-sub', content: [], usage: { input_tokens: 3, output_tokens: 4 } } })}\n`);

// 包一层 JSON.parse:数会话行解析数,遇到标记文本就 abort(只观察,不改解析结果)。
const realParse = JSON.parse;
let hook = null;
JSON.parse = function patchedParse(text, ...rest) {
  const value = realParse.call(this, text, ...rest);
  if (hook && typeof text === 'string') hook(text);
  return value;
};

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };

try {
  // ① 读侧车时中止:会话文件已读完(10 行都解析过)才触发,结果以 AbortError 结束
  {
    const ctrl = new AbortController();
    let sessionParsed = 0;
    let firedAfterRead = null;
    hook = (text) => {
      if (text.includes(`"sessionId":"${SID_SIDECAR}"`)) sessionParsed += 1;
      if (text.includes(SIDECAR_MARK) && !ctrl.signal.aborted) {
        firedAfterRead = sessionParsed;
        ctrl.abort();
      }
    };
    let result;
    await assert.rejects(
      (async () => { result = await getSessionMessages(SID_SIDECAR, PROJECT, { limit: 120, signal: ctrl.signal }); })(),
      { name: 'AbortError' },
    );
    hook = null;
    ok(firedAfterRead === SESSION_LINES, `侧车标记应在会话文件读完后才解析到(当时已解析 ${firedAfterRead} 行)`);
    ok(result === undefined, '中止后不返回结果');
  }

  // ② 读子代理用量时中止(该步骤在吞异常的 try/catch 里):中止不被吞,以 AbortError 结束
  {
    const ctrl = new AbortController();
    let sessionParsed = 0;
    let firedAfterRead = null;
    hook = (text) => {
      if (text.includes(`"sessionId":"${SID_AGENT}"`)) sessionParsed += 1;
      if (text.includes(AGENT_MARK) && !ctrl.signal.aborted) {
        firedAfterRead = sessionParsed;
        ctrl.abort();
      }
    };
    let result;
    await assert.rejects(
      (async () => { result = await getSessionMessages(SID_AGENT, PROJECT, { limit: 120, signal: ctrl.signal }); })(),
      { name: 'AbortError' },
    );
    hook = null;
    ok(firedAfterRead === SESSION_LINES, `子代理标记应在会话文件读完后才解析到(当时已解析 ${firedAfterRead} 行)`);
    ok(result === undefined, '中止后不返回结果');
  }

  // ③ 不传信号:正常返回;与传了但没中止的信号结果逐字相同
  for (const sid of [SID_SIDECAR, SID_AGENT]) {
    const plain = await getSessionMessages(sid, PROJECT, { limit: 120 });
    const idle = await getSessionMessages(sid, PROJECT, { limit: 120, signal: new AbortController().signal });
    const legacy = await getSessionMessages(sid, PROJECT);
    ok(Array.isArray(plain.messages) && plain.messages.length === 10, `${sid} 不传信号:10 条消息(实得 ${plain.messages?.length})`);
    ok(plain.total === 10 && plain.hasMore === false, '不传信号:total / hasMore 正常');
    for (const key of ['messages', 'usageTotals', 'historyStats', 'owner', 'view', 'hasMore', 'beforeCursor', 'total']) {
      ok(key in plain, `返回体含 ${key}`);
    }
    assert.deepEqual(idle, plain, '传了未中止的信号 = 不传信号'); passed += 1;
    assert.deepEqual(legacy.messages, plain.messages, '不传 paging 的旧调用:消息相同'); passed += 1;
  }
  // 子代理用量照常挂上(说明 ② 的中止点确实落在读子代理用量那一步)
  const withAgent = await getSessionMessages(SID_AGENT, PROJECT);
  ok(withAgent.historyStats && withAgent.usageTotals, '子代理会话正常返回');

  // ④ 开读前已中止:同样 AbortError
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(getSessionMessages(SID_SIDECAR, PROJECT, { signal: pre.signal }), { name: 'AbortError' }); passed += 1;
} finally {
  JSON.parse = realParse;
  hook = null;
}

// ── 历史路由:超时 / 断开都让读取停下(真路由 + 命名管道;Windows 没有 mkfifo,跳过)─────────
// 判据不靠计时:后端关掉管道读端后,写入方下一次写入以 EPIPE 失败。超时 15 秒是固定值,本段约 17 秒。
if (process.platform !== 'win32') {
  const { execFileSync } = await import('node:child_process');
  const { open } = await import('node:fs/promises');
  const express = (await import('express')).default;
  const { default: sessionsRouter } = await import('../../server/routes/sessions.js');
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);

  const app = express();
  app.use('/api', sessionsRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const line = `${JSON.stringify({ type: 'user', uuid: 'f', timestamp: ts(0), message: { role: 'user', content: 'x' } })}\n`;

  // 起一个"读不完的会话":管道 + 每 300ms 写一行;返回一个等到 EPIPE 就 resolve 的 promise
  const startEndlessSession = async (sid) => {
    const fifo = join(PROJECT_DIR, `${sid}.jsonl`);
    execFileSync('mkfifo', [fifo]);
    let stopped = false;
    const writerOpened = open(fifo, 'w');   // 后端开读端时才返回
    const epipe = (async () => {
      const fh = await writerOpened;
      try {
        while (!stopped) {
          try { await fh.write(line); } catch (err) { return err.code; }
          await wait(300);
        }
        return 'stopped';
      } finally { await fh.close().catch(() => {}); }
    })();
    return { epipe, stop: () => { stopped = true; } };
  };
  const within = (p, ms) => Promise.race([p, wait(ms).then(() => 'still-writing')]);

  try {
    // 超时:约 15 秒回 504(契约逐字),之后 5 秒内写入方收到 EPIPE
    {
      const sid = '11111111-2222-4333-8444-5555555555a1';
      const endless = await startEndlessSession(sid);
      const t0 = Date.now();
      const resp = await fetch(`${base}/sessions/${sid}/messages?projectHash=${PROJECT}&limit=120`);
      const elapsed = Date.now() - t0;
      assert.equal(resp.status, 504); passed += 1;
      assert.deepEqual(await resp.json(), { ok: false, code: 'HISTORY_READ_TIMEOUT', error: '读取会话历史超时' }); passed += 1;
      ok(elapsed >= 14_500 && elapsed < 17_500, `504 约在 15 秒返回(实际 ${elapsed}ms)`);
      const code = await within(endless.epipe, 5000);
      endless.stop();
      assert.equal(code, 'EPIPE', '超时后后端应关掉会话文件'); passed += 1;
    }
    // 断开:请求方 1 秒后取消,5 秒内写入方收到 EPIPE
    {
      const sid = '11111111-2222-4333-8444-5555555555a2';
      const endless = await startEndlessSession(sid);
      const ctrl = new AbortController();
      const req = fetch(`${base}/sessions/${sid}/messages?projectHash=${PROJECT}&limit=120`, { signal: ctrl.signal }).catch((e) => e.name);
      await wait(1000);
      ctrl.abort();
      assert.equal(await req, 'AbortError'); passed += 1;
      const code = await within(endless.epipe, 5000);
      endless.stop();
      assert.equal(code, 'EPIPE', '断开后后端应关掉会话文件'); passed += 1;
    }
    // 之后普通会话照常 200
    const normal = await fetch(`${base}/sessions/${SID_SIDECAR}/messages?projectHash=${PROJECT}&limit=120`);
    assert.equal(normal.status, 200); passed += 1;
    assert.equal((await normal.json()).messages.length, 10); passed += 1;
    await wait(200);
    assert.deepEqual(unhandled, [], '不得有未处理的 Promise 拒绝'); passed += 1;
  } finally {
    process.off('unhandledRejection', onUnhandled);
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

console.log(`check-r171-history-read-stop: OK (${passed} assertions)`);
