// r124 界面层验收(INTERFACE §C3/§C4 的界面口径 + 用户原场景):导入区那颗按钮的文字与 0 个技能时的提示。
// 依据只有 .devflow/BRIEF-r124.md 与 .devflow/INTERFACE-r124.md;没看实现代码。
// 跑在 run.sh 起的共享隔离实例 + dev server 上;各条用例只碰互不重叠的仓库/技能 id,顺序无关。
//   e2e 条:页面 → 共享实例 → 本地假 GitHub(端到端);
//   mock 条:浏览器侧直接喂 official 的响应,把前端"按 count/installed 决定文案"的逻辑单独判(也是选择器的自证)。
import { test, expect } from '@playwright/test';
import * as ui from './helpers/ui.mjs';

const ALL_INSTALLED = '此源已全部安装';
const importAll = (n) => `一键导入全部(${n})`;

/** 共享实例上导入若干技能(前置);失败就把原因写进断言信息。 */
async function importOnShared(repo, ids) {
  const r = await ui.api('POST', '/api/skills/import', { repo, ids });
  expect(r.status, `前置:向共享实例导入 ${repo} 的 ${ids.join(',')} 应成功,实际:${r.text.slice(0, 300)}`).toBe(200);
  expect(r.json?.imported ?? [], `前置:应导入 ${ids.join(',')}`).toEqual(expect.arrayContaining(ids));
}

test.describe('C3 界面:0 个技能不说"全部已装"', () => {
  test('C3-ui(e2e) 拉取 acme/no-skills:不出现「此源已全部安装」,出现含「没有找到技能」「SKILL.md」的提示', async ({ page }) => {
    await ui.boot(page);
    await ui.openMarketPanel(page);
    const json = await ui.fetchRepo(page, 'acme/no-skills');
    const text = await ui.marketText(page);
    expect(text, `official 返回:${JSON.stringify(json).slice(0, 200)};市场页文本:${text.slice(-400)}`).not.toContain(ALL_INSTALLED);
    expect(text, `应明说没找到技能;市场页文本:${text.slice(-400)}`).toMatch(/没有找到技能/);
    expect(text, '提示里应点名 SKILL.md').toMatch(/SKILL\.md/);
  });

  test('C3-ui(mock) 前端拿到 count 0:不出现「此源已全部安装」,出现「没有找到技能」+「SKILL.md」', async ({ page }) => {
    await ui.boot(page);
    await ui.mockOfficial(page, ui.officialPayload('acme/no-skills', []));
    await ui.openMarketPanel(page);
    await ui.fetchRepo(page, 'acme/no-skills');
    const text = await ui.marketText(page);
    expect(text, `市场页文本:${text.slice(-400)}`).not.toContain(ALL_INSTALLED);
    expect(text, `市场页文本:${text.slice(-400)}`).toMatch(/没有找到技能/);
    expect(text).toMatch(/SKILL\.md/);
  });
});

test.describe('C4 界面:技能数 > 0 时导入区文案照旧', () => {
  test('C4-a(e2e) acme/two-skills 两个都装了 → 导入区写「此源已全部安装」(逐字)', async ({ page }) => {
    await importOnShared('acme/two-skills', ['alpha', 'beta']);
    await ui.boot(page);
    await ui.openMarketPanel(page);
    const json = await ui.fetchRepo(page, 'acme/two-skills');
    expect(await ui.importButtonText(page), `official 返回:${JSON.stringify(json).slice(0, 200)}`).toBe(ALL_INSTALLED);
    expect(await ui.filterCounts(page)).toMatchObject({ 全部: 2, 已安装: 2, 未安装: 0 });
  });

  test('C4-b(e2e) acme/two-skills-b 只装了 gamma → 导入区写「一键导入全部(1)」', async ({ page }) => {
    await importOnShared('acme/two-skills-b', ['gamma']);
    await ui.boot(page);
    await ui.openMarketPanel(page);
    const json = await ui.fetchRepo(page, 'acme/two-skills-b');
    expect(await ui.importButtonText(page), `official 返回:${JSON.stringify(json).slice(0, 200)}`).toBe(importAll(1));
    expect(await ui.filterCounts(page)).toMatchObject({ 全部: 2, 已安装: 1, 未安装: 1 });
  });

  test('C4-c(e2e) acme/mixed 一个都没装 → 「一键导入全部(2)」,不是「此源已全部安装」', async ({ page }) => {
    await ui.boot(page);
    await ui.openMarketPanel(page);
    const json = await ui.fetchRepo(page, 'acme/mixed');
    const btn = await ui.importButtonText(page);
    expect(btn, `official 返回:${JSON.stringify(json).slice(0, 200)}`).toBe(importAll(2));
    expect(btn).not.toBe(ALL_INSTALLED);
  });

  test('C4-d(mock) 前端拿到 2 个、都 installed → 「此源已全部安装」(既有行为自证)', async ({ page }) => {
    await ui.boot(page);
    await ui.mockOfficial(page, ui.officialPayload('acme/two-skills', [ui.skillItem('alpha', '技能甲', true), ui.skillItem('beta', '技能乙', true)]));
    await ui.openMarketPanel(page);
    await ui.fetchRepo(page, 'acme/two-skills');
    expect(await ui.importButtonText(page)).toBe(ALL_INSTALLED);
  });

  test('C4-e(mock) 前端拿到 2 个、装了 1 个 → 「一键导入全部(1)」(既有行为自证)', async ({ page }) => {
    await ui.boot(page);
    await ui.mockOfficial(page, ui.officialPayload('acme/two-skills', [ui.skillItem('alpha', '技能甲', true), ui.skillItem('beta', '技能乙', false)]));
    await ui.openMarketPanel(page);
    await ui.fetchRepo(page, 'acme/two-skills');
    expect(await ui.importButtonText(page)).toBe(importAll(1));
  });
});

test.describe('C1 界面:用户原场景', () => {
  test('C1-ui(e2e) 拉取根目录单技能仓库 acme/solo-skill:列出 solo-skill,按钮写「一键导入全部(1)」而不是「此源已全部安装」', async ({ page }) => {
    await ui.boot(page);
    await ui.openMarketPanel(page);
    const json = await ui.fetchRepo(page, 'acme/solo-skill');
    const text = await ui.marketText(page);
    // 注意:页头本来就会写「仓库:acme/solo-skill」,所以不能拿 'solo-skill' 字样当"列出来了"的证据;
    // 要看技能卡片自己的内容(描述 + 版本)。
    expect(text, `应列出根目录那份 SKILL.md 描述的技能;official 返回:${JSON.stringify(json).slice(0, 200)};市场页文本:${text.slice(-400)}`).toContain('单技能仓库');
    expect(text, '技能卡片应带版本 v1.2.0').toMatch(/v1\.2\.0/);
    expect(await ui.filterCounts(page), '筛选片应显示 全部1 / 未安装1').toMatchObject({ 全部: 1, 未安装: 1 });
    const btn = await ui.importButtonText(page);
    expect(btn).not.toBe(ALL_INSTALLED);
    expect(btn).toBe(importAll(1));
  });
});
