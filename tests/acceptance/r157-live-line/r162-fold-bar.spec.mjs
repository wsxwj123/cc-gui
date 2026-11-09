// r162:折叠行(工作组头行)去掉左侧灰条,对齐 Claude 桌面版——折叠行直接贴着正文左缘,默认收起,点一下直接展开。
// 只看页面上看得见的东西(锚点 [data-work-group] / [data-work-group-head] / [data-entry-state] 与 getComputedStyle / getBoundingClientRect),
// 不读源码、不读 React state。夹具:本套件的会话 b1,历史回合里自带一个「思考 + 一次 Bash + 正文」的工作组。
//   F1 工作组里没有竖条状的左边框(外框与任何后代都没有);
//   F2 收起时,头行图标的左缘与紧跟着的正文文字左缘对齐(±2px,口径与界面缩放无关:两者同一坐标系);
//   F3 默认收起(aria-expanded=false),点一下头行直接展开(aria-expanded=true、条目可见),再点一下收起。
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';
import { primeOverlays, openApp, openSessionByMarker, resetCtl } from './helpers/runtime.mjs';

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

  // F1 没有竖条状的左边框:边框宽 > 0、样式不是 none、元素又高又窄(高 ≥ 20px 且高 > 3 倍宽)
  const bars = await group.evaluate((g) => {
    const out = [];
    for (const el of [g, ...g.querySelectorAll('*')]) {
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      const bw = parseFloat(cs.borderLeftWidth) || 0;
      if (bw > 0 && cs.borderLeftStyle !== 'none' && r.height >= 20 && r.height > r.width * 3) {
        out.push(`${el.tagName.toLowerCase()}[${String(el.className || '').slice(0, 50)}] 左边框 ${bw}px 高 ${r.height.toFixed(0)} 宽 ${r.width.toFixed(0)}`);
      }
    }
    return out;
  });
  expect(bars, `F1 工作组里不应有竖条状的左边框(找到 ${bars.length} 个)`).toEqual([]);
  const groupBorder = await group.evaluate((g) => getComputedStyle(g).borderLeftWidth);
  expect(parseFloat(groupBorder), `F1 工作组外框的左边框宽应为 0(实际 ${groupBorder})`).toBe(0);

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

  // F3(二)点一下直接展开,条目看得见;再点一下收起
  await head.click();
  await expect(head, 'F3 点一下头行应展开').toHaveAttribute('aria-expanded', 'true');
  await expect(group.locator('[data-entry-state]').first(), 'F3 展开后应看到组内条目').toBeVisible({ timeout: 10_000 });
  await head.click();
  await expect(head, 'F3 再点一下应收起').toHaveAttribute('aria-expanded', 'false');
});
