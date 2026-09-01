#!/usr/bin/env node
// 单测:r58 删除归因(Windows 文件被占用)+ 前端参考图内存 + MIME 兜底。
// Run: node tests/unit/check-r58-delete-attrib.mjs
//
// 核心牙:
//  ① 归因分流:守卫拒 → skipped(语义不变,r54 t6b 那套断言原样成立);unlink 抛错
//    (Windows 上文件被看图程序/缩略图缓存占着 = EBUSY/EPERM)→ failed,两个数组互不串。
//  ② 记录与文件同生死:unlink 失败时【该条历史记录必须留着】—— 否则记录没了、文件还在,
//    用户既看不见它也删不掉它(只能自己去文件夹翻)。失败可重试才是可用的失败。
//    ENOENT 例外:文件本来就不在了,记录照删(不是失败)。
//  ③ 前端两句文案分开:守卫的说「不在保存目录之内」,失败的说「可能正被其他程序占用」。
//  ④ 参考图预览改 objectURL(不再与 dataB64 同存一份 base64),createObjectURL 与
//    revokeObjectURL 必须成对(移除芯片 / 组件卸载 / 半路失败的批次)。
//  ⑤ f.type 为空(Win 注册表缺 MIME 映射)按扩展名认,认不出才回落 image/png。
//
// 隔离:HOME/USERPROFILE 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);
// 上游是本机假服务(临时口),绝不打真实网络。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r58-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r58-save-'));
const OUTSIDE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r58-outside-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });
const HISTORY_FILE = join(TMP_HOME, '.claude-gui', 'image-history.json');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-r58-stored-secret-abcdef123456';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BUF = Buffer.from(PNG_B64, 'base64');

// ───────────── 0. 纯函数:f.type 为空时按扩展名兜底(S4) ─────────────
{
  const { refMime } = await import('../../client/src/utils/refMime.js');
  const f = (name, type = '') => ({ name, type });
  // 浏览器给了 type 就信它(它看的是真实字节/系统映射,比扩展名可靠)
  assert.equal(refMime(f('cat.png', 'image/webp')), 'image/webp', 't0: type 非空时优先用 type');
  assert.equal(refMime(f('cat.txt', 'image/jpeg')), 'image/jpeg', 't0: type 非空时不看扩展名');
  // type 空(Windows 注册表缺映射)→ 按扩展名
  assert.equal(refMime(f('cat.png')), 'image/png', 't0: .png');
  assert.equal(refMime(f('cat.jpg')), 'image/jpeg', 't0: .jpg → image/jpeg');
  assert.equal(refMime(f('cat.jpeg')), 'image/jpeg', 't0: .jpeg → image/jpeg');
  assert.equal(refMime(f('cat.webp')), 'image/webp', 't0【核心】:.webp 不许再说自己是 png');
  assert.equal(refMime(f('CAT.WEBP')), 'image/webp', 't0: 大写扩展名同样认(Windows 上很常见)');
  assert.equal(refMime(f('cat.JPG')), 'image/jpeg', 't0: 大写 .JPG');
  assert.equal(refMime(f('a.b.c.webp')), 'image/webp', 't0: 多点文件名取最后一段');
  // 认不出才回落
  assert.equal(refMime(f('cat.gif')), 'image/png', 't0: 不认识的扩展名回落 image/png(现状)');
  assert.equal(refMime(f('cat')), 'image/png', 't0: 没有扩展名回落 image/png');
  assert.equal(refMime(f('', '')), 'image/png', 't0: 空文件名回落 image/png');
  assert.equal(refMime(undefined), 'image/png', 't0: 传空对象不炸');
}

const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;

const app = express();
app.use(express.json({ limit: '25mb' }));
app.post('/fast/v1/images/generations', (_req, res) => res.json({ data: [{ b64_json: PNG_B64 }] }));
app.use('/api', imageRouter);

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};
const waitFor = async (fn, ms = 12000, step = 100) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, step));
  }
};
const historyOf = async (id) => {
  const r = await api('GET', '/api/image/history');
  const list = r.json?.history || [];
  return { list, entry: id ? list.find((e) => e.id === id) : null };
};
const settle = (id) => waitFor(async () => {
  const h = await historyOf(id);
  return h.entry && h.entry.status !== 'running' ? h : null;
});
// 把条目的 file 字段改写成点名的路径(模拟"文件被移动/被换成别的东西")。
const repoint = (id, file) => {
  const list = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  list.find((x) => x.id === id).file = file;
  writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2));
};

let failure = null;
try {
  const r0 = await api('POST', '/api/image-providers', {
    name: 'r58 删除归因', protocol: 'openai', baseURL: `${BASE}/fast/v1`, apiKey: KEY,
    model: 'gpt-image-2', savePath: SAVE_DIR,
  });
  assert.equal(r0.status, 200, `建 provider(${r0.text})`);
  const pid = r0.json.id;
  const mk = async (prompt) => {
    const r = await api('POST', '/api/image/generate', { providerId: pid, prompt });
    const done = await settle(r.json.jobId);
    assert.equal(done.entry.status, 'done', `${prompt} 先正常出图`);
    return done.entry;
  };
  // unlink 一定失败但不是 ENOENT 的目标:同名目录(macOS EPERM / Linux EISDIR / Win EPERM)。
  // 比 mock fs 可移植 —— 走的是真实 unlink 的真实错误码。
  let busySeq = 0;
  const makeBusy = () => {
    const p = join(SAVE_DIR, `busy-${busySeq++}.png`);
    mkdirSync(p);
    return p;
  };

  // ───────────── 1. 正常删文件:failed 是空数组(字段在,零回归) ─────────────
  {
    const e = await mk('正常删');
    const r = await api('POST', '/api/image/history/delete', { ids: [e.id], deleteFile: true });
    assert.equal(r.json?.ok, true, `t1: 删除成功(${r.text})`);
    assert.equal(r.json.removed, 1, 't1: 记录删掉');
    assert.equal(r.json.filesDeleted, 1, 't1: 文件删掉');
    assert.deepEqual(r.json.skipped, [], 't1: 不进 skipped');
    assert.deepEqual(r.json.failed, [], 't1【字段常在】:正常路径 failed 是空数组,不是 undefined');
    assert.ok(!existsSync(e.file), 't1: 磁盘上的图已删');
  }

  // ───────────── 2. unlink 抛错:failed + 记录留着 + 文件留着 ─────────────
  {
    const e = await mk('占用删不掉');
    const busy = makeBusy();
    repoint(e.id, busy);
    const r = await api('POST', '/api/image/history/delete', { ids: [e.id], deleteFile: true });
    assert.equal(r.status, 200, `t2: 请求本身成功(${r.status} ${r.text.slice(0, 120)})`);
    assert.equal(r.json?.ok, true, 't2: 单个文件删不掉不算整体失败');
    assert.equal(r.json.filesDeleted, 0, 't2: 一个文件都没删掉');
    assert.deepEqual(r.json.skipped, [], 't2【不许串】:unlink 抛错不是守卫拒,不许进 skipped');
    assert.equal(r.json.failed?.length, 1, `t2【归因】:unlink 抛错进 failed(实际 ${JSON.stringify(r.json.failed)})`);
    assert.equal(r.json.failed[0].file, busy, 't2: failed 如实回报是哪个文件');
    assert.ok(r.json.failed[0].code, `t2: failed 带错误码供排查(实际 ${JSON.stringify(r.json.failed[0])})`);
    assert.notEqual(r.json.failed[0].code, 'ENOENT', 't2: 制造出来的确实不是"文件不存在"');
    assert.equal(r.json.removed, 0, 't2: 一条都没真删掉,removed 如实为 0');
    assert.ok(existsSync(busy), 't2: 文件仍在');
    const after = await historyOf(e.id);
    assert.ok(after.entry, 't2【记录与文件同生死】:unlink 失败时历史条目必须留着(否则文件删不掉又看不见)');
    assert.equal(after.entry.file, busy, 't2: 条目原样保留(可原地重试)');
    const onDisk = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    assert.ok(onDisk.some((x) => x.id === e.id), 't2: 落盘的历史里也还在(不是只在响应里装作还在)');
    // 重试:占用解除后同一条能删干净
    rmSync(busy, { recursive: true });
    writeFileSync(busy, PNG_BUF);
    const again = await api('POST', '/api/image/history/delete', { ids: [e.id], deleteFile: true });
    assert.equal(again.json?.filesDeleted, 1, `t2【可重试】:占用解除后再删就成了(${again.text})`);
    assert.deepEqual(again.json.failed, [], 't2: 重试后 failed 空');
    assert.ok(!(await historyOf(e.id)).entry, 't2: 这次记录才移除');
    assert.ok(!existsSync(busy), 't2: 文件也删了');
  }

  // ───────────── 3. 混删:失败的留着,其余照删(失败不牵连同批) ─────────────
  {
    const okEntry = await mk('混删-能删');
    const badEntry = await mk('混删-删不掉');
    const busy = makeBusy();
    repoint(badEntry.id, busy);
    const r = await api('POST', '/api/image/history/delete', { ids: [okEntry.id, badEntry.id], deleteFile: true });
    assert.equal(r.json?.filesDeleted, 1, `t3: 能删的那个照删(${r.text})`);
    assert.equal(r.json.failed.length, 1, 't3: 删不掉的那个进 failed');
    assert.equal(r.json.removed, 1, 't3: removed 只算真删掉的');
    assert.ok(!existsSync(okEntry.file), 't3: 能删的文件已删');
    assert.ok(existsSync(busy), 't3: 删不掉的文件仍在');
    const list = (await historyOf()).list;
    assert.ok(!list.some((x) => x.id === okEntry.id), 't3: 能删的记录移除');
    assert.ok(list.some((x) => x.id === badEntry.id), 't3【不牵连】:同批里失败的那条独自留着');
    rmSync(busy, { recursive: true });
    await api('POST', '/api/image/history/delete', { ids: [badEntry.id] }); // 收尾
  }

  // ───────────── 4. ENOENT 不算失败:记录照删 ─────────────
  {
    const e = await mk('文件早没了');
    rmSync(e.file);
    const r = await api('POST', '/api/image/history/delete', { ids: [e.id], deleteFile: true });
    assert.equal(r.json?.removed, 1, `t4: 文件不在了记录照删(${r.text})`);
    assert.deepEqual(r.json.failed, [], 't4【ENOENT 例外】:文件本来就没了不是删除失败');
    assert.deepEqual(r.json.skipped, [], 't4: 也不进 skipped');
    assert.equal(r.json.filesDeleted, 0, 't4: 没删成文件');
    assert.ok(!(await historyOf(e.id)).entry, 't4: 条目已移除');
  }

  // ───────────── 5. 守卫拒:语义一字不变(记录照删 + 进 skipped + 文件幸存) ─────────────
  {
    const e = await mk('越界-file-被改写');
    const outside = join(OUTSIDE_DIR, 'must-survive.png');
    writeFileSync(outside, PNG_BUF);
    repoint(e.id, outside);
    const r = await api('POST', '/api/image/history/delete', { ids: [e.id], deleteFile: true });
    assert.equal(r.json?.removed, 1, 't5【守卫语义不变】:守卫拒时记录照删(r54 t6b 原样)');
    assert.equal(r.json.filesDeleted, 0, 't5: savePath 之外的文件一个都不许删');
    assert.deepEqual(r.json.skipped, [outside], 't5: 守卫拒仍进 skipped');
    assert.deepEqual(r.json.failed, [], 't5【不许串】:守卫拒不是 unlink 失败');
    assert.ok(existsSync(outside), 't5: 文件必须幸存');
    assert.ok(!(await historyOf(e.id)).entry, 't5: 条目仍被移除');
  }

  // ───────────── 6. 不勾删文件时:两个数组都空,记录全删(零回归) ─────────────
  {
    const e = await mk('只删记录');
    const busy = makeBusy();
    repoint(e.id, busy);
    const r = await api('POST', '/api/image/history/delete', { ids: [e.id] });
    assert.equal(r.json?.removed, 1, 't6: 没勾删文件 → 记录照删');
    assert.equal(r.json.filesDeleted, 0, 't6: 一个文件都不许动');
    assert.deepEqual(r.json.failed, [], 't6: 没碰文件就谈不上失败');
    assert.ok(existsSync(busy), 't6: 文件原封不动');
    assert.ok(statSync(busy).isDirectory(), 't6: 连"删不掉的那种"都没被尝试删');
  }
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => server.once('close', r));
  for (const d of [TMP_HOME, SAVE_DIR, OUTSIDE_DIR]) rmSync(d, { recursive: true, force: true });
}
if (failure) throw failure;

// ───────────── 7. 服务端源码:分流判据 + 安全链路零改动 ─────────────
{
  const src = readFileSync(join(REPO, 'server/routes/image.js'), 'utf8');
  const delStart = src.indexOf("router.post('/image/history/delete'");
  const delBlock = src.slice(delStart, src.indexOf('router.', delStart + 10));
  assert.ok(delStart > 0 && delBlock.length > 200, 't7: 能定位删除端点源码块');
  assert.equal((delBlock.match(/await unlink\(/g) || []).length, 1, 't7: 仍只有一处 unlink(删单个文件)');
  assert.ok(!/\brm\(|rmSync|rmdir|recursive: true/.test(delBlock), 't7【禁递归删除】:删除端点里不许出现任何递归/目录删除');
  assert.match(delBlock, /failed\.push\(/, 't7: unlink 抛错记进 failed');
  assert.match(delBlock, /err\?\.code === 'ENOENT'/, 't7: ENOENT 单独放行(不算失败)');
  assert.match(delBlock, /skipped, failed/, 't7: 两个数组都回给前端');
  // 记录保留:next 的过滤必须把"失败的那条"排除在删除之外
  assert.match(delBlock, /keep\.add\(e\.id\)/, 't7【记录与文件同生死】:失败的条目要登记进 keep');
  assert.match(delBlock, /!keep\.has\(e\.id\)/, 't7: 移除条目时必须放过 keep 里的');
}

// ───────────── 8. 前端源码:两句文案 + objectURL 成对 + MIME 兜底接线 ─────────────
{
  const src = readFileSync(join(REPO, 'client/src/components/ImagePanel.jsx'), 'utf8');
  // 两句文案分开
  assert.match(src, /d\.skipped\?\.length/, 't8: 守卫那句仍在');
  assert.match(src, /文件路径不在生图 provider 的保存目录之内/, 't8: 守卫文案原文不变');
  assert.match(src, /d\.failed\?\.length/, 't8【归因】:失败那句单独判 failed');
  assert.match(src, /文件可能正被其他程序占用，请关闭后重试/, 't8: 失败文案是可行动的(去关掉占用的程序,不是去改配置)');
  // objectURL 成对
  assert.match(src, /preview: URL\.createObjectURL\(f\)/, 't8: 上传参考图的预览用 objectURL');
  assert.ok(!/preview: dataUrl/.test(src), 't8【省一份内存】:preview 不许再拼整份 dataURL');
  assert.match(src, /dataB64: dataUrl\.slice/, 't8: 发送用的 dataB64 保留(objectURL 传不给服务端)');
  assert.ok((src.match(/URL\.revokeObjectURL\(/g) || []).length >= 1, 't8: revokeObjectURL 在位');
  assert.match(src, /revokeRefPreview\(r\);\s*setRefs\(\(cur\) => cur\.filter/, 't8【成对】:移除芯片时先 revoke 再移除');
  assert.match(src, /refsRef\.current\.forEach\(revokeRefPreview\)/, 't8【成对】:组件卸载时把还挂着的全撤掉');
  assert.match(src, /useEffect\(\(\) => \(\) => \{ refsRef\.current\.forEach\(revokeRefPreview\); \}, \[\]\)/,
    't8: 卸载 effect 依赖数组必须为空(依赖 refs 会在每次增删时误撤当前预览)');
  assert.match(src, /kind === 'upload'/, 't8: 只撤 upload 的(history 的 preview 是服务端 URL)');
  assert.match(src, /next\.forEach\(revokeRefPreview\)/, 't8: 半路失败的批次也要撤(否则超限报错一次泄一批)');
  // MIME 兜底接线
  assert.match(src, /mime: refMime\(f\)/, 't8: mime 走扩展名兜底');
  assert.ok(!/mime: f\.type \|\| 'image\/png'/.test(src), 't8【不许撒谎】:不再无条件回落 image/png');
  assert.match(src, /import \{ refMime \} from '\.\.\/utils\/refMime\.js'/, 't8: 纯函数抽在 utils(可被单测直接 import)');
}

console.log('✓ check-r58-delete-attrib: 删除归因分流(skipped/failed 不串)+ 失败条目保留可重试 + ENOENT/守卫语义零回归 + 前端两句文案 + objectURL 成对 + MIME 扩展名兜底 全部通过');
