// r151s 静默超时可设置 —— 验收(接口部分)。S01–S06 依据 .devflow/r151s-stall-timeout-接口.md 的"行为清单",用例与行为号一一对应:
//   S01 新环境默认 5m · S02 PUT 合法值写进偏好文件且其它键不变 · S03 PUT 非法值 400 且文件逐字节不变 ·
//   S04(相邻)偏好里的值不认识回 5m · S05 带 BOM 的偏好文件照常读出 · S06 坏 JSON 回默认值 + 标准错误警告只出一次 + 文件不被改写。
// 每条用例各起一次性实例(临时 HOME、自挑端口、用例自己 stop),只走 HTTP / 文件,不 import 产品代码,不改产品代码。
import { test, expect } from '@playwright/test';
import { expectError } from '../r151b-xsession-p1/helpers/api.mjs';
import { startInstanceS, STALL_PATH, IDLE_PATH, prefsBytes, prefsJson, countLines, tailOf, sleep } from './helpers/s.mjs';

test.describe.configure({ timeout: 90_000 });

/** keep-alive-idle 的应答里取值(r151k K4 的发现式写法:value / keepAliveIdle / idle 三者之一,或直接是字符串)。 */
const idleValueOf = (body) => {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  for (const k of ['value', 'keepAliveIdle', 'idle']) if (typeof body[k] === 'string') return body[k];
  return undefined;
};
const shape = (r) => ({ status: r.status, body: r.body });

test('S01 新环境(临时 HOME 里没有偏好文件):GET /api/prefs/stall-timeout → 200 {"ok":true,"value":"5m"}', async () => {
  const inst = await startInstanceS('s01', { prefs: null });
  try {
    const g = await inst.c.get(STALL_PATH);
    expect(shape(g), `应答原文:${String(g.text).slice(0, 240)}`).toEqual({ status: 200, body: { ok: true, value: '5m' } });
  } finally { await inst.stop(); }
});

test('S02 偏好文件里已有别的键:PUT {"value":"10m"} → 200 {"ok":true,"value":"10m"};随后 GET 得 10m;文件里 stallTimeout 为 "10m",其它键原样', async () => {
  const inst = await startInstanceS('s02', { prefs: { keepAliveIdle: '2h', hiddenProjects: ['/x'] } });
  try {
    const before = prefsJson(inst.home);
    expect({ keepAliveIdle: before && before.keepAliveIdle, hiddenProjects: before && before.hiddenProjects },
      '前置:偏好文件里有预先写好的两个别的键').toEqual({ keepAliveIdle: '2h', hiddenProjects: ['/x'] });
    const put = await inst.c.put(STALL_PATH, { value: '10m' });
    expect(shape(put), `PUT 应答原文:${String(put.text).slice(0, 240)}`).toEqual({ status: 200, body: { ok: true, value: '10m' } });
    const get = await inst.c.get(STALL_PATH);
    expect(shape(get), `GET 应答原文:${String(get.text).slice(0, 240)}`).toEqual({ status: 200, body: { ok: true, value: '10m' } });
    const after = prefsJson(inst.home);
    expect(after && after.stallTimeout, `偏好文件内容:${JSON.stringify(after)}`).toBe('10m');
    const { stallTimeout, ...others } = after || {};
    expect(others, '文件里除 stallTimeout 以外的键与 PUT 之前完全一致').toEqual(before);

    // 另外三个合法值同样 200、GET 一致、写进文件(接口文件第 2 条:四个值都合法)
    for (const v of ['5m', '20m', 'never']) {
      const p = await inst.c.put(STALL_PATH, { value: v });
      expect(shape(p), `PUT ${v} 应答原文:${String(p.text).slice(0, 240)}`).toEqual({ status: 200, body: { ok: true, value: v } });
      const g = await inst.c.get(STALL_PATH);
      expect(shape(g), `PUT ${v} 后 GET 应答原文:${String(g.text).slice(0, 240)}`).toEqual({ status: 200, body: { ok: true, value: v } });
      expect(prefsJson(inst.home).stallTimeout, `PUT ${v} 后偏好文件里的 stallTimeout`).toBe(v);
    }
  } finally { await inst.stop(); }
});

test('S03 PUT 依次发 {"value":"15m"} / {"value":10} / {"value":null} / {} / [] → 每次 400,code=STALL_TIMEOUT_INVALID、error 为非空字符串;偏好文件逐字节不变,已存的值不变', async () => {
  const inst = await startInstanceS('s03', { prefs: { stallTimeout: '20m', keepAliveIdle: '2h', hiddenProjects: ['/x'] } });
  try {
    const bytesBefore = prefsBytes(inst.home);
    const g0 = await inst.c.get(STALL_PATH);
    expect(shape(g0), `前置:已存的值是 20m(应答原文:${String(g0.text).slice(0, 240)})`).toEqual({ status: 200, body: { ok: true, value: '20m' } });
    const bodies = [{ value: '15m' }, { value: 10 }, { value: null }, {}, []];
    for (const b of bodies) {
      const r = await inst.c.put(STALL_PATH, b);
      expectError(r, 400, 'STALL_TIMEOUT_INVALID', undefined, `PUT ${JSON.stringify(b)}`);
    }
    const bytesAfter = prefsBytes(inst.home);
    expect(bytesAfter.equals(bytesBefore), `五次非法 PUT 之后偏好文件应逐字节不变。之前:${bytesBefore.toString('utf8')}\n之后:${bytesAfter.toString('utf8')}`).toBe(true);
    const g1 = await inst.c.get(STALL_PATH);
    expect(shape(g1), `非法 PUT 不应改掉已存的值(应答原文:${String(g1.text).slice(0, 240)})`).toEqual({ status: 200, body: { ok: true, value: '20m' } });
  } finally { await inst.stop(); }
});

test('S04(相邻)偏好文件里 "stallTimeout":"bogus" → GET 得 5m;偏好文件逐字节不变', async () => {
  const inst = await startInstanceS('s04', { prefs: { stallTimeout: 'bogus', keepAliveIdle: '2h' } });
  try {
    const bytesBefore = prefsBytes(inst.home);
    const g = await inst.c.get(STALL_PATH);
    expect(shape(g), `应答原文:${String(g.text).slice(0, 240)}`).toEqual({ status: 200, body: { ok: true, value: '5m' } });
    expect(prefsBytes(inst.home).equals(bytesBefore), 'GET 不应改写偏好文件').toBe(true);
  } finally { await inst.stop(); }
});

test('S05 偏好文件以 UTF-8 BOM 开头、含 "stallTimeout":"20m" 和 "keepAliveIdle":"never":GET stall-timeout 得 20m,GET keep-alive-idle 得 never', async () => {
  const text = JSON.stringify({ stallTimeout: '20m', keepAliveIdle: 'never', hiddenProjects: ['/x'] }, null, 2);
  const inst = await startInstanceS('s05', { prefs: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]) });
  try {
    expect([...prefsBytes(inst.home).subarray(0, 3)], '前置:偏好文件以 EF BB BF 开头').toEqual([0xEF, 0xBB, 0xBF]);
    const g1 = await inst.c.get(STALL_PATH);
    const g2 = await inst.c.get(IDLE_PATH);
    expect({ stall: shape(g1), idle: [g2.status, idleValueOf(g2.body)] },
      `应答原文:stall=${String(g1.text).slice(0, 200)};idle=${String(g2.text).slice(0, 200)}`)
      .toEqual({ stall: { status: 200, body: { ok: true, value: '20m' } }, idle: [200, 'never'] });
  } finally { await inst.stop(); }
});

test('S06 偏好文件内容为 {"stallTimeout":(不是合法 JSON):两个 GET 分别得 5m / 1h;标准错误里有含 prefs.json 的警告行;对同一接口再连续 GET 5 次警告行数不增加;文件不被改写', async () => {
  const BAD = '{"stallTimeout":';
  const inst = await startInstanceS('s06', { prefs: BAD });
  try {
    const bytesBefore = prefsBytes(inst.home);
    expect(bytesBefore.toString('utf8'), '前置:偏好文件内容就是那段不完整的 JSON').toBe(BAD);
    const g1 = await inst.c.get(STALL_PATH);                 // 第 1 次 GET
    await sleep(300);
    const afterFirst = countLines(inst.errFile, 'prefs.json');
    const repeats = [];
    for (let i = 0; i < 5; i += 1) { const r = await inst.c.get(STALL_PATH); repeats.push(shape(r)); }   // 再连续 GET 5 次
    await sleep(300);
    const afterRepeats = countLines(inst.errFile, 'prefs.json');
    const g2 = await inst.c.get(IDLE_PATH);
    expect({ stall: shape(g1), idle: [g2.status, idleValueOf(g2.body)] },
      `应答原文:stall=${String(g1.text).slice(0, 200)};idle=${String(g2.text).slice(0, 200)}`)
      .toEqual({ stall: { status: 200, body: { ok: true, value: '5m' } }, idle: [200, '1h'] });
    expect(repeats, '再连续 GET 5 次的应答仍是默认值 5m').toEqual(Array(5).fill({ status: 200, body: { ok: true, value: '5m' } }));
    expect(afterFirst, `第 1 次 GET 之后标准错误里应至少有 1 行含 prefs.json 的警告(标准错误末尾:\n${tailOf(inst.errFile)})`).toBeGreaterThanOrEqual(1);
    expect(afterRepeats, `再 GET 5 次之后含 prefs.json 的警告行数应与第 1 次之后相同(第 1 次后 ${afterFirst} 行)`).toBe(afterFirst);
    expect(prefsBytes(inst.home).equals(bytesBefore), '偏好文件不被改写(逐字节不变)').toBe(true);
  } finally { await inst.stop(); }
});
