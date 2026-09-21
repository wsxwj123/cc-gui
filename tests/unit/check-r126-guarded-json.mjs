#!/usr/bin/env node
// r126 单测:server/utils/guarded-json.js —— 配置 json 守卫读取(BRIEF-r126 Q1 / Q2 / Q4 / Q5)。
//  ① 文件不存在 = missing、可写、不备份;0 字节 / 只有空白 同样按 missing(没有数据可保护);
//  ② 文件正常 = 解析值原样、不留任何 *.corrupt-*、可写;
//  ③ 损坏(半截 / 含非 UTF-8 字节的乱码)= corrupt + 同目录 `<原名>.corrupt-<数字>` 备份逐字节相同 + 原文件不动 + 0600;
//  ④ 同内容去重:再读 N 次 / 原字节重写(mtime 变)/ 并发 10 路首读 / 清状态模拟重启 → 仍只 1 份;换内容 → 第 2 份且旧的不被改写;
//  ⑤ assertWritable:损坏 → 抛 ConfigGuardError { status 409, code CONFIG_CORRUPT, file, backup },文案不含文件内容;
//     修好 / 删掉后不重启即可写;读不出(EACCES)→ CONFIG_UNREADABLE 同样拒写;
//  ⑥ corruptWarning / sendConfigGuardError 的形状(INTERFACE-r126 §B1 / §C1)。
// 隔离:全部在 mktemp 目录里,真实 ~/.claude-gui 一个字节不碰。
// Run: node tests/unit/check-r126-guarded-json.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname, basename } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'cgui-r126-guard-'));
const DIR = join(ROOT, '.claude-gui');
mkdirSync(DIR, { recursive: true });

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n += 1; };
const isWin = process.platform === 'win32';

const { readJsonGuarded, assertWritable, guardError, corruptWarning, sendConfigGuardError, isConfigGuardError, ConfigGuardError, _resetGuardStateForTests } = await import('../../server/utils/guarded-json.js');

const FILE = join(DIR, 'custom-providers.json');
const FAKE_KEY = 'sk-r126-unit-not-a-real-key-000111';
const HALF = Buffer.from(`[{"id":"half","name":"半截","apiKey":"${FAKE_KEY}"`, 'utf8');
const GARBAGE = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]), Buffer.from('r126 乱码\n', 'utf8'), Buffer.from([0xf0, 0x28, 0x8c, 0xbc, 0x00])]);
const backups = (file = FILE) => readdirSync(dirname(file)).filter((x) => new RegExp(`^${basename(file).replace(/\./g, '\\.')}\\.corrupt-\\d+$`).test(x)).sort();
const anyBackups = () => readdirSync(DIR).filter((x) => /\.corrupt-\d+$/.test(x));

let failure = null;
try {
  // ─── ① 不存在 / 空文件 = missing,可写,不备份 ───
  {
    const r = await readJsonGuarded(FILE);
    eq({ missing: r.missing, corrupt: r.corrupt, unreadable: r.unreadable, backup: r.backup, value: r.value }, { missing: true, corrupt: false, unreadable: false, backup: null, value: undefined }, 't1: 文件不存在 → missing');
    eq(r.file, FILE, 't1: 结果带 file(原路径)');
    const w = await assertWritable(FILE);
    ok(w.missing === true, 't1: 不存在时 assertWritable 放行并回读取结果');
    eq(guardError(r), null, 't1: missing 没有 guardError');
    eq(corruptWarning(r), null, 't1: missing 没有 corruptWarning');
    writeFileSync(FILE, '');
    ok((await readJsonGuarded(FILE)).missing === true, 't1: 0 字节文件按 missing(没有数据可保护)');
    writeFileSync(FILE, ' \n\t');
    ok((await readJsonGuarded(FILE)).missing === true, 't1: 只有空白的文件按 missing');
    await assertWritable(FILE);
    eq(anyBackups(), [], 't1: 空文件不产生备份');
  }

  // ─── ② 正常文件 ───
  {
    const good = [{ id: 'a', name: 'A', apiKey: FAKE_KEY, models: ['m1'] }];
    writeFileSync(FILE, JSON.stringify(good, null, 2));
    const r = await readJsonGuarded(FILE);
    eq(r.value, good, 't2: 正常文件解析值原样');
    eq({ missing: r.missing, corrupt: r.corrupt, unreadable: r.unreadable }, { missing: false, corrupt: false, unreadable: false }, 't2: 正常三态皆 false');
    for (let i = 0; i < 5; i += 1) await readJsonGuarded(FILE);
    await assertWritable(FILE);
    eq(anyBackups(), [], 't2: 正常文件反复读不产生任何 *.corrupt-*');
  }

  // ─── ③ 损坏:备份 + 原文件不动 ───
  {
    writeFileSync(FILE, HALF);
    const r = await readJsonGuarded(FILE);
    ok(r.corrupt === true && r.missing === false && r.value === undefined, 't3: 半截 → corrupt');
    eq(backups(), [basename(r.backup)], 't3: 同目录恰好 1 个备份,且就是结果里的 backup');
    ok(/^custom-providers\.json\.corrupt-\d+$/.test(basename(r.backup)), `t3: 备份名 <原名>.corrupt-<数字>:${basename(r.backup)}`);
    eq(dirname(r.backup), DIR, 't3: 备份与原文件同目录');
    ok(readFileSync(r.backup).equals(HALF), 't3: 备份与损坏文件逐字节相同');
    ok(readFileSync(FILE).equals(HALF), 't3: 原文件一个字节不动');
    if (!isWin) eq(statSync(r.backup).mode & 0o777, 0o600, 't3: 备份 0600(内容含密钥)');
    else n += 1;
    ok(typeof r.error === 'string' && r.error.length > 0, 't3: 带解析错误说明');
  }

  // ─── ④ 同内容去重 ───
  {
    for (let i = 0; i < 10; i += 1) await readJsonGuarded(FILE);
    eq(backups().length, 1, 't4: 再读 10 次仍只 1 份备份');
    // 原字节重写(mtime 变、内容不变)
    writeFileSync(FILE, HALF);
    const past = new Date(Date.now() + 5000);
    utimesSync(FILE, past, past);
    await readJsonGuarded(FILE);
    eq(backups().length, 1, 't4: 同内容重写(mtime 变)不再备份 —— 按内容去重,不按修改时间');
    // 模拟重启:清进程内状态 → 扫目录比对字节 → 复用
    _resetGuardStateForTests();
    const again = await readJsonGuarded(FILE);
    eq(backups().length, 1, 't4: 清状态(模拟重启)后再读仍只 1 份');
    eq(again.backup, join(DIR, backups()[0]), 't4: 重启后 backup 指向已有的那份');
    // 并发首读
    _resetGuardStateForTests();
    const rs = await Promise.all(Array.from({ length: 10 }, () => readJsonGuarded(FILE)));
    eq(backups().length, 1, 't4: 10 路并发首读只 1 份备份');
    ok(rs.every((x) => x.corrupt && x.backup === rs[0].backup), 't4: 并发各路拿到同一个 backup 路径');
    // 换一种损坏内容 → 第 2 份;旧的不被改写
    await new Promise((res) => setTimeout(res, 5));
    writeFileSync(FILE, GARBAGE);
    const r2 = await readJsonGuarded(FILE);
    const all = backups();
    eq(all.length, 2, 't4: 换内容后 2 份备份');
    ok(readFileSync(r2.backup).equals(GARBAGE), 't4: 新备份 = 乱码(含非 UTF-8 字节也逐字节相同)');
    const old = all.find((x) => x !== basename(r2.backup));
    ok(readFileSync(join(DIR, old)).equals(HALF), 't4: 第 1 份备份不被改写');
    // 换回半截 → 复用第 1 份(不出第 3 份)
    writeFileSync(FILE, HALF);
    const r3 = await readJsonGuarded(FILE);
    eq(backups().length, 2, 't4: 换回曾备份过的内容不出第 3 份');
    eq(basename(r3.backup), old, 't4: 复用的是内容相同的那份');
    // 备份被用户删掉 → 重新建
    rmSync(r3.backup);
    const r4 = await readJsonGuarded(FILE);
    ok(r4.backup && readFileSync(r4.backup).equals(HALF), 't4: 备份被删后再读会重新建一份');
  }

  // ─── ⑤ assertWritable / 恢复 ───
  {
    writeFileSync(FILE, HALF);
    await readJsonGuarded(FILE);
    let caught = null;
    try { await assertWritable(FILE); } catch (e) { caught = e; }
    ok(caught instanceof ConfigGuardError, 't5: 损坏时 assertWritable 抛 ConfigGuardError');
    ok(isConfigGuardError(caught), 't5: isConfigGuardError 识别');
    eq({ status: caught.status, code: caught.code, file: caught.file }, { status: 409, code: 'CONFIG_CORRUPT', file: FILE }, 't5: status 409 / code CONFIG_CORRUPT / file');
    ok(typeof caught.backup === 'string' && statSync(caught.backup).isFile(), 't5: backup 是已存在的备份路径');
    ok(caught.message.includes('custom-providers.json') && caught.message.includes('备份'), 't5: 文案含文件名与「备份」');
    ok(!caught.message.includes(FAKE_KEY) && !caught.message.includes('半截'), 't5: 文案不含文件内容 / 密钥');
    ok(readFileSync(FILE).equals(HALF), 't5: assertWritable 不改原文件');
    // 未读过就直接写(写路径没有前置读)也要拦:清状态后直接 assertWritable
    _resetGuardStateForTests();
    let caught2 = null;
    try { await assertWritable(FILE); } catch (e) { caught2 = e; }
    ok(caught2?.code === 'CONFIG_CORRUPT' && caught2.backup && statSync(caught2.backup).isFile(), 't5: 没有前置读取时 assertWritable 自己读盘判定并带 backup');
    // 修好 → 不重启即可写
    const fixed = [{ id: 'a', name: 'A' }];
    writeFileSync(FILE, JSON.stringify(fixed));
    const r = await readJsonGuarded(FILE);
    ok(r.corrupt === false && Array.isArray(r.value), 't5: 写回合法 JSON 后 corrupt 清除');
    const w = await assertWritable(FILE);
    eq(w.value, fixed, 't5: 修好后 assertWritable 放行');
    // 再改坏 → 再拦;删掉 → 放行
    writeFileSync(FILE, GARBAGE);
    await assert.rejects(assertWritable(FILE), (e) => e.code === 'CONFIG_CORRUPT', 't5: 再改坏再拦'); n += 1;
    rmSync(FILE);
    ok((await assertWritable(FILE)).missing === true, 't5: 删掉后放行(程序可重建)');
    // 读不出(EACCES):root / Windows 上没有这种权限语义,跳过
    if (!isWin && userInfo().uid !== 0) {
      writeFileSync(FILE, JSON.stringify(fixed));
      chmodSync(FILE, 0o000);
      const u = await readJsonGuarded(FILE);
      ok(u.unreadable === true && u.corrupt === false && u.missing === false, 't5: EACCES → unreadable(不是 corrupt、不是 missing)');
      const ge = guardError(u);
      ok(ge?.code === 'CONFIG_UNREADABLE' && ge.status === 409 && ge.backup === null, 't5: 读不出 → CONFIG_UNREADABLE 同样拒写');
      eq(anyBackups().filter((x) => x.startsWith('custom-providers.json.')).length, backups().length, 't5: 读不出不备份(备份数不变)');
      chmodSync(FILE, 0o600);
    } else { n += 3; }
  }

  // ─── ⑥ 形状:corruptWarning / sendConfigGuardError ───
  {
    writeFileSync(FILE, HALF);
    const r = await readJsonGuarded(FILE);
    const w = corruptWarning(r);
    eq(Object.keys(w).sort(), ['backup', 'file', 'kind', 'message'], 't6: warning 键集 { kind, file, message, backup }');
    eq({ kind: w.kind, file: w.file, backup: w.backup }, { kind: 'config-corrupt', file: FILE, backup: r.backup }, 't6: kind config-corrupt / file / backup');
    ok(w.message.includes('custom-providers.json') && w.message.includes('备份') && !w.message.includes(FAKE_KEY), 't6: message 含文件名与「备份」,不含内容');
    const res = { _s: 0, _b: null, status(s) { this._s = s; return this; }, json(b) { this._b = b; return this; } };
    sendConfigGuardError(res, guardError(r));
    eq(res._s, 409, 't6: sendConfigGuardError → 409');
    eq(Object.keys(res._b).sort(), ['backup', 'code', 'error', 'file'], 't6: 返回体键集 { error, code, file, backup }');
    eq({ code: res._b.code, file: res._b.file, backup: res._b.backup }, { code: 'CONFIG_CORRUPT', file: FILE, backup: r.backup }, 't6: 返回体值');
    ok(typeof res._b.error === 'string' && res._b.error.length > 0, 't6: error 非空');
    // 另一个文件名的备份互不干扰
    const OTHER = join(DIR, 'provider-models.json');
    writeFileSync(OTHER, '{"x":');
    const o = await readJsonGuarded(OTHER);
    ok(/^provider-models\.json\.corrupt-\d+$/.test(basename(o.backup)), 't6: 其它文件按各自文件名备份');
    eq(backups(OTHER).length, 1, 't6: 其它文件恰好 1 份');
  }
} catch (e) {
  failure = e;
} finally {
  try { chmodSync(FILE, 0o600); } catch { /* 可能已删 */ }
  rmSync(ROOT, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`✓ check-r126-guarded-json: ${n} 条断言通过(missing 可写 / 正常不备份 / 损坏备份逐字节 + 原文件不动 / 内容去重含重启与并发 / assertWritable 409 与恢复 / 形状)`);
