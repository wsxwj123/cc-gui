#!/usr/bin/env node
// r151b 复审建议 2(接口 POST /api/xsession/clear 与 X.3.6 的"2026-10-15 复审后补"):
//   · 清空以收件箱记录为准:记录删不掉 → XsStorageError(路由回 500 STORAGE_WRITE_FAILED),什么都不改;
//     记录已删而之后删正文 / 损坏留存 / 临时文件失败 → 照常返回 removed,失败只记日志(只带文件名);
//   · 残留由下次启动的清理删掉(开着:读盘恢复;关着:sweepXsLeftovers,只删不写);
//   · 启动清理删修改时间超过 7 天的 messages.json.corrupt-*;挪开损坏文件时把修改时间设成挪开那一刻。
// 白盒:临时 HOME,每次 import 新的模块实例 = 模拟服务重启;删除失败用"同名目录"替身造(unlink 删不了目录),不改目录权限。
// node tests/unit/check-r151b-xs-clear-leftovers.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, statSync, readdirSync, utimesSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-xsclear-')));
let checks = 0;
const ok = (v, m) => { assert.ok(v, m); checks += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks += 1; };

const storeUrl = new URL('../../server/services/xsession-store.js', import.meta.url).href;
let n = 0;
async function freshStore(home) { // 模块在加载时按 HOME 定目录:新实例 = 重启后的服务
  const prevH = process.env.HOME; const prevU = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try { return await import(`${storeUrl}?clr=${n++}`); } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
}
const uid = (k) => `${String(k).padStart(8, '0')}-0000-4000-8000-${String(k).padStart(12, '0')}`;
const rec = (id, status, extra = {}) => ({ id, status, to: { sessionId: uid(900) }, ...extra });
const mkHome = (tag) => {
  const h = join(TMP, tag); const x = join(h, '.claude-gui', 'xsession'); const b = join(x, 'bodies');
  mkdirSync(b, { recursive: true });
  return { h, x, b };
};
const DAY = 24 * 60 * 60 * 1000;
const age = (file, days) => { const t = new Date(Date.now() - days * DAY); utimesSync(file, t, t); };
const blockAsDir = (p) => { mkdirSync(p, { recursive: true }); writeFileSync(join(p, 'x'), 'x'); }; // 同名目录:unlink 删不掉
const DEAD = 99999990; // 不存在的进程号
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };

try {
  // ── 1. 记录删不掉 → XsStorageError(路由回 500),什么都不改 ──
  {
    const { h, x, b } = mkHome('h1');
    const A = uid(1); const D = uid(2);
    writeFileSync(join(x, 'messages.json'), JSON.stringify({ version: 1, messages: [rec(A, 'pending'), rec(D, 'done')] }));
    writeFileSync(join(b, `${A}.txt`), '正文-甲');
    writeFileSync(join(x, 'messages.json.corrupt-1'), '{坏');
    const S = await freshStore(h);
    eq((await S.listXsMessages()).map((m) => m.id), [A, D], '前置:读盘');
    unlinkSync(join(x, 'messages.json'));
    blockAsDir(join(x, 'messages.json')); // 记录换成删不掉的同名目录
    await assert.rejects(S.clearXsInbox(), (e) => e && e.name === 'XsStorageError' && e.code === 'STORAGE_WRITE_FAILED', '记录删不掉 → XsStorageError');
    checks += 1;
    eq([existsSync(join(b, `${A}.txt`)), existsSync(join(x, 'messages.json.corrupt-1'))], [true, true], '记录删不掉:正文与损坏留存都不动');
    eq((await S.listXsMessages()).map((m) => m.id), [A, D], '记录删不掉:内存里的记录不变');
  }

  // ── 2. 记录已删、之后的删除失败 → 照常返回 removed,只记日志 ──
  const { h: h2, x: x2, b: b2 } = mkHome('h2');
  const A2 = uid(11); const B2 = uid(12); const D2 = uid(13);
  {
    writeFileSync(join(x2, 'messages.json'), JSON.stringify({ version: 1, messages: [rec(A2, 'pending'), rec(B2, 'processing'), rec(D2, 'done')] }));
    writeFileSync(join(b2, `${A2}.txt`), '正文-秘密甲');
    blockAsDir(join(b2, `${B2}.txt`)); // 正文删不掉(相当于 Windows 上文件被占用)
    writeFileSync(join(b2, `${A2}.txt.tmp.${DEAD}.1`), '半截');
    blockAsDir(join(x2, 'messages.json.corrupt-5')); // 损坏留存删不掉
    writeFileSync(join(x2, 'messages.json.corrupt-6'), '{坏');
    writeFileSync(join(x2, `messages.json.tmp.${DEAD}.3`), '{}');
    writeFileSync(join(x2, 'README'), '不是本模块的');
    const S = await freshStore(h2);
    const w0 = warns.length;
    eq(await S.clearXsInbox(), 3, '记录删掉了:照常返回删掉的消息总条数');
    const gone = [join(x2, 'messages.json'), join(b2, `${A2}.txt`), join(b2, `${A2}.txt.tmp.${DEAD}.1`), join(x2, 'messages.json.corrupt-6'), join(x2, `messages.json.tmp.${DEAD}.3`)];
    eq(gone.map((p) => existsSync(p)), gone.map(() => false), '删得掉的照删(记录、正文、正文临时文件、损坏留存、记录临时文件)');
    eq([statSync(join(b2, `${B2}.txt`)).isDirectory(), statSync(join(x2, 'messages.json.corrupt-5')).isDirectory(), readFileSync(join(x2, 'README'), 'utf8')],
      [true, true, '不是本模块的'], '删不掉的留着;不是本模块的不动');
    const logged = warns.slice(w0);
    eq(logged.filter((s) => s.includes('留待下次启动清理')).length, 2, '两处删除失败各记一条日志');
    ok(logged.some((s) => s.includes(`${B2}.txt`)) && logged.some((s) => s.includes('messages.json.corrupt-5')), '日志带文件名');
    ok(!logged.some((s) => s.includes('正文-秘密') || s.includes(h2)), '日志不带正文、不带家目录路径');
    eq(await S.listXsMessages(), [], '清空后收件箱为空');
  }

  // ── 3. 下次启动(关着:sweepXsLeftovers)把这些残留删掉 ──
  {
    // 占用解除后重启:同名目录换回普通文件;损坏留存一个超过 7 天、一个不到 7 天
    rmSync(join(b2, `${B2}.txt`), { recursive: true });
    writeFileSync(join(b2, `${B2}.txt`), '正文-秘密乙');
    rmSync(join(x2, 'messages.json.corrupt-5'), { recursive: true });
    writeFileSync(join(x2, 'messages.json.corrupt-5'), '{坏');
    age(join(x2, 'messages.json.corrupt-5'), 8);
    writeFileSync(join(x2, 'messages.json.corrupt-7'), '{坏');
    age(join(x2, 'messages.json.corrupt-7'), 6);
    writeFileSync(join(b2, `${A2}.txt.tmp.${DEAD}.2`), '半截');
    const S = await freshStore(h2);
    await S.sweepXsLeftovers();
    eq(readdirSync(x2).sort(), ['README', 'bodies', 'messages.json.corrupt-7'], '关着启动清理:超过 7 天的损坏留存删掉,不到 7 天的留着,不新建记录文件');
    eq(readdirSync(b2), [], '关着启动清理:clear 没删成的正文(此时是孤儿)与临时文件删掉');
  }

  // ── 4. 开着启动(读盘恢复)同样按 7 天清损坏留存;不是普通文件的不动 ──
  {
    const { h, x, b } = mkHome('h3');
    const A = uid(21); const D = uid(22);
    writeFileSync(join(x, 'messages.json'), JSON.stringify({ version: 1, messages: [rec(A, 'pending'), rec(D, 'done')] }));
    writeFileSync(join(b, `${A}.txt`), '甲');
    writeFileSync(join(b, `${D}.txt`), '丁');
    for (const [f, d] of [['messages.json.corrupt-100', 8], ['messages.json.corrupt-200', 6.9], ['messages.json.corrupt-300', 0]]) {
      writeFileSync(join(x, f), '{坏');
      age(join(x, f), d);
    }
    blockAsDir(join(x, 'messages.json.corrupt-400'));
    age(join(x, 'messages.json.corrupt-400'), 30);
    const S = await freshStore(h);
    await S.loadXsInbox();
    eq(readdirSync(x).filter((f) => f.startsWith('messages.json.corrupt-')).sort(),
      ['messages.json.corrupt-200', 'messages.json.corrupt-300', 'messages.json.corrupt-400'], '开着启动:超过 7 天的删掉;不到 7 天的、不是普通文件的不动');
    eq(readdirSync(b), [`${A}.txt`], '开着启动:未结束消息的正文留着,已结束的正文删掉(原有行为)');
  }

  // ── 5. 关着启动清理只读判断、只删不写;记录解析不了时什么都不清;目录不存在时不建 ──
  {
    const { h, x, b } = mkHome('h4');
    const P = uid(31); const Q = uid(32); const D = uid(33); const O = uid(34);
    const raw = JSON.stringify({ version: 1, messages: [rec(P, 'pending'), rec(Q, 'processing', { token: 't' }), rec(D, 'done')] });
    writeFileSync(join(x, 'messages.json'), raw);
    for (const id of [P, Q, D, O]) writeFileSync(join(b, `${id}.txt`), id);
    writeFileSync(join(x, 'messages.json.corrupt-9'), '{坏');
    age(join(x, 'messages.json.corrupt-9'), 10);
    await (await freshStore(h)).sweepXsLeftovers();
    eq(readdirSync(b).sort(), [`${P}.txt`, `${Q}.txt`].sort(), '未结束(含 processing)消息的正文留着,已结束的与孤儿删掉');
    eq(readFileSync(join(x, 'messages.json'), 'utf8'), raw, '只删不写:不做恢复(processing 不改、token 不删)');
    ok(!existsSync(join(x, 'messages.json.corrupt-9')), '超过 7 天的损坏留存删掉');

    writeFileSync(join(x, 'messages.json'), '{坏的');
    writeFileSync(join(b, `${O}.txt`), 'o');
    writeFileSync(join(x, 'messages.json.corrupt-8'), '{坏');
    age(join(x, 'messages.json.corrupt-8'), 10);
    const snap = () => `${readdirSync(x).sort().join('|')}#${readdirSync(b).sort().join('|')}`;
    const before = snap();
    await (await freshStore(h)).sweepXsLeftovers();
    eq([snap(), readFileSync(join(x, 'messages.json'), 'utf8')], [before, '{坏的'], '记录解析不了:这一次什么都不清、不挪');

    const none = join(TMP, 'home-none');
    await (await freshStore(none)).sweepXsLeftovers();
    ok(!existsSync(none), '收件箱目录不存在时不建任何目录');
  }

  // ── 6. 挪开损坏文件时修改时间设成挪开那一刻,下次启动不会把它当过期删掉 ──
  {
    const { h, x } = mkHome('h5');
    writeFileSync(join(x, 'messages.json'), '{坏');
    age(join(x, 'messages.json'), 30); // 一个月没写过的记录文件损坏了
    eq(await (await freshStore(h)).listXsMessages(), [], '损坏:从空表开始');
    const aside = readdirSync(x).filter((f) => f.startsWith('messages.json.corrupt-'));
    eq(aside.length, 1, '损坏文件挪到一边');
    ok(Math.abs(Date.now() - statSync(join(x, aside[0])).mtimeMs) < 60000, '挪开时修改时间设成挪开那一刻(不沿用一个月前的)');
    await (await freshStore(h)).loadXsInbox();
    ok(existsSync(join(x, aside[0])), '下次启动:不满 7 天的损坏留存留着');
  }

  // ── 7. r151c 先修 6:7 天起算 = max(修改时间, 文件名里的毫秒时间戳)(挪开后设修改时间失败的那份不会被提前删) ──
  {
    const { h, x } = mkHome('h6');
    const now = Date.now();
    const files = [
      [`messages.json.corrupt-${now - 1 * DAY}`, 30], // 文件名是昨天挪开的、修改时间一个月前(设修改时间失败)→ 留
      [`messages.json.corrupt-${now - 8 * DAY}`, 30], // 两者都超过 7 天 → 删
      [`messages.json.corrupt-${now - 30 * DAY}`, 1], // 文件名超过 7 天、修改时间昨天 → 取较晚的,留
      ['messages.json.corrupt-abc', 8], //              后缀不是数字:只看修改时间 → 删
      ['messages.json.corrupt-xyz', 6], //              同上,不到 7 天 → 留
    ];
    for (const [f, d] of files) { writeFileSync(join(x, f), '{坏'); age(join(x, f), d); }
    await (await freshStore(h)).sweepXsLeftovers(); // 关着启动
    eq(readdirSync(x).filter((f) => f.startsWith('messages.json.corrupt-')).sort(), [files[0][0], files[2][0], 'messages.json.corrupt-xyz'].sort(),
      '关着启动:按两者较晚的算满 7 天才删;后缀不是数字只看修改时间');
    const { h: h2, x: x2 } = mkHome('h7');
    for (const [f, d] of files) { writeFileSync(join(x2, f), '{坏'); age(join(x2, f), d); }
    await (await freshStore(h2)).loadXsInbox(); // 开着启动(读盘恢复)同一口径
    eq(readdirSync(x2).filter((f) => f.startsWith('messages.json.corrupt-')).sort(), [files[0][0], files[2][0], 'messages.json.corrupt-xyz'].sort(), '开着启动:同一口径');
  }

  // ── 8. r151c 先修 7:清空时正文目录列不出来 → 记一行日志,记录照删、照常返回 removed,正文留待下次启动清理 ──
  {
    const { h, x, b } = mkHome('h8');
    const A = uid(41);
    writeFileSync(join(x, 'messages.json'), JSON.stringify({ version: 1, messages: [rec(A, 'pending')] }));
    writeFileSync(join(b, `${A}.txt`), '甲');
    const S = await freshStore(h);
    warns.length = 0;
    chmodSync(b, 0o000); // 目录本身还在(lstat 得到),但列不出来
    try {
      eq(await S.clearXsInbox(), 1, '正文目录列不出来:记录照删,照常返回 removed');
    } finally { chmodSync(b, 0o700); }
    eq(warns.filter((s) => s.includes('清空时读正文目录失败')).length, 1, '记一行日志(带错误码,不带正文)');
    eq([existsSync(join(x, 'messages.json')), existsSync(join(b, `${A}.txt`))], [false, true], '记录已删;正文留待下次启动清理');
    await (await freshStore(h)).sweepXsLeftovers();
    eq(readdirSync(b), [], '下次启动(关着)把这份孤儿正文删掉');
  }
} finally {
  console.warn = origWarn;
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`check-r151b-xs-clear-leftovers: ${checks} checks passed`);
