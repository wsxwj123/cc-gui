// 审计批A2:会话级偏好同步自检 —— 服务端 PUT 应用(applySessionSyncPut)与客户端
// 合并(mergeSyncedMap)。三张 map 的写入 / 收敛 / 后写胜出 / clear / draft 拒收 /
// effort '' 合法值各至少一条断言。node tests/unit/check-session-sync.mjs
import assert from 'node:assert/strict';
import { applySessionSyncPut, normalizeSessionSync, SYNC_KINDS } from '../../server/session-sync.js';
import { mergeSyncedMap, pushLocalOnlyKeys, syncableKey, createInFlightCounter } from '../../client/src/utils/sessionSync.js';

// ── 服务端:三张 map 各写入一条 ─────────────────────────────
let st = normalizeSessionSync(null);
let r = applySessionSyncPut(st, { kind: 'permissionMode', sessionId: 'sid-1', value: 'acceptEdits' });
assert.equal(r.error, null); assert.equal(r.changed, true);
assert.equal(r.maps.permissionModes['sid-1'], 'acceptEdits');
r = applySessionSyncPut(r.maps, { kind: 'modelPin', sessionId: 'sid-1', value: 'claude-opus-4-8' });
assert.equal(r.maps.modelPins['sid-1'], 'claude-opus-4-8');
r = applySessionSyncPut(r.maps, { kind: 'effortPin', sessionId: 'sid-1', value: 'high' });
assert.equal(r.maps.effortPins['sid-1'], 'high');

// 后写胜出:同 key 再写直接覆盖
r = applySessionSyncPut(r.maps, { kind: 'modelPin', sessionId: 'sid-1', value: 'claude-sonnet-4-6' });
assert.equal(r.maps.modelPins['sid-1'], 'claude-sonnet-4-6');

// 幂等:同 body 重放 changed=false,值不变
const replay = applySessionSyncPut(r.maps, { kind: 'modelPin', sessionId: 'sid-1', value: 'claude-sonnet-4-6' });
assert.equal(replay.changed, false);
assert.equal(replay.maps.modelPins['sid-1'], 'claude-sonnet-4-6');

// effort '' 是合法档位(「默认」),按值存不删
r = applySessionSyncPut(r.maps, { kind: 'effortPin', sessionId: 'sid-1', value: '' });
assert.ok('sid-1' in r.maps.effortPins); assert.equal(r.maps.effortPins['sid-1'], '');

// null 删除
r = applySessionSyncPut(r.maps, { kind: 'permissionMode', sessionId: 'sid-1', value: null });
assert.ok(!('sid-1' in r.maps.permissionModes));

// clear 清空整表(切 provider 清模型 pin)
r = applySessionSyncPut(r.maps, { clear: 'modelPins' });
assert.deepEqual(r.maps.modelPins, {});
assert.equal(r.maps.effortPins['sid-1'], ''); // 别的表不受影响

// draft 键拒收(未落盘会话不同步)
r = applySessionSyncPut(r.maps, { kind: 'modelPin', sessionId: 'draft-abc', value: 'x' });
assert.ok(r.error); assert.equal(r.changed, false);

// 非法 kind 拒收
r = applySessionSyncPut(st, { kind: 'nope', sessionId: 's', value: 'x' });
assert.ok(r.error);

// 收尾#2:超长 sessionId 拒收(与 value 同款 ≤200)
r = applySessionSyncPut(st, { kind: 'modelPin', sessionId: 'x'.repeat(201), value: 'm' });
assert.ok(r.error); assert.equal(r.changed, false);
r = applySessionSyncPut(st, { kind: 'modelPin', sessionId: 'x'.repeat(200), value: 'm' });
assert.equal(r.error, null); assert.equal(r.changed, true);

// SYNC_KINDS 覆盖三类
assert.deepEqual(Object.keys(SYNC_KINDS).sort(), ['effortPin', 'modelPin', 'permissionMode']);

// ── 客户端合并(收敛)────────────────────────────────────────
// 服务端胜出(后写胜出的全端收敛)
let merged = mergeSyncedMap({ 'sid-1': 'opus' }, { 'sid-1': 'sonnet' });
assert.equal(merged['sid-1'], 'sonnet');
// draft 键保留本地
merged = mergeSyncedMap({ 'draft-p1': 'opus' }, { 'sid-2': 'sonnet' });
assert.equal(merged['draft-p1'], 'opus'); assert.equal(merged['sid-2'], 'sonnet');
// 服务端缺失的本地实键保留(不做删除传播,防在途 PUT 被旧广播闪回)
merged = mergeSyncedMap({ 'sid-3': 'high' }, {});
assert.equal(merged['sid-3'], 'high');
// skip(提交中)键不被服务端覆盖
merged = mergeSyncedMap({ 'sid-4': 'new' }, { 'sid-4': 'old' }, new Set(['sid-4']));
assert.equal(merged['sid-4'], 'new');

// ── 收尾#1:clear 之后离线残留键回推不复活(方案 b:pushLocalOnly 仅首次)──
// 场景:设备 B 切 provider → 服务端 clear modelPins;设备 A 离线期间本地残留旧 pin。
let srv = applySessionSyncPut(
  { modelPins: { 'sid-old': 'old-provider-model' } }, { clear: 'modelPins' },
).maps;
assert.deepEqual(srv.modelPins, {});
const localA = { 'sid-old': 'old-provider-model', 'draft-p': 'x' };
// A 重连水合:已迁移(marker 置位)→ hydrateSessionSync 传 pushLocalOnly:false,
// applyRemoteSessionSync 不执行回推 —— 服务端保持为空,B 不会被旧 pin 重新填上。
// (本地值经 mergeSyncedMap 保留不闪回,但只留在 A 本机,不再进入同步表。)
merged = mergeSyncedMap(localA, srv.modelPins);
assert.equal(merged['sid-old'], 'old-provider-model');
assert.deepEqual(srv.modelPins, {});
// 修掉的正是这条路径:若仍走首次迁移分支,回推键集非空(且 draft 键被 syncableKey 排除)。
assert.deepEqual(pushLocalOnlyKeys(localA, srv.modelPins), ['sid-old']);
assert.ok(!syncableKey('draft-p') && syncableKey('sid-old'));

// ── 收尾#3:计数式 in-flight,同键两连改不闪回 ─────────────────
// 同键快速连改两次 → 两个 PUT 并发在途;第一个 settle 后标签必须仍在
// (Set 版会被误删,窗口内旧广播闪回第二次选择),第二个 settle 后才移除。
const flight = createInFlightCounter();
flight.acquire('modelPin:sid-9'); // 第一次改
flight.acquire('modelPin:sid-9'); // 第二次改(第一个 PUT 尚未 settle)
flight.release('modelPin:sid-9'); // 第一个 PUT settle
assert.ok(flight.has('modelPin:sid-9'), '第二个在途 PUT 的保护标签不得被第一个 finally 摘掉');
assert.deepEqual(flight.keys(), ['modelPin:sid-9']);
flight.release('modelPin:sid-9'); // 第二个 PUT settle
assert.ok(!flight.has('modelPin:sid-9'));
assert.deepEqual(flight.keys(), []);

console.log('check-session-sync: all assertions passed');
