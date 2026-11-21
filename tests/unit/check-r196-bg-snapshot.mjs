// r196:后台排空用的拍快照 largeSnapshot.bgPreflightLargeSnapshot(不弹窗)。
//   拍到 → 照常发(带 sha);目录太大、这个会话没就大目录做过选择(或正问着)→ 先不在后台发,不认领询问(窗格回来照样问);
//   选过「保存」→ 带 allowOversize 拍;选过「不保存」→ 不拍、照常发;请求失败(抛错 / 非 ok)→ 静默照常发;
//   窗格的 preflightLargeSnapshot 行为不动(被跳过时照旧弹窗)。
// node tests/unit/check-r196-bg-snapshot.mjs
import assert from 'node:assert/strict';
import {
  bgPreflightLargeSnapshot, preflightLargeSnapshot, rememberLargeSnapshot, resetLargeSnapshotState, willAskLargeSnapshot, claimLargeSnapshotAsk,
} from '../../client/src/utils/largeSnapshot.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const mkDeps = (resp) => {
  const calls = [];
  return {
    calls,
    request: async (url, body) => {
      calls.push({ url, body });
      if (resp instanceof Error) throw resp;
      return typeof resp === 'function' ? resp(body) : resp;
    },
    confirm: async () => { throw new Error('后台拍快照不该弹窗'); },
  };
};
const P = { sessionId: 's1', cwd: '/w', label: 'before: x', clientMessageId: 'bg-1', messageTimestamp: '2026-11-20T00:00:00.000Z', promptPreview: 'x' };

resetLargeSnapshotState();
{
  const d = mkDeps({ ok: true, data: { sha: 'abc' } });
  eq(await bgPreflightLargeSnapshot(P, d), { send: true, sha: 'abc' }, '拍到 → 照常发,带 sha');
  eq([d.calls.length, d.calls[0].url, d.calls[0].body], [1, '/api/checkpoints', P], '与窗格同一个请求,载荷原样');
}
resetLargeSnapshotState();
{
  const d = mkDeps({ ok: true, data: { skipped: true, estimatedBytes: 1e10, limitBytes: 1e9 } });
  eq(await bgPreflightLargeSnapshot(P, d), { send: false, reason: 'large-snapshot-ask' }, '目录太大、没做过选择 → 先不在后台发');
  eq(willAskLargeSnapshot('s1'), true, '没有认领询问:用户回到会话时窗格照样问');
}
resetLargeSnapshotState();
claimLargeSnapshotAsk('s1');
{
  eq(await bgPreflightLargeSnapshot(P, mkDeps({ ok: true, data: { skipped: true } })), { send: false, reason: 'large-snapshot-ask' }, '窗格正在问 → 同样先不发');
}
resetLargeSnapshotState();
rememberLargeSnapshot('s1', true);
{
  const d = mkDeps((b) => ({ ok: true, data: b.allowOversize ? { sha: 'big' } : { skipped: true } }));
  eq(await bgPreflightLargeSnapshot(P, d), { send: true, sha: 'big' }, '选过「保存」→ 带 allowOversize 拍到');
  eq(d.calls[0].body.allowOversize, true, '请求带 allowOversize');
  const d2 = mkDeps({ ok: true, data: { skipped: true } });
  eq(await bgPreflightLargeSnapshot(P, d2), { send: true, sha: null }, '选过「保存」仍被跳过 → 不问,照常发');
}
resetLargeSnapshotState();
rememberLargeSnapshot('s1', false);
{
  const d = mkDeps({ ok: true, data: { sha: 'x' } });
  eq(await bgPreflightLargeSnapshot(P, d), { send: true, sha: null }, '选过「不保存」→ 不拍、照常发');
  eq(d.calls.length, 0, '不发快照请求');
}
resetLargeSnapshotState();
{
  eq(await bgPreflightLargeSnapshot(P, mkDeps(new Error('network'))), { send: true, sha: null }, '请求抛错 → 静默照常发');
  eq(await bgPreflightLargeSnapshot(P, mkDeps({ ok: false })), { send: true, sha: null }, '请求非 ok → 静默照常发');
  eq(await bgPreflightLargeSnapshot(P, mkDeps({ ok: true, data: {} })), { send: true, sha: null }, '没有 sha 也没被跳过 → 照常发');
}
resetLargeSnapshotState();
{
  let asked = 0;
  const d = { request: async () => ({ ok: true, data: { skipped: true } }), confirm: async () => { asked += 1; return false; } };
  eq(await preflightLargeSnapshot(P, d), null, '窗格的函数:被跳过、选不保存 → null');
  eq(asked, 1, '窗格的函数照旧弹窗');
}

console.log(`✓ check-r196-bg-snapshot:${checks} 项断言全部通过`);
