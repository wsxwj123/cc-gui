// r130 · D 组(不变项)的确定性夹具:绝对日期、02Z/14Z(在 +08:00 不跨日,UTC 切日与本地切日给出同一天)、三个模型、两个项目、
// 一条无 timestamp 的记录('unknown' 行)。修前在当前代码上跑一次 helpers/snapshot.mjs 把 total/byModel/byProject/byDay(既有六键)
// 存成 d-baseline.json;修后必须逐字节相等(只允许多出 overview / sessions / messages)。
import { sessionFile, subagentFile, writeJsonl, assistant, user, sid } from './fixtures.mjs';

export const D_PROJ_A = '-Users-r131-d-projA';
export const D_PROJ_B = '-Users-r131-d-projB';
export function dFixture(home) {
  writeJsonl(sessionFile(home, sid(11), D_PROJ_A), [
    user({ ts: '2026-09-10T02:00:00.000Z', uuid: 'd-u1' }),
    assistant({ ts: '2026-09-10T02:00:05.000Z', id: 'd-m1', uuid: 'd-a1', model: 'claude-sonnet-4-6', u: [100, 20, 300, 40] }),
    assistant({ ts: '2026-09-10T14:00:05.000Z', id: 'd-m2', uuid: 'd-a2', model: 'claude-sonnet-4-6', u: [100, 20, 300, 40] }),
    '{"type":"assistant","message":{"id":"broken_',
  ]);
  writeJsonl(sessionFile(home, sid(12), D_PROJ_A), [
    assistant({ ts: '2026-09-12T14:00:00.000Z', id: 'd-m3', uuid: 'd-a3', model: 'claude-opus-4-1-20250805', u: [2000, 100, 0, 0] }),
    assistant({ ts: '2026-09-12T14:00:01.000Z', id: 'd-m3', uuid: 'd-a3x', model: 'claude-opus-4-1-20250805', u: [1, 1, 0, 0] }),   // 同 id 的小副本 → 去重掉
  ]);
  writeJsonl(subagentFile(home, sid(12), 'a', D_PROJ_A), [
    assistant({ ts: '2026-09-12T14:30:00.000Z', id: 'd-m4', uuid: 'd-a4', model: 'claude-opus-4-1-20250805', u: [500, 50, 0, 0] }),
  ]);
  writeJsonl(sessionFile(home, sid(13), D_PROJ_B), [
    assistant({ ts: '2026-09-15T02:00:00.000Z', id: 'd-m5', uuid: 'd-a5', model: 'deepseek-v3.2', u: [50, 10, 0, 0] }),
    assistant({ ts: undefined, id: 'd-m6', uuid: 'd-a6', model: 'deepseek-v3.2', u: [7, 3, 0, 0] }),
  ]);
}
/** 手算的既有值(与 d-baseline.json 互为对照;基线文件是当前代码的实际输出)。 */
export const D_EXPECTED = {
  total: { input: 2757, output: 203, cacheRead: 600, cacheWrite: 80, sessionCount: 3 },
  byDayDays: ['unknown', '2026-09-15', '2026-09-12', '2026-09-10'],
  byDayRows: {
    unknown: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, calls: 1 },
    '2026-09-15': { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, calls: 1 },
    '2026-09-12': { input: 2500, output: 150, cacheRead: 0, cacheWrite: 0, calls: 2 },
    '2026-09-10': { input: 200, output: 40, cacheRead: 600, cacheWrite: 80, calls: 2 },
  },
};
/** 只留既有六键的 byDay 行 / 剥掉 overview 的根,用于与基线逐字节比对。 */
export const legacyView = (body) => ({
  total: body.total,
  byModel: body.byModel,
  byProject: body.byProject,
  byDay: (body.byDay || []).map(({ day, input, output, cacheRead, cacheWrite, calls }) => ({ day, input, output, cacheRead, cacheWrite, calls })),
});
