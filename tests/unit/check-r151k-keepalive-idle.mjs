#!/usr/bin/env node
// r151k ②:会话常驻的空闲回收时长设置(keepAliveIdle)。
//   纯函数 resolveKeepAliveIdleMs(chat.js):六种枚举值、'never' → null、测试窗口
//   CGUI_KEEPALIVE_IDLE_MS 覆盖(合法整数 ≥1000)、'never' 压过窗口、缺省/非法回 1h。
//   同步读取 readKeepAliveIdleSync(prefs.js):文件缺失/损坏/非法值 → 默认 1h;合法值原样;
//   读时不改写文件。
// 全部真 import 产品代码(非复刻),临时 HOME。
// node tests/unit/check-r151k-keepalive-idle.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cgui-r151k-idle-'));
const GUI_DIR = join(HOME, '.claude-gui');
const PREFS = join(GUI_DIR, 'prefs.json');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
mkdirSync(GUI_DIR, { recursive: true });

const {
  KEEP_ALIVE_IDLE_VALUES, KEEP_ALIVE_IDLE_DEFAULT, normalizeKeepAliveIdle, readKeepAliveIdleSync,
} = await import('../../server/routes/prefs.js');
const { resolveKeepAliveIdleMs } = await import('../../server/routes/chat.js');

let checks = 0;
const eq = (got, want, label) => { assert.deepEqual(got, want, label); checks += 1; };
const setPrefs = (obj) => writeFileSync(PREFS, typeof obj === 'string' ? obj : JSON.stringify(obj));
const rmPrefs = () => rmSync(PREFS, { force: true });

try {
  // ── ① 枚举与解析 ────────────────────────────────────────────────────────────
  eq(KEEP_ALIVE_IDLE_VALUES, ['15m', '30m', '1h', '2h', '4h', 'never'], '枚举顺序即设置页顺序');
  eq(KEEP_ALIVE_IDLE_DEFAULT, '1h', '默认 1 小时');
  const MS = { '15m': 15 * 60e3, '30m': 30 * 60e3, '1h': 60 * 60e3, '2h': 2 * 60 * 60e3, '4h': 4 * 60 * 60e3 };
  for (const [setting, ms] of Object.entries(MS)) {
    eq(resolveKeepAliveIdleMs(setting, undefined), ms, `${setting} → ${ms}ms`);
    eq(resolveKeepAliveIdleMs(setting, ''), ms, `${setting} + 空窗口 → ${ms}ms`);
    eq(resolveKeepAliveIdleMs(setting, '999'), ms, `${setting} + 999(非法窗口)→ ${ms}ms`);
    eq(resolveKeepAliveIdleMs(setting, 'abc'), ms, `${setting} + 非数字窗口 → ${ms}ms`);
    eq(resolveKeepAliveIdleMs(setting, '1500.5'), ms, `${setting} + 小数窗口(非法)→ ${ms}ms`);
  }
  eq(resolveKeepAliveIdleMs('never', undefined), null, 'never → null(不武装 idleTimer)');
  eq(resolveKeepAliveIdleMs('never', '1500'), null, 'never 压过测试窗口');
  eq(resolveKeepAliveIdleMs('never', '999999'), null, 'never 压过任何合法窗口');
  eq(resolveKeepAliveIdleMs(undefined, undefined), MS['1h'], '设置缺省 → 1h');
  eq(resolveKeepAliveIdleMs(null, undefined), MS['1h'], '设置 null → 1h');
  eq(resolveKeepAliveIdleMs('10m', undefined), MS['1h'], '设置非法 → 1h');
  eq(resolveKeepAliveIdleMs('1H', undefined), MS['1h'], '设置大小写不宽容 → 1h');
  eq(resolveKeepAliveIdleMs({}, undefined), MS['1h'], '设置不是字符串 → 1h');

  // 测试窗口:合法整数 ≥1000 生效(与 CGUI_STALL_MS 同口径);边界 1000、number 形态也认
  eq(resolveKeepAliveIdleMs('1h', '1500'), 1500, '窗口 1500 覆盖设置');
  eq(resolveKeepAliveIdleMs('4h', '4321'), 4321, '窗口覆盖任意枚举');
  eq(resolveKeepAliveIdleMs('1h', 1500), 1500, '窗口是 number 也认');
  eq(resolveKeepAliveIdleMs('1h', '1000'), 1000, '窗口边界 1000 合法');
  eq(resolveKeepAliveIdleMs('1h', '999'), MS['1h'], '窗口 999 非法 → 设置值');
  eq(resolveKeepAliveIdleMs('1h', '-1000'), MS['1h'], '负窗口非法 → 设置值');
  eq(resolveKeepAliveIdleMs('1h', '1500abc'), MS['1h'], '半截数字窗口非法 → 设置值');
  eq(resolveKeepAliveIdleMs('1h', 'Infinity'), MS['1h'], 'Infinity 非法 → 设置值');
  eq(resolveKeepAliveIdleMs('1h', '0'), MS['1h'], '0 非法 → 设置值');
  eq(resolveKeepAliveIdleMs('1h', '2147483647'), 2147483647, 'Node 定时器上限内照用');
  // r151q 第 7 项:超出 Node 定时器上限(2^31-1)当没设 —— 否则 Node 按 1ms 触发,回合一结束进程就被回收
  eq(resolveKeepAliveIdleMs('1h', '2147483648'), MS['1h'], '超上限 2147483648 当没设 → 设置值');
  eq(resolveKeepAliveIdleMs('2h', '99999999999'), MS['2h'], '超上限 99999999999 当没设 → 设置值');
  eq(resolveKeepAliveIdleMs('never', '99999999999'), null, 'never 仍压过一切');

  // ── ② 同步读取 ──────────────────────────────────────────────────────────────
  eq(normalizeKeepAliveIdle('30m'), '30m', '归一:合法值原样');
  for (const bad of [undefined, null, '', '10m', '1H', 'never ', 15, true, [], {}]) {
    eq(normalizeKeepAliveIdle(bad), '1h', `归一:${JSON.stringify(bad)} → 1h`);
  }

  rmPrefs();
  eq(readKeepAliveIdleSync(), '1h', '文件缺失 → 1h');

  setPrefs({});
  eq(readKeepAliveIdleSync(), '1h', '键缺失 → 1h');

  for (const v of KEEP_ALIVE_IDLE_VALUES) {
    setPrefs({ keepAliveIdle: v, other: 1 });
    eq(readKeepAliveIdleSync(), v, `合法值 ${v} 原样`);
  }
  for (const bad of ['10m', '45m', '5h', '1H', 'never ', '', null, 15, true, ['1h'], {}]) {
    setPrefs({ keepAliveIdle: bad });
    eq(readKeepAliveIdleSync(), '1h', `非法值 ${JSON.stringify(bad)} → 1h`);
  }
  setPrefs('{broken');
  eq(readKeepAliveIdleSync(), '1h', '损坏 JSON → 1h');
  setPrefs('[]');
  eq(readKeepAliveIdleSync(), '1h', '顶层数组 → 1h');
  setPrefs('null');
  eq(readKeepAliveIdleSync(), '1h', '顶层 null → 1h');

  // 只读,不改写文件:逐字节比对
  const raw = JSON.stringify({ keepAliveIdle: '30m', xsEnabled: true });
  writeFileSync(PREFS, raw);
  eq(readKeepAliveIdleSync(), '30m', '合法值读取');
  eq(readFileSync(PREFS, 'utf8'), raw, '读时不改写偏好文件');

  console.log(`✓ r151k keepAliveIdle 单测全部通过(${checks} 项断言)`);
} finally {
  rmSync(HOME, { recursive: true, force: true });
}
