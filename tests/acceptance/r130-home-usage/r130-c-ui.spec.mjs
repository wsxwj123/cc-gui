// r130 · C 组:单屏首页的用量总览 + 热力图(INTERFACE §C)。webkit 1440×900;/api/usage 一律 page.route 打桩(每条用例自己的载荷,互不共享),
// 只有 C12 用隔离实例的真数据。依据只有 BRIEF/INTERFACE-r130;没看实现代码。「修前」= 首页没有 home-usage → 本组全红。
import { test, expect } from '@playwright/test';
import { gotoHome, stubUsage, payload, dayEntry, sum4, fmtTokens, fmtInt, levelFn, CARD_KEYS, TEXT, home, greeting, homeInput, usage, cards, card, cardValue,
  heatmap, cells, futureCells, cellOf, tip, state, cellGeometry, setPaneCount, readUiExpected, today, dayAgo, mondayIndex, dayShift, UI_BASE,
  snapshotVisible, findPopup, measureBox, fmtBox, fmtOver, describeMeasure } from './helpers/ui.mjs';

/** 典型载荷:最近 7 周内 8 个活跃天(tokens 两两不同),另有一天 tokens=0 但有消息。 */
const ACTIVE = [1, 2, 3, 5, 8, 13, 21, 34].map((n, i) => [dayAgo(n), (i + 1) * 1000 + i]);
const typical = () => payload({ byDay: [...ACTIVE.map(([d, t]) => dayEntry(d, t)), dayEntry(dayAgo(40), 0, { calls: 0 })] });
const domOrder = (page, a, b) => page.evaluate(([sa, sb]) => { const x = document.querySelector(sa); const y = document.querySelector(sb); return x && y ? Boolean(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING) : null; }, [a, b]);
async function bootWith(page, body) { const s = body === null ? null : await stubUsage(page, body); await gotoHome(page); await expect(usage(page), '首页应渲染 home-usage 容器').toBeVisible({ timeout: 8000 }); return s; }

// ───────────── 布局 ─────────────
test('C1a 单屏首页 DOM 顺序:招呼 h2 → home-usage → home-input(compareDocumentPosition)', async ({ page }) => {
  await bootWith(page, typical());
  expect(await domOrder(page, 'h2[data-cgui="home-greeting"]', '[data-testid="home-usage"]'), '招呼在用量图之前').toBe(true);
  expect(await domOrder(page, '[data-testid="home-usage"]', 'textarea[data-testid="home-input"]'), '用量图在输入框之前').toBe(true);
});
test('C1b 单屏首页 boundingBox:greeting.y < usage.y < input.y', async ({ page }) => {
  await bootWith(page, typical());
  const g = await greeting(page).boundingBox(); const u = await usage(page).boundingBox(); const i = await homeInput(page).boundingBox();
  expect(g && u && i, '三者都应可见').toBeTruthy();
  expect(g.y).toBeLessThan(u.y);
  expect(u.y).toBeLessThan(i.y);
});
test('C1c 输入框移到底部:home-input 底边 ≥ [data-cgui=home] 高度的 70%', async ({ page }) => {
  await bootWith(page, typical());
  const h = await home(page).boundingBox(); const i = await homeInput(page).boundingBox();
  expect((i.y + i.height - h.y) / h.height, `输入框底边相对 home 高度的比例`).toBeGreaterThanOrEqual(0.7);
});
test('C1d home-usage 只在 [data-cgui=home] 内出现且全页只有一个', async ({ page }) => {
  await bootWith(page, typical());
  await expect(page.locator('[data-cgui="home"] [data-testid="home-usage"]')).toHaveCount(1);
  await expect(usage(page)).toHaveCount(1);
});

// ───────────── 分屏 ─────────────
test('C2a 切到分屏(pane-count-2)后 ≤2 s 所有窗格 home-usage 计数为 0,不刷新页面', async ({ page }) => {
  await bootWith(page, typical());
  const nav0 = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  await setPaneCount(page, 2);
  await expect(usage(page)).toHaveCount(0, { timeout: 2000 });
  expect(await home(page).count(), '分屏后至少还有一个首页窗格(前提;探路实测分屏后只有 1 个 home,见 TEST-PLAN 判据说明 7)').toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length), '不该刷新').toBe(nav0);
});
test('C2b 分屏首页逐字维持现状:[data-cgui=home] 与其直接子元素的 className', async ({ page }) => {
  await bootWith(page, typical());
  await setPaneCount(page, 2);
  await expect(usage(page)).toHaveCount(0, { timeout: 2000 });
  const classes = await page.evaluate(() => [...document.querySelectorAll('[data-cgui="home"]')].map((h) => [h.className, h.firstElementChild?.className ?? null]));
  expect(classes.length, '分屏后至少还有一个首页窗格(前提;探路实测只有 1 个,不强求 2 个)').toBeGreaterThanOrEqual(1);
  for (const [outer, inner] of classes) {
    expect(outer).toBe('flex-1 flex items-center justify-center px-6');
    expect(inner).toBe('w-full max-w-[560px] flex flex-col items-center');
  }
});
test('C2c 从分屏切回单屏(pane-count-1)后 ≤2 s home-usage 重现', async ({ page }) => {
  await bootWith(page, typical());
  await setPaneCount(page, 2);
  await expect(usage(page)).toHaveCount(0, { timeout: 2000 });
  await setPaneCount(page, 1);
  await expect(usage(page)).toHaveCount(1, { timeout: 2000 });
  await expect(cards(page)).toBeVisible();
});

// ───────────── 八卡 ─────────────
test('C3a 八卡 testid 顺序 = sessions, messages, tokens, active-days, current-streak, longest-streak, peak-hour, favorite-model', async ({ page }) => {
  await bootWith(page, typical());
  const ids = await cards(page).evaluate((el) => [...el.querySelectorAll('[data-testid^="home-usage-card-"]')].map((e) => e.getAttribute('data-testid')));
  expect(ids).toEqual(CARD_KEYS.map((k) => `home-usage-card-${k}`));
});
test('C3b 各卡 data-value 与显示文本(典型值:12 / 1,234 / 6.3K / 7 / 3 / 5 / 8 时 / claude-opus-4-1)', async ({ page }) => {
  await bootWith(page, typical());
  const want = { sessions: ['12', '12'], messages: ['1234', '1,234'], tokens: ['6300', '6.3K'], 'active-days': ['7', '7'], 'current-streak': ['3', '3'], 'longest-streak': ['5', '5'], 'peak-hour': ['8', '8 时'], 'favorite-model': ['claude-opus-4-1-20250805', 'claude-opus-4-1'] };
  const wrong = [];
  for (const k of CARD_KEYS) { const v = await cardValue(page, k); const [dv, text] = want[k]; if (v.dataValue !== dv || v.text !== text) wrong.push(`${k}: data-value=${JSON.stringify(v.dataValue)} 文本=${JSON.stringify(v.text)}(期望 ${dv} / ${text})`); }
  expect(wrong, wrong.join('\n')).toEqual([]);
});
for (const [n, text] of [[999, '999'], [1500, '1.5K'], [2_500_000, '2.5M'], [1_200_000_000, '1.2B']]) {
  test(`C3c tokens 缩写:${n} → 「${text}」`, async ({ page }) => {
    await bootWith(page, payload({ total: { input: n, output: 0, cacheRead: 0, cacheWrite: 0 }, byDay: [dayEntry(dayAgo(1), n)] }));
    const v = await cardValue(page, 'tokens');
    expect(v.text).toBe(text);
    expect(v.dataValue).toBe(String(n));
  });
}
test('C3d 值为 0 或 null 的卡显示「—」(含 current-streak=0);data-value 数字 0 → "0",null → 空串', async ({ page }) => {
  await bootWith(page, payload({ total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessionCount: 0 }, byDay: [dayEntry(dayAgo(1), 0)],
    overview: { messages: 0, activeDays: 0, firstDay: null, lastActiveDay: null, currentStreak: 0, longestStreak: 0, hourCounts: Array(24).fill(0), peakHour: null, favoriteModel: null } }));
  const wantDv = { sessions: '0', messages: '0', tokens: '0', 'active-days': '0', 'current-streak': '0', 'longest-streak': '0', 'peak-hour': '', 'favorite-model': '' };
  const wrong = [];
  for (const k of CARD_KEYS) { const v = await cardValue(page, k); if (v.text !== '—' || v.dataValue !== wantDv[k]) wrong.push(`${k}: 文本=${JSON.stringify(v.text)} data-value=${JSON.stringify(v.dataValue)}(期望 — / ${JSON.stringify(wantDv[k])})`); }
  expect(wrong, wrong.join('\n')).toEqual([]);
});
test('C3e 响应缺 overview(旧缓存回放):七张 overview 卡显示「—」且 data-value 空串,sessions 卡仍有数', async ({ page }) => {
  await bootWith(page, payload({ overview: null, byDay: [dayEntry(dayAgo(1), 500)] }));
  expect((await cardValue(page, 'sessions')).text).toBe('12');
  const wrong = [];
  for (const k of CARD_KEYS.filter((x) => x !== 'sessions' && x !== 'tokens')) { const v = await cardValue(page, k); if (v.text !== '—' || v.dataValue !== '') wrong.push(`${k}: 文本=${JSON.stringify(v.text)} data-value=${JSON.stringify(v.dataValue)}`); }
  expect(wrong, wrong.join('\n')).toEqual([]);
});
test('C3f current-streak 显示规则:lastActiveDay 是前天 → 显示「—」;是昨天 → 显示 currentStreak', async ({ page }) => {
  await bootWith(page, payload({ overview: { lastActiveDay: dayAgo(2), currentStreak: 4 }, byDay: [dayEntry(dayAgo(2), 500)] }));
  expect((await cardValue(page, 'current-streak')).text, '前端本地看 lastActiveDay 既不是今天也不是昨天 → 按 0 显示').toBe('—');
});
test('C3f2 current-streak 显示规则:lastActiveDay 是昨天 → 显示 currentStreak 原值', async ({ page }) => {
  await bootWith(page, payload({ overview: { lastActiveDay: dayAgo(1), currentStreak: 4 }, byDay: [dayEntry(dayAgo(1), 500)] }));
  expect((await cardValue(page, 'current-streak')).text).toBe('4');
});
test('C3g favorite-model 去掉 [..] 段与结尾 -8 位日期:claude-opus-4-1-20250805[1m] → claude-opus-4-1;data-value 保留原始 id', async ({ page }) => {
  await bootWith(page, payload({ overview: { favoriteModel: 'claude-opus-4-1-20250805[1m]' }, byDay: [dayEntry(dayAgo(1), 500)] }));
  const v = await cardValue(page, 'favorite-model');
  expect(v.text).toBe('claude-opus-4-1');
  expect(v.dataValue).toBe('claude-opus-4-1-20250805[1m]');
});
test('C3h 卡片值元素带 truncate 且 title = 完整显示文本(messages 卡「1,234」)', async ({ page }) => {
  await bootWith(page, typical());
  const v = await cardValue(page, 'messages');
  expect(v.title).toBe('1,234');
  expect(v.truncate).toBe(true);
});
test('C3i peak-hour 是"0 → —"的唯一例外:peakHour=0(凌晨 0 时)显示「0 时」且 data-value="0"(INTERFACE 2026-09-28 修订)', async ({ page }) => {
  await bootWith(page, payload({ overview: { peakHour: 0 }, byDay: [dayEntry(dayAgo(1), 500)] }));
  const v = await cardValue(page, 'peak-hour');
  expect(v.text).toBe('0 时');
  expect(v.dataValue).toBe('0');
});
test('C3i2 peak-hour 为 null → 「—」且 data-value 空串(C3d 也覆盖,这里单独定位)', async ({ page }) => {
  await bootWith(page, payload({ overview: { peakHour: null }, byDay: [dayEntry(dayAgo(1), 500)] }));
  const v = await cardValue(page, 'peak-hour');
  expect(v.text).toBe('—');
  expect(v.dataValue).toBe('');
});

// ───────────── 热力图 ─────────────
const gridCount = async (page) => (await cells(page).count()) + (await futureCells(page).count());
test('C4a 1440 宽:data-weeks 在 8–53 且 ≥ 12;格子总数 = 7×weeks', async ({ page }) => {
  await bootWith(page, typical());
  const w = Number(await heatmap(page).getAttribute('data-weeks'));
  expect(w).toBeGreaterThanOrEqual(12);
  expect(w).toBeLessThanOrEqual(53);
  expect(await gridCount(page)).toBe(7 * w);
});
test('C4b 375 宽:data-weeks ≥ 8 且 ≤ 53;格子总数 = 7×weeks', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await bootWith(page, typical());
  const w = Number(await heatmap(page).getAttribute('data-weeks'));
  expect(w).toBeGreaterThanOrEqual(8);
  expect(w).toBeLessThanOrEqual(53);
  expect(await gridCount(page)).toBe(7 * w);
});
test('C4c 行 = 周一(上)到周日(下)、列 = 周:按 boundingBox 归组,每格行号 = 星期索引,列的周一逐列 +7 天且最右列 = 本周', async ({ page }) => {
  await bootWith(page, typical());
  const g = await cellGeometry(page);
  expect(g.rows, '应恰好 7 行').toBe(7);
  expect(g.cols, '列数 = data-weeks').toBe(Number(g.weeks));
  const wrongRow = g.items.filter((i) => !i.future && i.row !== mondayIndex(i.day)).map((i) => `${i.day} 在第 ${i.row} 行(星期索引 ${mondayIndex(i.day)})`);
  expect(wrongRow, `行号不对:${wrongRow.slice(0, 5).join(';')}`).toEqual([]);
  const thisMonday = dayShift(today(), -mondayIndex(today()));
  const wrongCol = g.items.filter((i) => !i.future).filter((i) => dayShift(i.day, -mondayIndex(i.day)) !== dayShift(thisMonday, -7 * (g.cols - 1 - i.col))).map((i) => `${i.day} 在第 ${i.col} 列`);
  expect(wrongCol, `列号不对:${wrongCol.slice(0, 5).join(';')}`).toEqual([]);
});
test('C4d 最右列含今天:data-today="1" 的格 data-day = 今天且只有一个;今天之后的格是 future(无 data-day),数量 = 6 - 今天的周一索引', async ({ page }) => {
  await bootWith(page, typical());
  const g = await cellGeometry(page);
  const todays = g.items.filter((i) => i.today === '1');
  expect(todays.map((i) => i.day)).toEqual([today()]);
  expect(todays[0].col).toBe(g.cols - 1);
  const fut = g.items.filter((i) => i.future);
  expect(fut.length).toBe(6 - mondayIndex(today()));
  expect(fut.every((i) => i.day === null && i.col === g.cols - 1 && i.row > todays[0].row), 'future 格无 data-day 且都在今天之后').toBe(true);
});
test('C4e data-tokens:byDay 有的天 = 四项合计(100+20+300+40=460);没有的天 = 0', async ({ page }) => {
  await bootWith(page, payload({ byDay: [dayEntry(dayAgo(3), 0, { input: 100, output: 20, cacheRead: 300, cacheWrite: 40 })] }));
  await expect(cellOf(page, dayAgo(3))).toHaveAttribute('data-tokens', '460');
  await expect(cellOf(page, dayAgo(4))).toHaveAttribute('data-tokens', '0');
});
test('C4f data-level 分级:8 个活跃天 tokens 两两不同 → 每格 = 分位公式的结果(最大的那天为 4 级,tokens=0 的天为 0 级)', async ({ page }) => {
  await bootWith(page, typical());
  const lv = levelFn(ACTIVE.map(([, t]) => t));
  const wrong = [];
  for (const [d, t] of ACTIVE) { const got = await cellOf(page, d).getAttribute('data-level'); if (got !== String(lv(t))) wrong.push(`${d}(${t}) 期望 ${lv(t)} 实际 ${got}`); }
  expect(wrong, wrong.join(';')).toEqual([]);
  await expect(cellOf(page, ACTIVE[7][0]), '最大的一天应是 4 级').toHaveAttribute('data-level', '4');
  await expect(cellOf(page, dayAgo(40)), 'tokens=0 的天为 0 级').toHaveAttribute('data-level', '0');
  await expect(cellOf(page, dayAgo(4)), '无记录的天为 0 级').toHaveAttribute('data-level', '0');
});
test('C4g 只有 4 个活跃天:没有任何 4 级格,最深为 3 级', async ({ page }) => {
  const four = [[dayAgo(2), 100], [dayAgo(6), 200], [dayAgo(9), 300], [dayAgo(15), 400]];
  await bootWith(page, payload({ byDay: four.map(([d, t]) => dayEntry(d, t)) }));
  expect(await page.locator('[data-testid="home-usage-cell"][data-level="4"]').count()).toBe(0);
  await expect(cellOf(page, dayAgo(15))).toHaveAttribute('data-level', '3');
  await expect(cellOf(page, dayAgo(2))).toHaveAttribute('data-level', '1');
});
test("C4h 'unknown' 行与未来日的行不进热力图:没有 data-day=unknown 的格,未来日没有 data-day 格,所有 data-day ≤ 今天", async ({ page }) => {
  await bootWith(page, payload({ byDay: [dayEntry('unknown', 9_000_000), dayEntry(dayAgo(-3), 8_000_000), dayEntry(dayAgo(1), 100)] }));
  expect(await page.locator('[data-testid="home-usage-cell"][data-day="unknown"]').count()).toBe(0);
  expect(await cellOf(page, dayAgo(-3)).count()).toBe(0);
  const days = await cells(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-day')));
  expect(days.every((d) => d && d <= today()), '所有 data-day 都不晚于今天').toBe(true);
});
test('C4i 1440 宽:home-usage-cards 的 data-cols = 4', async ({ page }) => {
  await bootWith(page, typical());
  await expect(cards(page)).toHaveAttribute('data-cols', '4');
});
test('C4j 375 宽(容器 < 480):home-usage-cards 的 data-cols = 2', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await bootWith(page, typical());
  await expect(cards(page)).toHaveAttribute('data-cols', '2');
});

// ───────────── 浮层 ─────────────
const [HDAY, HTOK] = ACTIVE[4];
const away = (page) => page.mouse.move(2, 2);
test('C5a 鼠标悬停有记录的格 → 浮层 role=tooltip 在热力图内,文案「YYYY-MM-DD · N tokens」逐字(千分位)', async ({ page }) => {
  await bootWith(page, typical());
  await cellOf(page, HDAY).hover();
  await expect(tip(page)).toBeVisible();
  await expect(tip(page)).toHaveText(`${HDAY} · ${fmtInt(HTOK)} tokens`);
  await expect(tip(page)).toHaveAttribute('role', 'tooltip');
  await expect(heatmap(page).locator('[data-testid="home-usage-tip"]')).toHaveCount(1);
});
test('C5b 悬停没有记录的天 → 「YYYY-MM-DD · 无记录」', async ({ page }) => {
  await bootWith(page, typical());
  await cellOf(page, dayAgo(4)).hover();
  await expect(tip(page)).toHaveText(`${dayAgo(4)} · ${TEXT.noRecord}`);
});
test('C5c 鼠标移出格子(未钉住)→ 浮层隐藏', async ({ page }) => {
  await bootWith(page, typical());
  await cellOf(page, HDAY).hover();
  await expect(tip(page)).toBeVisible();
  await away(page);
  await expect(tip(page)).toBeHidden();
});
test('C5d 点击格子钉住 → 鼠标移开仍显示', async ({ page }) => {
  await bootWith(page, typical());
  await cellOf(page, HDAY).click();
  await expect(tip(page)).toBeVisible();
  await away(page);
  await page.waitForTimeout(400);
  await expect(tip(page)).toBeVisible();
  await expect(tip(page)).toHaveText(`${HDAY} · ${fmtInt(HTOK)} tokens`);
});
test('C5e 钉住后点热力图外(招呼文本)→ 浮层隐藏', async ({ page }) => {
  await bootWith(page, typical());
  await cellOf(page, HDAY).click();
  await expect(tip(page)).toBeVisible();
  await greeting(page).click();
  await expect(tip(page)).toBeHidden();
});
test('C5f 钉住后按 Escape → 浮层隐藏', async ({ page }) => {
  await bootWith(page, typical());
  await cellOf(page, HDAY).click();
  await expect(tip(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip(page)).toBeHidden();
});
test('C5g 同一时刻最多一个浮层:先悬停 A 再悬停 B → 只有 1 个且文案是 B', async ({ page }) => {
  await bootWith(page, typical());
  await cellOf(page, ACTIVE[2][0]).hover();
  await expect(tip(page)).toBeVisible();
  await cellOf(page, ACTIVE[5][0]).hover();
  await expect(tip(page)).toHaveCount(1);
  await expect(tip(page)).toHaveText(`${ACTIVE[5][0]} · ${fmtInt(ACTIVE[5][1])} tokens`);
});
test('C5h 触屏上下文(hasTouch, 375×812):tap 格子 → 由 click 显示浮层', async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 375, height: 812 }, baseURL: UI_BASE, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await ctx.newPage();
  try {
    await bootWith(page, typical());
    await cellOf(page, HDAY).tap();
    await expect(tip(page)).toBeVisible();
    await expect(tip(page)).toHaveText(`${HDAY} · ${fmtInt(HTOK)} tokens`);
  } finally { await ctx.close(); }
});
test('C5i 格子不设原生 title(提示只走浮层)', async ({ page }) => {
  await bootWith(page, typical());
  const g = await cellGeometry(page);
  expect(g.items.filter((i) => i.title !== null).length).toBe(0);
});

// ───────────── 窄屏 ─────────────
for (const [w, h] of [[375, 812], [375, 430]]) {
  test(`C6 ${w}×${h}:整页不滚、不横滚,home-input 在视口内`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await bootWith(page, typical());
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight }));
    expect(m.sw, '不横滚').toBeLessThanOrEqual(m.iw);
    expect(m.sh, '整页不滚').toBeLessThanOrEqual(m.ih);
    await expect(homeInput(page)).toBeInViewport();
    const b = await homeInput(page).boundingBox();
    expect(b.y >= 0 && b.y + b.height <= h, `输入框 y=${b.y} h=${b.height} 应完整落在 ${h} 高的视口内`).toBe(true);
  });
}

// ───────────── 空态 / 加载 / 错误 ─────────────
const ZERO_OV = { messages: 0, activeDays: 0, firstDay: null, lastActiveDay: null, currentStreak: 0, longestStreak: 0, hourCounts: Array(24).fill(0), peakHour: null, favoriteModel: null };
test('C7a 空态:sessionCount=0 且 byDay 为空 → home-usage-empty「还没有用量记录」,不渲染卡片与热力图', async ({ page }) => {
  await bootWith(page, payload({ total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessionCount: 0 }, byDay: [], byModel: [], overview: ZERO_OV }));
  await expect(state(page, 'empty')).toBeVisible();
  await expect(state(page, 'empty')).toHaveText(TEXT.empty);
  await expect(cards(page)).toHaveCount(0);
  await expect(heatmap(page)).toHaveCount(0);
  await expect(state(page, 'error')).toHaveCount(0);
});
test("C7b sessionCount>0 但只有 'unknown' 行 → 正常态:sessions 卡有数、其余卡「—」、热力图全 0 级", async ({ page }) => {
  await bootWith(page, payload({ total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessionCount: 3 }, byDay: [dayEntry('unknown', 0, { calls: 2 })], overview: ZERO_OV }));
  await expect(state(page, 'empty')).toHaveCount(0);
  await expect(cards(page)).toBeVisible();
  expect((await cardValue(page, 'sessions')).text).toBe('3');
  for (const k of CARD_KEYS.filter((x) => x !== 'sessions')) expect((await cardValue(page, k)).text, k).toBe('—');
  const levels = await cells(page).evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-level')))]);
  expect(levels).toEqual(['0']);
});
test('C8a 首屏不阻塞:/api/usage 延迟 5 s → home-input 2 s 内可见且可输入', async ({ page }) => {
  await stubUsage(page, () => ({ status: 200, body: typical(), delayMs: 5000 }));
  await gotoHome(page);
  await expect(homeInput(page)).toBeVisible({ timeout: 2000 });
  await homeInput(page).fill('r130 不阻塞');
  await expect(homeInput(page)).toHaveValue('r130 不阻塞', { timeout: 2000 });
});
test('C8b 加载骨架:请求未返回时 home-usage-loading 可见;超过 3 s 加 data-slow="1" 与「正在统计全部会话…」;返回后卡片出现、骨架消失', async ({ page }) => {
  await stubUsage(page, () => ({ status: 200, body: typical(), delayMs: 6500 }));
  await gotoHome(page);
  const loading = state(page, 'loading');
  await expect(loading).toBeVisible({ timeout: 5000 });
  expect(await loading.getAttribute('data-slow'), '刚开始加载时不该标慢').toBeNull();
  await expect(loading).toHaveAttribute('data-slow', '1', { timeout: 4500 });
  await expect(loading).toContainText(TEXT.slow);
  await expect(cards(page)).toBeVisible({ timeout: 8000 });
  await expect(loading).toHaveCount(0);
});
test('C9a /api/usage 返回 500 → home-usage-error「无法加载用量数据」+ 按钮「重试」;home-input 可用;不弹对话框', async ({ page }) => {
  let dialogs = 0; page.on('dialog', (d) => { dialogs += 1; d.dismiss().catch(() => {}); });
  await stubUsage(page, () => ({ status: 500, body: { error: 'boom' } }));
  await gotoHome(page);
  await expect(state(page, 'error')).toBeVisible({ timeout: 10_000 });
  await expect(state(page, 'error')).toContainText(TEXT.error);
  await expect(page.getByTestId('home-usage-retry')).toHaveText(TEXT.retry);
  await homeInput(page).fill('还能打字');
  await expect(homeInput(page)).toHaveValue('还能打字');
  expect(dialogs).toBe(0);
  expect(await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count()).toBe(0);
});
test('C9b 出错后点「重试」(放行为 200)→ 正常态,错误态消失', async ({ page }) => {
  const s = await stubUsage(page, () => ({ status: 500, body: { error: 'boom' } }));
  await gotoHome(page);
  await expect(state(page, 'error')).toBeVisible({ timeout: 10_000 });
  s.set(typical());
  await page.getByTestId('home-usage-retry').click();
  await expect(cards(page)).toBeVisible({ timeout: 10_000 });
  await expect(state(page, 'error')).toHaveCount(0);
});

// ───────────── 刷新链路 ─────────────
test('C10a meta.stale=true → home-usage-stale「统计中，数据可能略旧」', async ({ page }) => {
  await bootWith(page, payload({ meta: { stale: true }, byDay: [dayEntry(dayAgo(1), 500)] }));
  await expect(state(page, 'stale')).toBeVisible();
  await expect(state(page, 'stale')).toHaveText(TEXT.stale);
});
test('C10b meta.stale=false → 没有 home-usage-stale', async ({ page }) => {
  await bootWith(page, payload({ meta: { stale: false }, byDay: [dayEntry(dayAgo(1), 500)] }));
  await expect(state(page, 'stale')).toHaveCount(0);
});
test('C10c 恒返 stale=true:100 s 内恰好 3 次 GET(0 s / 45 s / 90 s,每次 stale 响应只安排一次 45 s 延迟重取)', async ({ page }) => {
  test.setTimeout(170_000);
  const s = await stubUsage(page, payload({ meta: { stale: true }, byDay: [dayEntry(dayAgo(1), 500)] }));
  await bootWith(page, null);
  await expect.poll(() => s.hits.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  const first = s.hits[0];
  await page.waitForTimeout(100_000);
  const rel = s.hits.map((t) => Math.round((t - first) / 1000));
  expect(s.hits.length, `100 s 内的 GET 时刻(相对首发,秒):${rel.join(',')}`).toBe(3);
  expect(rel[1]).toBeGreaterThanOrEqual(44); expect(rel[1]).toBeLessThanOrEqual(50);
  expect(rel[2]).toBeGreaterThanOrEqual(89); expect(rel[2]).toBeLessThanOrEqual(95);
});
test('C10d 恒返 stale=false:首页不周期轮询,50 s 内只有 1 次 GET', async ({ page }) => {
  const s = await stubUsage(page, typical());
  await bootWith(page, null);
  await expect.poll(() => s.hits.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(50_000);
  expect(s.hits.length, `50 s 内的 GET 次数(时刻 ms:${s.hits.join(',')})`).toBe(1);
});
/** 装一个"骨架是否出现过"的观察器(挂载后再装,所以首次 loading 不计)。 */
const watchLoading = (page) => page.evaluate(() => {
  window.__r130LoadingSeen = false;
  new MutationObserver(() => { if (document.querySelector('[data-testid="home-usage-loading"]')) window.__r130LoadingSeen = true; }).observe(document.body, { childList: true, subtree: true, attributes: true });
});
for (const ev of ['cgui:usage-updated', 'cgui:chat-done']) {
  test(`C11 window 事件 ${ev} → 静默重取(GET +1,不闪骨架,卡片一直在)`, async ({ page }) => {
    const s = await stubUsage(page, typical());
    await bootWith(page, null);
    await expect.poll(() => s.hits.length, { timeout: 15_000 }).toBe(1);
    // ⚠️ hits 计数是在**路由被调用**时 +1,不代表响应已落地。原用例在 hits==1 后立刻开观察窗,
    // 于是存在这样一个窗口:首取响应还没应用(缓存还是 null)时若发生重挂,新实例会走**非静默首取** → 闪骨架。
    // 这是竞态(实测 1/3 红),与本用例要测的"静默重取"无关。改成确定性:等首屏真正 ready、
    // 骨架元素**不在** DOM 里,再开观察窗 —— 之后任何骨架出现都只能来自被测的那条路径。
    await expect(cards(page), '首屏要先真正 ready(卡片出现)').toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('home-usage-loading'), '开观察窗前骨架必须已经消失').toHaveCount(0);
    await watchLoading(page);
    await page.evaluate((name) => window.dispatchEvent(new CustomEvent(name)), ev);
    await expect.poll(() => s.hits.length, { timeout: 5000, message: `${ev} 之后应再发一次 GET` }).toBe(2);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.__r130LoadingSeen), '静默重取不该闪出骨架').toBe(false);
    await expect(cards(page)).toBeVisible();
  });
}

// ───────────── 真数据端到端(不打桩,隔离实例的夹具:今天两条会话) ─────────────
test('C12 真数据:sessions=2、messages=4、tokens=11.0K、active-days=1、current-streak=1、peak-hour=9 时、favorite-model=claude-sonnet-4-6;今天格 data-tokens=11000', async ({ page }) => {
  const e = readUiExpected();
  await gotoHome(page);
  await expect(cards(page)).toBeVisible({ timeout: 30_000 });
  const want = { sessions: String(e.sessions), messages: String(e.messages), tokens: fmtTokens(e.tokens), 'active-days': '1', 'current-streak': '1', 'longest-streak': '1', 'peak-hour': `${e.hour} 时`, 'favorite-model': e.model };
  const wrong = [];
  for (const k of Object.keys(want)) { const v = await cardValue(page, k); if (v.text !== want[k]) wrong.push(`${k}: 实际 ${JSON.stringify(v.text)} 期望 ${JSON.stringify(want[k])}`); }
  expect(wrong, wrong.join('\n')).toEqual([]);
  await expect(cellOf(page, e.day)).toHaveAttribute('data-tokens', String(e.tokens));
  await expect(cellOf(page, e.day)).toHaveAttribute('data-today', '1');
});

// ───────────── C13 输入「/」「@」弹出的浮层必须完整可见(INTERFACE §D 2026-09-28 补的盲区) ─────────────
// 浮层定位不靠 testid(INTERFACE 没给):在 home-input 里输入前先记下"当时可见的元素",输入后取"新变得可见的最外层元素"
// (position 为 absolute/fixed、不包含 home-input)当作浮层容器;「/」再要求它含「SLASH 命令」(与 D5c 一致),「@」INTERFACE 没给文案,不限。
// 三项判据各自 soft 断言,一次跑能同时看到三项结果与超出的像素数:
//   ① 浮层矩形 ⊆ 视口;② 浮层矩形 ⊆ 最近有 overflow 裁剪的祖先(html/body 除外:它们的 overflow 归视口,由 ① 覆盖)的可视矩形;
//   ③ 四角 elementFromPoint 命中浮层自身或其后代(四角按圆角半径向内收一点,免得取到圆角外的像素)。弹出方向不限。
/** 打开浮层(照 D5c:点 home-input 输入字符),等它出现并等动画走完,返回测量结果。 */
async function openPopupAndMeasure(page, ch, hint) {
  await homeInput(page).click();
  await homeInput(page).fill('');
  await page.waitForTimeout(300);
  await snapshotVisible(page);
  await page.keyboard.type(ch);
  if (hint) await expect(page.getByText(hint).first(), `输入「${ch}」后应出现「${hint}」`).toBeVisible({ timeout: 5000 });
  let handle = null;
  await expect.poll(async () => { handle = await findPopup(page, hint); return await handle.evaluate((el) => Boolean(el)); }, { timeout: 5000, message: `输入「${ch}」后应有一个新出现的可见浮层(absolute/fixed、不含 home-input${hint ? `、含「${hint}」` : ''})` }).toBe(true);
  await handle.evaluate(async (el) => { try { await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)); } catch { /* 不支持就靠下面的等待 */ } });
  await page.waitForTimeout(300);
  return measureBox(handle);
}
function assertPopupFullyVisible(m, label) {
  console.log(`[C13] ${label}:浮层 ${describeMeasure(m)}`);
  expect.soft(Math.max(...Object.values(m.overViewport)), `① ${label}:浮层矩形 ${fmtBox(m.rect)} 应完全落在 ${m.vp.w}×${m.vp.h} 视口内,实际${fmtOver(m.overViewport)}`).toBeLessThanOrEqual(0.5);
  if (m.clipInfo) expect.soft(Math.max(...Object.values(m.clipInfo.over)), `② ${label}:浮层矩形 ${fmtBox(m.rect)} 应落在最近裁剪祖先 ${m.clipInfo.desc}(overflow ${m.clipInfo.overflow})的可视区 ${fmtBox(m.clipInfo.visible)} 内,实际${fmtOver(m.clipInfo.over)}`).toBeLessThanOrEqual(0.5);
  const misses = m.corners.filter((c) => !c.ok).map((c) => `${c.name}(${c.x},${c.y})${c.inViewport ? ` 命中的是 ${c.hit}` : ' 在视口外'}`);
  expect.soft(misses, `③ ${label}:浮层四角 elementFromPoint 都应命中浮层自身或后代,未命中:${misses.join(';')}`).toEqual([]);
}
for (const [w, h] of [[1440, 900], [375, 812]]) {
  test(`C13a ${w}×${h} 单屏首页输入「/」弹出的斜杠命令菜单完整可见:矩形 ⊆ 视口、⊆ 最近裁剪祖先可视区、四角 elementFromPoint 命中菜单`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await bootWith(page, typical());
    await expect(cards(page), '前提:首页处于正常态(八卡可见)').toBeVisible();
    const m = await openPopupAndMeasure(page, '/', 'SLASH 命令');
    assertPopupFullyVisible(m, `${w}×${h} 斜杠命令菜单`);
  });
  test(`C13b ${w}×${h} 单屏首页输入「@」弹出的引用面板完整可见:矩形 ⊆ 视口、⊆ 最近裁剪祖先可视区、四角 elementFromPoint 命中面板`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await bootWith(page, typical());
    await expect(cards(page), '前提:首页处于正常态(八卡可见)').toBeVisible();
    const m = await openPopupAndMeasure(page, '@', '');
    expect(m.text.length, `输入「@」后弹出的面板应有内容(实际文本:${JSON.stringify(m.text)})`).toBeGreaterThan(0);
    assertPopupFullyVisible(m, `${w}×${h} 引用面板`);
  });
}

test('C11b 真重挂(分屏切走再切回)不闪骨架:带缓存重挂要以旧数据 ready 起步、只静默刷新', async ({ page }) => {
  // 盲判 2026-09-30 指出:原 C11 只在同一实例上派 window 事件,够不着"回合结束导致组件重挂"这条真路径 ——
  // 把缓存整个废掉它照样全绿(假绿)。这里用**真重挂**(分屏切走 → 切回)把需求钉死:
  // 重挂后不得闪骨架,但仍要静默补一次 GET。
  const s = await stubUsage(page, typical());
  await bootWith(page, null);
  await expect.poll(() => s.hits.length, { timeout: 15_000 }).toBe(1);
  await setPaneCount(page, 2);
  await expect(usage(page), '分屏时用量块整块卸载').toHaveCount(0, { timeout: 5000 });
  await watchLoading(page);                       // 观察窗从"重挂前"开始
  const before = s.hits.length;
  await setPaneCount(page, 1);
  await expect(cards(page), '回单屏后卡片要直接出现').toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__r130LoadingSeen), '重挂不该闪骨架(缓存以 ready 起步)').toBe(false);
  await expect.poll(() => s.hits.length, { timeout: 5000, message: '重挂后仍应静默补一次 GET' }).toBeGreaterThan(before);
});
