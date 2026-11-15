// r190:新会话首页的第一条消息在草稿挂上窗格时立即发出(不再等后台状态轮询 + 50ms 定时器)。
// 钉住:两条入队路的信封都带 opts.homeFirst、保留调用方 opts;判据函数的真假表;
// 首发副作用的声明位置与轮询排空兜底仍在。
import { readFileSync } from 'node:fs';
import { enqueueHomeDraft, enqueueRestoredHomeDraft, shouldSendHomeFirstNow } from '../../client/src/utils/home.js';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}

function fakeStore() {
  const calls = [];
  return {
    calls,
    enqueueMessage(key, msg) { calls.push(['enqueue', key, msg]); return { ...msg, queueId: 'q-1' }; },
    setPaneSession(i, s) { calls.push(['pane', i, s]); },
    setPaneMessages(i, m) { calls.push(['msgs', i, m]); },
    takeOrphanDraftMessage(k, id) { calls.push(['takeOrphan', k, id]); },
  };
}

const draft = { draft: true, draftId: 'd1', sessionId: null, projectHash: 'h', projectPath: '/p' };
const meta = { attachments: [{ path: '/a.png' }] };

// 1. enqueueHomeDraft:信封带 homeFirst,原有 opts 字段保留
{
  const store = fakeStore();
  const envelope = { text: 'hi', queuedAt: 1, opts: { meta, extra: 7 } };
  const queued = enqueueHomeDraft({ store, sessionKey: 'draft-h-d1', envelope, tabIndex: 0, draft });
  const sent = store.calls.find((c) => c[0] === 'enqueue')?.[2];
  check('enqueueHomeDraft: 返回入队结果', !!queued);
  check('enqueueHomeDraft: 信封带 homeFirst: true', sent?.opts?.homeFirst === true);
  check('enqueueHomeDraft: 保留 opts.meta', sent?.opts?.meta === meta);
  check('enqueueHomeDraft: 保留 opts 其它字段', sent?.opts?.extra === 7);
  check('enqueueHomeDraft: 文字与时间原样', sent?.text === 'hi' && sent?.queuedAt === 1);
  check('enqueueHomeDraft: 不改调用方的信封对象', envelope.opts.homeFirst === undefined);
}

// 1b. 调用方没给 opts 也带上标记
{
  const store = fakeStore();
  enqueueHomeDraft({ store, sessionKey: 'k', envelope: { text: 'x' }, tabIndex: 0, draft });
  const sent = store.calls.find((c) => c[0] === 'enqueue')?.[2];
  check('enqueueHomeDraft: 无 opts 时也带 homeFirst', sent?.opts?.homeFirst === true);
}

// 2. enqueueRestoredHomeDraft:经同一路入队,同样带标记,并删旧孤儿副本
{
  const store = fakeStore();
  const envelope = { text: 'restored', queuedAt: 2, opts: { meta } };
  enqueueRestoredHomeDraft({ store, orphanQueueKey: 'ok', orphanQueueId: 'oid', sessionKey: 'k2', envelope, tabIndex: 1, draft });
  const sent = store.calls.find((c) => c[0] === 'enqueue')?.[2];
  check('enqueueRestoredHomeDraft: 信封带 homeFirst: true', sent?.opts?.homeFirst === true);
  check('enqueueRestoredHomeDraft: 保留 opts.meta', sent?.opts?.meta === meta);
  check('enqueueRestoredHomeDraft: 仍删旧孤儿副本', store.calls.some((c) => c[0] === 'takeOrphan' && c[1] === 'ok' && c[2] === 'oid'));
}

// 3. 判据函数
const head = { text: 'M', opts: { homeFirst: true } };
const base = { session: draft, head, streaming: false, backgroundPid: null, finalizing: false, rollbackBusy: false };
check('判据: 草稿 + 带标记队首 + 全空闲 → 真', shouldSendHomeFirstNow(base) === true);
check('判据: 带附件 meta 的队首 → 真', shouldSendHomeFirstNow({ ...base, head: { text: 'M', opts: { homeFirst: true, meta } } }) === true);
check('判据: 不是草稿(有会话号) → 假', shouldSendHomeFirstNow({ ...base, session: { ...draft, sessionId: 's1' } }) === false);
check('判据: 没有草稿号 → 假', shouldSendHomeFirstNow({ ...base, session: { sessionId: null } }) === false);
check('判据: 队列空 → 假', shouldSendHomeFirstNow({ ...base, head: undefined }) === false);
check('判据: 队首没文字 → 假', shouldSendHomeFirstNow({ ...base, head: { text: '', opts: { homeFirst: true } } }) === false);
check('判据: 隐藏消息 → 假', shouldSendHomeFirstNow({ ...base, head: { ...head, hidden: true } }) === false);
check('判据: 没有首发标记 → 假', shouldSendHomeFirstNow({ ...base, head: { text: 'M', opts: {} } }) === false);
check('判据: 有本地流 → 假', shouldSendHomeFirstNow({ ...base, streaming: true }) === false);
check('判据: 有后台进程 → 假', shouldSendHomeFirstNow({ ...base, backgroundPid: '123' }) === false);
check('判据: 有流在收尾 → 假', shouldSendHomeFirstNow({ ...base, finalizing: true }) === false);
check('判据: 在回退等待 → 假', shouldSendHomeFirstNow({ ...base, rollbackBusy: true }) === false);
check('判据: 无入参 → 假', shouldSendHomeFirstNow() === false);

// 4. 源码:首发副作用在 handleSendRef 赋值之后;轮询排空的 50ms 兜底仍在
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const assignAt = app.indexOf('useEffect(() => { handleSendRef.current = handleSend; }, [handleSend]);');
  const effectAt = app.indexOf('shouldSendHomeFirstNow({');
  check('源码: 首发副作用声明在 handleSendRef 赋值之后', assignAt > 0 && effectAt > assignAt);
  // 订正:还要在处理会话切换的副作用([selectedSession])之后 —— 否则换上草稿那次提交里,
  // 切换处理会清掉首发刚起的流状态与气泡、把切换计数加一,第一轮回复不实时显示。
  const switchEffectAt = app.indexOf('}, [selectedSession]);');
  check('源码: 首发副作用声明在处理会话切换的副作用之后', switchEffectAt > 0 && effectAt > switchEffectAt);
  const drainAt = app.indexOf('drainScheduled = true;');
  const timerAt = app.indexOf('setTimeout(() => {', drainAt);
  const fiftyAt = app.indexOf('}, 50);', timerAt);
  check('源码: 轮询排空的 setTimeout 与 50ms 仍在', drainAt > 0 && timerAt > drainAt && fiftyAt > timerAt && fiftyAt - timerAt < 2000);
}

console.log(`\ncheck-r190-home-first-send: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
