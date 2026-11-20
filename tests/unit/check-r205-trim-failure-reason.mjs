// r205-rollback-trim-reason 白盒单测:回滚的裁剪失败时,黄字里那句「原因：…」(trimFailureReason)。
// 逐条对照接口文件列的每一种原因(页面用例只造得出「找不到这条消息」与「拆散工具调用」两种,其余在这里守),
// 并核对 App.jsx 两处提示都把这句接在第一句之后。页面用例在 tests/acceptance/r205-rollback-trim-reason/。
// 跑法:node tests/unit/check-r205-trim-failure-reason.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trimFailureReason, runHistoryOpSettled } from '../../client/src/utils/historyOps.js';

let passed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; } catch (err) { fails.push(`${name}: ${err.message}`); }
};

// 接口文件「对外行为变化」第 1 条的原文。
const RUNNING = '原因：这一轮还没停下来（会话里可能有后台任务在跑）。稍等几秒再点一次回滚。';
const NOT_FOUND = '原因：会话记录里找不到这条消息。';
const SPLIT_TOOL = '原因：从这条消息处裁开会拆散一次工具调用和它的结果，为了不损坏会话没有裁。可以回滚到更早的一条消息。';
const CHANGED = '原因：裁剪时会话记录还在写入新内容。稍等几秒再点一次回滚。';
const NOT_SENT = '原因：请求没有发出去。';

// runHistoryOp 失败结果的形状:{ok:false, stage, status, code, error}。
const failed = (code, error, extra = {}) => ({ ok: false, stage: 'submit', status: 409, code, error, ...extra });

// ── 1. 认得出的四种代码:写成人话,不夹后端原文 ─────────────────────────────────
await t('1a SESSION_RUNNING', () => {
  assert.equal(trimFailureReason(failed('SESSION_RUNNING', '该会话有回合正在运行,请先停止再做历史操作')), RUNNING);
});
await t('1b SESSION_NOT_FOUND(预览阶段 404)', () => {
  assert.equal(trimFailureReason(failed('SESSION_NOT_FOUND', '会话里找不到该锚点', { stage: 'preview', status: 404 })), NOT_FOUND);
});
await t('1c SESSION_COMPATIBILITY_UNVERIFIED', () => {
  assert.equal(trimFailureReason(failed('SESSION_COMPATIBILITY_UNVERIFIED', '该变换的签名兼容性无法验证,已拒绝改写')), SPLIT_TOOL);
});
await t('1d SESSION_CHANGED', () => {
  assert.equal(trimFailureReason(failed('SESSION_CHANGED', '会话刚有新活动,请重新预览再提交')), CHANGED);
});
await t('1e 认得出的代码不夹后端原文', () => {
  const out = trimFailureReason(failed('SESSION_RUNNING', '该会话有回合正在运行,请先停止再做历史操作'));
  assert.ok(!out.includes('请先停止再做历史操作'), out);
});

// ── 2. 其他代码:「原因：」+ 后端原文 +「（代码 XXX）。」;没有代码只写原文,以句号收尾 ─────────
await t('2a SESSION_WRITE_FAILED 带原文与代码,末尾句号', () => {
  assert.equal(
    trimFailureReason(failed('SESSION_WRITE_FAILED', '改写失败,原会话可能未改动:磁盘已满', { status: 500 })),
    '原因：改写失败,原会话可能未改动:磁盘已满（代码 SESSION_WRITE_FAILED）。',
  );
});
await t('2b SESSION_PREVIEW_EXPIRED 带原文与代码,末尾句号', () => {
  assert.equal(
    trimFailureReason(failed('SESSION_PREVIEW_EXPIRED', '预览已失效(过期或服务已重启),请重新预览')),
    '原因：预览已失效(过期或服务已重启),请重新预览（代码 SESSION_PREVIEW_EXPIRED）。',
  );
});
await t('2c 原型链上的名字不算认得出的代码', () => {
  assert.equal(trimFailureReason(failed('toString', 'x')), '原因：x（代码 toString）。');
});
await t('2d 没有代码(后端没回 JSON)时只写原文,不加代码括注,补句号', () => {
  assert.equal(trimFailureReason(failed(null, '预览失败（HTTP 502）', { stage: 'preview', status: 502 })), '原因：预览失败（HTTP 502）。');
});
await t('2e 没有代码、原文已以句号 / 问号 / 叹号结尾(全角或半角):不重复加', () => {
  assert.equal(trimFailureReason(failed(null, '服务暂时不可用。')), '原因：服务暂时不可用。');
  assert.equal(trimFailureReason(failed(null, '会话还在吗？')), '原因：会话还在吗？');
  assert.equal(trimFailureReason(failed(null, '写入失败！')), '原因：写入失败！');
  assert.equal(trimFailureReason(failed(null, 'ENOSPC: no space left on device.')), '原因：ENOSPC: no space left on device.');
});

// ── 3. 请求没发出去 ────────────────────────────────────────────────────────────
await t('3a 请求抛异常({thrown:true})', () => {
  assert.equal(trimFailureReason({ thrown: true }), NOT_SENT);
});
await t('3b 拿不到失败结果(null / undefined)按没发出去写', () => {
  assert.equal(trimFailureReason(null), NOT_SENT);
  assert.equal(trimFailureReason(undefined), NOT_SENT);
});

// ── 4. 与 runHistoryOpSettled 连起来:它给出的失败结果直接喂进来 ───────────────────
await t('4a 不重试的失败原样返回 → 对应原因', async () => {
  let calls = 0;
  const r = await runHistoryOpSettled('sid', 'trim', {}, {
    runOp: async () => { calls += 1; return failed('SESSION_COMPATIBILITY_UNVERIFIED', 'x'); },
  });
  assert.equal(calls, 1, '不在重试代码里,只跑一次');
  assert.equal(trimFailureReason(r), SPLIT_TOOL);
});
await t('4b SESSION_RUNNING 重试到时限仍失败 → 对应原因', async () => {
  let calls = 0;
  const r = await runHistoryOpSettled('sid', 'trim', {}, {
    runOp: async () => { calls += 1; return failed('SESSION_RUNNING', 'x'); }, maxMs: 6, intervalMs: 2,
  });
  assert.ok(calls >= 2, `应重试过,实际 ${calls} 次`);
  assert.equal(trimFailureReason(r), RUNNING);
});

// ── 5. App.jsx:两处提示都把原因接在第一句之后,其余不变 ─────────────────────────
const A = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const RB = A.slice(A.indexOf('const handleRollback = useCallback'), A.indexOf('useEffect(() => { handleRollbackRef.current = handleRollback; }'));
await t('5a 留在本会话的黄字:第一句 → 原因 → 放回输入框 → 文件结果', () => {
  assert.ok(RB.includes("['会话记录裁剪失败，会话记录没有改动，原定的重发没有发出。', trimFailureReason(trimFailure), where, fileNote]"));
});
await t('5b 中途切走留给原会话的提示:第一句之后接原因(只在裁剪失败时)', () => {
  assert.ok(RB.includes("'回退过程中切换了会话：会话记录裁剪失败（磁盘历史未改动），原定的重发没有发出。',\n        trimOk ? '' : trimReason,"));
  assert.ok(RB.includes("leaveForOwner({ notes: diskNotes, trimOk: !trimFailed, trimReason: trimFailed ? trimFailureReason(trimFailure) : '', wiped: wipedAway });"));
});
await t('5c 记下失败结果:接口回的失败与请求抛的异常两条路都记', () => {
  assert.ok(RB.includes('if (!tr.ok) { trimFailed = true; trimFailure = tr; }'));
  assert.ok(RB.includes('} catch { trimFailed = true; if (!trimFailure) trimFailure = { thrown: true }; }'));
});

console.log(`\n[check-r205-trim-failure-reason] ${passed} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
