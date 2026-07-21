// 验收测试:POST /api/chat/:pid/stop-task 的黑盒契约(部件① 按单个 task 精确停止)
// 依据:.devflow/INTERFACE-teammate-stop.md 的 A 节。只通过 HTTP 打端点,不看实现。
//
// ── 怎么跑 ────────────────────────────────────────────────────────
//   1. 先起后端:  npm run server        (监听 :6677)
//   2. 另开终端跑:  node tests/acceptance/stop-task.acceptance.mjs
//   可选:  BASE_URL=http://127.0.0.1:6677  覆盖默认地址。
//
// ── 依赖什么前置(诚实分层)──────────────────────────────────────
//   Tier 0  服务器可达 —— 不可达则整体判失败并打印起服务命令(端点契约无法验证)。
//   Tier 1  不需要活会话:非法 :pid → 404。任何机器都能跑。
//   Tier 2  需要「至少一个活着的 chat-process slot」(GET /api/agents/active 里有
//           kind:'chat-process' 的 pid)。哪怕是空闲会话也行,不需要真跑着 teammate。
//           覆盖:缺/非法 toolUseId → 400;查无 toolUseId → stopped:false;
//           sessionId 不匹配 → stopped:false;重复调用幂等。
//           无活 slot 时这些用例整体 SKIP(打印如何造:GUI 里开一个会话发一条消息即可)。
//   Tier 3  需要真机 + 真实在飞 teammate(真 API/真子进程)才能验的:
//           stopped:true、task_notification 收尾、不误伤主流/兄弟/别的会话。
//           本文件不自动化,见 .devflow/TEST-PLAN.md 的「真机手验」栏。
//
// 退出码:有断言失败 → 1;仅 SKIP 无失败 → 0。SKIP 不算失败,但会明确打印原因。

import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:6677';

let failed = 0;
let passed = 0;
let skipped = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function skip(name, reason) {
  skipped++;
  console.log(`  SKIP  ${name}\n        ${reason}`);
}

async function post(pid, body) {
  const res = await fetch(`${BASE}/api/chat/${pid}/stop-task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应,json 留 null */ }
  return { status: res.status, json };
}

// ── Tier 0:服务器可达 ───────────────────────────────────────────
let health;
try {
  const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
  health = r.ok;
} catch {
  health = false;
}
if (!health) {
  console.log(`\n服务器不可达:${BASE}`);
  console.log('先起后端再跑本测试:  npm run server   (监听 :6677)');
  console.log('端点契约无法在无服务时验证 —— 判失败退出。\n');
  process.exit(1);
}
console.log(`\n后端可达:${BASE}\n`);

// 发现一个活着的 chat-process pid(Tier 2 前置)
async function findLivePid() {
  let data;
  try {
    const r = await fetch(`${BASE}/api/agents/active`, { signal: AbortSignal.timeout(3000) });
    data = await r.json();
  } catch { return { pid: null, pids: [] }; }
  // 结构防御:可能是数组,也可能是 { agents:[...] } 之类;把所有对象摊平找 kind:'chat-process'
  const flat = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if ('pid' in v) flat.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(data);
  const chat = flat.filter((e) => e.kind === 'chat-process' && e.pid != null);
  const pids = flat.map((e) => e.pid).filter((p) => p != null);
  return { pid: chat.length ? chat[0].pid : null, entry: chat[0], pids };
}

const { pid: livePid, entry: liveEntry, pids: activePids } = await findLivePid();

// 选一个绝不在活动表里的 pid 用于 404
let bogusPid = 987654321;
while (activePids.includes(bogusPid)) bogusPid++;

// ── Tier 1:非法 :pid → 404 ─────────────────────────────────────
console.log('Tier 1  非法 pid(无需活会话)');
await check('非法_pid_带合法body_返回404_ProcessNotFound', async () => {
  // 带上合法 toolUseId,确保只触发「pid 不存在」这一个条件,不掺入 400 分支
  const { status, json } = await post(bogusPid, { toolUseId: 'tu_whatever' });
  assert.equal(status, 404, `期望 404,实际 ${status}`);
  assert.equal(json?.error, 'Process not found', `期望 error:"Process not found",实际 ${JSON.stringify(json)}`);
});
await check('非数字_pid_不返回2xx成功', async () => {
  // 'abc' 不是有效 pid,不该被当成一个能停的进程返回 ok:true
  const { status, json } = await post('abc', { toolUseId: 'tu_x' });
  assert.notEqual(json?.ok, true, `非法 pid 不应返回 ok:true(实际 status ${status} / ${JSON.stringify(json)})`);
});

// ── Tier 2:需要一个活着的 chat-process slot ─────────────────────
console.log('\nTier 2  合法 pid 上的入参校验与 no-op 分支(需活 slot)');
if (!livePid) {
  const why = '未发现 kind:"chat-process" 的活动 slot。造法:打开 GUI,在任一会话发一条消息,'
    + '让 :6677 起一个 CLI 进程,保持会话不关,再重跑本测试。';
  ['合法pid_缺toolUseId_返回400',
    '合法pid_toolUseId非字符串_返回400',
    '合法pid_查无toolUseId_返回stopped_false',
    '合法pid_sessionId不匹配_返回stopped_false',
    '合法pid_重复停同一未知task_幂等ok'].forEach((n) => skip(n, why));
} else {
  console.log(`  (使用活动 pid=${livePid}${liveEntry?.sessionId ? `, sessionId=${liveEntry.sessionId}` : ''})`);

  await check('合法pid_缺toolUseId_返回400', async () => {
    const { status, json } = await post(livePid, {});
    assert.equal(status, 400, `期望 400,实际 ${status} / ${JSON.stringify(json)}`);
    assert.equal(json?.error, 'toolUseId required', `期望 error:"toolUseId required",实际 ${JSON.stringify(json)}`);
  });

  await check('合法pid_toolUseId非字符串_返回400', async () => {
    // number 与 null 都不是 string,均须 400(契约:缺 toolUseId 或非字符串)
    for (const bad of [{ toolUseId: 123 }, { toolUseId: null }, { toolUseId: {} }]) {
      const { status, json } = await post(livePid, bad);
      assert.equal(status, 400, `body ${JSON.stringify(bad)} 期望 400,实际 ${status} / ${JSON.stringify(json)}`);
      assert.equal(json?.error, 'toolUseId required', `body ${JSON.stringify(bad)} 期望 toolUseId required,实际 ${JSON.stringify(json)}`);
    }
  });

  await check('合法pid_查无toolUseId_返回ok且stopped_false', async () => {
    // 该 slot 内不存在这个 tool_use_id → 不是错误,ok:true / stopped:false
    const { status, json } = await post(livePid, { toolUseId: 'tu_does_not_exist_zzz' });
    assert.equal(status, 200, `期望 200,实际 ${status} / ${JSON.stringify(json)}`);
    assert.equal(json?.ok, true, `期望 ok:true,实际 ${JSON.stringify(json)}`);
    assert.equal(json?.stopped, false, `未知 task 期望 stopped:false,实际 ${JSON.stringify(json)}`);
  });

  await check('合法pid_sessionId不匹配_会话归属守卫no-op', async () => {
    // 传一个绝不匹配 slot.sessionId 的会话 → 守卫拦下 → stopped:false,且仍是成功(200/ok)
    const { status, json } = await post(livePid, {
      toolUseId: 'tu_does_not_exist_zzz',
      sessionId: '__no_such_session__',
    });
    assert.equal(status, 200, `期望 200,实际 ${status} / ${JSON.stringify(json)}`);
    assert.equal(json?.ok, true, `期望 ok:true,实际 ${JSON.stringify(json)}`);
    assert.equal(json?.stopped, false, `会话不匹配期望 stopped:false,实际 ${JSON.stringify(json)}`);
    // 注:此处 toolUseId 本就不存在,stopped:false 无法单独归因于守卫。
    // 「真实存在的 task 被 sessionId 守卫挡下(stopped:false)」需活 teammate,见手验 M4。
  });

  await check('合法pid_重复停同一未知task_幂等无异常', async () => {
    // 幂等:连打两次,两次都必须是成功且不抛(status 200 / ok:true)
    const a = await post(livePid, { toolUseId: 'tu_idem_probe' });
    const b = await post(livePid, { toolUseId: 'tu_idem_probe' });
    for (const [i, r] of [['第1次', a], ['第2次', b]]) {
      assert.equal(r.status, 200, `${i} 期望 200,实际 ${r.status} / ${JSON.stringify(r.json)}`);
      assert.equal(r.json?.ok, true, `${i} 期望 ok:true,实际 ${JSON.stringify(r.json)}`);
    }
    assert.equal(b.json?.stopped, false, `重复停未知 task 第2次期望 stopped:false,实际 ${JSON.stringify(b.json)}`);
  });
}

// ── Tier 3:说明为何不在此自动化 ─────────────────────────────────
console.log('\nTier 3  需真机 + 真实在飞 teammate(不自动化,见 TEST-PLAN.md 手验栏)');
skip('真实task_匹配sessionId_返回stopped_true', '需真起一个具名 teammate 并拿到其 tool_use_id;涉真 API/真子进程。');
skip('停止后task_notification收尾为已停止', '收尾信号走 SSE/WS,须端到端真会话验证。');
skip('停单个不误伤主流_兄弟task_别的会话', '需并存多个真实 task 观察其余状态不变,HTTP 无法直接断言任务内部态。');

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n结果:${passed} 通过 / ${failed} 失败 / ${skipped} 跳过`);
if (failed > 0) process.exit(1);
