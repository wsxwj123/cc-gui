// r151k 会话常驻 + 提问卡不再被看门狗误杀 —— 验收。K1–K5 依据 .devflow/r151k-session-liveness-接口.md 的
// "验收要点(行为清单)"(5 条),用例与行为号一一对应:
//   K1(必修)提问卡等待超过 CGUI_STALL_MS 后进程仍活着、无 stall_notice;答复卡后回合继续 ·
//   K2(相邻回归)无卡、上游静默超阈值 → 仍 stall_notice + 中止 ·
//   K3(必修)keepAliveIdle=never 时回合收尾后不在测试窗口内关进程;缺省(1h)同窗口到点关 ·
//   K4(必修)GET/PUT /api/prefs/keep-alive-idle 的默认值、合法值、非法值 ·
//   K5(必修)总开关打开后,无显式 inbound 的会话按自动处理判定,显式 card 的会话仍是 card。
//
// 每条用例一个一次性实例(临时 HOME、自挑端口、用例自己 stop);K1/K2 只走假 CLI,K5 用真 CLI 车道
// (工作目录 ws/real-*,模型请求只到本地假接口)让"模型"真的调用 list_sessions。
// 静默阈值通过 startInstanceP2 的 envExtra 以 CGUI_STALL_MS 传给服务进程(当前代码已读这个变量,
// 不需要阈值垫片);空闲回收窗口通过 CGUI_KEEPALIVE_IDLE_MS 传给服务进程(接口要求的测试用变量)。
import { test, expect } from '@playwright/test';
import { uniq, seedSession, makeWorkspace, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { waitFor } from '../r151b-xsession-p1/helpers/api.mjs';
import { LS, aiCalls, entry } from '../r151c-xsession-p2/helpers/p2.mjs';
import { startInstanceP2 } from './helpers/p2.mjs';
import {
  sleep, newT, procPids, startTurn, waitAskCard, answerCard, pendingCards, stallNotices, stallText, permResponses, releaseWait,
} from './helpers/k.mjs';

test.describe.configure({ timeout: 180_000 });

const STALL_MS = 1500;
const SILENCE_MS = 5_000;
const THRESHOLD = { CGUI_STALL_MS: String(STALL_MS) };
const IDLE_ENV = { CGUI_KEEPALIVE_IDLE_MS: '1500' };
const STALL_HEAD = '上游超过 5 分钟无后续输出';
const eventDigest = (events) => JSON.stringify(events.map((e) => ({ type: e.type, subtype: e.subtype, text: e.text })).slice(-20));

// ============================ K1 必修:提问卡等待期间看门狗不动手 ============================
test('K1 行为1 回合里弹出 AskUserQuestion 卡、用户不答,等 5 秒(阈值 1500ms):不出现 stall_notice、进程仍活着、卡还挂着;答复卡后回合正常收尾', async () => {
  const run = uniq('');
  const tag = 'k1';
  const mark = `R151K-K1-${run}`;
  const scriptName = `k1-${run}`;
  const askInput = {
    questions: [{
      question: `R151K K1 提问卡等待 ${run}:继续吗?`, header: 'r151k', multiSelect: false,
      options: [{ label: '是', description: '继续' }, { label: '否', description: '停止' }],
    }],
  };
  const askId = `toolu_k1_ask_${run}`;
  let inst = null;
  let s = null;
  try {
    inst = await startInstanceP2(`k-${tag}`, { envExtra: THRESHOLD });
    const T = newT(inst, tag);
    s = await startTurn(inst, T, {
      mark, scriptName,
      steps: [
        // 先有一个 Task 工具调用(看门狗判据要求本回合起过子代理/续跑),再弹提问卡,然后卡住等用户。
        { toolUse: { id: `toolu_k1_task_${run}`, name: 'Task', input: { subagent_type: 'general-purpose', description: 'K1 起过的子代理', prompt: '等一会儿再返回' } } },
        { toolUse: { id: askId, name: 'AskUserQuestion', input: askInput } },
        { canUseTool: { tool_name: 'AskUserQuestion', tool_use_id: askId, input: askInput } },
        { say: 'R151K K1 答复后继续' },
        { result: { result: 'R151K-K1-FINAL' } },
      ],
    });
    const card = await waitAskCard(inst.c, T.sid, run);
    expect(card, `前置:GUI 弹出提问卡(GET /api/permissions/pending 里应有一条 AskUserQuestion;当前:${JSON.stringify((await pendingCards(inst.c)).map((p) => ({ toolName: p.toolName, sessionId: p.sessionId })))})`).toBeTruthy();
    // 用户不答:等 5 秒(阈值 1500ms,超过 3 个窗口)。
    await sleep(SILENCE_MS);
    const notices = stallNotices(s.stream.events);
    const pids = await procPids(inst.c, T.sid);
    const still = await pendingCards(inst.c);
    expect({
      stallNotices: notices.map(stallText),
      pidAlive: pids.includes(Number(s.cliPid)),
      cardStillPending: still.some((p) => p && p.id === card.id),
    }, `提问卡等待超过 ${STALL_MS}ms(${SILENCE_MS}ms)后:进程应仍活着、没有 stall_notice、卡还挂着。SSE 事件:${eventDigest(s.stream.events)};进程列表 pid:${JSON.stringify(pids)};假 CLI pid:${s.cliPid}`)
      .toEqual({ stallNotices: [], pidAlive: true, cardStillPending: true });
    // 通过既有接口答复该卡(allow + 用户选择),回合应继续并以 done 收尾。
    const answer = await answerCard(inst.c, card, {
      updatedInput: { ...askInput, answers: { [askInput.questions[0].question]: '是' } },
    });
    expect(answer.status, `前置:答复提问卡应 200(${String(answer.text).slice(0, 240)})`).toBe(200);
    const doneEv = await s.stream.waitFor((e) => e && e.type === 'done', 15_000);
    expect(doneEv, `答复后回合应正常收尾(SSE 里应有 done;SSE 事件:${eventDigest(s.stream.events)})`).toBeTruthy();
    const log = permResponses(inst.ctl, T.sid);
    expect(log.length, `假 CLI 应收到答复记录(${JSON.stringify(log).slice(0, 300)})`).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(log[log.length - 1].response || null), '答复内容是 allow(假 CLI 收到的 control_response)').toContain('"behavior":"allow"');
    expect(stallNotices(s.stream.events).map(stallText), '答复与收尾期间不再出现 stall_notice').toEqual([]);
    expect((await pendingCards(inst.c)).filter((p) => p && p.id === card.id), '答复后卡已撤下').toEqual([]);
  } finally {
    if (s) {
      try { releaseWait(inst.ctl, `${scriptName}-never`); } catch { /* 没摆过 waitFile */ }
      try { s.stream.stop(); } catch { /* 已断 */ }
    }
    if (inst) await inst.stop().catch(() => null);
  }
});

// ============================ K2 相邻回归:无卡静默仍按原行为中止 ============================
test('K2 行为2 只有 Task 子代理、没有提问卡,上游静默超过 1500ms:仍收到 stall_notice(含固定开头)且进程被中止', async () => {
  const run = uniq('');
  const tag = 'k2';
  const mark = `R151K-K2-${run}`;
  const scriptName = `k2-${run}`;
  const never = `${scriptName}-never`;
  let inst = null;
  let s = null;
  try {
    inst = await startInstanceP2(`k-${tag}`, { envExtra: THRESHOLD });
    const T = newT(inst, tag);
    s = await startTurn(inst, T, {
      mark, scriptName,
      steps: [
        { toolUse: { id: `toolu_k2_task_${run}`, name: 'Task', input: { subagent_type: 'general-purpose', description: 'K2 起过的子代理', prompt: '等一会儿再返回' } } },
        { waitFile: never },
      ],
    });
    // 最后一条输出就是这个 Task 工具调用;之后静默 5 秒(阈值 1500ms)。
    await sleep(SILENCE_MS);
    const notices = stallNotices(s.stream.events);
    expect(notices.length, `应收到 1 条 stall_notice(实际 ${notices.length} 条;SSE 事件:${eventDigest(s.stream.events)})`).toBeGreaterThanOrEqual(1);
    for (const n of notices) {
      expect(stallText(n), `stall_notice 的文案应含固定开头("${STALL_HEAD}"):${JSON.stringify(stallText(n))}`).toContain(STALL_HEAD);
    }
    const gone = await waitFor(async () => {
      const pids = await procPids(inst.c, T.sid);
      return !pids.includes(Number(s.cliPid)) ? true : null;
    }, 5_000, 100);
    expect(gone, `看门狗应中止该进程:进程列表里不再有假 CLI pid ${s.cliPid}(进程列表:${JSON.stringify(await procPids(inst.c, T.sid))})`).toBe(true);
  } finally {
    if (s) {
      try { releaseWait(inst.ctl, never); } catch { /* 忽略 */ }
      try { s.stream.stop(); } catch { /* 忽略 */ }
    }
    if (inst) await inst.stop().catch(() => null);
  }
});

// ============================ K3 必修:空闲回收时长可设置 ============================
/** 起一个普通回合并等它收尾(done),返回 { T, s };收尾时进程仍在(进入空闲常驻)是前置。 */
async function idleTurn(inst, tag, mark) {
  const T = newT(inst, tag);
  const s = await startTurn(inst, T, { mark, prompt: `${mark} 普通回合` });
  try {
    const doneEv = await s.stream.waitFor((e) => e && e.type === 'done', 20_000);
    expect(doneEv, `前置:普通回合正常收尾(SSE done;SSE 事件:${eventDigest(s.stream.events)})`).toBeTruthy();
    expect((await procPids(inst.c, T.sid)).includes(Number(s.cliPid)), '前置:回合刚收尾时进程仍在(进入空闲常驻)').toBe(true);
    return { T, s };
  } finally { s.stream.stop(); }
}

test('K3 行为3 keepAliveIdle=never 时回合收尾后 5 秒进程仍在;keepAliveIdle 缺省(默认 1h)时同一测试窗口(CGUI_KEEPALIVE_IDLE_MS=1500)到点关进程', async () => {
  // 第一段:pref 显式 never —— 到测试窗口(1500ms)也绝不自动关。
  {
    const run = uniq('');
    const inst = await startInstanceP2('k-k3-never', { prefs: { keepAliveIdle: 'never' }, envExtra: IDLE_ENV });
    try {
      const { T, s } = await idleTurn(inst, 'k3n', `R151K-K3-N-${run}`);
      await sleep(SILENCE_MS);
      const pids = await procPids(inst.c, T.sid);
      expect({ keepAliveIdle: 'never', pidAlive: pids.includes(Number(s.cliPid)) },
        `keepAliveIdle=never:回合收尾后等 ${SILENCE_MS}ms(测试窗口 1500ms)进程应仍在。进程列表:${JSON.stringify(pids)};假 CLI pid:${s.cliPid}`)
        .toEqual({ keepAliveIdle: 'never', pidAlive: true });
    } finally { await inst.stop(); }
  }
  // 第二段:pref 没有这个键(默认 1h)+ 同一测试窗口 —— 应到点关进程,证明测试窗口与设置真的生效。
  {
    const run = uniq('');
    const inst = await startInstanceP2('k-k3-default', { prefs: {}, envExtra: IDLE_ENV });
    try {
      const { T, s } = await idleTurn(inst, 'k3d', `R151K-K3-D-${run}`);
      const gone = await waitFor(async () => {
        const pids = await procPids(inst.c, T.sid);
        return !pids.includes(Number(s.cliPid)) ? true : null;
      }, 8_000, 100);
      expect(gone, `keepAliveIdle 缺省(默认 1h)在 CGUI_KEEPALIVE_IDLE_MS=1500 下:回合收尾后应到点关进程(等 8 秒仍未关;进程列表:${JSON.stringify(await procPids(inst.c, T.sid))};假 CLI pid:${s.cliPid})`).toBe(true);
    } finally { await inst.stop(); }
  }
});

// ============================ K4 必修:prefs 接口 ============================
// 接口文件只写了"GET 返回当前值 / PUT 合法值 200 / 非法值 400 + 稳定 code",没写请求体与应答字段名。
// 用例按本仓库单值偏好接口的常见形状取 value / keepAliveIdle / idle 三者之一(发现式):
// 哪个键 PUT 合法值得到 200 就用哪个,GET 也接受这三种键(或直接是字符串)。行为断言不因字段名放宽。
const IDLE_PATH = '/api/prefs/keep-alive-idle';
const IDLE_VALUES = ['15m', '30m', '1h', '2h', '4h', 'never'];
const IDLE_BODY_KEYS = ['value', 'keepAliveIdle', 'idle'];
const idleValueOf = (body) => {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  for (const k of IDLE_BODY_KEYS) if (typeof body[k] === 'string') return body[k];
  return undefined;
};

test('K4 行为4 GET /api/prefs/keep-alive-idle 默认 1h;PUT 六个合法值 200 且 GET 一致;非法值 400 + 稳定 code 且不改当前设置', async () => {
  const inst = await startInstanceP2('k-k4');
  try {
    const c = inst.c;
    const g0 = await c.get(IDLE_PATH);
    expect(g0.status, `GET ${IDLE_PATH} 应 200(未修复时没有这个端点;应答:${String(g0.text).slice(0, 240)})`).toBe(200);
    expect(idleValueOf(g0.body), `GET 默认值应为 1h(应答原文:${String(g0.text).slice(0, 240)})`).toBe('1h');

    // 发现 PUT 请求体字段:合法值只有 200 才算接上,400/404 继续试下一个候选键。
    let key = null;
    for (const cand of IDLE_BODY_KEYS) {
      const r = await c.put(IDLE_PATH, { [cand]: '30m' });
      if (r.status === 200) { key = cand; break; }
      expect([400, 404], `PUT {${cand}:"30m"} 若不是 200,只允许 400/404(实际 ${r.status}:${String(r.text).slice(0, 200)})`).toContain(r.status);
    }
    expect(key, `PUT 合法值应 200,请求体字段应是 ${JSON.stringify(IDLE_BODY_KEYS)} 之一(未修复时端点为 404)`).toBeTruthy();
    expect(idleValueOf((await c.get(IDLE_PATH)).body), `PUT 后 GET 应立刻一致(${key})`).toBe('30m');

    for (const v of IDLE_VALUES) {
      const r = await c.put(IDLE_PATH, { [key]: v });
      expect(r.status, `PUT ${JSON.stringify({ [key]: v })} 应 200(应答:${String(r.text).slice(0, 240)})`).toBe(200);
      const g = await c.get(IDLE_PATH);
      expect(g.status, `PUT ${v} 后 GET 应 200`).toBe(200);
      expect(idleValueOf(g.body), `PUT ${v} 后 GET 应返回 ${v}(应答原文:${String(g.text).slice(0, 240)})`).toBe(v);
    }

    const before = idleValueOf((await c.get(IDLE_PATH)).body);
    const codes = [];
    for (const bad of ['10m', '45m', '5h', '1H', 'never ', '', '0m', null, 15]) {
      const r1 = await c.put(IDLE_PATH, { [key]: bad });
      expect(r1.status, `PUT 非法值 ${JSON.stringify(bad)} 应 400(应答:${String(r1.text).slice(0, 240)})`).toBe(400);
      expect(r1.body && typeof r1.body.code === 'string' && r1.body.code.length > 0,
        `非法值 ${JSON.stringify(bad)} 应带稳定 code(应答:${String(r1.text).slice(0, 240)})`).toBe(true);
      const r2 = await c.put(IDLE_PATH, { [key]: bad });
      expect(r2.body && r2.body.code, `同一非法值 ${JSON.stringify(bad)} 重复请求 code 应稳定(第一次 ${r1.body && r1.body.code},第二次 ${r2.body && r2.body.code})`)
        .toBe(r1.body.code);
      codes.push(r1.body.code);
    }
    expect(new Set(codes).size, `各类非法值应使用同一个稳定 code(实际:${JSON.stringify(codes)})`).toBe(1);
    expect(idleValueOf((await c.get(IDLE_PATH)).body), '非法值不改当前设置').toBe(before);
  } finally { await inst.stop(); }
});

// ============================ K5 必修:GUI 跨会话入站默认 ============================
test('K5 行为5 总开关打开:没有显式 inbound 的会话在 list_sessions(与会话列表接口)里是 auto;显式设成 card 的会话仍是 card', async () => {
  expect(!!realCliPath(), '本机需要真 claude CLI 才能让"模型"调用 list_sessions(参考 r151c 夹具;没有就失去了本用例的观察对象)').toBe(true);
  const inst = await startInstanceP2('k-k5');
  try {
    const c = inst.c;
    const on = await c.put('/api/xsession/config', { enabled: true });
    expect(on.status, `前置:打开跨会话总开关应 200(${String(on.text).slice(0, 240)})`).toBe(200);
    const run = uniq('');
    // A 不写任何显式接收设置;B 走既有 PUT 接口显式设成"先收卡片"(card 的存储形式由实现决定,用例不碰盘上格式)。
    const A = seedSession(`k5-a-${run}`, { home: inst.home, title: `R151K K5 未显式 ${run}`, mtime: new Date(Date.now() - 60_000) });
    const B = seedSession(`k5-b-${run}`, { home: inst.home, title: `R151K K5 显式卡片 ${run}`, mtime: new Date(Date.now() - 120_000) });
    const setB = await c.put(`/api/xsession/sessions/${B.sid}/inbound`, { mode: 'card' });
    expect(setB.status, `前置:把 B 显式设成 card 应 200(${String(setB.text).slice(0, 240)})`).toBe(200);

    // 发送方是真 CLI(工作目录 real-*),由假模型接口让"模型"调用 list_sessions。
    const cwd = makeWorkspace(`real-k5-${run}`);
    const r = await aiCalls(c, { cwd, mode: 'default', steps: [{ name: LS, input: {} }], timeoutMs: 120_000 });
    expect(r.results.length, `前置:list_sessions 应只返回一次工具结果(实际 ${r.results.length};${JSON.stringify(r.results.map((x) => String(x.text).slice(0, 160)))})`).toBe(1);
    expect(r.results[0].is_error, `前置:list_sessions 调用成功、没弹权限卡(${String(r.results[0].text).slice(0, 240)})`).toBe(false);
    const all = r.results[0].json;
    expect(all && Array.isArray(all.sessions), `list_sessions 应返回 {sessions:[...]}(${String(r.results[0].text).slice(0, 300)})`).toBe(true);

    const aEntry = await entry(c, A.sid);
    const bEntry = await entry(c, B.sid);
    expect(aEntry && bEntry, `前置:A/B 都应出现在会话列表(实际 A=${JSON.stringify(aEntry && aEntry.shortId)},B=${JSON.stringify(bEntry && bEntry.shortId)})`).toBeTruthy();
    const byShortId = new Map(all.sessions.map((s) => [s.id, s]));
    const aItem = byShortId.get(aEntry.shortId);
    const bItem = byShortId.get(bEntry.shortId);
    expect({
      listNoExplicit: aItem && aItem.inbound,
      listExplicitCard: bItem && bItem.inbound,
      apiNoExplicit: aEntry.inbound,
      apiExplicitCard: bEntry.inbound,
    }, `总开关开着时:没有显式 inbound 的会话应判 auto、显式 card 的仍是 card。list_sessions 返回:${JSON.stringify(all.sessions)};会话列表接口:A=${JSON.stringify(aEntry)},B=${JSON.stringify(bEntry)}`)
      .toEqual({ listNoExplicit: 'auto', listExplicitCard: 'card', apiNoExplicit: 'auto', apiExplicitCard: 'card' });
  } finally { await inst.stop(); }
});
