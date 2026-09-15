#!/usr/bin/env node
// computer-use 坐标与快照判定单测(批次3/R15):
//   * mapPoint:原图像素 → 屏幕逻辑点的比例换算(含屏幕原点偏移)
//   * checkCoordinateArg/Bounds:JSON 类型错(CU_INVALID_ARGUMENT)与数字非法/越界
//     (CU_INVALID_COORDINATE)必须分流,最右下像素合法
//   * resolveSnapshot:省略=最近有效截图;被新截图取代/别的实例/文件已清理 = CU_STALE_SNAPSHOT
//     (早失败);本实例从未签发过的 id 只能延后到目标判定之后再报(见下注)
// 跑法:node tests/unit/check-cu-mapping.mjs
// 注意:mcp-server.js 被 import 时会起 stdin readline(协议循环),结束前 destroy stdin。
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  mapPoint, checkCoordinateArg, checkCoordinateBounds, resolveSnapshot, state, __instanceShort,
} = await import('../../server/computer-use/mcp-server.js');

// ── 比例换算(Retina 基准:图 1600x900,屏幕逻辑 1920x1080)────────────
const SNAP = { imgW: 1600, imgH: 900, logicalW: 1920, logicalH: 1080, bounds: { x: 0, y: 0, w: 1920, h: 1080 } };
assert.deepEqual(mapPoint(SNAP, 464, 237), [557, 284], '实测锚点:图内(464,237) → 逻辑(557,284)');
assert.deepEqual(mapPoint(SNAP, 0, 0), [0, 0], '原点恒等');
assert.deepEqual(mapPoint(SNAP, 1599, 899), [1919, 1079], '最后一个有效像素 → 逻辑右下');
assert.deepEqual(mapPoint(SNAP, 1, 1), [1, 1], '非整除四舍五入');
assert.deepEqual(mapPoint({ ...SNAP, bounds: { x: 1920, y: 0, w: 1920, h: 1080 } }, 0, 0), [1920, 0],
  '副屏:逻辑点带屏幕原点偏移');
assert.deepEqual(mapPoint({ ...SNAP, imgW: 1600, imgH: 900, logicalW: 1080, logicalH: 1920 }, 800, 450), [540, 960],
  'x/y 独立比例(竖屏形态)');

// ── 坐标判定:类型错 vs 数字非法 ───────────────────────────────────
assert.equal(checkCoordinateArg(5, 'x'), null, '合法整数');
assert.equal(checkCoordinateArg(0, 'x'), null, '0 合法');
assert.equal(checkCoordinateArg(-1, 'x').code, 'CU_INVALID_COORDINATE', '负数 → INVALID_COORDINATE');
assert.equal(checkCoordinateArg(1.5, 'x').code, 'CU_INVALID_COORDINATE', '小数 → INVALID_COORDINATE');
assert.equal(checkCoordinateArg(Number.NaN, 'x').code, 'CU_INVALID_COORDINATE', 'NaN → INVALID_COORDINATE');
assert.equal(checkCoordinateArg(Number.POSITIVE_INFINITY, 'x').code, 'CU_INVALID_COORDINATE', 'Infinity → INVALID_COORDINATE');
assert.equal(checkCoordinateArg('NaN', 'x').code, 'CU_INVALID_ARGUMENT', '字符串是 JSON 类型错 → INVALID_ARGUMENT');
assert.equal(checkCoordinateArg(null, 'x').code, 'CU_INVALID_ARGUMENT', 'null 是类型错');
assert.equal(checkCoordinateArg({ x: 1 }, 'x').code, 'CU_INVALID_ARGUMENT', '对象是类型错');
assert.equal(checkCoordinateBounds(1599, 1600, 'x'), null, '最右下像素合法(0≤x<imgW)');
assert.equal(checkCoordinateBounds(1600, 1600, 'x').code, 'CU_INVALID_COORDINATE', 'x=imgW 越界');
assert.equal(checkCoordinateBounds(900, 900, 'y').code, 'CU_INVALID_COORDINATE', 'y=imgH 越界');

// ── 快照判定 ───────────────────────────────────────────────────────
const tmp = join(tmpdir(), `cu-unit-snap-${process.pid}.jpg`);
writeFileSync(tmp, 'x');
const latestId = `cu_snap_${__instanceShort}_2`;
const staleId = `cu_snap_${__instanceShort}_1`;
state.snapshots.set(latestId, { ...SNAP, file: tmp, at: Date.now() });
state.snapshots.set(staleId, { ...SNAP, file: tmp, at: Date.now() });
state.lastSnapshotId = latestId;

assert.equal(resolveSnapshot(undefined).mapping.file, tmp, '省略 snapshotId = 用本实例最近有效截图');
assert.equal(resolveSnapshot(latestId).mapping.file, tmp, '最新 snapshotId 可用');
assert.equal(resolveSnapshot(staleId).earlyError, 'CU_STALE_SNAPSHOT', '被新截图取代 → 早失败 STALE');
assert.equal(resolveSnapshot('cu_snap_aaaaaa_9').earlyError, 'CU_STALE_SNAPSHOT', '其他实例的 snapshotId → STALE');
// 文件被清理(例如异常退出遗留清理)后同一 id 也不能再用
state.snapshots.set(latestId, { ...SNAP, file: join(tmpdir(), 'cu-unit-missing-file.jpg'), at: Date.now() });
assert.equal(resolveSnapshot(latestId).earlyError, 'CU_STALE_SNAPSHOT', '文件已清理 → STALE');
state.snapshots.delete(latestId);
state.snapshots.delete(staleId);
state.lastSnapshotId = null;
assert.equal(resolveSnapshot(undefined).earlyError, 'CU_SCREENSHOT_REQUIRED', '没有映射 → CU_SCREENSHOT_REQUIRED');
// 从未签发过的 id:本实例无法判定映射,不早失败(先让目标判定说话),但最终仍报 STALE。
// 依据:锁定套件 CU-R14-04(幽灵目标 + 未签发 snapshotId 期望 CU_TARGET_NOT_FOUND)与
// CU-R15-09(同形状期望 CU_STALE_SNAPSHOT)互相矛盾,取"目标可达时才报快照失效"这一侧。
assert.equal(resolveSnapshot('cu_batch_never_issued_snapshot').deferredError, 'CU_STALE_SNAPSHOT',
  '从未签发的 snapshotId → 延后报 STALE');

rmSync(tmp, { force: true });
console.log('check-cu-mapping: 全部断言通过 ✓');
process.stdin.destroy();
