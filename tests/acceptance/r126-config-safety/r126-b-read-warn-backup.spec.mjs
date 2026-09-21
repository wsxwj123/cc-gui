// r126 · B 组:读取 / 警告 / 备份(INTERFACE §B B1–B3;BRIEF Q2 / Q3 / Q5)。
// 依据只有 .devflow/BRIEF-r126.md 与 .devflow/INTERFACE-r126.md;没看实现代码。
//   B1 / B3 是接口用例:每条自起一个全新 HOME 的隔离实例(用例之间不共享文件,顺序无关)。
//   B2 是界面用例:在共享隔离实例上做,每条先把共享 HOME 的 custom-providers.json 置成自己要的状态、结束后复位(连同备份)。
// 损坏内容两种:半截 JSON(写到一半断掉)与乱码(含 0x00 / 非法 UTF-8 的二进制垃圾)。
// 「启动前已损坏」= 断电半写后重启;「运行中被改坏」= 外部工具在程序运行时改坏 —— 两种时机都覆盖。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { caseRoot, startInstance, stopAll } from './helpers/instance.mjs';
import { getProviders, getProviderModels, listImageProviders, createCustomProvider, corruptWarningFor, warningsOf, OFFICIAL } from './helpers/api.mjs';
import { KINDS, HALF, GARBAGE, corruptFile, setFile, resetFile, readBytes, sameBytes, sha, listBackups, backupPaths, listAnyBackups, backupRe } from './helpers/corrupt.mjs';
import { FILES, guiDir, HOME_DIR } from './helpers/fixtures.mjs';
import { boot, openProviderList, closeProviderList, switchList, switchListAny, switchRowsAny, listWarning, listWarningIn, openProviderManager, textOf, MOBILE, bootMobile, openMobileProviderPage } from './helpers/ui.mjs';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => JSON.stringify(v ?? null).slice(0, 400);

/** 起一个实例,某文件在启动前就已损坏(断电半写后重启的场景)。 */
async function bootCorrupt(slug, kind, key = 'custom') {
  const cr = caseRoot(slug);
  const p = corruptFile(cr.home, key, KINDS[kind]);
  const h = await startInstance(cr, {}, { label: slug });
  return { h, p, home: cr.home, bytes: KINDS[kind] };
}
const logWarnings = (tag, r) => console.log(`[r126] ${tag} status=${r.status} warnings=${short(r.json?.warnings)} warning=${JSON.stringify(r.json?.warning ?? null).slice(0, 160)}`);

// ═══════════════════════════ B1 读取:损坏时仍 200 + warnings 数组 ═══════════════════════════
test.describe('B1 读取与 warnings', () => {
  test.afterEach(async () => { await stopAll(); });

  for (const kind of ['半截', '乱码']) {
    test(`B1-1[${kind}] 启动前 custom-providers.json 已损坏:GET /api/providers 仍 200,warnings 含 kind:'config-corrupt' 且 file 以 custom-providers.json 结尾`, async () => {
      const { h } = await bootCorrupt(`b1-1-${kind}`, kind);
      const r = await getProviders(h.base);
      logWarnings(`B1-1[${kind}]`, r);
      expect(r.status, r.text.slice(0, 200)).toBe(200);
      expect(corruptWarningFor(r.json, FILES.custom), `warnings 里应有 {kind:'config-corrupt', file:…/custom-providers.json},实际 warnings=${short(r.json?.warnings)}`).not.toBeNull();
    });
  }

  test('B1-2[半截] 实例运行中 custom-providers.json 被外部改坏(之前已正常读过一次):紧接着的 GET /api/providers 仍 200 且 warnings 含 config-corrupt(不靠重启才发现)', async () => {
    const cr = caseRoot('b1-2-running');
    const h = await startInstance(cr, {}, { label: 'b1-2' });
    await createCustomProvider(h.base, { name: 'r126 B1-2 先有一个正常的' });
    const first = await getProviders(h.base);
    expect(corruptWarningFor(first.json, FILES.custom), '前提:文件正常时不该有 config-corrupt').toBeNull();
    corruptFile(cr.home, 'custom', HALF);
    const r = await getProviders(h.base);
    logWarnings('B1-2', r);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(corruptWarningFor(r.json, FILES.custom), `运行中改坏后下一次读取就该报 config-corrupt,实际 warnings=${short(r.json?.warnings)}`).not.toBeNull();
  });

  test('B1-3[半截] 损坏时 customProviders 为 [](空数组,不是缺字段、不是残缺解析结果)', async () => {
    const { h } = await bootCorrupt('b1-3-empty', '半截');
    const r = await getProviders(h.base);
    logWarnings('B1-3', r);
    expect(r.json?.customProviders, `customProviders 应为 [],实际 ${short(r.json?.customProviders)}`).toEqual([]);
  });

  test('B1-4[乱码] config-corrupt 项的 backup 指向已创建的备份:与原文件同目录、名形如 custom-providers.json.corrupt-<数字>、文件真实存在', async () => {
    const { h, p } = await bootCorrupt('b1-4-backup', '乱码');
    const r = await getProviders(h.base);
    logWarnings('B1-4', r);
    const w = corruptWarningFor(r.json, FILES.custom);
    expect(w, `前提:应有 config-corrupt 警告,实际 warnings=${short(r.json?.warnings)}`).not.toBeNull();
    expect(typeof w.backup, `backup 应是字符串路径,实际 ${short(w.backup)}`).toBe('string');
    expect(path.dirname(path.resolve(w.backup)), '备份应与原文件同目录').toBe(path.dirname(p));
    expect(path.basename(w.backup), '备份名应形如 custom-providers.json.corrupt-<数字时间戳>').toMatch(backupRe('custom'));
    expect(fs.existsSync(w.backup), `backup 指向的文件应真实存在:${w.backup}`).toBe(true);
  });

  test('B1-5[半截] config-corrupt 项带非空 message(说明文字)', async () => {
    const { h } = await bootCorrupt('b1-5-message', '半截');
    const r = await getProviders(h.base);
    const w = corruptWarningFor(r.json, FILES.custom);
    expect(w, `前提:应有 config-corrupt 警告,实际 warnings=${short(r.json?.warnings)}`).not.toBeNull();
    console.log(`[r126] B1-5 message=${JSON.stringify(w.message)}`);
    expect(typeof w.message === 'string' && w.message.trim().length > 0, `message 应是非空字符串,实际 ${short(w.message)}`).toBe(true);
  });

  test('B1-6[半截] r125 既有的 warning 字符串仍在且非空(新增 warnings 数组不替代它)', async () => {
    const { h } = await bootCorrupt('b1-6-legacy', '半截');
    const r = await getProviders(h.base);
    logWarnings('B1-6', r);
    expect(typeof r.json?.warning === 'string' && r.json.warning.trim().length > 0, `warning 应是非空字符串,实际 ${short(r.json?.warning)}`).toBe(true);
  });

  test("B1-7 全新 HOME(四个文件都不存在,cc-switch 未安装):warnings 恰好只有一条,kind:'ccswitch-missing'", async () => {
    const h = await startInstance(caseRoot('b1-7-fresh'), {}, { label: 'b1-7' });
    const r = await getProviders(h.base);
    logWarnings('B1-7', r);
    expect(Array.isArray(r.json?.warnings), `warnings 应是数组,实际 ${short(r.json?.warnings)}`).toBe(true);
    expect(r.json.warnings.map((w) => w?.kind), '未安装 cc-switch 只该有 ccswitch-missing 这一条').toEqual(['ccswitch-missing']);
  });

  test('B1-8 反向:文件正常(已建 1 个自定义 provider)→ warnings 不含 config-corrupt,customProviders 含该 provider', async () => {
    const h = await startInstance(caseRoot('b1-8-valid'), {}, { label: 'b1-8' });
    const c = await createCustomProvider(h.base, { name: 'r126 B1-8 正常' });
    const r = await getProviders(h.base);
    logWarnings('B1-8', r);
    expect(warningsOf(r.json, 'config-corrupt'), '正常文件不该报 config-corrupt').toEqual([]);
    expect((r.json?.customProviders ?? []).map((x) => x.id), '正常文件里的 provider 应读得到').toContain(c.id);
  });

  for (const key of ['models', 'active', 'image']) {
    test(`B1-9[${FILES[key]}] 该文件启动前已损坏(半截):GET /api/providers 仍 200 且 providers 含内置官方(不整体 500)`, async () => {
      const { h } = await bootCorrupt(`b1-9-${key}`, '半截', key);
      const r = await getProviders(h.base);
      logWarnings(`B1-9[${FILES[key]}]`, r);
      expect(r.status, r.text.slice(0, 200)).toBe(200);
      expect((r.json?.providers ?? []).map((p) => p.id)).toContain(OFFICIAL);
    });
  }
});

// ═══════════════════════════ B2 界面:provider 列表区的警告 ═══════════════════════════
test.describe('B2 界面警告', () => {
  test.skip(!process.env.R126_UI_BASE, '没有 dev server(R126_API_ONLY=1)');
  test.beforeEach(() => { resetFile(HOME_DIR(), 'custom'); });
  test.afterEach(() => { resetFile(HOME_DIR(), 'custom'); });

  test('B2-1[半截] 打开切换浮层 → provider-switch-list 内出现可见的 provider-list-warning', async ({ page }) => {
    corruptFile(HOME_DIR(), 'custom', HALF);
    await boot(page);
    await openProviderList(page);
    await expect(switchList(page), '浮层根锚点 provider-switch-list 应存在').toBeVisible();
    await expect(listWarningIn(switchList(page)), '浮层里应出现 [data-testid="provider-list-warning"]').toBeVisible();
  });

  test('B2-2[乱码] 切换浮层的警告文字含文件名 custom-providers.json 与「备份」二字', async ({ page }) => {
    corruptFile(HOME_DIR(), 'custom', GARBAGE);
    await boot(page);
    await openProviderList(page);
    const w = listWarningIn(switchList(page));
    await expect(w, '前提:浮层里有 provider-list-warning').toBeVisible();
    const text = await textOf(w);
    console.log(`[r126] B2-2 浮层警告文字:${text}`);
    expect(text, '应点名读不出的文件').toContain('custom-providers.json');
    expect(text, '应说明备份在哪').toContain('备份');
  });

  test('B2-3[半截] 管理页:Provider 管理弹窗内出现同锚点 provider-list-warning,文字含文件名与「备份」', async ({ page }) => {
    corruptFile(HOME_DIR(), 'custom', HALF);
    await boot(page);
    const m = await openProviderManager(page);
    const w = listWarningIn(m);
    await expect(w, '管理弹窗内应出现 [data-testid="provider-list-warning"]').toBeVisible();
    const text = await textOf(w);
    console.log(`[r126] B2-3 管理页警告文字:${text}`);
    expect(text).toContain('custom-providers.json');
    expect(text).toContain('备份');
  });

  test('B2-4 反向:文件不存在(只有 ccswitch-missing)→ 浮层已列出 ≥1 行,但 provider-list-warning 数量为 0', async ({ page }) => {
    await boot(page);
    await openProviderList(page);
    await expect.poll(() => switchRowsAny(page).count(), { message: '前提:列表至少有内置官方一行' }).toBeGreaterThanOrEqual(1);
    await settle(800);
    await expect(listWarning(page), 'cc-switch 未安装不算警告,不该出现 provider-list-warning').toHaveCount(0);
  });

  test('B2-5 反向:文件正常(有 1 个自定义 provider)→ 浮层列出该 provider,provider-list-warning 数量为 0', async ({ page }) => {
    const c = await createCustomProvider(process.env.R126_API_BASE, { name: 'r126 B2-5 正常' });
    await boot(page);
    await openProviderList(page);
    await expect(switchListAny(page).locator(`[data-provider-id="${c.id}"]`).or(switchListAny(page).getByText('r126 B2-5 正常')).first(), '前提:列表里有刚建的自定义 provider').toBeVisible();
    await settle(500);
    await expect(listWarning(page), '文件正常时不该有警告').toHaveCount(0);
  });

  test('B2-6[半截] 恢复:警告可见 → 删掉损坏文件(不重启服务端)→ 关掉再打开浮层 → 警告消失', async ({ page }) => {
    corruptFile(HOME_DIR(), 'custom', HALF);
    await boot(page);
    await openProviderList(page);
    await expect(listWarningIn(switchList(page)), '前提:先看到警告').toBeVisible();
    await closeProviderList(page);
    setFile(HOME_DIR(), 'custom', null);
    let refetched = 0;
    page.on('request', (rq) => { if (new URL(rq.url()).pathname === '/api/providers') refetched += 1; });
    await openProviderList(page);
    await settle(800);
    console.log(`[r126] B2-6 重开浮层期间页面发出的 /api/providers 请求数=${refetched}`);
    await expect(listWarning(page), '文件已删(程序可重建)后,重开浮层不该再有警告').toHaveCount(0, { timeout: 10_000 });
  });

  test.describe('手机页', () => {
    test.use(MOBILE);
    test('B2-7[半截] 手机页:菜单 →「Provider / 模型」→ provider 页里出现 provider-list-warning,文字含文件名与「备份」', async ({ page }) => {
      corruptFile(HOME_DIR(), 'custom', HALF);
      await bootMobile(page);
      await openMobileProviderPage(page);
      const w = listWarning(page);
      await expect(w.first(), '手机 provider 页应出现 [data-testid="provider-list-warning"]').toBeVisible();
      const text = await textOf(w.first());
      console.log(`[r126] B2-7 手机页警告文字:${text}`);
      expect(text).toContain('custom-providers.json');
      expect(text).toContain('备份');
    });
  });
});

// ═══════════════════════════ B3 备份:第一次读取即备份,同内容不重复 ═══════════════════════════
test.describe('B3 备份', () => {
  test.afterEach(async () => { await stopAll(); });

  for (const kind of ['半截', '乱码']) {
    test(`B3-1[${kind}] 运行中改坏 → 读之前 0 个备份 → 第一次 GET /api/providers 后同目录恰好 1 个 custom-providers.json.corrupt-<数字>,内容与损坏文件逐字节相同`, async () => {
      const cr = caseRoot(`b3-1-${kind}`);
      const h = await startInstance(cr, {}, { label: `b3-1-${kind}` });
      corruptFile(cr.home, 'custom', KINDS[kind]);
      expect(listBackups(cr.home, 'custom'), '前提:读之前没有备份').toEqual([]);
      const r = await getProviders(h.base);
      const backups = listBackups(cr.home, 'custom');
      console.log(`[r126] B3-1[${kind}] status=${r.status} 备份=${JSON.stringify(backups)}`);
      expect(backups, '第一次读取后应恰好有 1 个备份').toHaveLength(1);
      const b = readBytes(backupPaths(cr.home, 'custom')[0]);
      expect(sameBytes(b, KINDS[kind]), `备份应与损坏文件逐字节相同(备份 sha=${sha(b)},原 sha=${sha(KINDS[kind])})`).toBe(true);
    });
  }

  test('B3-2[乱码] 启动前已损坏 → 第一次 GET /api/providers 后恰好 1 个备份(启动本身若读过也只算一次)', async () => {
    const { h, home, bytes } = await bootCorrupt('b3-2-prestart', '乱码');
    await getProviders(h.base);
    const backups = listBackups(home, 'custom');
    console.log(`[r126] B3-2 备份=${JSON.stringify(backups)}`);
    expect(backups).toHaveLength(1);
    expect(sameBytes(readBytes(path.join(guiDir(home), backups[0])), bytes)).toBe(true);
  });

  test('B3-3[半截] 读取之后原损坏文件本身一个字节不动(备份是复制,不是搬走或改写)', async () => {
    const { h, p, bytes } = await bootCorrupt('b3-3-orig', '半截');
    await getProviders(h.base);
    await getProviders(h.base);
    const after = readBytes(p);
    expect(after !== null && sameBytes(after, bytes), `原文件应保持损坏原样(现 sha=${sha(after)},应=${sha(bytes)})`).toBe(true);
  });

  test('B3-4[半截] 首读之后再连续 GET /api/providers 10 次 → 备份仍只有 1 个', async () => {
    const { h, home } = await bootCorrupt('b3-4-tenreads', '半截');
    await getProviders(h.base);
    expect(listBackups(home, 'custom'), '前提:首读后有 1 个备份').toHaveLength(1);
    for (let i = 0; i < 10; i += 1) await getProviders(h.base);
    const backups = listBackups(home, 'custom');
    console.log(`[r126] B3-4 再读 10 次后备份=${JSON.stringify(backups)}`);
    expect(backups).toHaveLength(1);
  });

  test('B3-5[半截] 同一份损坏内容原样重写一遍(修改时间变、字节不变)再 GET → 备份仍只有 1 个(按内容去重,不按修改时间)', async () => {
    const { h, home, bytes } = await bootCorrupt('b3-5-samecontent', '半截');
    await getProviders(h.base);
    expect(listBackups(home, 'custom'), '前提:首读后有 1 个备份').toHaveLength(1);
    await settle(1100);
    setFile(home, 'custom', bytes);
    await getProviders(h.base);
    const backups = listBackups(home, 'custom');
    console.log(`[r126] B3-5 同内容重写后备份=${JSON.stringify(backups)}`);
    expect(backups).toHaveLength(1);
  });

  test('B3-6 半截 → 已备份 → 换成乱码再 GET → 出现第 2 个备份;新备份 = 乱码,第 1 个备份仍是半截(没被改写)', async () => {
    const { h, home } = await bootCorrupt('b3-6-second', '半截');
    await getProviders(h.base);
    const first = listBackups(home, 'custom');
    expect(first, '前提:首读后有 1 个备份').toHaveLength(1);
    await settle(1100);   // 备份名带时间戳;隔 1.1s 免得撞名 —— 本条测的是"不同内容要再备份",不是时间戳精度
    setFile(home, 'custom', GARBAGE);
    await getProviders(h.base);
    const all = listBackups(home, 'custom');
    console.log(`[r126] B3-6 换内容后备份=${JSON.stringify(all)}`);
    expect(all, '换一种损坏内容后应有 2 个备份').toHaveLength(2);
    const added = all.filter((n) => !first.includes(n));
    expect(added).toHaveLength(1);
    expect(sameBytes(readBytes(path.join(guiDir(home), added[0])), GARBAGE), '第 2 个备份应是新的损坏内容(乱码)').toBe(true);
    expect(sameBytes(readBytes(path.join(guiDir(home), first[0])), HALF), '第 1 个备份不该被改写').toBe(true);
  });

  test('B3-7[半截] 运行中改坏后 10 路并发首读 → 备份仍只有 1 个(不因并发重复备份)', async () => {
    const cr = caseRoot('b3-7-concurrent');
    const h = await startInstance(cr, {}, { label: 'b3-7' });
    corruptFile(cr.home, 'custom', HALF);
    const rs = await Promise.all(Array.from({ length: 10 }, () => getProviders(h.base)));
    const backups = listBackups(cr.home, 'custom');
    console.log(`[r126] B3-7 并发 10 读 status=${rs.map((r) => r.status).join(',')} 备份=${JSON.stringify(backups)}`);
    expect(backups).toHaveLength(1);
  });

  test('B3-8[乱码] 已有 1 个备份 → 停掉实例、同一 HOME 再起一个(文件仍损坏)→ GET 后备份仍只有 1 个', async () => {
    const cr = caseRoot('b3-8-restart');
    corruptFile(cr.home, 'custom', GARBAGE);
    const h1 = await startInstance(cr, {}, { label: 'b3-8-first' });
    await getProviders(h1.base);
    expect(listBackups(cr.home, 'custom'), '前提:第一个实例读后有 1 个备份').toHaveLength(1);
    await h1.stop();
    await settle(1100);
    const h2 = await startInstance(cr, {}, { label: 'b3-8-second' });
    await getProviders(h2.base);
    const backups = listBackups(cr.home, 'custom');
    console.log(`[r126] B3-8 重启后备份=${JSON.stringify(backups)}`);
    expect(backups, '重启不该再备份同一份损坏内容').toHaveLength(1);
  });

  const READS = {
    models: { via: 'GET /api/provider-models', fn: (base) => getProviderModels(base) },
    image: { via: 'GET /api/image-providers', fn: (base) => listImageProviders(base).then((x) => x.r) },
    active: { via: 'GET /api/providers', fn: (base) => getProviders(base) },
  };
  for (const [key, { via, fn }] of Object.entries(READS)) {
    test(`B3-9[${FILES[key]}] 启动前已损坏(半截)→ ${via} 后同目录出现 ${FILES[key]}.corrupt-<数字>,内容与损坏文件逐字节相同`, async () => {
      const { h, home, bytes } = await bootCorrupt(`b3-9-${key}`, '半截', key);
      const r = await fn(h.base);
      const backups = listBackups(home, key);
      console.log(`[r126] B3-9[${FILES[key]}] status=${r.status} 备份=${JSON.stringify(backups)}`);
      expect(backups, `${via} 之后应恰好有 1 个 ${FILES[key]} 的备份`).toHaveLength(1);
      expect(sameBytes(readBytes(path.join(guiDir(home), backups[0])), bytes), '备份应与损坏文件逐字节相同').toBe(true);
    });
  }

  test('B3-10 反向:四个文件都正常时反复读取不产生任何 *.corrupt-* 文件', async () => {
    const h = await startInstance(caseRoot('b3-10-valid'), {}, { label: 'b3-10' });
    await createCustomProvider(h.base, { name: 'r126 B3-10' });
    for (let i = 0; i < 3; i += 1) { await getProviders(h.base); await getProviderModels(h.base); await listImageProviders(h.base); }
    expect(listAnyBackups(h.home), '正常文件不该有备份').toEqual([]);
  });
});
