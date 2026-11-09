// r162:折叠行(工作组头行)去掉左侧灰条,对齐 Claude 桌面版——折叠行直接贴着正文左缘,默认收起,点一下直接展开。
// 只看页面上看得见的东西(锚点 [data-work-group] / [data-work-group-head] / [data-entry-state] 与 getComputedStyle / getBoundingClientRect),
// 不读源码、不读 React state。夹具:本套件的会话 b1,历史回合里自带一个「思考 + 一次 Bash + 正文」的工作组。
//   F1 工作组里没有「只有左边一条边框」的元素(= 灰条):收起、展开、展开思考内容三个状态各查一遍;外框的左边框宽为 0;
//      (整圈都有边框的工具卡不算灰条,所以只认「左边有、上右下都没有」的元素);
//   F2 收起时,头行图标的左缘与紧跟着的正文文字左缘对齐(±2px,两者同一坐标系,与界面缩放无关);
//   F3 行为守卫(不鉴别新旧,新旧代码都应过):默认收起(aria-expanded=false),点一下头行直接展开(aria-expanded=true、条目可见),再点收起。
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';
import { primeOverlays, openApp, openSessionByMarker, resetCtl } from './helpers/runtime.mjs';

/** 组内(含外框自己)「只有左边一条边框」的元素:左边框宽 > 0 且样式不是 none,上 / 右 / 下三边的边框宽都是 0,且有高度。 */
async function leftOnlyBorders(group) {
  return await group.evaluate((g) => {
    const out = [];
    for (const el of [g, ...g.querySelectorAll('*')]) {
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      const w = (p) => parseFloat(cs[p]) || 0;
      if (w('borderLeftWidth') > 0 && cs.borderLeftStyle !== 'none'
        && w('borderTopWidth') === 0 && w('borderRightWidth') === 0 && w('borderBottomWidth') === 0 && r.height >= 8) {
        out.push(`${el.tagName.toLowerCase()}[${String(el.className || '').slice(0, 60)}] 左边框 ${w('borderLeftWidth')}px 高 ${r.height.toFixed(0)}`);
      }
    }
    return out;
  });
}

test('F1–F3 折叠行:没有左侧灰条、与正文左缘对齐、默认收起点一下就展开', async ({ page }) => {
  test.setTimeout(90_000);
  resetCtl();
  await primeOverlays(page, {});
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.b1.marker);
  const group = page.locator('[data-work-group]').first();
  await expect(group, '前置:夹具会话 b1 的历史回合里应有一个工作组').toBeVisible({ timeout: 20_000 });
  const head = group.locator('[data-work-group-head]');
  await expect(head, 'F3 前置:工作组头行应在').toBeVisible();

  // F3(一)默认收起
  await expect(head, 'F3 默认应收起(aria-expanded=false)').toHaveAttribute('aria-expanded', 'false');

  // F1(一)收起状态:外框左边框宽为 0,组内没有只有左边的边框
  const groupBorder = await group.evaluate((g) => getComputedStyle(g).borderLeftWidth);
  expect(parseFloat(groupBorder), `F1 工作组外框的左边框宽应为 0(实际 ${groupBorder})`).toBe(0);
  let bars = await leftOnlyBorders(group);
  expect(bars, `F1 收起状态:组内不应有只有左边一条边框的元素(找到 ${bars.length} 个:${bars.join(' | ')})`).toEqual([]);

  // F2 头行图标左缘 = 紧跟着的正文文字左缘(±2px)
  const icon = head.locator('svg').first();
  const iconBox = await icon.boundingBox();
  expect(iconBox, 'F2 前置:头行里应有图标').not.toBeNull();
  const text = group.locator('xpath=following::*[contains(concat(" ", normalize-space(@class), " "), " markdown-content ")][1]');
  await expect(text, 'F2 前置:工作组后面应跟着一段正文').toBeVisible();
  const textBox = await text.boundingBox();
  expect(textBox, 'F2 前置:正文应有矩形').not.toBeNull();
  const dx = Math.abs(iconBox.x - textBox.x);
  expect(dx, `F2 头行图标左缘 ${iconBox.x.toFixed(1)} 与正文左缘 ${textBox.x.toFixed(1)} 应对齐(±2px),差 ${dx.toFixed(1)}px`).toBeLessThanOrEqual(2);

  // F3(二)点一下直接展开,条目看得见
  await head.click();
  await expect(head, 'F3 点一下头行应展开').toHaveAttribute('aria-expanded', 'true');
  await expect(group.locator('[data-entry-state]').first(), 'F3 展开后应看到组内条目').toBeVisible({ timeout: 10_000 });

  // F1(二)展开状态
  bars = await leftOnlyBorders(group);
  expect(bars, `F1 展开状态:组内不应有只有左边一条边框的元素(找到 ${bars.length} 个:${bars.join(' | ')})`).toEqual([]);

  // F1(三)再展开组内的「已思考」折叠行,思考内容那块也不应有左边灰条
  const thinkingFold = group.getByRole('button', { name: /已思考/ }).first();
  await expect(thinkingFold, 'F1 前置:展开后组内应有「已思考」折叠行').toBeVisible({ timeout: 10_000 });
  await thinkingFold.click();
  await expect(thinkingFold, 'F1 点一下「已思考」折叠行应展开').toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(300);
  bars = await leftOnlyBorders(group);
  expect(bars, `F1 展开思考内容后:组内不应有只有左边一条边框的元素(找到 ${bars.length} 个:${bars.join(' | ')})`).toEqual([]);

  // F3(三)头行再点一下收起
  await head.click();
  await expect(head, 'F3 再点一下应收起').toHaveAttribute('aria-expanded', 'false');
});
