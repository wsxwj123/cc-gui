// r159-orbit-random：① 每轮回复最上面的「总栏」和设置里「过程块自动折叠」开关去掉；② 旋转类加载动画圆点变小、近大远小；
// ③ 加载动画新增「随机」模式（没存过偏好的用户默认用它）。
// 判据全部来自 .devflow/r159-orbit-random-接口.md 的行为清单 A1–A4 / B1–B2 / C1–C5，只看页面上用户能看到的东西
// （接口文件列出的 data-* 锚点、localStorage 键、公开文案）；不读源码、不读 React state、不 import 应用内部模块。
// 命名：用例标题以行为编号开头，每条行为一个用例。
import { test, expect } from '@playwright/test';
import { SESSIONS, END_ANCHOR } from './helpers/fixtures.mjs';
import { primeOverlays, openApp, openSessionByMarker, touchCtl } from './helpers/runtime.mjs';
import {
  ORBITS, ORBIT_IDS, IND, DOT_LO, DOT_HI, MAX_AT_LEAST, MIN_AT_MOST, norm, uniq, lsGet, bash, phaseEvents, openAllGates,
  prepareLive, sendRound, reloadApp, expectPhase, startSampler, stopSampler, playPhases,
  openInterfaceTab, closeThemePopover, loadingGrid, openSettings, settingsSearch, sampleGrid, ZOOM_ONE, expectZoomOne,
} from './helpers/ui.mjs';

// 用例失败时直播回合会停在半路（假命令行在等放行文件）：把所有闸门都放了，让它自己收尾，别拖累下一条。
test.afterEach(async () => { try { openAllGates(); } catch { /* 忽略 */ } });

/** 阶段切换后留给界面落稳的时间（放行 → 假命令行读到闸门 → 推送 → 页面画出来）。阶段内"读数不变"只在稳定窗口里查。 */
const SETTLE = 700;
const within = (samples, from, to) => samples.filter((s) => s.wall >= from && s.wall < to);

// ───────────────────────── A 组：总栏与旧开关 ─────────────────────────
async function openHistory(page, key, presets = {}) {
  await primeOverlays(page, presets);
  await openApp(page);
  await openSessionByMarker(page, SESSIONS[key].marker);
  await expect(page.getByText(END_ANCHOR).first(), '前置自证：历史回合末尾那段正文应已画出来（会话确实打开了）').toBeVisible({ timeout: 30_000 });
}

/** A1 / A2 共用：总栏不存在、工作组头行 ≥ 1 且全部可见。 */
async function expectNoStripAndVisibleHeads(page) {
  const heads = page.locator('[data-work-group-head]');
  await expect.poll(async () => await heads.count(), { timeout: 15_000, message: '历史回合里应有至少 1 个工作组头行 [data-work-group-head]' }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(800); // 总栏若还在，这点时间足够它画出来；稳定之后再数
  expect(await page.locator('[data-strip="head"]').count(), '总栏 [data-strip="head"] 应不存在（数量 0）').toBe(0);
  const n = await heads.count();
  const visible = [];
  for (let i = 0; i < n; i += 1) visible.push(await heads.nth(i).isVisible());
  expect(visible, `全部 ${n} 个 [data-work-group-head] 都应可见`).toEqual(Array(n).fill(true));
}

test('A1 历史回合：页面上没有「总栏」（[data-strip="head"] 数量 0），每个工作组头行都可见', async ({ page }) => {
  await openHistory(page, 'a1');
  await expectNoStripAndVisibleHeads(page);
});

test('A2 旧开关键 cgui-auto-fold-process=1 写过也一样：没有总栏；点工作组头行 aria-expanded 翻转，展开后组内至少一个条目可见', async ({ page }) => {
  await openHistory(page, 'a2', { 'cgui-auto-fold-process': '1' });
  expect(await lsGet(page, 'cgui-auto-fold-process'), '前置：页面里 cgui-auto-fold-process 确实是 1（旧版里开过）').toBe('1');
  await expectNoStripAndVisibleHeads(page);

  const heads = page.locator('[data-work-group-head]');
  const n = await heads.count();
  let idx = 0; // 优先挑一个收起的头行；没有收起的就用第一个
  for (let i = 0; i < n; i += 1) {
    if ((await heads.nth(i).getAttribute('aria-expanded')) === 'false') { idx = i; break; }
  }
  const head = heads.nth(idx);
  const before = await head.getAttribute('aria-expanded');
  expect(['true', 'false'], `头行 aria-expanded 初值应是 true / false（实际 ${before}）`).toContain(before);
  const flipped = before === 'true' ? 'false' : 'true';
  await head.click({ timeout: 8_000 });
  await expect(head, `点一下头行：aria-expanded 应从 ${before} 翻成 ${flipped}`).toHaveAttribute('aria-expanded', flipped, { timeout: 8_000 });
  if (flipped === 'false') { // 本来就是展开的：再点一下展开
    await head.click({ timeout: 8_000 });
    await expect(head, '本来就展开的组：再点一下应翻回 aria-expanded=true').toHaveAttribute('aria-expanded', 'true', { timeout: 8_000 });
  }
  // 展开后：该组里至少一个条目可见（条目 = [data-entry-state] 或 [data-tool-card]；自身和祖先都没有 hidden，且占得到位置）
  await expect.poll(async () => await head.evaluate((h) => {
    const g = h.closest('[data-work-group]') || h.parentElement;
    const items = [...g.querySelectorAll('[data-entry-state], [data-tool-card]')];
    const shown = items.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.closest('[hidden]') && getComputedStyle(el).visibility !== 'hidden';
    });
    return shown.length;
  }), { timeout: 8_000, message: '展开后该组里应至少有 1 个可见条目（自身和祖先都没有 hidden）' }).toBeGreaterThan(0);
});

test('A3 设置「通用」页：没有「过程块自动折叠」（无 #set-auto-fold、页面文字里没有它），设置搜索「折叠」也搜不到', async ({ page }) => {
  await primeOverlays(page);
  await openApp(page);
  await openSettings(page);
  await expect(page.locator('[id^="set-"]').first(), '前置自证：设置默认页应已渲染出若干设置区块（id 以 set- 开头），否则下面的"没有"是空话').toBeAttached({ timeout: 10_000 });
  await page.waitForTimeout(600);
  expect(await page.locator('#set-auto-fold').count(), '设置默认页不应有 #set-auto-fold（数量 0）').toBe(0);
  expect(await page.getByText('过程块自动折叠').count(), '设置默认页里不应有「过程块自动折叠」字样').toBe(0);
  expect((await page.locator('body').innerText()).includes('过程块自动折叠'), '页面可见文字里不应有「过程块自动折叠」').toBe(false);

  await settingsSearch(page).fill('折叠');
  await page.waitForTimeout(1000); // 给搜索结果列表渲染的时间
  expect(await page.getByText('过程块自动折叠').count(), '设置搜索输入「折叠」后，结果列表里不应有「过程块自动折叠」这一项').toBe(0);
  expect(await page.locator('#set-auto-fold').count(), '搜索「折叠」后也不应出现 #set-auto-fold').toBe(0);
});

test('A4 生成中（思考 2.5 秒 → 调用一次工具并保持运行）：两个阶段都有状态行和指示器，页面上没有总栏', async ({ page }) => {
  await prepareLive(page, {
    key: 'a4',
    scenario: { events: [{ kind: 'thinking', text: 'A4 思考。' }, { kind: 'wait', file: 'g1' }, bash('A4 一直没返回的命令', { pending: 'd1' })] },
  });
  await sendRound(page);
  await startSampler(page, 100);
  await expectPhase(page, 'thinking');
  await page.waitForTimeout(2500);
  touchCtl('g1');
  await expectPhase(page, 'tool');
  await page.waitForTimeout(2000);
  const samples = await stopSampler(page);
  for (const phase of ['thinking', 'tool']) {
    const rows = samples.filter((s) => s.phase === phase);
    expect(rows.length, `前置：${phase} 阶段应采到足够多的样本（≥ 10）`).toBeGreaterThanOrEqual(10);
    const bad = rows.filter((s) => !(s.lines >= 1 && s.hasInd && s.strips === 0));
    expect(
      bad.slice(0, 3).map((s) => `状态行 ${s.lines} 个、指示器${s.hasInd ? '在' : '不在'}、总栏 [data-strip="head"] ${s.strips} 个`),
      `${phase} 阶段：[data-live-line] 应存在且含 [data-live-indicator]，[data-strip="head"] 数量应为 0（共 ${bad.length}/${rows.length} 个样本不符）`,
    ).toEqual([]);
  }
});

// ───────────────────────── B 组：圆点大小 ─────────────────────────
test('B1 设置 → 主题 → 界面 → 加载动画网格：16 种旋转动画逐个核对（选项格、标签、点数、圆点宽高范围与远近大小变化）', async ({ page }) => {
  test.setTimeout(150_000);
  await primeOverlays(page, ZOOM_ONE);
  await openApp(page);
  await expectZoomOne(page);
  await openInterfaceTab(page);
  const problems = [];

  for (const o of ORBITS) { // 逐个：选项格在、可见、标签文字一致
    const cell = page.locator(`[data-loading-option="${o.id}"]`);
    const count = await cell.count();
    if (count !== 1) { problems.push(`${o.id}: [data-loading-option] 选项格数量 ${count}（应为 1）`); continue; }
    if (!(await cell.isVisible())) problems.push(`${o.id}: 选项格不可见`);
    const text = norm(await cell.innerText());
    if (!text.includes(o.label)) problems.push(`${o.id}: 格内可见文字「${text}」不含标签「${o.label}」`);
    const others = ORBITS.filter((x) => x.id !== o.id && x.label !== o.label && text.includes(x.label)).map((x) => x.label);
    if (others.length) problems.push(`${o.id}: 格内文字「${text}」还含了别的格的标签 ${JSON.stringify(others)}`);
  }

  const sampled = await sampleGrid(page, ORBIT_IDS, 12_000, 100); // 16 格同一个 12 秒窗口、每 100 毫秒读一次
  for (const o of ORBITS) {
    const s = sampled[o.id];
    if (!s.found) continue; // 上面已记"选项格数量"
    if (!s.root) { problems.push(`${o.id}: 格内找不到指示器根元素（带 data-style 的元素）`); continue; }
    if (s.styleAttr !== o.id) problems.push(`${o.id}: 格内指示器 data-style=${s.styleAttr}（应等于 ${o.id}）`);
    if (s.dotCount !== o.dots) problems.push(`${o.id}: 圆点（指示器根元素的直接子元素 <i>）数量 ${s.dotCount}（应为 ${o.dots}）`);
    if (s.n === 0) { problems.push(`${o.id}: 12 秒内一个圆点读数都没读到`); continue; }
    if (s.bad > 0) problems.push(`${o.id}: ${s.bad}/${s.n} 个宽高读数越出 [${DOT_LO}, ${DOT_HI}]px（最小 ${s.min.toFixed(2)}、最大 ${s.max.toFixed(2)}）`);
    if (s.max < MAX_AT_LEAST) problems.push(`${o.id}: 12 秒内最大读数 ${s.max.toFixed(2)}px < ${MAX_AT_LEAST}px（没出现"最近"的大小）`);
    if (s.min > MIN_AT_MOST) problems.push(`${o.id}: 12 秒内最小读数 ${s.min.toFixed(2)}px > ${MIN_AT_MOST}px（没出现"最远"的大小）`);
  }
  expect(problems, `16 种旋转动画里不合格的项（共 ${problems.length} 条）`).toEqual([]);
});

test('B2 状态行里 14px 指示器（一直停在思考阶段 12 秒）：所有圆点的宽、高读数都在 [1.45, 2.65]px 内', async ({ page }) => {
  test.setTimeout(120_000);
  await prepareLive(page, { key: 'b2', presets: ZOOM_ONE, scenario: { events: [{ kind: 'thinking', text: 'B2 思考。' }] } });
  await sendRound(page);
  await expectPhase(page, 'thinking');
  await expect(page.locator(IND).first(), '前置：状态行里应有指示器').toBeVisible({ timeout: 15_000 });
  await expectZoomOne(page);
  await startSampler(page, 100);
  await page.waitForTimeout(12_000);
  const samples = await stopSampler(page);
  expect(uniq(samples.map((s) => s.phase)), '前置：整个 12 秒观察窗口应一直停在 thinking 阶段（不切阶段、不触发抽取）').toEqual(['thinking']);
  const sizes = samples.flatMap((s) => s.dots.flatMap((d) => [d[0], d[1]]));
  expect(sizes.length, '前置：应读到足够多的圆点读数（≥ 3 个点 × 约 120 次采样 × 宽高）').toBeGreaterThanOrEqual(600);
  const bad = sizes.filter((v) => v < DOT_LO || v > DOT_HI);
  expect(
    bad.length,
    `状态行指示器（当前动画 ${uniq(samples.map((s) => s.style)).join('/')}）：${bad.length}/${sizes.length} 个宽高读数越出 [${DOT_LO}, ${DOT_HI}]px（最小 ${Math.min(...sizes).toFixed(2)}、最大 ${Math.max(...sizes).toFixed(2)}）`,
  ).toBe(0);
});

// ───────────────────────── C 组：随机模式与设置 ─────────────────────────
test('C1 全新环境：「随机」排第一并选中、orbit3 / orbit4 紧随，转速「慢」选中；生成中指示器是随机模式、转速慢', async ({ page }) => {
  await prepareLive(page, { key: 'c1', scenario: { events: [{ kind: 'thinking', text: 'C1 思考。' }] } });
  await openInterfaceTab(page);
  await expect.soft(loadingGrid(page), '「加载动画」网格 [role="radiogroup"][aria-label="加载动画样式"] 应有 1 个').toHaveCount(1);
  const ids = await page.locator('[data-loading-option]').evaluateAll((els) => els.map((e) => e.getAttribute('data-loading-option')));
  expect.soft(ids.slice(0, 3), `网格前三格依次应是 random / orbit3 / orbit4（实际前 5 格 ${JSON.stringify(ids.slice(0, 5))}）`).toEqual(['random', 'orbit3', 'orbit4']);
  expect.soft(uniq(ids.slice(0, 17)).sort(), '网格前 17 格应恰好是「随机」+ 表里 16 个 id（后 14 个的内部顺序不查）').toEqual(['random', ...ORBIT_IDS].sort());
  expect.soft(['cli', 'ring'].every((id) => ids.slice(17).includes(id)), `原有样式 cli、ring 应排在 16 个旋转动画之后（实际第 18 格起 ${JSON.stringify(ids.slice(17))}）`).toBe(true);

  const random = page.locator('[data-loading-option="random"]');
  const randomCount = await random.count();
  expect.soft(randomCount, '应有且只有 1 个 [data-loading-option="random"]').toBe(1);
  if (randomCount === 1) {
    await expect.soft(random, '「随机」格应是选中态（aria-checked=true）').toHaveAttribute('aria-checked', 'true');
    await expect.soft(random, '「随机」格里应有可见文字「随机」').toContainText('随机');
    const hasInd = (await random.locator('[data-style]').count()) > 0;
    expect.soft(hasInd, '「随机」格里应有指示器（带 data-style 的元素）').toBe(true);
    if (hasInd) {
      const rInd = random.locator('[data-style]').first();
      await expect.soft(rInd, '「随机」格里的指示器应带 data-loading-mode="random"').toHaveAttribute('data-loading-mode', 'random');
      const rStyle = await rInd.getAttribute('data-style');
      expect.soft(ORBIT_IDS, `「随机」格里指示器的 data-style（${rStyle}）应是 16 个 id 之一`).toContain(rStyle);
    }
  }
  await expect.soft(page.locator('[data-loading-speed="slow"]'), '转速「慢」[data-loading-speed="slow"] 应是选中态').toHaveAttribute('aria-checked', 'true');

  await closeThemePopover(page);
  await sendRound(page);
  const ind = page.locator(IND).first();
  await expect(ind, '生成中：状态行里应出现指示器').toBeVisible({ timeout: 30_000 });
  await expect.soft(ind, '生成中指示器的 data-loading-mode 应为 random').toHaveAttribute('data-loading-mode', 'random');
  await expect.soft(ind, '生成中指示器的 data-speed 应为 slow').toHaveAttribute('data-speed', 'slow');
  const style = await ind.getAttribute('data-style');
  expect.soft(ORBIT_IDS, `生成中指示器的 data-style（${style}）应是 16 个 id 之一`).toContain(style);
});

test('C2 选定 orbit4 后各阶段（思考 → 工具 → 思考）都保持 orbit4 且无 data-loading-mode；改选「随机」后刷新仍选中', async ({ page }) => {
  test.setTimeout(150_000);
  const phases = [{ kind: 'think', ms: 2800 }, { kind: 'tool', title: 'C2 一直没返回的命令', ms: 2800 }, { kind: 'think', ms: 2800 }];
  await prepareLive(page, { key: 'c2', scenario: { events: phaseEvents(phases) } });

  await openInterfaceTab(page);
  await page.locator('[data-loading-option="orbit4"]').click();
  await expect.poll(() => lsGet(page, 'cgui-loading-style'), { timeout: 5_000, message: '点 orbit4 后 localStorage["cgui-loading-style"] 应为 orbit4' }).toBe('orbit4');
  await closeThemePopover(page);

  await sendRound(page);
  const { samples, starts, ends } = await playPhases(page, phases);
  const problems = [];
  phases.forEach((p, i) => {
    const name = `阶段${i + 1}(${p.kind === 'think' ? '思考' : '工具'})`;
    const want = p.kind === 'think' ? 'thinking' : 'tool';
    const win = within(samples, starts[i] + SETTLE, ends[i]);
    if (win.length < 10) problems.push(`${name}: 稳定窗口里只采到 ${win.length} 个样本（应 ≥ 10）`);
    const styles = uniq(win.map((s) => s.style));
    const modes = uniq(win.map((s) => s.mode));
    const seen = uniq(win.map((s) => s.phase));
    if (JSON.stringify(styles) !== '["orbit4"]') problems.push(`${name}: data-style 应恒为 orbit4，实际 ${JSON.stringify(styles)}`);
    if (JSON.stringify(modes) !== '[null]') problems.push(`${name}: 指示器不应有 data-loading-mode 属性，实际读到 ${JSON.stringify(modes)}`);
    if (JSON.stringify(seen) !== JSON.stringify([want])) problems.push(`${name}: data-live-phase 应恒为 ${want}，实际 ${JSON.stringify(seen)}`);
  });
  expect(problems, '偏好选 orbit4：三个阶段都应保持 orbit4、不进随机').toEqual([]);

  await openInterfaceTab(page);
  const random = page.locator('[data-loading-option="random"]');
  await expect(random, '「界面」页应有 1 个「随机」选项格 [data-loading-option="random"]').toHaveCount(1);
  await random.click();
  await expect.poll(() => lsGet(page, 'cgui-loading-style'), { timeout: 5_000, message: '点「随机」后 localStorage["cgui-loading-style"] 应为 random' }).toBe('random');
  await reloadApp(page);
  expect(await lsGet(page, 'cgui-loading-style'), '刷新后 localStorage["cgui-loading-style"] 仍应是 random').toBe('random');
  await openInterfaceTab(page);
  await expect(page.locator('[data-loading-option="random"]'), '刷新页面后「随机」格仍应是选中态').toHaveAttribute('aria-checked', 'true');
});

test('C3 随机模式连走 8 个阶段（思考、工具甲、思考、工具乙…）：阶段内读数不变、相邻阶段不同、至少 3 种、都属于 16 个 id、phase 与阶段一致', async ({ page }) => {
  test.setTimeout(180_000);
  const T = 2700;
  const phases = [
    { kind: 'think', ms: T }, { kind: 'tool', title: 'C3 工具甲', ms: T }, { kind: 'think', ms: T }, { kind: 'tool', title: 'C3 工具乙', ms: T },
    { kind: 'think', ms: T }, { kind: 'tool', title: 'C3 工具丙', ms: T }, { kind: 'think', ms: T }, { kind: 'tool', title: 'C3 工具丁', ms: T },
  ];
  await prepareLive(page, { key: 'c3', scenario: { events: phaseEvents(phases) } });
  await sendRound(page);
  const { samples, starts, ends } = await playPhases(page, phases);

  const names = phases.map((p, i) => `阶段${i + 1}(${p.kind === 'think' ? '思考' : p.title})`);
  const readings = [];
  const problems = [];
  phases.forEach((p, i) => {
    const want = p.kind === 'think' ? 'thinking' : 'tool';
    const win = within(samples, starts[i] + SETTLE, ends[i]);
    const styles = uniq(win.map((s) => s.style));
    const seen = uniq(win.map((s) => s.phase));
    if (win.length < 10) problems.push(`${names[i]}: 稳定窗口里只采到 ${win.length} 个样本（应 ≥ 10）`);
    if (styles.length !== 1) problems.push(`①${names[i]}: 同一阶段内读数应全相同，实际出现 ${JSON.stringify(styles)}`);
    if (JSON.stringify(seen) !== JSON.stringify([want])) problems.push(`⑤${names[i]}: data-live-phase 应恒为 ${want}，实际 ${JSON.stringify(seen)}`);
    if (styles.length === 1 && !ORBIT_IDS.includes(styles[0])) problems.push(`④${names[i]}: 读数 ${styles[0]} 不在 16 个 id 里`);
    readings.push(styles.length === 1 ? styles[0] : null);
  });
  for (let i = 1; i < readings.length; i += 1) {
    if (readings[i] !== null && readings[i] === readings[i - 1]) problems.push(`②${names[i - 1]} 与 ${names[i]} 读数相同（${readings[i]}），相邻阶段应不同`);
  }
  const kinds = uniq(readings.filter((r) => r !== null));
  if (kinds.length < 3) problems.push(`③8 个阶段里不同的 id 只有 ${kinds.length} 种（${JSON.stringify(kinds)}），应 ≥ 3 种`);
  console.log(`[R159 C3] 8 个阶段的读数：${readings.join(' → ')}`);
  expect(problems, `随机模式 8 个阶段（读数 ${readings.join(' → ')}）不合规的项`).toEqual([]);
});

test('C4 随机模式：距上次抽取不满 1.5 秒时进入新阶段不换，这个阶段内部之后也不补换', async ({ page }) => {
  test.setTimeout(150_000);
  const phases = [
    { kind: 'think', ms: 2600 }, { kind: 'tool', title: 'C4 工具甲', ms: 300 }, { kind: 'tool', title: 'C4 工具乙', ms: 300 },
    { kind: 'tool', title: 'C4 工具丙', ms: 300 }, { kind: 'think', ms: 3000 },
  ];
  await prepareLive(page, { key: 'c4', scenario: { events: phaseEvents(phases) } });
  await sendRound(page);
  const { samples, starts, ends } = await playPhases(page, phases);

  const p0 = within(samples, starts[0] + SETTLE, ends[0]);
  const id0 = p0.length ? p0[p0.length - 1].style : null;
  expect(ORBIT_IDS, `前置：第一段思考结束时的读数 id0（${id0}）应是 16 个 id 之一`).toContain(id0);
  const iA = samples.findIndex((s) => s.wall >= starts[0] && s.phase === 'tool');
  expect(iA, '前置：应观察到进入工具阶段（data-live-phase=tool）').toBeGreaterThanOrEqual(0);
  const after = samples.slice(iA); // 从进入工具 A 起一直到最后那段思考结束
  expect(after.length, '前置：进入工具 A 之后到结束应采到足够多的样本（0.9 秒工具段 + 3 秒思考 ≈ 39 个，要求 ≥ 25）').toBeGreaterThanOrEqual(25);
  const id1 = after[2].style; // 进入后 ≥ 200 毫秒的读数（前两个样本留给"phase 先变、data-style 晚一帧"的边界容差）
  expect(ORBIT_IDS, `进入工具 A 之后的读数 id1（${id1}）应是 16 个 id 之一`).toContain(id1);
  expect(id1, `进入工具 A（距上次抽取 ≥ 1.5 秒）之后读数 id1 应与之前的 id0（${id0}）不同`).not.toBe(id0);

  const changed = after.slice(2).filter((s) => s.style !== id1);
  expect(
    changed.slice(0, 5).map((s) => `${s.phase}「${s.text}」@进入工具A后+${s.wall - starts[1]}ms: ${s.style}`),
    `从进入工具 A 起到最后那段思考结束，读数应始终等于 id1（${id1}）；共 ${changed.length}/${after.length - 2} 个样本不符`,
  ).toEqual([]);
  const early = after.slice(0, 2).filter((s) => s.style !== id0 && s.style !== id1);
  expect(early.map((s) => s.style), `进入工具 A 的头两个样本只能是 id0（${id0}）或 id1（${id1}）`).toEqual([]);

  const tail = within(samples, starts[4] + SETTLE, ends[4]); // 最后那段思考（3 秒，跨过 1.5 秒线）
  expect(tail.length, '前置：最后一段思考应采到足够多的样本（≥ 15）').toBeGreaterThanOrEqual(15);
  expect(uniq(tail.map((s) => s.phase)), '前置：最后一段应一直是 thinking 阶段').toEqual(['thinking']);
  console.log(`[R159 C4] id0=${id0} id1=${id1}`);
});

test('C5 减弱动画偏好下的随机模式：圆点是静止帧（1.5 秒内不动），任意两点中心距离 ≥ 3px，data-style 属于 16 个 id', async ({ page }) => {
  await prepareLive(page, { key: 'c5', presets: ZOOM_ONE, scenario: { events: [{ kind: 'thinking', text: 'C5 思考。' }] }, reducedMotion: true });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), '前置：页面应处于"减弱动画"偏好').toBe(true);
  await sendRound(page);
  await expectPhase(page, 'thinking');
  await expect(page.locator(IND).first(), '前置：状态行里应有指示器').toBeVisible({ timeout: 15_000 });
  await expectZoomOne(page);
  await startSampler(page, 100);
  await page.waitForTimeout(1600);
  const samples = await stopSampler(page);

  expect(samples.length, '前置：1.6 秒应采到 ≥ 12 个样本').toBeGreaterThanOrEqual(12);
  expect(uniq(samples.map((s) => s.mode)), '前置：没存过偏好 = 随机模式，指示器应带 data-loading-mode="random"').toEqual(['random']);
  const styles = uniq(samples.map((s) => s.style));
  expect(styles.length === 1 && ORBIT_IDS.includes(styles[0]), `data-style 应是 16 个 id 之一（实际 ${JSON.stringify(styles)}）`).toBe(true);

  const counts = uniq(samples.map((s) => s.dots.length));
  expect(counts.length === 1 && counts[0] >= 3, `每个样本里圆点个数应一致且 ≥ 3（实际 ${JSON.stringify(counts)}）`).toBe(true);
  let maxMove = 0;
  let minDist = Infinity;
  for (const s of samples) {
    s.dots.forEach((d, j) => {
      maxMove = Math.max(maxMove, Math.hypot(d[4] - samples[0].dots[j][4], d[5] - samples[0].dots[j][5])); // 相对指示器中心的偏移：页面滚动不算"圆点在动"
      for (let k = j + 1; k < s.dots.length; k += 1) minDist = Math.min(minDist, Math.hypot(d[2] - s.dots[k][2], d[3] - s.dots[k][3]));
    });
  }
  expect(maxMove, `静止帧：1.5 秒内每个点的中心位移应 ≤ 0.05px（实际最大 ${maxMove.toFixed(3)}px，动画 ${styles[0]}）`).toBeLessThanOrEqual(0.05);
  expect(minDist, `任意两个点的中心距离应 ≥ 3px（实际最小 ${minDist.toFixed(2)}px，动画 ${styles[0]}）`).toBeGreaterThanOrEqual(3);
});
