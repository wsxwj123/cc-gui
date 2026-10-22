#!/usr/bin/env node
// r151s 静默超时设置:routes/prefs.js 的同步读取(真 import 产品代码,非复刻;临时 HOME)。
// · STALL_TIMEOUT_VALUES / normalizeStallTimeout:枚举 5m / 10m / 20m / never,其余 → 5m;
// · readStallTimeoutSync:文件缺失 / 键缺失 / 非法值 / 坏 JSON / 非对象 → 5m;合法值原样;开头 UTF-8 BOM 照常读出;
//   带缓存:修改时间、大小、inode 都没变就复用上次结果,任一变化重新读;本模块写盘(updatePrefs)后立刻读到新值;只读不改写文件;
// · readKeepAliveIdleSync:开头 UTF-8 BOM 照常读出;
// · 两个读取共用的警告:坏文件写一行含 prefs.json 的警告且不带文件内容;同一种失败不重复写;读成功后清零,再坏重新提示一次;
//   读不出(这里用"prefs.json 是个目录"造 EISDIR)算另一种失败。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cgui-r151s-stall-'));
const GUI_DIR = join(HOME, '.claude-gui');
const PREFS = join(GUI_DIR, 'prefs.json');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
mkdirSync(GUI_DIR, { recursive: true });

const {
  STALL_TIMEOUT_VALUES, STALL_TIMEOUT_DEFAULT, normalizeStallTimeout, readStallTimeoutSync, readKeepAliveIdleSync, updatePrefs,
} = await import('../../server/routes/prefs.js');

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
const prefsWarnings = () => warnings.filter((w) => w.includes('prefs.json')).length;

let checks = 0;
const eq = (got, want, label) => { assert.deepEqual(got, want, label); checks += 1; };
// 每次写入把修改时间设到不同的整秒:不依赖文件系统的时间精度(缓存按修改时间 + 大小 + inode 判断文件变没变)。
// keepTime = 把修改时间设回上一次的值(配合同大小、原地写,造"看起来没变"的文件)。
const BASE_SEC = Date.parse('2026-01-01T00:00:00Z') / 1000;
let tick = 0;
const setPrefs = (content, { keepTime = false } = {}) => {
  writeFileSync(PREFS, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  const t = BASE_SEC + (keepTime ? tick : ++tick);
  utimesSync(PREFS, t, t);
};

try {
  // ── ① 枚举与归一 ──────────────────────────────────────────────────────────
  eq(STALL_TIMEOUT_VALUES, ['5m', '10m', '20m', 'never'], '枚举顺序即设置页顺序');
  eq(STALL_TIMEOUT_DEFAULT, '5m', '默认 5 分钟');
  for (const v of STALL_TIMEOUT_VALUES) eq(normalizeStallTimeout(v), v, `合法值 ${v} 原样`);
  for (const bad of [undefined, null, '', '15m', '5M', ' never', 'never ', 5, true, [], {}, ['5m']]) {
    eq(normalizeStallTimeout(bad), '5m', `归一:${JSON.stringify(bad)} → 5m`);
  }

  // ── ② 读取:缺失 / 键缺失 / 合法 / 非法 ───────────────────────────────────
  rmSync(PREFS, { force: true });
  eq(readStallTimeoutSync(), '5m', '文件缺失 → 5m');
  setPrefs({});
  eq(readStallTimeoutSync(), '5m', '键缺失 → 5m');
  for (const v of STALL_TIMEOUT_VALUES) {
    setPrefs({ stallTimeout: v, other: 1 });
    eq(readStallTimeoutSync(), v, `合法值 ${v} 原样`);
  }
  for (const bad of ['bogus', '15m', '', null, 10, true, ['10m'], {}]) {
    setPrefs({ stallTimeout: bad });
    eq(readStallTimeoutSync(), '5m', `非法值 ${JSON.stringify(bad)} → 5m`);
  }
  eq(prefsWarnings(), 0, '合法 JSON 对象里的非法值不算坏文件,不写警告');

  // ── ③ UTF-8 BOM ───────────────────────────────────────────────────────────
  setPrefs(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ stallTimeout: '20m', keepAliveIdle: 'never' }))]));
  eq(readStallTimeoutSync(), '20m', 'BOM 开头照常读出(静默超时)');
  eq(readKeepAliveIdleSync(), 'never', 'BOM 开头照常读出(空闲回收)');
  eq(prefsWarnings(), 0, 'BOM 文件不算坏,不写警告');

  // ── ④ 缓存 ────────────────────────────────────────────────────────────────
  setPrefs({ stallTimeout: '10m' });
  eq(readStallTimeoutSync(), '10m', '读到 10m');
  setPrefs({ stallTimeout: '20m' }, { keepTime: true }); // 同大小、原地写(inode 不变)、修改时间设回原值
  eq(readStallTimeoutSync(), '10m', '修改时间、大小、inode 都没变 → 复用上次结果,不重读');
  setPrefs({ stallTimeout: '20m' });
  eq(readStallTimeoutSync(), '20m', '修改时间变了 → 重新读');
  setPrefs({ stallTimeout: 'never' }, { keepTime: true });
  eq(readStallTimeoutSync(), 'never', '修改时间没变但大小变了 → 重新读');
  await updatePrefs((p) => { p.stallTimeout = '10m'; });
  eq(readStallTimeoutSync(), '10m', '本模块写盘后立刻读到新值');

  // ── ⑤ 坏文件的警告 ────────────────────────────────────────────────────────
  const MARKER = 'CONTENT_MARKER_7f3a';
  const before = prefsWarnings();
  setPrefs(`{"stallTimeout": ${MARKER}`);
  eq(readStallTimeoutSync(), '5m', '坏 JSON → 5m');
  eq(prefsWarnings() - before, 1, '坏文件写 1 行含 prefs.json 的警告');
  for (let i = 0; i < 5; i += 1) readStallTimeoutSync();
  eq(prefsWarnings() - before, 1, '同一个坏文件反复读,警告不增加');
  eq(readKeepAliveIdleSync(), '1h', '坏 JSON → 空闲回收默认 1h');
  eq(prefsWarnings() - before, 1, '同一种失败,空闲回收的读取也不再写');
  setPrefs(`{"keepAliveIdle": ${MARKER}!!`);
  eq(readStallTimeoutSync(), '5m', '换了一份坏内容 → 仍 5m');
  setPrefs('[]');
  eq(readStallTimeoutSync(), '5m', '顶层数组 → 5m');
  setPrefs('null');
  eq(readKeepAliveIdleSync(), '1h', '顶层 null → 1h');
  eq(prefsWarnings() - before, 1, '文件变了但仍是同一种失败(不是 JSON 对象),不重复写');
  eq(warnings.some((w) => w.includes(MARKER)), false, '警告不带文件内容');
  setPrefs({ stallTimeout: '10m' });
  eq(readStallTimeoutSync(), '10m', '修好后照常读');
  setPrefs('{broken');
  eq(readStallTimeoutSync(), '5m', '再坏 → 5m');
  eq(prefsWarnings() - before, 2, '读成功过一次后再坏,重新提示一次');
  rmSync(PREFS, { force: true });
  mkdirSync(PREFS);
  eq(readStallTimeoutSync(), '5m', '读不出(EISDIR)→ 5m');
  eq(readKeepAliveIdleSync(), '1h', '读不出(EISDIR)→ 1h');
  eq(prefsWarnings() - before, 3, '读不出是另一种失败,只写 1 行');
  rmSync(PREFS, { recursive: true, force: true });

  // ── ⑥ 只读,不改写文件:逐字节比对 ─────────────────────────────────────────
  const raw = JSON.stringify({ stallTimeout: '20m', xsEnabled: true });
  setPrefs(raw);
  eq(readStallTimeoutSync(), '20m', '合法值读取');
  eq(readFileSync(PREFS, 'utf8'), raw, '读时不改写偏好文件');

  // ── ⑦ 读不出不缓存、坏 JSON 照常缓存 ────────────────────────────────────────
  //    文件在、stat 成功但读取失败(Windows 上被杀软 / 同步盘 / 编辑器占用的 EBUSY、EPERM,这里用去掉读权限的 EACCES 代替):
  //    这次回默认值但不写缓存;恢复可读后文件特征(修改时间、大小、inode,chmod 都不改)没变,也要重新读到文件里的值。
  //    修前:读不出那次把 5m 连同文件特征缓存住,恢复后一直回 5m。
  const BAD_SAME_SIZE = '{"stallTimeout":"10m" '; // 坏 JSON(少右括号),与下面的合法内容同大小
  const GOOD_SAME_SIZE = '{"stallTimeout":"10m"}';
  eq(Buffer.byteLength(BAD_SAME_SIZE), Buffer.byteLength(GOOD_SAME_SIZE), '前置:两份内容同大小');
  setPrefs(BAD_SAME_SIZE);
  eq(readStallTimeoutSync(), '5m', '坏 JSON → 5m');
  setPrefs(GOOD_SAME_SIZE, { keepTime: true });
  eq(readStallTimeoutSync(), '5m', '坏 JSON 照常缓存:文件特征没变就不重读');
  setPrefs({ stallTimeout: '20m' });
  chmodSync(PREFS, 0o000);
  let unreadable = false;
  try { readFileSync(PREFS); } catch { unreadable = true; }
  if (!unreadable) {
    chmodSync(PREFS, 0o644);
    console.log('  (跳过「读不出后恢复」:去掉读权限后当前用户仍能读文件,常见于以 root 运行或文件系统不认权限位,前提不成立)');
  } else {
    eq(readStallTimeoutSync(), '5m', '读不出(EACCES)→ 这次回 5m');
    chmodSync(PREFS, 0o644);
    eq(readStallTimeoutSync(), '20m', '恢复可读后文件特征没变,也能重新读到文件里的 20m(读不出那次没写缓存)');
  }

  console.log(`✓ r151s stallTimeout 单测全部通过(${checks} 项断言)`);
} finally {
  console.warn = realWarn;
  rmSync(HOME, { recursive: true, force: true });
}
