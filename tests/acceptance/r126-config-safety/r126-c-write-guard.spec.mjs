// r126 · C 组:写保护(INTERFACE §C C1–C4;BRIEF Q1 / Q4)。
// 依据只有 .devflow/BRIEF-r126.md 与 .devflow/INTERFACE-r126.md;没看实现代码。
//   全部是接口用例:每条自起一个全新 HOME 的隔离实例;每个写接口一条。
//   每条先让用户"原有数据"真实存在(先正常建一条),再把文件改坏,再发写请求 —— 请求前后对原文件做字节比对:
//   修前会看到 200 + 文件被"空列表 + 新项"覆盖(原有那条连同密钥丢失),这就是要修的数据丢失,证据打在日志里。
//   C4 的"修好后不重启":同一个实例里把合法 JSON 写回去(写回的就是改坏前读出来的原字节,不猜格式)再请求。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { caseRoot, startInstance, stopAll } from './helpers/instance.mjs';
import { getProviders, getProviderModels, createCustomProvider, customBody, postCustom, putCustom, deleteCustom, putProviderModels, createImageProvider, imageBody, postImage, putImage, deleteImage, switchProvider, corruptWarningFor, warningsOf, OFFICIAL } from './helpers/api.mjs';
import { HALF, GARBAGE, KINDS, corruptFile, readBytes, sameBytes, sha, backupRe } from './helpers/corrupt.mjs';
import { FILES, cfgPath } from './helpers/fixtures.mjs';

const short = (v) => JSON.stringify(v ?? null).slice(0, 300);

/**
 * 写保护的统一判据(INTERFACE C1 同形):409 + { error, code:'CONFIG_CORRUPT', file 以该文件名结尾, backup 为存在的备份路径 } + 原文件字节不变。
 * 状态码 / 返回体形状用 soft 断言,字节比对用硬断言:一条用例把三件事的证据都报出来(修前要看得到"被覆盖"这个事实)。
 */
async function expectRefused(tag, p, key, fn) {
  const fileName = FILES[key];
  const before = readBytes(p);
  const r = await fn();
  const after = readBytes(p);
  const unchanged = sameBytes(before, after);
  const overwritten = unchanged ? '' : ` 现在的内容开头:${JSON.stringify((after ?? Buffer.alloc(0)).subarray(0, 90).toString('utf8'))}`;
  console.log(`[r126] ${tag} status=${r.status} body=${r.text.slice(0, 160)} | ${fileName} 请求前 ${before?.length ?? 0}B sha=${sha(before)} → 请求后 ${after?.length ?? 0}B sha=${sha(after)} ⇒ ${unchanged ? '未变' : '被覆盖!'}${overwritten}`);
  expect.soft(r.status, `应 409 拒绝,实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(409);
  expect.soft(r.json?.code, `返回体 code 应为 'CONFIG_CORRUPT',实际 ${short(r.json)}`).toBe('CONFIG_CORRUPT');
  expect.soft(typeof r.json?.error === 'string' && r.json.error.trim().length > 0, `返回体应带非空 error 文案,实际 ${short(r.json)}`).toBe(true);
  expect.soft(typeof r.json?.file === 'string' && r.json.file.endsWith(fileName), `返回体 file 应以 ${fileName} 结尾,实际 ${short(r.json?.file)}`).toBe(true);
  expect.soft(typeof r.json?.backup === 'string' && backupRe(key).test(path.basename(r.json.backup)) && fs.existsSync(r.json.backup), `返回体 backup 应是已存在的 ${fileName}.corrupt-<数字> 路径,实际 ${short(r.json?.backup)}`).toBe(true);
  expect(unchanged, `请求后原文件必须一个字节不变(请求前 sha=${sha(before)},请求后 sha=${sha(after)})`).toBe(true);
  return r;
}

// ═══════════════════════════ C1 custom-providers.json ═══════════════════════════
test.describe('C1 custom-providers.json 损坏 → 增删改 409 且文件不动', () => {
  test.afterEach(async () => { await stopAll(); });

  /** 先有 1 个正常 provider(用户原有数据,含密钥),再把文件改坏 —— 之后的写操作若覆盖,丢的就是这条。 */
  async function corruptedCustom(slug, kind) {
    const cr = caseRoot(slug);
    const h = await startInstance(cr, {}, { label: slug });
    const c = await createCustomProvider(h.base, { name: `r126 ${slug} 原有` });
    const p = corruptFile(cr.home, 'custom', KINDS[kind]);
    return { h, c, p, home: cr.home };
  }

  test('C1-1[半截] POST /api/custom-providers → 409 CONFIG_CORRUPT(带 file / backup),原文件字节不变', async () => {
    const { h, p } = await corruptedCustom('c1-1-post', '半截');
    await expectRefused('C1-1 POST /api/custom-providers', p, 'custom', () => postCustom(h.base, customBody({ name: 'r126 C1-1 新增' })));
  });

  test('C1-2[乱码] PUT /api/custom-providers/:id → 409 CONFIG_CORRUPT(不是 404),原文件字节不变', async () => {
    const { h, c, p } = await corruptedCustom('c1-2-put', '乱码');
    await expectRefused('C1-2 PUT /api/custom-providers/:id', p, 'custom', () => putCustom(h.base, c.id, customBody({ name: 'r126 C1-2 改名' })));
  });

  test('C1-3[半截] DELETE /api/custom-providers/:id → 409 CONFIG_CORRUPT(不是 404),原文件字节不变', async () => {
    const { h, c, p } = await corruptedCustom('c1-3-delete', '半截');
    await expectRefused('C1-3 DELETE /api/custom-providers/:id', p, 'custom', () => deleteCustom(h.base, c.id));
  });
});

// ═══════════════════════════ C2 provider-models.json / image-providers.json ═══════════════════════════
test.describe('C2 provider-models.json / image-providers.json 损坏 → 写 409 且文件不动', () => {
  test.afterEach(async () => { await stopAll(); });

  test('C2-1[半截] PUT /api/provider-models/:id(provider-models.json 损坏)→ 409 CONFIG_CORRUPT,原文件字节不变', async () => {
    const cr = caseRoot('c2-1-models');
    const h = await startInstance(cr, {}, { label: 'c2-1' });
    const c = await createCustomProvider(h.base, { name: 'r126 C2-1' });
    const ok = await putProviderModels(h.base, c.id, ['r126-m1']);
    expect(ok.status, `前提:文件正常时 PUT provider-models 成功,实际 ${ok.status} ${ok.text.slice(0, 120)}`).toBe(200);
    const p = corruptFile(cr.home, 'models', HALF);
    await expectRefused('C2-1 PUT /api/provider-models/:id', p, 'models', () => putProviderModels(h.base, c.id, ['r126-m1', 'r126-m2']));
  });

  /** 先有 1 个正常生图 provider(含密钥),再把 image-providers.json 改坏。 */
  async function corruptedImage(slug, kind) {
    const cr = caseRoot(slug);
    const h = await startInstance(cr, {}, { label: slug });
    const ip = await createImageProvider(h.base, cr.home, { name: `r126 ${slug} 原有` });
    const p = corruptFile(cr.home, 'image', KINDS[kind]);
    return { h, ip, p, home: cr.home };
  }

  test('C2-2[乱码] POST /api/image-providers → 409 CONFIG_CORRUPT,原文件字节不变', async () => {
    const { h, p, home } = await corruptedImage('c2-2-img-post', '乱码');
    await expectRefused('C2-2 POST /api/image-providers', p, 'image', () => postImage(h.base, imageBody(home, { name: 'r126 C2-2 新增' })));
  });

  test('C2-3[半截] PUT /api/image-providers/:id → 409 CONFIG_CORRUPT(不是 404),原文件字节不变', async () => {
    const { h, ip, p, home } = await corruptedImage('c2-3-img-put', '半截');
    await expectRefused('C2-3 PUT /api/image-providers/:id', p, 'image', () => putImage(h.base, ip.id, imageBody(home, { name: 'r126 C2-3 改名' })));
  });

  test('C2-4[乱码] DELETE /api/image-providers/:id → 409 CONFIG_CORRUPT(不是 404),原文件字节不变', async () => {
    const { h, ip, p } = await corruptedImage('c2-4-img-delete', '乱码');
    await expectRefused('C2-4 DELETE /api/image-providers/:id', p, 'image', () => deleteImage(h.base, ip.id));
  });
});

// ═══════════════════════════ C3 active-provider.json ═══════════════════════════
test.describe('C3 active-provider.json 损坏 → 切换 409 且不覆盖', () => {
  test.afterEach(async () => { await stopAll(); });

  test('C3-1[半截] 先正常切换过一次(文件已存在)→ 改坏 active-provider.json → 再切换 → 409 CONFIG_CORRUPT,原文件字节不变', async () => {
    const cr = caseRoot('c3-1-switch');
    const h = await startInstance(cr, {}, { label: 'c3-1' });
    const c = await createCustomProvider(h.base, { name: 'r126 C3-1' });
    const ok = await switchProvider(h.base, { id: c.id, model: 'r126-m1' });
    expect(ok.status, `前提:文件正常时切换成功(${ok.path}),实际 ${ok.status} ${ok.text.slice(0, 120)}`).toBe(200);
    expect(fs.existsSync(cfgPath(cr.home, 'active')), '前提:切换后 active-provider.json 存在').toBe(true);
    const p = corruptFile(cr.home, 'active', HALF);
    const r = await expectRefused('C3-1 切换 provider', p, 'active', () => switchProvider(h.base, { id: OFFICIAL }));
    console.log(`[r126] C3-1 用的切换接口:${r.path}`);
  });

  test('C3-2[乱码] 从未切换过、active-provider.json 直接是乱码 → 切换 → 409 CONFIG_CORRUPT,原文件字节不变', async () => {
    const cr = caseRoot('c3-2-switch-garbage');
    const p = corruptFile(cr.home, 'active', GARBAGE);
    const h = await startInstance(cr, {}, { label: 'c3-2' });
    const c = await createCustomProvider(h.base, { name: 'r126 C3-2' });
    await expectRefused('C3-2 切换 provider', p, 'active', () => switchProvider(h.base, { id: c.id, model: 'r126-m1' }));
  });
});

// ═══════════════════════════ C4 修好后不重启即恢复 ═══════════════════════════
test.describe('C4 修好后不重启即恢复读写', () => {
  test.afterEach(async () => { await stopAll(); });

  /** 正常建 1 个 provider → 记下正常文件字节(这就是"修好"时要写回的合法 JSON)→ 改坏 → 读一次确认损坏已被发现。 */
  async function corruptedThenSeen(slug) {
    const cr = caseRoot(slug);
    const h = await startInstance(cr, {}, { label: slug });
    const c = await createCustomProvider(h.base, { name: `r126 ${slug} 原有` });
    const p = cfgPath(cr.home, 'custom');
    const good = readBytes(p);
    corruptFile(cr.home, 'custom', HALF);
    const seen = await getProviders(h.base);
    expect(corruptWarningFor(seen.json, FILES.custom), `前提:损坏已被发现(实际 warnings=${short(seen.json?.warnings)})`).not.toBeNull();
    return { h, c, p, good, home: cr.home };
  }
  const idsOnDisk = (p) => { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return (Array.isArray(j) ? j : (j?.providers ?? [])).map((x) => x.id); };

  test('C4-1 写回合法 JSON(改坏前的原字节)后,同一实例紧接着的 GET /api/providers 不再带 config-corrupt,且原 provider 读得到', async () => {
    const { h, c, p, good } = await corruptedThenSeen('c4-1-fixed-get');
    fs.writeFileSync(p, good);
    const r = await getProviders(h.base);
    console.log(`[r126] C4-1 修好后 status=${r.status} warnings=${short(r.json?.warnings)} custom=${(r.json?.customProviders ?? []).map((x) => x.id).join(',')}`);
    expect(warningsOf(r.json, 'config-corrupt'), '修好后不该再报 config-corrupt').toEqual([]);
    expect((r.json?.customProviders ?? []).map((x) => x.id), '修好后原 provider 应读得到').toContain(c.id);
  });

  test('C4-2 写回合法 JSON 后,同一实例 POST /api/custom-providers 成功(200)并落盘:文件里原 provider 与新 provider 都在', async () => {
    const { h, c, p, good } = await corruptedThenSeen('c4-2-fixed-post');
    fs.writeFileSync(p, good);
    const r = await postCustom(h.base, customBody({ name: 'r126 C4-2 修好后新增' }));
    console.log(`[r126] C4-2 修好后 POST status=${r.status} body=${r.text.slice(0, 160)}`);
    expect(r.status, `修好后 POST 应成功,实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(200);
    const newId = r.json?.id ?? r.json?.provider?.id;
    const ids = idsOnDisk(p);
    expect(ids, '落盘文件应仍含原 provider').toContain(c.id);
    expect(ids, '落盘文件应含新 provider').toContain(newId);
  });

  test('C4-3 删掉损坏文件(让程序重建)后,同一实例 GET 不带 config-corrupt,POST 成功并重建文件', async () => {
    const { h, p } = await corruptedThenSeen('c4-3-deleted');
    fs.rmSync(p, { force: true });
    const g = await getProviders(h.base);
    console.log(`[r126] C4-3 删文件后 GET status=${g.status} warnings=${short(g.json?.warnings)}`);
    expect(warningsOf(g.json, 'config-corrupt'), '文件已删就不算损坏').toEqual([]);
    const r = await postCustom(h.base, customBody({ name: 'r126 C4-3 重建' }));
    expect(r.status, `删掉后 POST 应成功,实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(200);
    expect(fs.existsSync(p), 'POST 后文件应被重建').toBe(true);
    expect(idsOnDisk(p)).toContain(r.json?.id ?? r.json?.provider?.id);
  });

  test('C4-4 provider-models.json 同理:改坏 → 读到损坏 → 写回合法 JSON → 同一实例 PUT /api/provider-models/:id 成功并落盘', async () => {
    const cr = caseRoot('c4-4-models');
    const h = await startInstance(cr, {}, { label: 'c4-4' });
    const c = await createCustomProvider(h.base, { name: 'r126 C4-4' });
    expect((await putProviderModels(h.base, c.id, ['r126-m1'])).status, '前提:正常 PUT 成功').toBe(200);
    const p = cfgPath(cr.home, 'models');
    const good = readBytes(p);
    corruptFile(cr.home, 'models', GARBAGE);
    const bad = await putProviderModels(h.base, c.id, ['r126-x']);
    expect(bad.status, `前提:损坏时 PUT 应被拒(409),实际 ${bad.status}`).toBe(409);
    fs.writeFileSync(p, good);
    const r = await putProviderModels(h.base, c.id, ['r126-m1', 'r126-m2']);
    console.log(`[r126] C4-4 修好后 PUT status=${r.status} body=${r.text.slice(0, 160)}`);
    expect(r.status, `修好后 PUT 应成功,实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(200);
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(onDisk?.[c.id] ?? onDisk?.selections?.[c.id], '落盘应是修好后写入的模型列表').toEqual(['r126-m1', 'r126-m2']);
    const g = await getProviderModels(h.base);
    expect(g.json?.selections?.[c.id]).toEqual(['r126-m1', 'r126-m2']);
  });
});
