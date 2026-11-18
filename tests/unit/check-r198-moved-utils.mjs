#!/usr/bin/env node
// r198 转到后台:页面工具函数(client/src/utils/movedToBackground.js)——结构化判定、后台时限与输出路径解析、
// 回车 / 并入那一路的窗格提示与按钮那一路的弹框文案(接口文件「页面提示」表逐行)。
// Run: node tests/unit/check-r198-moved-utils.mjs
import assert from 'node:assert/strict';

const {
  isMovedToBackground, parseBackgroundDeadline, parseOutputPath, autoMoveNoticeText, buttonMoveDialogText,
  longTimeoutConfirmText, LONG_FG_TIMEOUT_MS,
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

console.log(`\nr198 页面工具函数单测:${PASS} 通过,${FAILS} 失败`);
process.exit(FAILS ? 1 : 0);
