// r196 T4:后台排空 client/src/utils/backgroundDrain.js(假轮询器、假请求、假时钟;状态库用真的,配 localStorage 垫片)。
//   P 纯函数:classifyBgSendResponse 两个阶段全表、isSessionBusy、bgDrainBlockReason / pickBgDrainTargets 每条判据(含回退令牌过期、
//     窗格登记作废退避)、backoffMs、holdReasonText、权限解析、历史模型、登记在抛错路径也注销。
//   C 控制器:受理 → 核对编号后移除;权限 / 模型按会话(V4 两个变体)与第三方降档;会话忙退避与窗格接管;404 移进首页;明确失败、
//     重试用尽、结果不明同号同体重发后转复核、换了服务实例;编号对不上;504 后三种终态;兜底超时三分支;草稿迁移与第一条失败;
//     刷新遗留 / 隐藏项 / 回退中 / 远程控制中不发;stop 不改条目。
// node tests/unit/check-r196-background-drain.mjs
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, String(v)); }, removeItem: (k) => { storage.delete(k); },
  key: (i) => [...storage.keys()][i] ?? null, get length() { return storage.size; },
};
const BD = await import('../../client/src/utils/backgroundDrain.js');
const { useStore, RUN_ID } = await import('../../client/src/stores/sessionStore.js');
const {
  classifyBgSendResponse: classify, isSessionBusy, bgDrainBlockReason, pickBgDrainTargets, backoffMs, holdReasonText,
  resolveBgPermissionMode, resolveBgHistModel, registerPaneDrain, beginFinalizing, isFinalizing, setRollbackBusy, clearRollbackBusy,
  createBackgroundDrainer, bgAcceptedPids, BG_INTERRUPTED_TEXT, AUTO_DOWNGRADE_NOTICE,
} = BD;

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };
const proc = (sessionId, extra = {}) => ({ kind: 'chat-process', pid: 'p-' + sessionId, sessionId, stoppable: true, status: 'idle', ...extra });

// ── P 纯函数 ──────────────────────────────────────────────────────────────────────────
{
  const T = [
    [[200, { ok: true, pid: '1' }], 'accepted', 'accepted'], [[200, { ok: true, pid: '1', duplicated: true }], 'accepted', 'accepted'],
    [[504, { code: 'CHAT_START_TIMEOUT', pid: '1' }], 'start-timeout', 'start-timeout'],
    [[409, { code: 'CHAT_SESSION_BUSY' }], 'busy', 'busy'], [[409, { code: 'CHAT_SESSION_BUSY', reason: 'session-turn-running', pid: '1' }], 'busy', 'busy'],
    [[404, { code: 'CHAT_SESSION_GONE' }], 'gone', 'gone'],
    [[400, { code: 'CHAT_INVALID_CWD', error: 'x' }], 'failed', 'failed'], [[400, { code: 'CHAT_INVALID_INPUT' }], 'failed', 'failed'], [[403, {}], 'failed', 'failed'],
    [[500, { code: 'CHAT_START_FAILED' }], 'retryable', 'retryable'], [[503, { code: 'TURN_CAPACITY' }], 'retryable', 'retryable'],
    [[409, { code: 'TURN_SERVER_CHANGED' }], 'server-changed', 'unknown'],
    [[409, { code: 'TURN_CONFLICT' }], 'failed', 'unknown'], [[409, { code: 'TURN_EXPIRED' }], 'failed', 'unknown'],
    [[200, { ok: true }], 'ambiguous', 'ambiguous'], [[504, { code: 'CHAT_START_TIMEOUT' }], 'ambiguous', 'ambiguous'],
    [[502, {}], 'ambiguous', 'ambiguous'], [[500, { code: 'OTHER' }], 'ambiguous', 'ambiguous'], [[200, null], 'ambiguous', 'ambiguous'],
  ];
  for (const [[s, b], first, resend] of T) {
    eq([classify('first', s, b), classify('resend', s, b)], [first, resend], `P classify ${s} ${JSON.stringify(b)}`);
  }
  eq([classify('first', 0, null, true), classify('resend', 200, { pid: '1' }, true)], ['ambiguous', 'ambiguous'], 'P classify 网络错误 / 超时');

  const K = 'P-K';
  eq(isSessionBusy([proc(K, { status: 'starting' })], K), true, 'P busy:初始化中');
  eq(isSessionBusy([proc(K, { status: 'streaming' })], K), true, 'P busy:续跑复活 / 收尾窗 / 被停那一段(idle 为假)');
  eq(isSessionBusy([proc(K, { status: 'idle' })], K), false, 'P busy:空闲');
  eq(isSessionBusy([proc(K, { status: 'done', stoppable: false }), proc(K, { status: 'error', stoppable: false })], K), false, 'P busy:已退出');
  eq(isSessionBusy([proc('other', { status: 'streaming' }), { kind: 'subagent', sessionId: K, stoppable: true, status: 'running' }], K), false, 'P busy:别的会话 / 别的种类不算');

  const head = (extra) => ({ queueId: 'h', text: 'hi', runId: RUN_ID, owner: { cwd: '/w' }, ...extra });
  const base = (extra = {}) => ({ queues: { [K]: [head()] }, items: [], runId: RUN_ID, now: 5_000_000, inFlight: new Map(), nextTryAt: new Map(),
    pendingDelete: new Set(), remoteControlled: {}, lastProviderBySession: {}, currentProviderHint: 'anthropic', largeAsk: new Map(), ...extra });
  eq(bgDrainBlockReason(K, base()), null, 'P 判据:全部满足 → 可发');
  eq(pickBgDrainTargets(base()).map((x) => [x.key, x.index, x.item.queueId]), [[K, 0, 'h']], 'P pick:选出队首');
  const R = (extra, m) => bgDrainBlockReason(K, base(extra));
  eq(R({ queues: { [K]: [] } }), 'no-head', 'P 判据:没有队首');
  eq(R({ queues: { [K]: [head({ runId: 'old-run' })] } }), 'other-run', 'P 判据:刷新 / 重启前遗留的不发');
  eq(R({ queues: { [K]: [head({ runId: undefined })] } }), 'other-run', 'P 判据:没有运行号的不发');
  eq(R({ queues: { [K]: [head({ hidden: true }), head({ queueId: 'h2' })] } }), 'hidden', 'P 判据:隐藏项不发,也挡住后面的');
  eq(R({ queues: { [K]: [head({ owner: null })] } }), 'no-owner', 'P 判据:没有入队快照不发');
  eq(R({ queues: { [K]: [head({ steerState: 'bg-sending' })] } }), 'no-head', 'P 判据:在途条目不是可发队首');
  eq(R({ queues: { [K]: [head({ busyRetryAt: 5_000_001 })] } }), 'no-head', 'P 判据:窗格 409 的间隔没到不发');
  eq(R({ pendingDelete: new Set([K]) }), 'deleting', 'P 判据:待删');
  eq(R({ remoteControlled: { [K]: true } }), 'remote', 'P 判据:远程控制中');
  eq(R({ lastProviderBySession: { [K]: 'deepseek' } }), 'provider-changed', 'P 判据:Provider 与上次不同');
  eq(R({ lastProviderBySession: { [K]: 'anthropic' } }), null, 'P 判据:Provider 相同照发');
  eq(R({ largeAsk: new Map([[K, { epoch: 0 }]]) }), 'large-snapshot', 'P 判据:拍快照时目录太大、要先问用户');
  eq(R({ inFlight: new Map([[K, {}]]) }), 'in-flight', 'P 判据:本会话已有一条在途');
  eq(R({ items: [proc(K, { status: 'streaming' })] }), 'busy', 'P 判据:这一轮还在跑');
  eq(R({ queues: { 'draft-h-d1-1': [head()] } }) && bgDrainBlockReason('draft-h-d1-1', base({ queues: { 'draft-h-d1-1': [head()] } })), 'draft', 'P 判据:草稿键不直接发');
  const unreg = registerPaneDrain(K);
  eq(R(), 'pane', 'P 判据:有窗格登记');
  unreg(); unreg();
  eq(R({ largeAsk: new Map([[K, { epoch: 0 }]]) }), null, 'P 判据:窗格登记过 → 大目录询问的记录作废(交给窗格)');
  eq(R(), null, 'P 判据:注销(重复注销无副作用)后恢复');
  const end = beginFinalizing([K]);
  try { throw new Error('收尾途中抛错'); } catch { /* 模拟 */ } finally { end(); }
  eq([R(), isFinalizing(K)], [null, false], 'P 判据:流收尾在抛错路径也注销');
  const end2 = beginFinalizing(['draft-x']); end2.add(K);
  eq(R(), 'finalizing', 'P 判据:收尾登记追加正式编号');
  end2(); end2();
  eq(R(), null, 'P 判据:收尾注销');
  setRollbackBusy(K, 5_000_000 - 119_999);
  eq(R(), 'rollback', 'P 判据:回退令牌未过期');
  setRollbackBusy(K, 5_000_000 - 120_000);
  eq(R(), null, 'P 判据:回退令牌 2 分钟过期');
  setRollbackBusy(K, 5_000_000); clearRollbackBusy(K);
  eq(R(), null, 'P 判据:回退令牌清除');
  // 退避换一个从没登记过窗格的键(登记代数 0):条目记的代数与当前相同才算数
  const K2 = 'P-K2';
  const R2 = (extra) => bgDrainBlockReason(K2, base({ queues: { [K2]: [head()] }, ...extra }));
  const nt = new Map([[K2, { at: 5_000_001, epoch: 0 }]]);
  eq(R2({ nextTryAt: nt }), 'backoff', 'P 判据:退避中');
  eq(R2({ nextTryAt: new Map([[K2, { at: 5_000_000, epoch: 0 }]]) }), null, 'P 判据:退避到点');
  registerPaneDrain(K2)();
  eq(R2({ nextTryAt: nt }), null, 'P 判据:窗格登记过一次 → 之前的退避作废');

  eq([1, 2, 3, 4, 5, 9].map((n) => backoffMs('busy', n)), [2000, 4000, 8000, 16000, 30000, 30000], 'P 退避:会话忙');
  eq([1, 2, 3, 4].map((n) => backoffMs('retryable', n)), [5000, 15000, 45000, 45000], 'P 退避:可重试');
  eq([1, 2, 3].map((n) => backoffMs('ambiguous', n)), [3000, 10000, 10000], 'P 退避:结果不明');
  eq(holdReasonText('interrupted'), '这条在自动发出时被打断（网络中断、页面刷新或服务重启），不能确定是否已经发出；请先查看会话记录，再决定重发或删除。', 'P 文案:结果不明');
  eq(holdReasonText('failed', '工作目录不存在'), '自动发送没有成功：工作目录不存在', 'P 文案:明确失败');
  eq(holdReasonText('retries-exhausted', 'x'), '自动发送没有成功（已重试 3 次）：x', 'P 文案:重试用尽');
  eq(holdReasonText('turn-incomplete'), '自动发出的这一轮没有完成；请先查看会话记录，再决定重发或删除。', 'P 文案:504 后没完成');
  eq(holdReasonText('session-mismatch'), '自动发出后会话编号对不上；请先查看会话记录。', 'P 文案:编号对不上');
  eq(holdReasonText('???'), BG_INTERRUPTED_TEXT, 'P 文案:认不出的原因码按结果不明说');
  eq([resolveBgPermissionMode({ [K]: 'acceptEdits' }, K), resolveBgPermissionMode({}, K), resolveBgPermissionMode(null, K)], ['acceptEdits', 'default', 'default'],
    'P 权限:单独设过用它,没设过一律逐步确认');
  const EP = 1_700_000_000_000;
  eq(resolveBgHistModel({ histMsg: { model: 'm-h', timestamp: new Date(EP + 1).toISOString() }, key: K, providerEpoch: EP }), 'm-h', 'P 历史模型:快照晚于 epoch');
  eq(resolveBgHistModel({ histMsg: { model: 'm-h', timestamp: new Date(EP - 1).toISOString() }, key: K, providerEpoch: EP }), null, 'P 历史模型:快照早于 epoch(非官方)');
  eq(resolveBgHistModel({ items: [proc(K, { model: 'm-p', startedAt: EP + 5 })], key: K, providerEpoch: EP }), 'm-p', 'P 历史模型:快照为空用进程 model');
  eq(resolveBgHistModel({ items: [proc(K, { model: 'm-p', startedAt: EP - 5 })], key: K, providerEpoch: EP }), null, 'P 历史模型:进程早于 epoch 不用');
}

// ── C 控制器 ─────────────────────────────────────────────────────────────────────────
let clock = 10_000_000;
let timers = [];
let tid = 0;
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
async function advance(ms) {
  const end = clock + ms;
  for (;;) {
    await flush();
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > end) break;
    timers.shift(); clock = t.at; t.fn();
  }
  clock = end;
  await flush();
}
function makeEnv({ responder, fresh, items, snapshot } = {}) {
  const env = { posts: [], notices: [], promoted: [], epoch: 'ep-1', epochCleared: 0, fresh: fresh || { agents: [] } };
  env.drainer = createBackgroundDrainer({
    subscribe: (cb) => { env.cb = cb; return () => { env.cb = null; }; },
    fetchFresh: async () => (typeof env.fresh === 'function' ? env.fresh(env) : env.fresh),
    store: useStore, runId: RUN_ID,
    postChat: async (body) => {
      env.posts.push(JSON.parse(JSON.stringify(body)));
      const r = responder(body, env.posts.length);
      if (r === 'network') throw new Error('network');
      return r;
    },
    getServerEpoch: async () => env.epoch, clearServerEpoch: () => { env.epochCleared++; env.epoch = 'ep-2'; },
    now: () => clock,
    setTimer: (fn, ms) => { const id = ++tid; timers.push({ at: clock + ms, fn, id }); return id; },
    clearTimer: (id) => { timers = timers.filter((t) => t.id !== id); },
    newTurnId: (() => { let n = 0; return () => `bg-t${++n}`; })(),
    leaveNotice: (k, text) => env.notices.push([k, text]),
    promoteDraftArtifacts: (d, s) => env.promoted.push([d, s]),
    preflightSnapshot: snapshot || null,
  });
  env.drainer.start();
  env.poll = async (agents = items || []) => { env.cb({ agents }); await flush(); };
  return env;
}
const item = (queueId, extra = {}) => ({ queueId, text: `msg ${queueId}`, queuedAt: 1, runId: RUN_ID, owner: { cwd: '/w/a', projectHash: '-w-a', histMsg: null }, ...extra });
function seed(queues, extra = {}) {
  timers = [];
  useStore.setState({
    messageQueue: queues, orphanDraftQueues: {}, permissionModeBySession: {}, modelBySession: {}, permissionMode: 'bypassPermissions',
    currentProvider: { providerHint: 'anthropic' }, autoAuditStatus: { official: true, enabled: false }, remoteControlled: {},
    lastProviderBySession: {}, pendingDeleteSessions: new Set(), availableModels: [], customModels: [], currentModel: 'm-global',
    context1mBySession: {}, providerEpoch: 0, persistentChat: true, maxBudgetUsd: 0, genuiRender: true, ...extra,
  });
}
const q = (k) => useStore.getState().messageQueue[k] || [];
const OK200 = (pid) => ({ status: 200, body: { ok: true, pid } });

{ // C1 受理 → 核对编号 → 移除;请求体按会话(V4 变体 b:没设过档位、全局是全部放行 → 逐步确认)
  seed({ C1: [item('a')] });
  const env = makeEnv({ responder: () => OK200('p1'), fresh: (e) => ({ agents: [proc('C1', { pid: 'p1', status: e.posts.length ? 'streaming' : 'idle' })] }) });
  await env.poll([proc('C1')]);
  eq(env.posts.length, 1, 'C1:发出一次');
  const b = env.posts[0];
  eq([b.sessionId, b.cwd, b.queuedDrain, b.prompt, b.clientTurnId, b.serverEpoch, b.permissionMode, b.model], ['C1', '/w/a', true, 'msg a', 'bg-t1', 'ep-1', 'default', 'm-global'],
    'C1:请求体 sessionId = 队列键、cwd = 入队快照、带 queuedDrain、权限没设过 → 逐步确认');
  eq(q('C1'), [], 'C1:核对编号后移除');
  ok(bgAcceptedPids.get('C1')?.has('p1'), 'C1:记下受理的 pid');
  await env.poll([proc('C1')]);
  eq(env.posts.length, 1, 'C1:不重发');
  env.drainer.stop();
}
{ // C2 V4 变体 a:单独设过档位与模型;第三方 auto 未开 → 降档写回并留言
  seed({ C2: [item('a')] }, { permissionModeBySession: { C2: 'acceptEdits', Q: 'bypassPermissions' }, modelBySession: { C2: 'm-a', Q: 'm-q' } });
  const env = makeEnv({ responder: () => OK200('p2'), fresh: { agents: [] } });
  await env.poll();
  eq([env.posts[0].permissionMode, env.posts[0].model], ['acceptEdits', 'm-a'], 'C2:用 A 自己的档位与模型');
  env.drainer.stop();
  seed({ C2b: [item('a')] }, { permissionModeBySession: { C2b: 'auto' }, currentProvider: { providerHint: 'deepseek' }, autoAuditStatus: { official: false, enabled: false } });
  const env2 = makeEnv({ responder: () => OK200('p2b'), fresh: { agents: [] } });
  await env2.poll();
  eq(env2.posts[0].permissionMode, 'default', 'C2:第三方 auto 未开 → 按逐步确认发');
  eq([useStore.getState().permissionModeBySession.C2b, env2.notices], ['default', [['C2b', AUTO_DOWNGRADE_NOTICE]]], 'C2:写回会话档位并留言');
  env2.drainer.stop();
}
{ // C3 刷新遗留 / 隐藏项 / 回退中 / 远程控制中 / 这一轮还在跑:不发
  seed({ C3a: [item('a', { runId: 'old' })], C3b: [item('b', { hidden: true })], C3c: [item('c')], C3d: [item('d')], C3e: [item('e')] }, { remoteControlled: { C3d: true } });
  setRollbackBusy('C3c', clock);
  const env = makeEnv({ responder: () => OK200('x') });
  await env.poll([proc('C3e', { status: 'starting' })]);
  eq(env.posts.length, 0, 'C3:一条都不发');
  clearRollbackBusy('C3c');
  env.drainer.stop();
}
{ // C4 会话忙 → 退回普通态、内存退避;窗格登记过 → 退避作废
  seed({ C4: [item('a')] });
  let n = 0;
  const env = makeEnv({ responder: () => (++n === 1 ? { status: 409, body: { code: 'CHAT_SESSION_BUSY' } } : OK200('p4')) });
  await env.poll();
  eq([env.posts.length, q('C4')[0].steerState, 'busyRetryAt' in q('C4')[0]], [1, undefined, false], 'C4:被拒 → 原位、普通态、条目上不写 busyRetryAt');
  await advance(1000); await env.poll();
  eq(env.posts.length, 1, 'C4:退避 2 秒内不再发');
  registerPaneDrain('C4')();
  await env.poll();
  eq([env.posts.length, env.posts[1].clientTurnId !== env.posts[0].clientTurnId, q('C4')], [2, true, []], 'C4:窗格登记过 → 退避作废、换新号再发并受理');
  env.drainer.stop();
}
{ // C5 404 会话文件不在 → 这个键的排队(隐藏项除外)移进首页「未发出的消息」
  seed({ C5: [item('a'), item('b', { steerState: 'kept' }), item('h', { hidden: true })] });
  const env = makeEnv({ responder: () => ({ status: 404, body: { ok: false, code: 'CHAT_SESSION_GONE', error: '会话记录不存在' } }) });
  await env.poll();
  const orphan = useStore.getState().orphanDraftQueues.C5;
  eq([q('C5'), orphan?.projectHash, orphan?.items.map((x) => x.queueId)], [[], '-w-a', ['a', 'b']], 'C5:移进首页,队列清空');
  ok(orphan.items.every((x) => !('steerState' in x) && !('bgTurnId' in x)), 'C5:移过去的条目去掉在途字段');
  env.drainer.stop();
}
{ // C6 明确失败 → 复核;C7 可重试 3 次后转复核
  seed({ C6: [item('a'), item('b')] });
  const env = makeEnv({ responder: () => ({ status: 400, body: { ok: false, code: 'CHAT_INVALID_CWD', error: '工作目录不存在或无法访问' } }) });
  await env.poll();
  const h = q('C6')[0];
  eq([h.steerState, h.holdReason.code, h.holdReason.detail, q('C6')[1].steerState], ['needs-review', 'failed', '工作目录不存在或无法访问', undefined], 'C6:复核、原因原文,后面的不动');
  await env.poll();
  eq(env.posts.length, 1, 'C6:复核挡住整条队列,不再自动发');
  env.drainer.stop();
  seed({ C7: [item('a')] });
  const env7 = makeEnv({ responder: () => ({ status: 500, body: { ok: false, code: 'CHAT_START_FAILED', error: '起不来' } }) });
  for (const wait of [0, 5000, 15000, 45000]) { await advance(wait); await env7.poll(); }
  eq([env7.posts.length, q('C7')[0].holdReason?.code, q('C7')[0].holdReason?.detail], [4, 'retries-exhausted', '起不来'], 'C7:第 4 次失败转复核');
  env7.drainer.stop();
}
{ // C8 结果不明:3 秒、10 秒后同号同体重发,仍不明转复核(interrupted)
  seed({ C8: [item('a')] });
  const env = makeEnv({ responder: () => 'network' });
  await env.poll();
  eq(env.posts.length, 1, 'C8:首发');
  await advance(2999); eq(env.posts.length, 1, 'C8:3 秒内不重发');
  await advance(1); eq(env.posts.length, 2, 'C8:3 秒后重发');
  await advance(10000); eq(env.posts.length, 3, 'C8:再 10 秒后重发');
  eq(env.posts[1], env.posts[0], 'C8:同号同体(1)'); eq(env.posts[2], env.posts[0], 'C8:同号同体(2)');
  eq([q('C8')[0].steerState, q('C8')[0].holdReason.code], ['needs-review', 'interrupted'], 'C8:仍不明 → 复核');
  env.drainer.stop();
  // 第二次重发收下 → 正常移除;请求超时(45 秒没回音)也按结果不明
  seed({ C8b: [item('a')] });
  let n = 0;
  const env2 = makeEnv({ responder: () => (++n === 1 ? new Promise(() => {}) : OK200('p8')) });
  await env2.poll();
  await advance(45000); await advance(3000);
  eq([env2.posts.length, env2.posts[1].clientTurnId, q('C8b')], [2, 'bg-t1', []], 'C8:45 秒超时 → 3 秒后同号重发、收下后移除');
  env2.drainer.stop();
}
{ // C9 换了服务实例:清缓存、取新实例号、同号立即重发一次;重发又是 TURN_SERVER_CHANGED → 复核
  seed({ C9: [item('a')] });
  const env = makeEnv({ responder: () => ({ status: 409, body: { code: 'TURN_SERVER_CHANGED' } }) });
  await env.poll();
  eq([env.posts.length, env.epochCleared, env.posts[1]?.serverEpoch, env.posts[1]?.clientTurnId], [2, 1, 'ep-2', env.posts[0].clientTurnId], 'C9:同号带新实例号重发一次');
  eq(q('C9')[0].holdReason?.code, 'interrupted', 'C9:重发阶段的 TURN_* 按结果不明复核');
  env.drainer.stop();
}
{ // C10 受理后进程的会话编号对不上 → 复核
  seed({ C10: [item('a')] });
  const env = makeEnv({ responder: () => OK200('p10'), fresh: { agents: [proc('C10'), proc('ZZZ', { pid: 'p10' })] } });
  await env.poll();
  eq(q('C10')[0].holdReason?.code, 'session-mismatch', 'C10:编号对不上 → 复核');
  env.drainer.stop();
}
for (const [label, final, expect] of [['completed', { status: 200, body: { ok: true, pid: 'p11', duplicated: true, status: 'completed' } }, 'removed'],
  ['failed', { status: 200, body: { ok: true, pid: 'p11', duplicated: true, status: 'failed' } }, 'turn-incomplete'],
  ['当新请求收下', { status: 200, body: { ok: true, pid: 'p12' } }, 'removed']]) { // C11 504 后三种终态
  seed({ C11: [item('a')] });
  let n = 0;
  const env = makeEnv({ responder: () => (++n === 1 ? { status: 504, body: { ok: false, code: 'CHAT_START_TIMEOUT', pid: 'p11' } } : final) });
  await env.poll();
  eq([q('C11')[0].steerState, q('C11')[0].bgAcceptedPid, q('C11')[0].bgStartTimedOut], ['bg-sending', 'p11', true], `C11 ${label}:504 → 保持在途`);
  await env.poll([proc('C11', { pid: 'p11', status: 'starting' })]);
  eq(env.posts.length, 1, `C11 ${label}:那个进程还在跑 → 不查`);
  await env.poll([proc('C11', { pid: 'p11', status: 'idle' })]);
  eq([env.posts.length, env.posts[1]?.clientTurnId], [2, env.posts[0].clientTurnId], `C11 ${label}:不在跑了 → 同号查询`);
  if (expect === 'removed') eq(q('C11'), [], `C11 ${label}:移除`);
  else eq(q('C11')[0].holdReason?.code, expect, `C11 ${label}:复核`);
  env.drainer.stop();
}
{ // C12 兜底超时(BD 内存里没有对应在途):有 pid 非 504 → 移除;没有 pid → 复核;504 而内存里没有原请求体 → 复核
  const t0 = clock - 120_001;
  seed({ C12a: [item('a', { steerState: 'bg-sending', bgTurnId: 'x', bgStartedAt: t0, bgAcceptedPid: 'p' })],
    C12b: [item('b', { steerState: 'bg-sending', bgTurnId: 'x', bgStartedAt: t0 })],
    C12c: [item('c', { steerState: 'bg-sending', bgTurnId: 'x', bgStartedAt: clock - 1000 })],
    C12d: [item('d', { steerState: 'bg-sending', bgTurnId: 'x', bgStartedAt: clock - 1000, bgAcceptedPid: 'p', bgStartTimedOut: true })] });
  const env = makeEnv({ responder: () => OK200('x') });
  await env.poll();
  eq([q('C12a'), q('C12b')[0].holdReason?.code, q('C12c')[0].steerState, q('C12d')[0].holdReason?.code], [[], 'interrupted', 'bg-sending', 'interrupted'],
    'C12:三分支 + 未到 120 秒的不动');
  eq(env.posts.length, 0, 'C12:都不发');
  env.drainer.stop();
}
{ // C13 草稿:拿到正式编号 → 调迁移函数;第一条失败(进程已结束仍没编号)→ 移进首页
  seed({ 'draft-h-d1-1': [item('a')], 'draft-h-d2-2': [item('b')] });
  const env = makeEnv({ responder: () => OK200('x') });
  await env.poll([proc('SID1', { draftId: 'd1-1' }), { kind: 'chat-process', pid: 'z', sessionId: null, draftId: 'd2-2', stoppable: false, status: 'error' }]);
  eq(env.promoted, [['draft-h-d1-1', 'SID1']], 'C13:替草稿迁移到正式编号');
  eq([q('draft-h-d2-2'), useStore.getState().orphanDraftQueues['draft-h-d2-2']?.items.map((x) => x.queueId)], [[], ['b']], 'C13:第一条失败 → 移进首页');
  eq(env.posts.length, 0, 'C13:草稿键本身不发');
  env.drainer.stop();
}
{ // C14 stop:中止在途、不改条目
  seed({ C14: [item('a')] });
  const env = makeEnv({ responder: () => new Promise(() => {}) });
  await env.poll();
  env.drainer.stop();
  await flush();
  eq([q('C14')[0].steerState, env.cb], ['bg-sending', null], 'C14:停下后条目保持在途、退订轮询');
  env.drainer.start(); clock += 120_001; await env.poll();
  eq([q('C14')[0].holdReason?.code, env.posts.length], ['interrupted', 1], 'C14:再 start 后由兜底超时收尾(没有被旧占位卡住、不重发)');
  env.drainer.stop();
}

{ // C15 文件快照:目录太大、没做过选择 → 不发、条目原位、没人接管前不重试;窗格接管过 → 作废;拍到 → 照常发
  seed({ C15: [item('a'), item('b')] });
  const snaps = [];
  let answer = { send: false, reason: 'large-snapshot-ask' };
  const env = makeEnv({ responder: () => OK200('p15'), snapshot: async (p) => { snaps.push(p); return answer; } });
  await env.poll();
  eq([env.posts.length, snaps.length, q('C15').map((x) => [x.queueId, x.steerState])], [0, 1, [['a', undefined], ['b', undefined]]], 'C15:目录要询问 → 不发,条目退回原位');
  eq([snaps[0].sessionId, snaps[0].cwd, snaps[0].clientMessageId, snaps[0].promptPreview], ['C15', '/w/a', 'bg-t1', 'msg a'], 'C15:快照请求带会话、入队快照的工作区、后台回合编号、提示');
  await env.poll();
  eq([snaps.length, env.posts.length], [1, 0], 'C15:没人接管之前不再试');
  registerPaneDrain('C15')();
  answer = { send: true, sha: 'sha-1' };
  await env.poll();
  eq([snaps.length, env.posts.length, q('C15').map((x) => x.queueId)], [2, 1, ['b']], 'C15:窗格接管过 → 作废;再试时拍到就照常发');
  env.drainer.stop();
}

console.log(`✓ check-r196-background-drain:${checks} 项断言全部通过`);
setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
