// r209 自动清理时间线(后端 B:首轮 10 秒后、第二轮再 10 秒后、之后每 1 秒一轮;夹具文件在 B 起来前一刻写好,基准时刻 G 见 sweep-manifest.json)。
// 只通过文件系统(文件在不在)和后端标准输出里的 [histbak] 汇总行观测。时间线由 helpers/record-sweep.mjs 在跑用例之前一次录好(各轮结束时的文件快照),用例只对快照下断言,互不依赖。
// 所有等待都有上限,超时记成「没等到」并让相关用例失败,不会无限挂着。
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { art, stdoutLog, exists } from './helpers/common.mjs';

const man = JSON.parse(fs.readFileSync(art('sweep-manifest.json'), 'utf8'));
const byKey = Object.fromEntries(man.files.map((f) => [f.key, f]));
const allHistbakLines = () => {
  let out = '';
  try { out += fs.readFileSync(stdoutLog('B'), 'utf8'); } catch { /* 没有 */ }
  try { out += `\n${fs.readFileSync(stdoutLog('B').replace('stdout', 'stderr'), 'utf8')}`; } catch { /* 没有 */ }
  return out.split('\n').filter((l) => l.includes('[histbak]'));
};
const T = JSON.parse(fs.readFileSync(art('sweep-timeline.json'), 'utf8'));

const expectState = (snap, keys, want, label) => {
  for (const k of keys) expect(snap[k], `${label}:${k}(${byKey[k].name})应${want ? '还在' : '已被删除'}`).toBe(want);
};
const keysOf = (prefix) => man.files.filter((f) => f.key.startsWith(prefix)).map((f) => f.key);

test('S1 启动首轮_天数规则:满14天的删,差2分钟的留,按名里的时刻算不看修改时间,古早.bak不按天数删', () => {
  expect(T.line1, '首轮没有在上限内打出 [histbak] 清理完成 汇总行').not.toBeNull();
  const s = T.snap1;
  expectState(s, ['age_expired', 'age_nameOld_mtimeNew', 'age_bakTs', 'age_oldForm'], false, '首轮后');
  expectState(s, ['age_near', 'age_nameNew_mtimeOld', 'age_plainBak'], true, '首轮后');
});

test('S2 启动首轮_每会话最多3份:三种形态合计,同一时刻按文件名字典序大的留,正好3份全留,未来文件不占名额,古早.bak不占名额', () => {
  expect(T.line1, '首轮没有在上限内打出 [histbak] 清理完成 汇总行').not.toBeNull();
  const s = T.snap1;
  expectState(s, ['cnt_1', 'cnt_2', 'cnt_3', 'cnt_plainBak'], true, '首轮后(最新3份+.bak)');
  expectState(s, ['cnt_4', 'cnt_5'], false, '首轮后(第4、5份)');
  expectState(s, ['tie_b', 'tie_c', 'tie_d'], true, '首轮后(同时刻,名字大的3份)');
  expectState(s, ['tie_a'], false, '首轮后(同时刻,名字最小的那份)');
  expectState(s, keysOf('exact3_'), true, '首轮后(正好3份)');
  expectState(s, ['mix_exp1', 'mix_exp2', 'mix_f4'], false, '首轮后(先按天数、再按份数)');
  expectState(s, ['mix_f1', 'mix_f2', 'mix_f3'], true, '首轮后(先按天数、再按份数)');
  expectState(s, keysOf('fut_'), true, '首轮后(3份新的+1份未来的,未来的不算备份、不挤掉任何一份)');
});

test('S3 会话记录已不在:第一轮全留(含已过期的),连续第二轮才删三种形态,古早.bak始终留', () => {
  expect(T.line2, '第二轮没有在首轮后 25 秒内打出汇总行').not.toBeNull();
  expectState(T.snap1, ['gone_1', 'gone_2', 'gone_expired', 'gone_plainBak'], true, '第一轮后');
  expectState(T.snap2, ['gone_1', 'gone_2', 'gone_expired'], false, '第二轮后');
  expectState(T.snap2, ['gone_plainBak'], true, '第二轮后(古早 .bak 不参与)');
});

test('S4 反向_不该动的一律不动:会话记录/.archived/名字差一点的/子目录/软链接/归属不明/别的目录有会话记录/非工作区目录/未来文件/古早.bak', () => {
  expect(T.snapEnd, '时间线没有录下来').not.toBeNull();
  const keeps = man.files.filter((f) => f.expect === 'keep').map((f) => f.key);
  expect(keeps.length, '夹具自检:应有一批要留的文件').toBeGreaterThan(40);
  expectState(T.snapEnd, keeps, true, '全部轮次结束后');
});

test('S5 服务不重启跨过14天边界:到点前留着,满14天后由定时轮删掉(不早于满14天的时刻)', () => {
  expect(T.snap2, '第二轮快照没录到(首轮或第二轮汇总行没等到)').not.toBeNull();
  expect(T.snap2.cross_14d, '第二轮后(差约 15 秒才满 14 天)这份应还在').toBe(true);
  expect(T.crossGoneAtMs, '夹具写入后 90 秒内,这份满 14 天的备份没有被定时轮删掉').not.toBeNull();
  expect(T.crossGoneAtMs, '不得早于它满 14 天的时刻(夹具写入时刻 + 35 秒)被删').toBeGreaterThanOrEqual(man.G + 35_000);
});

test('S6 每轮结束打汇总日志:格式、数字与夹具一致、不含路径与会话编号', () => {
  expect(T.line1, '首轮没有汇总行').not.toBeNull();
  expect(T.line1).toMatch(new RegExp(`^\\[histbak\\] 清理完成\\(启动\\): 工作区目录 ${man.workspaceDirs} 个, 删除 ${man.expectRound1Deleted} 份共 ${man.expectRound1Deleted * 100} 字节, 失败 0 份, 占用跳过 0 份, 归属不明 1 组, 待确认已删 1 组, 目录读取失败 0 个, 耗时 \\d+ ms$`));
  expect(T.line2, '第二轮没有汇总行').not.toBeNull();
  expect(T.line2).toMatch(new RegExp(`^\\[histbak\\] 清理完成\\(定时\\): 工作区目录 ${man.workspaceDirs} 个, 删除 ${man.expectRound2Deleted} 份共 ${man.expectRound2Deleted * 100} 字节, 失败 0 份, 占用跳过 0 份, 归属不明 1 组, 待确认已删 0 组, 目录读取失败 0 个, 耗时 \\d+ ms$`));
  for (const l of allHistbakLines()) {
    expect(l, `日志行不应含路径或会话编号:${l}`).not.toMatch(/sw-|a0900000|\.jsonl|\/|\\/);
  }
});
