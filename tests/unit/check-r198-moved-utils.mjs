#!/usr/bin/env node
// r198 转到后台:页面工具函数(client/src/utils/movedToBackground.js)——结构化判定、后台时限与输出路径解析、
// 回车 / 并入那一路的窗格提示与按钮那一路的弹框文案(接口文件「页面提示」表逐行)。
// Run: node tests/unit/check-r198-moved-utils.mjs
import assert from 'node:assert/strict';

const {
  isMovedToBackground, parseBackgroundDeadline, parseOutputPath, autoMoveNoticeText, buttonMoveDialogText,
  longTimeoutConfirmText, LONG_FG_TIMEOUT_MS,
  canMoveToBackground, foregroundMoveTarget, hasMovedCommand, ownedMovedEntry, movedIdsKey,
} = await import('../../client/src/utils/movedToBackground.js');

let PASS = 0;
let FAILS = 0;
function check(name, fn) {
  try { fn(); PASS++; console.log(`  ✓ ${name}`); }
  catch (e) { FAILS++; console.log(`  ✗ ${name}\n      ${String(e?.message || e).split('\n').slice(0, 6).join('\n      ')}`); }
}

const ORIGINAL = 'Command was manually backgrounded by user with ID: bbz01wrtn. Output is being written to: C:\\Users\\John Doe\\AppData\\Local\\Temp\\claude\\tasks\\bbz01wrtn.output If it is still running after 30m in the background, it will be stopped and you will be notified.';
const ok = (extra = {}) => ({ ok: true, code: null, error: '', moved: [], pending: [], skipped: [], ...extra });
const fail = (code, error, extra = {}) => ({ ok: false, code, error, moved: [], pending: [], skipped: [], ...extra });

check('结构化判定:三种标记与历史的 movedToBackground 算;只有 backgroundTaskId 的(模型后台起的)不算', () => {
  assert.equal(isMovedToBackground({ backgroundTaskId: 'b', backgroundedByUser: true }), true);
  assert.equal(isMovedToBackground({ backgroundedToDeliverMessage: true }), true);
  assert.equal(isMovedToBackground({ timedOutAfterMs: 120000 }), true);
  assert.equal(isMovedToBackground({ movedToBackground: true, bgTaskId: 'b' }), true);
  assert.equal(isMovedToBackground({ backgroundTaskId: 'b' }), false);
  assert.equal(isMovedToBackground({ backgroundedByUser: 'yes' }), false);
  assert.equal(isMovedToBackground(null), false);
  assert.equal(isMovedToBackground('x'), false);
});
check('后台时限从原句取,取不到回 null;输出路径含空格也取全', () => {
  assert.equal(parseBackgroundDeadline(ORIGINAL), '30m');
  assert.equal(parseBackgroundDeadline('If it is still running after 2h in the background'), '2h');
  assert.equal(parseBackgroundDeadline('Command was manually backgrounded by user with ID: x'), null);
  assert.equal(parseBackgroundDeadline(undefined), null);
  assert.equal(parseOutputPath(ORIGINAL), 'C:\\Users\\John Doe\\AppData\\Local\\Temp\\claude\\tasks\\bbz01wrtn.output');
  assert.equal(parseOutputPath('no path'), null);
});
check('回车 / 并入那一路的窗格提示(接口文件页面提示表)', () => {
  assert.equal(autoMoveNoticeText(ok({ moved: ['a'] })), null);
  assert.equal(autoMoveNoticeText(ok()), null);
  assert.equal(autoMoveNoticeText(ok({ skipped: [{ toolUseId: 'a', reason: 'LONG_TIMEOUT' }] })),
    '有 1 条命令设了超过 30 分钟的前台时限,移到后台会在后台满 30 分钟时被命令行停掉,这次没有移动;需要的话点它卡片上的「移到后台」。');
  for (const c of ['BG_NO_ACTIVE_TURN', 'BG_STOPPING', 'BG_XS_TURN']) assert.equal(autoMoveNoticeText(fail(c, 'x')), null, c);
  assert.equal(autoMoveNoticeText(fail('BG_REJECTED', '命令行拒绝转到后台:后台任务已被关闭')), '没能移到后台:后台任务已被关闭');
  assert.equal(autoMoveNoticeText(fail('BG_TIMEOUT', '5 秒内没有收到命令行确认,结果未知')), '移到后台的结果未知:5 秒内没有收到命令行确认,结果未知');
  assert.equal(autoMoveNoticeText(fail('BG_INTERNAL', '转到后台处理异常,结果未知')), '移到后台的结果未知:转到后台处理异常,结果未知');
  assert.equal(autoMoveNoticeText(fail('BG_FORBIDDEN', 'x')), '请求被拒绝(登录或来源校验未通过)');
  assert.equal(autoMoveNoticeText(fail('BG_NETWORK', 'x')), '没连上后台服务,结果未知');
  assert.equal(autoMoveNoticeText(null), null);
});
check('按钮那一路的弹框文案;超长前台时限的确认文案', () => {
  assert.equal(buttonMoveDialogText(ok({ moved: ['a'] })), null);
  assert.equal(buttonMoveDialogText(ok()), '这条命令已经不在前台运行(可能刚结束或已在后台),没有移动。');
  assert.equal(buttonMoveDialogText(fail('BG_NO_ACTIVE_TURN', 'x')), '这一轮已经结束,没有需要移动的命令。');
  assert.equal(buttonMoveDialogText(fail('BG_STOPPING', 'x')), '这一轮正在停止,没有移动。');
  assert.equal(buttonMoveDialogText(fail('BG_XS_TURN', 'x')), '这一轮在处理跨会话消息;移到后台会让对方先收到“已完成”,所以不移。');
  assert.equal(buttonMoveDialogText(fail('BG_REJECTED', '命令行拒绝转到后台:原话')), '没能移到后台:原话');
  assert.equal(buttonMoveDialogText(fail('BG_TIMEOUT', '5 秒内没有收到命令行确认,结果未知')), '移到后台的结果未知:5 秒内没有收到命令行确认,结果未知');
  assert.equal(buttonMoveDialogText(fail('BG_FORBIDDEN', 'x')), '请求被拒绝(登录或来源校验未通过)');
  assert.equal(buttonMoveDialogText(fail('BG_NETWORK', 'x')), '没连上后台服务,结果未知');
  assert.equal(LONG_FG_TIMEOUT_MS, 1_800_000);
  assert.equal(longTimeoutConfirmText(2_400_000), '这条命令设了 40 分钟的前台时限。移到后台后,命令行会在它后台运行满约 30 分钟时停掉它。仍要移到后台吗?');
});

// ---- T5 补 / C11:按钮给谁、组要不要默认展开、状态库里的已转走记录 ----
const bash = (id, extra = {}) => ({ id, name: 'Bash', input: { command: `cmd-${id}` }, result: null, ...extra });
const use = (tc) => ({ type: 'tool_use', toolCall: tc });
check('canMoveToBackground:Bash、没结果、前台任务表有它、属主一致、没被记为已转走才给', () => {
  const fg = { sessionId: 'S1', taskId: 'b1' };
  assert.equal(canMoveToBackground(bash('t1'), fg, 'S1'), true);
  assert.equal(canMoveToBackground(bash('t1'), fg, null), true, '没有属主上下文时照给');
  assert.equal(canMoveToBackground(bash('t1'), { sessionId: null }, 'S1'), true, '条目没记会话时照给');
  assert.equal(canMoveToBackground(bash('t1'), fg, 'S-FORK'), false, '分支复制出的卡片(属主不同)不给');
  assert.equal(canMoveToBackground(bash('t1', { result: { content: 'done' } }), fg, 'S1'), false, '已出结果的不给');
  assert.equal(canMoveToBackground(bash('t1'), undefined, 'S1'), false, '前台任务表没有的不给');
  assert.equal(canMoveToBackground({ ...bash('t1'), name: 'Read' }, fg, 'S1'), false, '不是 Bash 不给');
  assert.equal(canMoveToBackground(bash('t1'), fg, 'S1', new Set(['t1'])), false, '已记为转走的不给');
  assert.equal(canMoveToBackground(null, fg, 'S1'), false);
});
check('foregroundMoveTarget:收起的工作组头行按钮对着组里最后一条可转的;没有回 null', () => {
  const fgTasks = { t1: { sessionId: 'S1' }, t3: { sessionId: 'S1' } };
  const items = [use(bash('t1')), { type: 'thinking', content: 'x' }, use(bash('t2', { result: { content: 'ok' } })), use(bash('t3'))];
  const hit = foregroundMoveTarget(items, fgTasks, 'S1');
  assert.equal(hit.toolCall.id, 't3');
  assert.equal(hit.sessionId, 'S1');
  assert.equal(foregroundMoveTarget(items, fgTasks, 'S1', new Set(['t3'])).toolCall.id, 't1', '已转走的跳过');
  assert.equal(foregroundMoveTarget(items, {}, 'S1'), null);
  assert.equal(foregroundMoveTarget(null, fgTasks, 'S1'), null);
  assert.equal(foregroundMoveTarget([use(bash('t9'))], { t9: { sessionId: null } }, null).sessionId, null);
});
check('hasMovedCommand:工具结果带转走标记,或在状态库已转走集合里,组就默认展开;模型后台起的不算', () => {
  assert.equal(hasMovedCommand([use(bash('a', { result: { movedToBackground: true, bgTaskId: 'b' } }))]), true);
  assert.equal(hasMovedCommand([use(bash('a', { result: { content: 'x', bgTaskId: 'b' } }))]), false);
  assert.equal(hasMovedCommand([use(bash('a'))]), false);
  assert.equal(hasMovedCommand([use(bash('a'))], new Set(['a'])), true, '没收到工具结果的窗格靠状态库记录');
  assert.equal(hasMovedCommand([{ type: 'thinking' }], new Set(['a'])), false);
  assert.equal(hasMovedCommand(undefined), false);
});
check('ownedMovedEntry / movedIdsKey:只认 moved:true 且属主一致的记录;拼成字符串给选择器', () => {
  const bg = {
    a: { id: 'a', moved: true, sessionId: 'S1', shellId: 'bbza' },
    b: { id: 'b', status: 'running', sessionId: 'S1' },            // 模型后台起的命令
    c: { id: 'c', moved: true, sessionId: 'S2' },                  // 别的会话(分支复制)
    d: { id: 'd', moved: true, sessionId: null },
  };
  assert.equal(ownedMovedEntry(bg.a, 'S1'), bg.a);
  assert.equal(ownedMovedEntry(bg.b, 'S1'), null);
  assert.equal(ownedMovedEntry(bg.c, 'S1'), null);
  assert.equal(ownedMovedEntry(bg.c, null), bg.c);
  assert.equal(ownedMovedEntry(undefined, 'S1'), null);
  assert.equal(movedIdsKey(bg, ['a', 'b', 'c', 'd', 'zz'], 'S1'), 'a,d');
  assert.equal(movedIdsKey(bg, [], 'S1'), '');
  assert.equal(movedIdsKey(null, ['a'], 'S1'), '');
});

// ---- C8:停止闩锁只挡"被停的那一段"(client/src/utils/reattach.js) ----
const { isStoppedSegment } = await import('../../client/src/utils/reattach.js');
check('isStoppedSegment:只跳过被停的那一段;编号越过后解除并删掉进程号;服务端没处理到停止 / 旧服务端照旧跳过', () => {
  const set = new Set(['sdk-1', 'sdk-2', 'sdk-3']);
  assert.equal(isStoppedSegment({ pid: 'sdk-9', segment: '0.0' }, set), false, '没停过的进程不跳过');
  assert.equal(isStoppedSegment({ pid: 'sdk-1', segment: '0.0', stoppedSegment: '0.0' }, set), true, '还是被停的那一段');
  assert.equal(isStoppedSegment({ pid: 'sdk-1', segment: '0.0' }, set), true, '服务端还没处理到停止');
  assert.equal(isStoppedSegment({ pid: 'sdk-2' }, set), true, '旧服务端没有这两个字段');
  assert.equal(set.has('sdk-1'), true);
  assert.equal(isStoppedSegment({ pid: 'sdk-1', segment: '0.1', stoppedSegment: '0.0' }, set), false, '命令行自己续跑的下一段');
  assert.equal(set.has('sdk-1'), false, '解除后从集合里删掉');
  assert.equal(isStoppedSegment({ pid: 'sdk-1', segment: '0.0', stoppedSegment: '0.0' }, set), false, '删掉之后不再跳过');
  assert.equal(isStoppedSegment({ pid: 'sdk-3', segment: '1.0', stoppedSegment: '0.0' }, set), false, '复用进程开了新回合');
  assert.equal(isStoppedSegment({ pid: 'sdk-2', segment: '0.0' }, null), false);
});

console.log(`\nr198 页面工具函数单测:${PASS} 通过,${FAILS} 失败`);
process.exit(FAILS ? 1 : 0);
