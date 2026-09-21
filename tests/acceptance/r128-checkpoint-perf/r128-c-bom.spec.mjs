// r128 · C 组:开头带 UTF-8 BOM 的合法 JSON 不算损坏(INTERFACE §C C1–C3;BRIEF N3)。
// 依据只有 .devflow/BRIEF-r128.md 与 .devflow/INTERFACE-r128.md;没看实现代码。
// 夹具不猜文件格式:先让产品自己把文件写出来(建 provider / 设模型 / 建生图 provider / 切换),停掉实例,
// 在产品写的原字节前面加上 EF BB BF(Windows 记事本 / PowerShell 默认写的 BOM),再起一个实例读写它。
// 四个文件各一条(C1 = custom-providers.json,C2 = 其余三个);C3 用真损坏(半截 JSON)看文案。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { caseRoot, cfgPath, guiDir, FILES, assertIsolated } from './helpers/fixtures.mjs';
import { startInstance, stopAll, req } from './helpers/instance.mjs';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const OFFICIAL = 'builtin-official';
const FAKE_KEY = 'sk-r128-not-a-real-key-0123456789';
const HALF = Buffer.from('[{"id":"r128-half","name":"半截 JSON —— 写到一半断了"', 'utf8');
const short = (v) => JSON.stringify(v ?? null).slice(0, 300);
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const customBody = (o = {}) => ({ name: `r128 自定义 ${uniq()}`, type: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: FAKE_KEY, models: ['r128-m1', 'r128-m2'], ...o });
const imageBody = (home, o = {}) => { const dir = path.join(home, 'images', uniq()); assertIsolated(dir); fs.mkdirSync(dir, { recursive: true }); return { name: `r128 生图 ${uniq()}`, protocol: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: FAKE_KEY, model: 'r128-img-a', models: ['r128-img-a'], size: '1024x1024', savePath: dir, ...o }; };
const getProviders = (base) => req(base, 'GET', '/api/providers');
const corruptWarnings = (json) => (Array.isArray(json?.warnings) ? json.warnings : []).filter((w) => w && w.kind === 'config-corrupt');
const backupsIn = (home) => (fs.existsSync(guiDir(home)) ? fs.readdirSync(guiDir(home)).filter((n) => /\.corrupt-\d+$/.test(n)).sort() : []);
const startsWithBom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
const parseJson = (buf) => { try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; } catch (e) { return { ok: false, error: String(e.message).slice(0, 120) }; } };
const idsOf = (v) => (Array.isArray(v) ? v : (v?.providers ?? [])).map((x) => x.id);

async function mustOk(r, what) { if (r.status !== 200) throw new Error(`前提失败:${what} HTTP ${r.status} ${r.text.slice(0, 200)}`); return r; }

/**
 * 让产品先把 <key> 文件写出来,停实例,给文件加 BOM,再起一个实例。
 * 返回 { cr, h(第二个实例), p(文件路径), before(产品写的原字节), ids(前一实例建的对象 id) }。
 */
async function bootWithBom(slug, key) {
  const cr = caseRoot('c', slug);
  const h1 = await startInstance(cr, {}, { label: `${slug}-writer` });
  const ids = {};
  const c = await mustOk(await req(h1.base, 'POST', '/api/custom-providers', customBody({ name: `r128 ${slug} 原有` })), '建自定义 provider');
  ids.custom = c.json?.id ?? c.json?.provider?.id;
  if (key === 'models') await mustOk(await req(h1.base, 'PUT', `/api/provider-models/${ids.custom}`, { models: ['r128-m1'] }), '设 provider-models');
  if (key === 'image') { const ip = await mustOk(await req(h1.base, 'POST', '/api/image-providers', imageBody(cr.home, { name: `r128 ${slug} 原有生图` })), '建生图 provider'); ids.image = ip.json?.id; }
  if (key === 'active') await mustOk(await req(h1.base, 'POST', '/api/provider/switch', { id: ids.custom, model: 'r128-m1' }), '切换 provider');
  await h1.stop();
  const p = cfgPath(cr.home, key);
  if (!fs.existsSync(p)) throw new Error(`前提失败:产品没有写出 ${FILES[key]}(${p})`);
  const before = fs.readFileSync(p);
  if (startsWithBom(before)) throw new Error(`前提失败:产品自己写的 ${FILES[key]} 就带 BOM`);
  if (!parseJson(before).ok) throw new Error(`前提失败:产品自己写的 ${FILES[key]} 不是合法 JSON`);
  fs.writeFileSync(p, Buffer.concat([BOM, before]));
  const h = await startInstance(cr, {}, { label: `${slug}-reader` });
  return { cr, h, p, before, ids };
}

/** 三条共用的"没被当成损坏"证据:warnings 无 config-corrupt、目录里没有 .corrupt- 备份。 */
function expectNotTreatedAsCorrupt(tag, home, providersJson) {
  const cw = corruptWarnings(providersJson);
  const bk = backupsIn(home);
  console.log(`[r128] ${tag} config-corrupt 警告=${short(cw)} 备份=${JSON.stringify(bk)}`);
  expect.soft(cw, `带 BOM 的合法 JSON 不该报 config-corrupt,实际 warnings=${short(providersJson?.warnings)}`).toEqual([]);
  expect.soft(bk, `目录里不该出现 .corrupt- 备份,实际 ${JSON.stringify(bk)}`).toEqual([]);
}
/** 写回之后的文件证据:合法 JSON、开头不再是 BOM。返回解析结果。 */
function expectCleanWriteBack(tag, p) {
  const after = fs.readFileSync(p);
  const parsed = parseJson(after);
  console.log(`[r128] ${tag} 写回后 ${after.length}B 开头字节=${after.subarray(0, 3).toString('hex')} 合法JSON=${parsed.ok}`);
  expect.soft(startsWithBom(after), '写回后文件开头不该再是 BOM').toBe(false);
  expect.soft(parsed.ok, `写回后文件应是合法 JSON:${parsed.error ?? ''}`).toBe(true);
  return parsed.value;
}

test.afterEach(async () => { await stopAll(); });

// ───────────────────────── C1 custom-providers.json ─────────────────────────
test('C1 custom-providers.json 带 BOM 的合法 JSON:GET /api/providers 读到该 provider、无 config-corrupt、无备份;POST 新增 200,写回后合法且无 BOM,原有那条仍在', async () => {
  const { cr, h, p, ids } = await bootWithBom('c1-custom', 'custom');
  const g = await getProviders(h.base);
  expect(g.status, g.text.slice(0, 200)).toBe(200);
  const listed = (g.json?.customProviders ?? []).map((x) => x.id);
  console.log(`[r128] C1 customProviders=${JSON.stringify(listed)} 期望含 ${ids.custom}`);
  expect.soft(listed, '带 BOM 的文件里那条自定义 provider 应读得到').toContain(ids.custom);
  expectNotTreatedAsCorrupt('C1', cr.home, g.json);
  const w = await req(h.base, 'POST', '/api/custom-providers', customBody({ name: 'r128 C1 新增' }));
  console.log(`[r128] C1 POST status=${w.status} body=${w.text.slice(0, 160)}`);
  expect.soft(w.status, `POST /api/custom-providers 应 200,实际 ${w.status} ${w.text.slice(0, 120)}`).toBe(200);
  const value = expectCleanWriteBack('C1', p);
  if (value !== undefined) {
    expect.soft(idsOf(value), '写回后原有 provider 不许丢').toContain(ids.custom);
    if (w.status === 200) expect.soft(idsOf(value), '写回后新 provider 应落盘').toContain(w.json?.id ?? w.json?.provider?.id);
  }
  expect(backupsIn(cr.home), '整条用例结束时目录里仍不该有 .corrupt- 备份').toEqual([]);
});

// ───────────────────────── C2 provider-models.json / image-providers.json / active-provider.json ─────────────────────────
test('C2-1 provider-models.json 带 BOM:GET /api/provider-models 读到已设模型、无 config-corrupt、无备份;PUT 200,写回后合法且无 BOM', async () => {
  const { cr, h, p, ids } = await bootWithBom('c2-models', 'models');
  const g = await req(h.base, 'GET', '/api/provider-models');
  console.log(`[r128] C2-1 GET provider-models status=${g.status} body=${g.text.slice(0, 160)}`);
  expect(g.status, g.text.slice(0, 200)).toBe(200);
  expect.soft(g.json?.selections?.[ids.custom], '带 BOM 的文件里已设的模型应读得到').toEqual(['r128-m1']);
  expectNotTreatedAsCorrupt('C2-1', cr.home, (await getProviders(h.base)).json);
  const w = await req(h.base, 'PUT', `/api/provider-models/${ids.custom}`, { models: ['r128-m1', 'r128-m2'] });
  console.log(`[r128] C2-1 PUT status=${w.status} body=${w.text.slice(0, 160)}`);
  expect.soft(w.status, `PUT /api/provider-models/:id 应 200,实际 ${w.status} ${w.text.slice(0, 120)}`).toBe(200);
  const value = expectCleanWriteBack('C2-1', p);
  if (value !== undefined && w.status === 200) expect.soft(value?.[ids.custom] ?? value?.selections?.[ids.custom], '写回后应是新模型列表').toEqual(['r128-m1', 'r128-m2']);
  expect(backupsIn(cr.home), '整条用例结束时目录里仍不该有 .corrupt- 备份').toEqual([]);
});

test('C2-2 image-providers.json 带 BOM:GET /api/image-providers 读到该生图 provider、无 config-corrupt、无备份;POST 新增 200,写回后合法且无 BOM,原有那条仍在', async () => {
  const { cr, h, p, ids } = await bootWithBom('c2-image', 'image');
  const g = await req(h.base, 'GET', '/api/image-providers');
  console.log(`[r128] C2-2 GET image-providers status=${g.status} ids=${JSON.stringify(idsOf(g.json))}`);
  expect(g.status, g.text.slice(0, 200)).toBe(200);
  expect.soft(idsOf(g.json), '带 BOM 的文件里那条生图 provider 应读得到').toContain(ids.image);
  expectNotTreatedAsCorrupt('C2-2', cr.home, (await getProviders(h.base)).json);
  const w = await req(h.base, 'POST', '/api/image-providers', imageBody(cr.home, { name: 'r128 C2-2 新增' }));
  console.log(`[r128] C2-2 POST status=${w.status} body=${w.text.slice(0, 160)}`);
  expect.soft(w.status, `POST /api/image-providers 应 200,实际 ${w.status} ${w.text.slice(0, 120)}`).toBe(200);
  const value = expectCleanWriteBack('C2-2', p);
  if (value !== undefined) {
    expect.soft(idsOf(value), '写回后原有生图 provider 不许丢').toContain(ids.image);
    if (w.status === 200) expect.soft(idsOf(value), '写回后新生图 provider 应落盘').toContain(w.json?.id);
  }
  expect(backupsIn(cr.home), '整条用例结束时目录里仍不该有 .corrupt- 备份').toEqual([]);
});

test('C2-3 active-provider.json 带 BOM:GET /api/providers 里那条自定义 provider 仍是当前(isCurrent)、无 config-corrupt、无备份;再切换 200,写回后合法且无 BOM', async () => {
  const { cr, h, p, ids } = await bootWithBom('c2-active', 'active');
  const g = await getProviders(h.base);
  expect(g.status, g.text.slice(0, 200)).toBe(200);
  const me = (g.json?.customProviders ?? []).find((x) => x.id === ids.custom);
  console.log(`[r128] C2-3 当前标记 isCurrent=${me?.isCurrent} (provider ${ids.custom})`);
  expect.soft(me?.isCurrent, '带 BOM 的 active-provider.json 里记的 provider 应仍被认作当前(isCurrent=true)').toBe(true);
  expectNotTreatedAsCorrupt('C2-3', cr.home, g.json);
  const w = await req(h.base, 'POST', '/api/provider/switch', { id: OFFICIAL });
  console.log(`[r128] C2-3 切换 status=${w.status} body=${w.text.slice(0, 160)}`);
  expect.soft(w.status, `切换应 200,实际 ${w.status} ${w.text.slice(0, 120)}`).toBe(200);
  const value = expectCleanWriteBack('C2-3', p);
  if (value !== undefined && w.status === 200) expect.soft(value?.id, '写回后 active-provider.json 应记着切到的 provider').toBe(OFFICIAL);
  expect(backupsIn(cr.home), '整条用例结束时目录里仍不该有 .corrupt- 备份').toEqual([]);
});

// ───────────────────────── C3 真损坏时的文案 ─────────────────────────
test('C3-1 真损坏(半截 JSON)的 custom-providers.json:GET /api/providers 的 config-corrupt warnings[].message 提到「BOM」或「不可见字符」', async () => {
  const cr = caseRoot('c', 'c3-1-warning-text');
  fs.mkdirSync(guiDir(cr.home), { recursive: true });
  fs.writeFileSync(cfgPath(cr.home, 'custom'), HALF);
  const h = await startInstance(cr, {}, { label: 'c3-1' });
  const g = await getProviders(h.base);
  const w = corruptWarnings(g.json).find((x) => typeof x.file === 'string' && x.file.endsWith(FILES.custom));
  console.log(`[r128] C3-1 warning=${short(w)}`);
  expect(w, `前提:真损坏应报 config-corrupt,实际 warnings=${short(g.json?.warnings)}`).toBeTruthy();
  expect(w.message, `警告文案应提示"开头可能有 BOM 或不可见字符",实际:${JSON.stringify(w.message)}`).toMatch(/BOM|不可见字符/i);
});

test('C3-2 真损坏(半截 JSON)时 POST /api/custom-providers 的 409 error 文案提到「BOM」或「不可见字符」', async () => {
  const cr = caseRoot('c', 'c3-2-409-text');
  fs.mkdirSync(guiDir(cr.home), { recursive: true });
  fs.writeFileSync(cfgPath(cr.home, 'custom'), HALF);
  const h = await startInstance(cr, {}, { label: 'c3-2' });
  const r = await req(h.base, 'POST', '/api/custom-providers', customBody({ name: 'r128 C3-2' }));
  console.log(`[r128] C3-2 status=${r.status} body=${r.text.slice(0, 300)}`);
  expect(r.status, `前提:真损坏时写应被 409 拒绝(r126 既有契约),实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(409);
  expect(r.json?.error, `409 的 error 文案应提示"开头可能有 BOM 或不可见字符",实际:${JSON.stringify(r.json?.error)}`).toMatch(/BOM|不可见字符/i);
});
