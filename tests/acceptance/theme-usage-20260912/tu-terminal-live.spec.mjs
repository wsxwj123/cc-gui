// TU-3xx：R38 在**真浏览器 + 真终端**里的呈现面（BRIEF 成功标准 1/2/3 + 契约 §A.3/§A.4/§A.5/§A.7）。
//
// 这一组回答的是用户那句"终端面板白底黑字，应用是米色/暖色主题，像贴了块白纸"：
// 打开终端 → 改主题（四种触发）→ 终端**当场**跟着变，且变出来的颜色就是当前主题的 token。
//
// 黑盒取法（不读实现，全部来自契约）：
//   ① 颜色来源：读 `<html>` 上**当前生效**的 CSS token（getComputedStyle().getPropertyValue），
//      再按契约 §A.2 的 6 槽覆盖规则与 cursor 兜底规则算出"终端应该长什么样"，与终端渲染面的实际值比。
//      期望值不在用例里写死 —— 换任何主题家族都照样成立。
//   ② 触发：明暗档/家族走**公开 UI**（顶栏「主题」→ 浅色/深色 + 配色页家族按钮）；
//      系统明暗与"非法 data-theme 归类"直接改 `<html>` 属性（契约 §A.3/§A.4 把这三个属性定义成触发面）。
//   ③ 终端渲染面：见 helpers/tu-runtime.mjs 的 probeTerminalPalette()（三条取证手段与边界写在注释里）。
import { test, expect } from '@playwright/test';
import {
  getRuntime, EnvironmentBlocked,
  openTerminalPanel, closePanelTerminals, openFixtureSession,
  openThemePopover, closeThemePopover, pickTone, pickThemeFamily,
  readThemeAttributes, readRootTokens, TERMINAL_TOKEN_NAMES,
  probeTerminalPalette, pollPalette,
  CONTRACT_BASE, ANSI_KEYS, THRESHOLD, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE,
  isValidColorValue, parseColor, compositeOver, contrastRatio, sameColor, cr,
} from './helpers/tu-runtime.mjs';

/** §A.3 的深浅档归类（测试侧独立实现：`data-theme` 非 light/dark 一律当缺席，再看 `data-theme-system`）。 */
function resolveMode({ theme, system }) {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return system === 'dark' ? 'dark' : 'light';
}

const alphaOf = (value) => parseColor(value).a;
const inAlphaRange = (value) => {
  const a = alphaOf(value);
  return a >= THRESHOLD.selectionAlphaMin && a <= THRESHOLD.selectionAlphaMax;
};

/** 按 §A.2 的合成规则，从"当前主题 token"算出终端该有的 6 个槽（测试侧独立实现，不是抄实现）。 */
function expectedSlots(mode, tokens) {
  const base = CONTRACT_BASE[mode];
  const pick = (token, fallback) => {
    const value = tokens[token];
    return (typeof value === 'string' && isValidColorValue(value)) ? value.trim() : fallback;
  };
  const background = pick('--color-canvas', base.background);
  const foreground = pick('--color-ink', base.foreground);
  let selectionBackground = pick('--color-accent-muted', base.selectionBackground);
  if (!inAlphaRange(selectionBackground)) selectionBackground = base.selectionBackground;
  let selectionInactiveBackground = pick('--color-accent-subtle', base.selectionInactiveBackground);
  if (!inAlphaRange(selectionInactiveBackground)) selectionInactiveBackground = base.selectionInactiveBackground;
  const candidate = pick('--color-accent', base.cursor);
  const cursor = contrastRatio(candidate, background) >= THRESHOLD.cursorBackground ? candidate : foreground;
  return {
    background, foreground, cursor, cursorAccent: background,
    selectionBackground, selectionInactiveBackground,
    // 渲染层能看到的（xterm 把带 alpha 的选中色 source-over 合到背景上再画）
    selectionActiveOpaque: compositeOver(selectionBackground, background),
    selectionInactiveOpaque: compositeOver(selectionInactiveBackground, background),
  };
}

async function liveExpectation(page) {
  const attrs = await readThemeAttributes(page);
  const tokens = await readRootTokens(page, TERMINAL_TOKEN_NAMES);
  const mode = resolveMode(attrs);
  return { attrs, tokens, mode, expected: expectedSlots(mode, tokens) };
}


/** 等 `<html>` 上的主题属性真的变成期望值（UI 点击后 React 是同步写的，这里只做一次收敛确认）。 */
async function expectThemeAttributes(page, partial, label) {
  await expect.poll(async () => {
    const attrs = await readThemeAttributes(page);
    return Object.entries(partial).every(([key, value]) => attrs[key] === value) ? 'ok' : JSON.stringify(attrs);
  }, { timeout: 10_000, message: `${label}：<html> 属性必须变成 ${JSON.stringify(partial)}` }).toBe('ok');
}

/** 等终端渲染面收敛到"当前主题应有的样子"（轮询，不用固定等待）。 */
async function expectTerminalFollowsTheme(page, { label = '' } = {}) {
  const { mode, expected, tokens } = await liveExpectation(page);
  await pollPalette(page, (palette) => {
    const bad = [];
    if (!sameColor(palette.backgroundInline || palette.backgroundComputed, expected.background)) {
      bad.push(`background 实测 ${palette.backgroundInline || palette.backgroundComputed} ≠ 主题 --color-canvas ${expected.background}`);
    }
    if (!sameColor(palette.foreground, expected.foreground)) {
      bad.push(`foreground 实测 ${palette.foreground} ≠ 主题 --color-ink ${expected.foreground}`);
    }
    return bad.length ? bad.join('；') : true;
  }, `${label} 终端背景/前景必须跟随当前主题（--color-canvas=${tokens['--color-canvas']}，档=${mode}）`);
  return { mode, expected, tokens };
}

/** 找"文本恰好是 marker、且没有子元素"的渲染元素，读它的计算前景色。 */
async function markerColor(page, marker) {
  return await page.evaluate((needle) => {
    const el = [...document.querySelectorAll('*')]
      .find(node => node.children.length === 0 && (node.textContent || '').trim() === needle);
    return el ? getComputedStyle(el).color : null;
  }, marker);
}

// ---------------------------------------------------------------------------

test('TU-301 打开终端：背景/前景就等于当前主题 token；字体族与字号等于契约常量且背景不透明', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);
    const { mode, expected, tokens } = await liveExpectation(page);

    await pollPalette(page,
      (palette) => sameColor(palette.backgroundInline || palette.backgroundComputed, expected.background)
        || `background 实测 ${palette.backgroundInline || palette.backgroundComputed} ≠ 主题 --color-canvas ${expected.background}`,
      `新开的终端背景必须等于当前主题的 --color-canvas（${mode}，token=${tokens['--color-canvas']}；§F#5：xterm 自己把主题底色写在 .xterm-scrollable-element 行内）`);

    const palette = await probeTerminalPalette(page);
    expect(sameColor(palette.foreground, expected.foreground),
      `终端前景必须等于 --color-ink（实测 ${palette.foreground}，期望 ${expected.foreground}）`).toBe(true);

    // §A.5：字体族/字号是常量，必须与契约值一致（BRIEF R38.4「与 GUI 其他等宽文字一致」）
    const compact = (value) => String(value).replace(/["']/g, '').replace(/\s*,\s*/g, ',').trim();
    expect(compact(palette.fontFamily), '§A.5 终端字体族必须与 --font-mono 逐字一致（渲染层实测）')
      .toBe(compact(TERMINAL_FONT_FAMILY));
    expect(palette.fontSizePx, '§A.5 终端字号必须是 13px').toBe(`${TERMINAL_FONT_SIZE}px`);

    // §E：本批 allowTransparency 恒为默认 false —— 可观测形式 = 终端底色不带 alpha
    const bg = palette.backgroundInline || palette.backgroundComputed;
    expect(alphaOf(bg), `§E 背景必须不透明（allowTransparency=false 的可观测后果），实测 ${bg}`).toBe(1);
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

test('TU-302 触发①（明暗档）：应用里切到深色，已打开的终端当场跟着变，且终端没有被重建', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);
    await expectTerminalFollowsTheme(page, { label: '切档前（浅色）' });

    // 给终端 DOM 打一个身份戳：变色之后它必须还在（证明是同一个终端在变，不是重开了一个）
    await page.evaluate(() => {
      const el = document.querySelector('.xterm');
      if (el) el.__tuIdentity = 'tu-302';
    });

    await openThemePopover(page);
    await pickTone(page, '深色');
    await closeThemePopover(page);
    await expectThemeAttributes(page, { theme: 'dark' }, 'TU-302 切到深色');

    const { mode } = await expectTerminalFollowsTheme(page, { label: '切到深色后' });
    expect(mode, '切档后 <html data-theme> 应该已是 dark').toBe('dark');

    const palette = await probeTerminalPalette(page);
    for (let i = 0; i < ANSI_KEYS.length; i += 1) {
      expect(sameColor(palette.ansi[i], CONTRACT_BASE.dark[ANSI_KEYS[i]]),
        `§A.1/§A.2 ⑨ 切到深色档后 ANSI ${ANSI_KEYS[i]} 必须等于深色档常量 ${CONTRACT_BASE.dark[ANSI_KEYS[i]]}（实测 ${palette.ansi[i]}）`).toBe(true);
    }

    const identity = await page.evaluate(() => document.querySelector('.xterm')?.__tuIdentity || null);
    expect(identity, 'BRIEF R38.1：已打开的终端要**实时**变色，不是新开一个才生效（同一终端 DOM 节点必须还在）').toBe('tu-302');
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

test('TU-303 触发①双向：切回浅色，同一个终端又跟着变回浅色', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);
    await openThemePopover(page);
    await pickTone(page, '深色');
    await closeThemePopover(page);
    await expectThemeAttributes(page, { theme: 'dark' }, 'TU-303 切深色');
    await expectTerminalFollowsTheme(page, { label: '深色' });

    await openThemePopover(page);
    await pickTone(page, '浅色');
    await closeThemePopover(page);
    await expectThemeAttributes(page, { theme: 'light' }, 'TU-303 切回浅色');
    await expectTerminalFollowsTheme(page, { label: '切回浅色' });

    const palette = await probeTerminalPalette(page);
    for (let i = 0; i < ANSI_KEYS.length; i += 1) {
      expect(sameColor(palette.ansi[i], CONTRACT_BASE.light[ANSI_KEYS[i]]),
        `切回浅色后 ANSI ${ANSI_KEYS[i]} 必须回到浅色档常量（实测 ${palette.ansi[i]}）`).toBe(true);
    }
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

test('TU-304 触发②（同档换家族）：只改 data-cgui-theme 时终端也要跟着变，ANSI 不变', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);
    await expectTerminalFollowsTheme(page, { label: '初始（默认家族）' });
    const before = await probeTerminalPalette(page);
    const attrsBefore = await readThemeAttributes(page);

    await openThemePopover(page);
    await pickThemeFamily(page, '暖陶');
    await closeThemePopover(page);

    // 「同档换家族」的判据是**只有 data-cgui-theme 变**：明暗档那两项保持不变。
    // 不写死具体是哪一档 —— 应用默认档是 auto（跟随系统），本机系统偏好一变档就变，
    // 写死 'light' 是假红（设计期实测：默认 data-theme=auto）。
    const attrs = await readThemeAttributes(page);
    expect(attrs.theme, '本用例只改家族，明暗档不得跟着变').toBe(attrsBefore.theme);
    expect(attrs.system, '本用例只改家族，系统档位标识不得跟着变').toBe(attrsBefore.system);
    expect(attrs.family, '同档换家族只改 data-cgui-theme（换到暖陶家族，具体变体随明暗档走）').toMatch(/^claude/);
    expect(attrs.family, '家族必须真的换了').not.toBe(attrsBefore.family);

    await expectTerminalFollowsTheme(page, { label: '换成暖陶家族后' });
    const after = await probeTerminalPalette(page);
    const bgBefore = before.backgroundInline || before.backgroundComputed;
    const bgAfter = after.backgroundInline || after.backgroundComputed;
    expect(sameColor(bgAfter, bgBefore),
      `换家族后终端背景必须真的变了（默认家族 ${bgBefore} → 暖陶家族 ${bgAfter}）`).toBe(false);
    for (let i = 0; i < ANSI_KEYS.length; i += 1) {
      expect(sameColor(after.ansi[i], before.ansi[i]),
        `§A.2 ⑨ 同档换家族不得改变 ANSI ${ANSI_KEYS[i]}（它是常量槽）`).toBe(true);
    }
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

test('TU-305 触发④（系统明暗）：data-theme=auto 时翻 data-theme-system，已打开的终端跟着翻', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);

    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'auto');
      document.documentElement.setAttribute('data-theme-system', 'light');
    });
    const light = await expectTerminalFollowsTheme(page, { label: 'auto + 系统浅色' });
    expect(light.mode, 'auto + data-theme-system=light → 按 light 合成').toBe('light');

    await page.evaluate(() => document.documentElement.setAttribute('data-theme-system', 'dark'));
    const dark = await expectTerminalFollowsTheme(page, { label: 'auto + 系统深色' });
    expect(dark.mode, 'auto + data-theme-system=dark → 按 dark 合成').toBe('dark');

    const palette = await probeTerminalPalette(page);
    for (let i = 0; i < ANSI_KEYS.length; i += 1) {
      expect(sameColor(palette.ansi[i], CONTRACT_BASE.dark[ANSI_KEYS[i]]),
        `系统翻到深色后 ANSI ${ANSI_KEYS[i]} 必须切到深色档常量（实测 ${palette.ansi[i]}）`).toBe(true);
    }
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

test('TU-306 §A.3 非法 data-theme + data-theme-system=dark：按"缺席"处理 → 用深色档合成', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);
    await page.evaluate(() => {
      const root = document.documentElement;
      root.setAttribute('data-theme', 'Dark');   // 非法值：不是 light/dark/auto
      root.setAttribute('data-theme-system', 'dark');
      // 一次真触发（§A.4 订阅的三个属性之一），逼出一次重算
      root.setAttribute('data-cgui-theme', 'claude-warm');
    });
    await pollPalette(page,
      (palette) => sameColor(palette.ansi[0], CONTRACT_BASE.dark.black) || `ANSI[0] 实测 ${palette.ansi[0]} ≠ 期望 ${CONTRACT_BASE["dark"].black}`,
      '§A.3：data-theme="Dark" 必须按"缺席"处理，继续看 data-theme-system=dark → 深色档常量槽');

    const palette = await probeTerminalPalette(page);
    for (let i = 0; i < ANSI_KEYS.length; i += 1) {
      expect(sameColor(palette.ansi[i], CONTRACT_BASE.dark[ANSI_KEYS[i]]),
        `§A.3 非法 data-theme 归类为缺席 → 深色档：${ANSI_KEYS[i]}（实测 ${palette.ansi[i]}）`).toBe(true);
    }
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

test('TU-307 §A.3 非法 data-theme 且无 data-theme-system：按 light 合成（不许查系统偏好）', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);
    await page.evaluate(() => {
      const root = document.documentElement;
      root.setAttribute('data-theme', 'LIGHT');   // 非法值
      root.removeAttribute('data-theme-system');
      root.setAttribute('data-cgui-theme', 'claude-warm');
    });
    await pollPalette(page,
      (palette) => sameColor(palette.ansi[0], CONTRACT_BASE.light.black) || `ANSI[0] 实测 ${palette.ansi[0]} ≠ 期望 ${CONTRACT_BASE["light"].black}`,
      '§A.3：data-theme 非法 + 无 data-theme-system → 一律 light（不得查 matchMedia）');
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

test('TU-308 §A.4 反向：拖 --ui-zoom / --surface-alpha 不得触发终端重算', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);
    await expectTerminalFollowsTheme(page, { label: '基线' });
    const before = await probeTerminalPalette(page);

    // 往 <html> 的 style 上写一串"跟配色无关"的变量（§A.4 明确这些不得触发回调）
    await page.evaluate(() => {
      const root = document.documentElement;
      root.style.setProperty('--ui-zoom', '1.2');
      root.style.setProperty('--surface-alpha', '0.5');
    });
    // 反向用例需要一段"没发生"的观察窗：先让 MutationObserver 的微任务与两帧 rAF 都跑完
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
    }));

    const after = await probeTerminalPalette(page);
    expect(sameColor(after.backgroundInline || after.backgroundComputed, before.backgroundInline || before.backgroundComputed),
      '§A.4：只改 <html> 的 style（--ui-zoom/--surface-alpha）不得触发终端重算').toBe(true);
    expect(sameColor(after.foreground, before.foreground), '§A.4 同上：前景不得变').toBe(true);

    // 阳性对照：证明这条"更新通路"此刻是活的（否则上面那条是恒真断言）
    await page.evaluate(() => {
      const root = document.documentElement;
      if (root.getAttribute('data-cgui-theme') === 'claude-warm') root.removeAttribute('data-cgui-theme');
      else root.setAttribute('data-cgui-theme', 'claude-warm');
    });
    await expectTerminalFollowsTheme(page, { label: '阳性对照：真触发一次' });
    const touched = await probeTerminalPalette(page);
    expect(sameColor(touched.backgroundInline || touched.backgroundComputed, before.backgroundInline || before.backgroundComputed),
      '阳性对照：真改家族后终端背景必须变（否则说明"跟着主题变"这条通路根本没在工作）').toBe(false);
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

test('TU-309 §A.7 渲染落地：渲染层读到的光标/选中色确实来自本次主题，且按实测值复算达标', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);
    for (const tone of ['浅色', '深色']) {
      if (tone !== '浅色') {
        await openThemePopover(page);
        await pickTone(page, tone);
        await closeThemePopover(page);
        await expectThemeAttributes(page, { theme: 'dark' }, 'TU-309 切深色');
      }
      const { mode, expected } = await expectTerminalFollowsTheme(page, { label: `渲染落地（${tone}）` });
      const palette = await probeTerminalPalette(page);

      // 6 个 token 槽：渲染层实际拿到的色必须是按 §A.2 规则算出来的
      expect(sameColor(palette.cursor, expected.cursor),
        `§A.2 cursor 兜底规则：期望 ${expected.cursor}（accent 对比度不够时回落 foreground），实测 ${palette.cursor}（${mode}）`).toBe(true);
      expect(sameColor(palette.cursorAccent, expected.cursorAccent),
        `§A.2 cursorAccent 恒为 background：期望 ${expected.cursorAccent}，实测 ${palette.cursorAccent}`).toBe(true);
      expect(palette.selectionRuleCount, '§A.7 需要激活态与失焦态两条选中色都在渲染层里').toBeGreaterThanOrEqual(2);
      expect(sameColor(palette.selectionActive, expected.selectionActiveOpaque),
        `§A.7 激活态选中色：期望 xterm 合成后的 ${JSON.stringify(expected.selectionActiveOpaque)}，实测 ${palette.selectionActive}`).toBe(true);
      expect(sameColor(palette.selectionInactive, expected.selectionInactiveOpaque),
        `§A.7 失焦态选中色：期望 ${JSON.stringify(expected.selectionInactiveOpaque)}，实测 ${palette.selectionInactive}`).toBe(true);

      // 判据 1~6：按**渲染层实测值**复算（不是按常量表）
      const bg = palette.backgroundInline || palette.backgroundComputed;
      expect(cr(palette.foreground, bg), `§A.7 判据 1（${tone}，实测值）`).toBeGreaterThanOrEqual(THRESHOLD.foregroundBackground);
      for (let i = 0; i < ANSI_KEYS.length; i += 1) {
        expect(cr(palette.ansi[i], bg),
          `§A.7 判据 2：ANSI ${ANSI_KEYS[i]} 实测 ${palette.ansi[i]} 对实测底色 ${bg} 的可读性`).toBeGreaterThanOrEqual(THRESHOLD.ansi);
      }
      expect(cr(palette.cursor, bg), `§A.7 判据 3（${tone}，实测值）`).toBeGreaterThanOrEqual(THRESHOLD.cursorBackground);
      expect(cr(palette.cursorAccent, palette.cursor), `§A.7 判据 4（${tone}，实测值）`).toBeGreaterThanOrEqual(THRESHOLD.cursorAccentCursor);
      expect(cr(palette.selectionActive, bg), `§A.7 判据 5：激活态选中区必须看得出来（${tone}，实测值）`).toBeGreaterThanOrEqual(THRESHOLD.selectionContrast);
      expect(cr(palette.foreground, palette.selectionActive), `§A.7 判据 6 激活态：选中文字（${tone}）`).toBeGreaterThanOrEqual(THRESHOLD.selectionText);
      expect(cr(palette.foreground, palette.selectionInactive), `§A.7 判据 6 失焦态：选中文字（${tone}）`).toBeGreaterThanOrEqual(THRESHOLD.selectionText);
    }
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

test('TU-310 成功标准 3：终端里跑一条彩色输出命令，彩色文字用的是本轮 ANSI 调色板，两种主题下都看得清', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);
    // 合同入口：面板打开后提示符可见即可直接输入（同 FB 套件的终端输入路径）
    await page.keyboard.type("printf '\\033[31mTU_RED_MARK\\033[0m \\033[32mTU_GREEN_MARK\\033[0m \\033[34mTU_BLUE_MARK\\033[0m\\n'");
    await page.keyboard.press('Enter');
    await expect(page.getByText('TU_RED_MARK').first(), '彩色命令的输出必须出现在终端里').toBeVisible({ timeout: 20_000 });

    for (const tone of ['浅色', '深色']) {
      if (tone !== '浅色') {
        await openThemePopover(page);
        await pickTone(page, tone);
        await closeThemePopover(page);
        await expectThemeAttributes(page, { theme: 'dark' }, 'TU-310 切深色');
      }
      await expectTerminalFollowsTheme(page, { label: `彩色输出（${tone}）` });
      const palette = await probeTerminalPalette(page);
      const bg = palette.backgroundInline || palette.backgroundComputed;
      for (const marker of ['TU_RED_MARK', 'TU_GREEN_MARK', 'TU_BLUE_MARK']) {
        const color = await markerColor(page, marker);
        expect(color, `彩色输出的 ${marker} 必须能在渲染层读到颜色`).toBeTruthy();
        expect(ANSI_KEYS.some((_, i) => sameColor(palette.ansi[i], color)),
          `BRIEF R38.3：${marker} 的颜色必须来自本轮 ANSI 调色板（不是默认前景）。实测 ${color}，调色板 ${JSON.stringify(palette.ansi)}`).toBe(true);
        expect(sameColor(color, palette.foreground), `${marker} 必须不是默认前景色（否则等于没上色）`).toBe(false);
        expect(cr(color, bg), `BRIEF R38.3/§A.7 判据 2：${marker}（${tone}）必须看得清（实测 ${color}，底色 ${bg}）`)
          .toBeGreaterThanOrEqual(THRESHOLD.ansi);
      }
    }
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

/** 内置皮肤（T2 代码皮肤）只在「开发者皮肤(本机)」开关打开后才可应用；首次启用要过确认框。 */
function skinUi(page) {
  return {
    tab: page.getByRole('tab', { name: '皮肤' }),
    section: page.locator('[data-cgui-skin-section]'),
    toggle: page.locator('[data-cgui-skin-section] input[type="checkbox"]').first(),
    confirm: page.getByRole('dialog').getByRole('button', { name: '我明白,启用', exact: true }),
    ack: page.getByRole('dialog').getByRole('button', { name: '知道了', exact: true }),
  };
}

/**
 * 打开「皮肤」页并确保「开发者皮肤(本机)」开关是开的。
 * 首次启用会弹确认框（`SkinPanel.ensureDevSkins`，确认键文案 `我明白,启用`）；确认框是 portal 到
 * body 的，点它会被主题弹层的"外点即关"判定吃掉 → 弹层关掉、SkinSection 卸载。所以这里：
 * 点开关 → （有确认框就确认）→ 由调用方重新打开弹层再取卡片。
 */
async function enableDevSkins(page) {
  const ui = skinUi(page);
  const skinTab = page.getByRole('tab', { name: '皮肤' });
  const openSkinPage = async () => {
    await closeThemePopover(page);
    await openThemePopover(page);        // 页签只在弹层展开后才在 DOM 里
    if (!(await skinTab.count())) {
      throw new EnvironmentBlocked('主题弹层没有「皮肤」页签 → 无法从公开 UI 触发皮肤激活（契约 §A.4 第 4 条）');
    }
    await skinTab.click();
    if (!(await ui.section.count())) {
      throw new EnvironmentBlocked('皮肤页签里没有 data-cgui-skin-section → 无法从公开 UI 触发皮肤激活（契约 §A.4 第 4 条）');
    }
  };
  await openSkinPage();
  if (!(await ui.toggle.count())) {
    throw new EnvironmentBlocked('皮肤区没有「开发者皮肤(本机)」开关 → 内置皮肤不可应用，触发③没有公开制备路径');
  }
  await ui.toggle.click({ force: true });
  // 要么出现确认框，要么开关已直接打开（两种都算"前置满足"；轮询避免固定等待）
  await expect.poll(async () => {
    if (await ui.confirm.count()) return 'dialog';
    if (await ui.toggle.isChecked().catch(() => false)) return 'checked';
    return 'waiting';
  }, { timeout: 10_000, message: '点「开发者皮肤」开关后，要么出现确认框、要么开关直接打开' }).not.toBe('waiting');
  if (await ui.confirm.count()) {
    // 确认框是 portal 到 body 的 → 这一击会被主题弹层的"外点即关"判定吃掉，弹层连同开关一起卸载，
    // 所以不能在原地断言开关状态，必须重开「皮肤」页去看（这也是真实用户看到的样子）。
    await ui.confirm.click();
  }
  await openSkinPage();
  await expect(ui.toggle, '启用后「开发者皮肤(本机)」开关必须处于打开状态').toBeChecked({ timeout: 10_000 });
  await closeThemePopover(page);
}

test('TU-311 触发③（皮肤激活）：皮肤是唯一经 subscribeSkin 通知的配色来源', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  await enableDevSkins(page);
  const ui = skinUi(page);

  try {
    await openTerminalPanel(page);
    await expectTerminalFollowsTheme(page, { label: '皮肤前的终端' });
    const before = await probeTerminalPalette(page);

    await openThemePopover(page);
    await ui.tab.click();
    // 优先「试穿」（不保存，刷新即回 —— 对测试隔离更干净）；没有就退到「应用」。
    // 不用 .or()：两张卡各有一对按钮时它会同时命中两个，click 会被 strict mode 拦下。
    const tryOn = ui.section.getByRole('button', { name: '试穿', exact: true }).first();
    const applyAndKeep = ui.section.getByRole('button', { name: '应用', exact: true }).first();
    const applyButton = (await tryOn.count()) ? tryOn : applyAndKeep;
    if (!(await applyButton.count())) {
      throw new EnvironmentBlocked('开启「开发者皮肤」后仍没有可点的「试穿/应用」按钮 → 触发③没有公开制备路径');
    }
    await applyButton.click();
    // T2 代码层若被安全校验拦下会弹一条"知道了"通知（颜色变量部分仍会应用，不影响本用例判据）；
    // 出现就点掉，别让它挡住后面的取证。
    if (await ui.ack.count()) await ui.ack.first().click().catch(() => null);
    await closeThemePopover(page);

    // 皮肤激活 = 往 <html> 写内联配色变量（§F#2：皮肤是唯一往 documentElement 写内联样式色的机制）
    await expect.poll(async () => await page.evaluate(() => document.documentElement.getAttribute('data-cgui-skin')),
      { timeout: 15_000, message: '点「试穿/应用」后 <html> 上必须出现 data-cgui-skin（皮肤已激活的证据）' })
      .not.toBeNull();

    const tokens = await readRootTokens(page, ['--color-canvas']);
    await pollPalette(page,
      (palette) => sameColor(palette.backgroundInline || palette.backgroundComputed, tokens['--color-canvas'])
        || `background 实测 ${palette.backgroundInline || palette.backgroundComputed} ≠ 皮肤改过的 --color-canvas ${tokens['--color-canvas']}`,
      '§A.4 第 4 条：皮肤被激活后终端必须跟着重算（底色跟随皮肤改过的 --color-canvas）');

    const after = await probeTerminalPalette(page);
    expect(sameColor(after.backgroundInline || after.backgroundComputed, before.backgroundInline || before.backgroundComputed),
      '皮肤必须真的改变了终端配色（否则这条用例等于没测到触发③）').toBe(false);
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});
