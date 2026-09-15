// TU-1xx：R38 终端配色的**纯逻辑面**（契约 §A.1 / §A.2 / §A.5 / §A.6 / §A.7；用例号对应 §A.8）。
//
// 黑盒取法：只 import 契约点名的模块 `client/src/utils/terminalTheme.js`，只调它公布的那几个导出。
// 本文件不读实现源码、不看 JSX，全部判据来自契约的定稿值表与阈值表。
//
// 为什么对比度在这层判：契约 §A.7「验证口径」把常量槽（16 ANSI）与 token 槽（6 个）的达标
// 判据定义在**合成结果的色值**上（§A.8 P6 明写"对 §A.1 两张定稿表跑 §A.7 判据"），
// 不是定义在浏览器像素上。取色来源断言（TU-107/108/109）与对比度断言（TU-117~120）**刻意分成两组**，
// 这是契约 §6.5.1 的要求（"一组用例不得同时担两责"）。
import { test, expect } from '@playwright/test';
import {
  requireTerminalThemeModule,
  CONTRACT_BASE, THEME_KEYS, ANSI_KEYS, TOKEN_SLOT_KEYS,
  THRESHOLD, REFERENCE_BACKGROUNDS, TOKEN_PRESETS,
  TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE,
  isValidColorValue, INVALID_COLOR_VALUES, cr, sameColor, selectionOnTop,
} from './helpers/tu-runtime.mjs';

/** 契约 §A.2 的 6 槽 → token 名（唯一真相，逐字抄自 §A.2 表）。 */
const SLOT_TO_TOKEN = {
  background: '--color-canvas',
  foreground: '--color-ink',
  cursorAccent: '--color-canvas',
  selectionBackground: '--color-accent-muted',
  selectionInactiveBackground: '--color-accent-subtle',
  cursor: '--color-accent',
};

/** §A.8 P3 的入参（逐字）。 */
const P3_TOKENS = {
  '--color-canvas': '#FAF7F2',
  '--color-ink': '#1A1A1A',
  '--color-accent': '#D97757',
  '--color-accent-muted': 'rgba(217,119,87,0.28)',
  '--color-accent-subtle': 'rgba(217,119,87,0.12)',
};

// ---------------------------------------------------------------------------
// §A.1 基座常量
// ---------------------------------------------------------------------------

test('TU-101 §A.1 基座形状：light/dark 各恰好 22 键，值都是非空字符串且过色值文法', async () => {
  const mod = await requireTerminalThemeModule();
  const base = mod.TERMINAL_THEME_BASE;
  expect(base, 'TERMINAL_THEME_BASE 必须是 {light,dark}').toBeTruthy();
  for (const mode of ['light', 'dark']) {
    const theme = base[mode];
    expect(theme, `TERMINAL_THEME_BASE.${mode}`).toBeTruthy();
    expect(Object.keys(theme).sort(), `§A.1 ${mode} 必须恰好 22 个键（多一个少一个都不行，§E 明确不产出 scrollbarSlider*/overviewRulerBorder）`)
      .toEqual([...THEME_KEYS].sort());
    for (const key of THEME_KEYS) {
      expect(typeof theme[key], `§A.1 ${mode}.${key} 必须是非空字符串`).toBe('string');
      expect(theme[key].length, `§A.1 ${mode}.${key} 不得为空串`).toBeGreaterThan(0);
      expect(isValidColorValue(theme[key]), `§A.1 ${mode}.${key}=${JSON.stringify(theme[key])} 必须过 §A.6 色值文法`).toBe(true);
    }
  }
  expect(base.light, '§A.1 light 与 dark 必须是两个不同对象').not.toBe(base.dark);
});

test('TU-102 §A.1 定稿值：两档 22 键逐一等于契约表的值', async () => {
  const mod = await requireTerminalThemeModule();
  const base = mod.TERMINAL_THEME_BASE;
  for (const mode of ['light', 'dark']) {
    for (const key of THEME_KEYS) {
      expect(base[mode][key], `§A.1 定稿值 ${mode}.${key}（合同表逐字）`).toBe(CONTRACT_BASE[mode][key]);
    }
  }
});

test('TU-103 §A.1 两档必须是两套不同调色板（16 ANSI 不得完全相同）', async () => {
  const mod = await requireTerminalThemeModule();
  const { light, dark } = mod.TERMINAL_THEME_BASE;
  const same = ANSI_KEYS.filter(key => sameColor(light[key], dark[key]));
  expect(same, `§A.1 要求两套不同调色板；这些 ANSI 键两档取值相同：${same.join(', ')}`).toEqual([]);
  for (const key of ['background', 'foreground', 'black', 'white', 'brightBlack', 'brightWhite']) {
    expect(light[key], `§A.1 点名的六键之一必须两档不同：${key}`).not.toBe(dark[key]);
  }
});

test('TU-104 §A.1 基座不可变（Object.freeze）', async () => {
  const mod = await requireTerminalThemeModule();
  expect(Object.isFrozen(mod.TERMINAL_THEME_BASE.light), '§A.1 明写对象应 Object.freeze（测试可断言不可变）：light').toBe(true);
  expect(Object.isFrozen(mod.TERMINAL_THEME_BASE.dark), '§A.1 明写对象应 Object.freeze（测试可断言不可变）：dark').toBe(true);
});

// ---------------------------------------------------------------------------
// §A.2 resolveTerminalTheme —— 取色来源
// ---------------------------------------------------------------------------

test('TU-105 §A.2 P1 无参调用：语义等于 light 基座，且是新对象', async () => {
  const mod = await requireTerminalThemeModule();
  const theme = mod.resolveTerminalTheme();
  const base = mod.TERMINAL_THEME_BASE.light;
  for (const key of THEME_KEYS) expect(theme[key], `TU-105 ${key}`).toBe(base[key]);
  expect(theme, '§A.2 ⑦ 每次调用必须是新对象引用').not.toBe(base);
});

test('TU-106 §A.2 P2 mode=dark：语义等于 dark 基座，与 light 结果不同引用', async () => {
  const mod = await requireTerminalThemeModule();
  const dark = mod.resolveTerminalTheme({ mode: 'dark' });
  for (const key of THEME_KEYS) {
    expect(dark[key], `TU-106 dark.${key}`).toBe(mod.TERMINAL_THEME_BASE.dark[key]);
  }
  expect(dark, '同一模块两次不同档的结果不得是同一引用').not.toBe(mod.resolveTerminalTheme({ mode: 'light' }));
});

test('TU-107 §A.2 P3 六槽 token 覆盖关系：只有这 6 个槽会被 token 覆盖，16 ANSI 恒定', async () => {
  const mod = await requireTerminalThemeModule();
  const theme = mod.resolveTerminalTheme({ mode: 'light', tokens: P3_TOKENS });
  const base = mod.TERMINAL_THEME_BASE.light;

  expect(theme.background, '§A.2 --color-canvas → background').toBe(P3_TOKENS['--color-canvas']);
  expect(theme.foreground, '§A.2 --color-ink → foreground').toBe(P3_TOKENS['--color-ink']);
  expect(theme.cursorAccent, '§A.2 cursorAccent 与 background 同源').toBe(P3_TOKENS['--color-canvas']);
  expect(theme.selectionBackground, '§A.2 --color-accent-muted → selectionBackground').toBe(P3_TOKENS['--color-accent-muted']);
  expect(theme.selectionInactiveBackground, '§A.2 --color-accent-subtle → selectionInactiveBackground').toBe(P3_TOKENS['--color-accent-subtle']);
  expect(theme.cursor, '§A.2 ⑩ CR(#D97757,#FAF7F2)=2.92<3.0 → cursor 必须回落成合成结果里的 foreground').toBe(P3_TOKENS['--color-ink']);

  for (const key of ANSI_KEYS) {
    expect(theme[key], `§A.2 ⑨ ${key} 是常量槽：tokens 给什么都不许变`).toBe(base[key]);
  }
});

test('TU-108 §A.2 P4 对比度够时 cursor 保留 accent（不得一律回落）', async () => {
  const mod = await requireTerminalThemeModule();
  const tokens = { '--color-accent': '#0969DA', '--color-canvas': '#FFFFFF', '--color-ink': '#24292F' };
  const theme = mod.resolveTerminalTheme({ mode: 'light', tokens });
  expect(cr('#0969DA', '#FFFFFF'), '自证：CR(#0969DA,#FFFFFF)=5.19 ≥ 3.0').toBeGreaterThanOrEqual(THRESHOLD.cursorBackground);
  expect(theme.cursor, '§A.2 ⑩ cursor 保留 accent').toBe('#0969DA');
  expect(theme.cursorAccent, 'cursorAccent 恒为 background').toBe('#FFFFFF');
  expect(theme.foreground, 'foreground 取 --color-ink').toBe('#24292F');
  for (const key of ANSI_KEYS) expect(theme[key], `TU-108 ${key} 仍取常量`).toBe(mod.TERMINAL_THEME_BASE.light[key]);
});

test('TU-109 §A.2 N12 cursor 兜底后判据 3/4 仍成立（推论，任意输入都要成立）', async () => {
  const mod = await requireTerminalThemeModule();
  const theme = mod.resolveTerminalTheme({ mode: 'light', tokens: P3_TOKENS });
  expect(theme.cursor, 'N12 cursor === foreground').toBe('#1A1A1A');
  expect(theme.cursorAccent, 'N12 cursorAccent === background').toBe('#FAF7F2');
  expect(cr(theme.cursor, theme.background), '§A.2 推论：CR(cursor, background) ≥ 3.0').toBeGreaterThanOrEqual(THRESHOLD.cursorBackground);
  expect(cr(theme.cursorAccent, theme.cursor), '§A.2 推论：CR(cursorAccent, cursor) ≥ 3.0').toBeGreaterThanOrEqual(THRESHOLD.cursorAccentCursor);
});

// ---------------------------------------------------------------------------
// §A.2 错误契约
// ---------------------------------------------------------------------------

const EMPTY_TOKEN_CASES = [
  ['① 空 token 值', { '--color-canvas': '' }, 'background'],
  ['② 纯空白 token 值', { '--color-canvas': '   ' }, 'background'],
  ['② 缺失该 token', {}, 'background'],
];
for (const [label, tokens, slot] of EMPTY_TOKEN_CASES) {
  test(`TU-110 §A.2 ${label}：该槽回落到 base，不抛、不产生空串`, async () => {
    const mod = await requireTerminalThemeModule();
    const theme = mod.resolveTerminalTheme({ mode: 'light', tokens });
    expect(theme[slot], `§A.2 错误契约：${slot} 必须回落到 TERMINAL_THEME_BASE.light.${slot}`)
      .toBe(mod.TERMINAL_THEME_BASE.light[slot]);
    expect(typeof theme[slot] === 'string' && theme[slot].length > 0, '不得产生空串/undefined').toBe(true);
  });
}

test('TU-111 §A.2 ③/N9 非法色值：该槽回落 base，其余槽不受影响，整体不抛', async () => {
  const mod = await requireTerminalThemeModule();
  const base = mod.TERMINAL_THEME_BASE.light;
  for (const bad of INVALID_COLOR_VALUES) {
    let theme;
    expect(() => { theme = mod.resolveTerminalTheme({ mode: 'light', tokens: { '--color-canvas': bad, '--color-ink': '#123456' } }); },
      `§A.2 ③ 非法值 ${JSON.stringify(bad)} 不得抛`).not.toThrow();
    expect(theme.background, `§A.2 ③ 非法值 ${JSON.stringify(bad)}：background 必须回落 base（非法值绝不能透传给 xterm）`)
      .toBe(base.background);
    expect(theme.foreground, `§A.2 ③ 非法值 ${JSON.stringify(bad)}：其余槽仍正常覆盖`).toBe('#123456');
  }
});

test('TU-112 §A.2 N3/N4 非字符串 token 值 / 与槽无关的 token 键：一律不影响结果', async () => {
  const mod = await requireTerminalThemeModule();
  const base = mod.TERMINAL_THEME_BASE.light;
  const theme = mod.resolveTerminalTheme({
    mode: 'light',
    tokens: { '--color-error': 'javascript:alert(1)', '--color-canvas': 123, '--color-ink': null },
  });
  expect(theme.background, 'N4 非字符串（数字）必须回落 base').toBe(base.background);
  expect(theme.foreground, 'N3/N4 非字符串（null）必须回落 base').toBe(base.foreground);
  for (const key of ANSI_KEYS) {
    expect(theme[key], `§A.2 ⑨ --color-error 不得影响 ${key}（ANSI 恒取常量）`).toBe(base[key]);
  }
  expect(theme.cursor, 'cursor 候选非法 → 用 base.cursor').toBe(base.cursor);
});

const ILLEGAL_MODE_CASES = [
  ['auto', '④ mode=auto 按 light'],
  ['Dark', '⑤ 大小写非法'],
  ['LIGHT', '⑤ 大小写非法'],
  ['system', '⑤ 未知档名'],
  [undefined, '⑤ 缺失'],
  [123, '⑤ 非字符串'],
  ['', '⑤ 空串'],
];
for (const [mode, label] of ILLEGAL_MODE_CASES) {
  test(`TU-113 §A.2 mode=${JSON.stringify(mode)}（${label}）：不得猜系统偏好，也不得抛`, async () => {
    const mod = await requireTerminalThemeModule();
    const theme = mod.resolveTerminalTheme({ mode });
    for (const key of THEME_KEYS) {
      expect(theme[key], `§A.2 ④⑤ 非法 mode=${JSON.stringify(mode)} 必须完全按 light 合成：${key}`)
        .toBe(mod.TERMINAL_THEME_BASE.light[key]);
    }
  });
}

const NON_OBJECT_TOKEN_CASES = [
  ['tokens=null', null],
  ['tokens=字符串', 'x'],
  ['tokens=数组', [1, 2]],
  ['tokens=数字', 42],
];
for (const [label, tokens] of NON_OBJECT_TOKEN_CASES) {
  test(`TU-114 §A.2 ⑥/N7 ${label}：全用 base，不抛`, async () => {
    const mod = await requireTerminalThemeModule();
    let theme;
    expect(() => { theme = mod.resolveTerminalTheme({ mode: 'dark', tokens }); }, '§A.2 ⑥ 不得抛').not.toThrow();
    for (const key of THEME_KEYS) {
      expect(theme[key], `§A.2 ⑥ tokens 非对象时 ${key} 取 base`).toBe(mod.TERMINAL_THEME_BASE.dark[key]);
    }
  });
}

const BAD_INPUT_CASES = [
  ['N8 resolveTerminalTheme(null)', null],
  ['N8 resolveTerminalTheme(42)', 42],
  ['N8 resolveTerminalTheme("x")', 'x'],
  ['N8 resolveTerminalTheme([])', []],
];
for (const [label, input] of BAD_INPUT_CASES) {
  test(`TU-115 §A.2 ⑧ ${label}：整体不抛，返回 light 基座`, async () => {
    const mod = await requireTerminalThemeModule();
    let theme;
    expect(() => { theme = mod.resolveTerminalTheme(input); }, '§A.2 ⑧ 任何输入都不得抛异常').not.toThrow();
    for (const key of THEME_KEYS) {
      expect(theme[key], `TU-115 ${key}`).toBe(mod.TERMINAL_THEME_BASE.light[key]);
    }
  });
}

test('TU-116 §A.2 ⑦/P5 返回对象引用不变量：连续两次调用必不相等，且值都是非空字符串', async () => {
  const mod = await requireTerminalThemeModule();
  const input = { mode: 'dark', tokens: { '--color-canvas': '#101010' } };
  const a = mod.resolveTerminalTheme(input);
  const b = mod.resolveTerminalTheme(input);
  expect(a, '§A.2 ⑦ 即使入参完全相同，两次调用也必须 notStrictEqual').not.toBe(b);
  expect(a).toEqual(b);
  for (const key of THEME_KEYS) {
    expect(typeof b[key], `§A.2 ⑦ ${key} 必须是非空字符串`).toBe('string');
    expect(b[key].length).toBeGreaterThan(0);
  }
});

const ALPHA_CASES = [
  ['N13 α 越界（0.85）', 'rgba(0,0,0,0.85)', false],
  ['判据 7 α 下界 0.10（含）', 'rgba(0,0,0,0.10)', true],
  ['判据 7 α 上界 0.60（含）', 'rgba(0,0,0,0.60)', true],
  ['判据 7 α 低于下界 0.09', 'rgba(0,0,0,0.09)', false],
];
for (const [label, value, inRange] of ALPHA_CASES) {
  test(`TU-117 §A.2/§A.7 判据 7 ${label}：越界即该槽回落 base`, async () => {
    const mod = await requireTerminalThemeModule();
    const base = mod.TERMINAL_THEME_BASE.light;
    const theme = mod.resolveTerminalTheme({
      mode: 'light',
      tokens: { '--color-accent-muted': value, '--color-accent-subtle': value },
    });
    const expectBase = !inRange;
    expect(theme.selectionBackground,
      `§A.6 额外约束：selection 的 α 必须 ∈[0.10,0.60]，越界回落；实测 ${value}`)
      .toBe(expectBase ? base.selectionBackground : value);
    expect(theme.selectionInactiveBackground,
      `§A.6 额外约束：selectionInactiveBackground 同规则；实测 ${value}`)
      .toBe(expectBase ? base.selectionInactiveBackground : value);
  });
}

test('TU-118 §A.6 明列的真实越界值：:root 默认浅色 --color-accent-subtle=rgba(0,0,0,0.06) 必须回落基座', async () => {
  const mod = await requireTerminalThemeModule();
  const base = mod.TERMINAL_THEME_BASE.light;
  const theme = mod.resolveTerminalTheme({
    mode: 'light',
    tokens: { '--color-accent-subtle': 'rgba(0, 0, 0, 0.06)', '--color-accent-muted': 'rgba(0, 0, 0, 0.16)' },
  });
  expect(theme.selectionInactiveBackground,
    '§A.6 仓内真实越界值（α=0.06）必须回落基座 rgba(0,0,0,0.12)').toBe(base.selectionInactiveBackground);
  expect(theme.selectionBackground, '同批给的合法值（α=0.16）应正常覆盖').toBe('rgba(0, 0, 0, 0.16)');
});

// ---------------------------------------------------------------------------
// §A.7 对比度（与取色来源分开的第二组）
// ---------------------------------------------------------------------------

test('TU-119 §A.7 判据 1/2 常量槽：两档 × 两套参考底色，前景 ≥4.5、16 ANSI 各自 ≥3.0', async () => {
  const mod = await requireTerminalThemeModule();
  for (const mode of ['light', 'dark']) {
    const base = mod.TERMINAL_THEME_BASE[mode];
    for (const bg of REFERENCE_BACKGROUNDS[mode]) {
      expect(cr(base.foreground, bg), `§A.7 判据 1：CR(foreground, ${bg}) ≥ 4.5（${mode}）`)
        .toBeGreaterThanOrEqual(THRESHOLD.foregroundBackground);
      for (const key of ANSI_KEYS) {
        const value = cr(base[key], bg);
        expect(value, `§A.7 判据 2：CR(${mode}.${key}=${base[key]}, 参考底色 ${bg}) ≥ 3.0（实际 ${value}）`)
          .toBeGreaterThanOrEqual(THRESHOLD.ansi);
      }
    }
  }
});

test('TU-120 §A.7 判据 3/4 cursor 槽：基座两档 + claude-warm 兜底点都达标', async () => {
  const mod = await requireTerminalThemeModule();
  for (const mode of ['light', 'dark']) {
    const base = mod.TERMINAL_THEME_BASE[mode];
    expect(cr(base.cursor, base.background), `§A.7 判据 3（${mode} 基座）`).toBeGreaterThanOrEqual(THRESHOLD.cursorBackground);
    expect(cr(base.cursorAccent, base.cursor), `§A.7 判据 4（${mode} 基座）`).toBeGreaterThanOrEqual(THRESHOLD.cursorAccentCursor);
  }
  // §A.7「验证口径」点名的已知回落点：claude-warm / 默认深色
  const claudeWarm = mod.resolveTerminalTheme({ mode: 'light', tokens: TOKEN_PRESETS[0].tokens });
  expect(claudeWarm.cursor, '§A.7 点名：claude-warm 的 cursor 必须回落成 foreground').toBe('#1A1A1A');
  expect(cr(claudeWarm.cursor, claudeWarm.background), '§A.7 判据 3（claude-warm 合成后）').toBeGreaterThanOrEqual(THRESHOLD.cursorBackground);
  expect(cr(claudeWarm.cursorAccent, claudeWarm.cursor), '§A.7 判据 4（claude-warm 合成后）').toBeGreaterThanOrEqual(THRESHOLD.cursorAccentCursor);
});

test('TU-121 §A.7 判据 5/6/6b 基座选中态：激活态区分度 ≥1.20、两种态的文字 ≥3.0；失焦态不套 1.20', async () => {
  const mod = await requireTerminalThemeModule();
  for (const mode of ['light', 'dark']) {
    const base = mod.TERMINAL_THEME_BASE[mode];
    for (const bg of REFERENCE_BACKGROUNDS[mode]) {
      const activeBg = selectionOnTop(base.selectionBackground, bg);
      const inactiveBg = selectionOnTop(base.selectionInactiveBackground, bg);
      const activeContrast = cr(activeBg, bg);
      const activeText = cr(base.foreground, activeBg);
      const inactiveText = cr(base.foreground, inactiveBg);
      expect(activeContrast, `§A.7 判据 5（只判激活态）：CR(selBg, ${bg}) ≥ 1.20（${mode}，实际 ${activeContrast.toFixed(3)}）`)
        .toBeGreaterThanOrEqual(THRESHOLD.selectionContrast);
      expect(activeText, `§A.7 判据 6 激活态：CR(foreground, selBg) ≥ 3.0（${mode}/${bg}）`)
        .toBeGreaterThanOrEqual(THRESHOLD.selectionText);
      expect(inactiveText, `§A.7 判据 6 失焦态：CR(foreground, selInactiveBg) ≥ 3.0（${mode}/${bg}）`)
        .toBeGreaterThanOrEqual(THRESHOLD.selectionText);
    }
  }
});

async function assertTokenPresetContrast(preset) {
  const mod = await requireTerminalThemeModule();
  const theme = mod.resolveTerminalTheme({ mode: preset.mode, tokens: preset.tokens });
  const bg = theme.background;
  expect(cr(theme.foreground, bg), `判据 1：CR(foreground, ${bg}) ≥ 4.5`).toBeGreaterThanOrEqual(THRESHOLD.foregroundBackground);
  expect(cr(theme.cursor, bg), `判据 3：CR(cursor, ${bg}) ≥ 3.0`).toBeGreaterThanOrEqual(THRESHOLD.cursorBackground);
  expect(cr(theme.cursorAccent, theme.cursor), '判据 4：CR(cursorAccent, cursor) ≥ 3.0').toBeGreaterThanOrEqual(THRESHOLD.cursorAccentCursor);
  const activeBg = selectionOnTop(theme.selectionBackground, bg);
  const inactiveBg = selectionOnTop(theme.selectionInactiveBackground, bg);
  expect(cr(activeBg, bg), `判据 5：CR(selBg, ${bg}) ≥ 1.20（实际 ${cr(activeBg, bg)}）`).toBeGreaterThanOrEqual(THRESHOLD.selectionContrast);
  expect(cr(theme.foreground, activeBg), '判据 6 激活态：CR(foreground, selBg) ≥ 3.0').toBeGreaterThanOrEqual(THRESHOLD.selectionText);
  expect(cr(theme.foreground, inactiveBg), '判据 6 失焦态：CR(foreground, selInactiveBg) ≥ 3.0').toBeGreaterThanOrEqual(THRESHOLD.selectionText);
  for (const key of ANSI_KEYS) {
    expect(cr(theme[key], bg), `判据 2：ANSI ${key} 对本次合成底色 ${bg} 也要 ≥3.0（§A.7 验证口径：以本次合成的真实取值）`)
      .toBeGreaterThanOrEqual(THRESHOLD.ansi);
  }
}

for (const preset of TOKEN_PRESETS) {
  test(`TU-122 §A.7 token 槽对比度：预设 ${preset.name} 逐条跑判据 1/2/3/4/5/6`, async () => {
    await assertTokenPresetContrast(preset);
  });
}

// ---------------------------------------------------------------------------
// §A.5 字体常量 / §A.6 文法自证
// ---------------------------------------------------------------------------

test('TU-123 §A.5 字体常量：族与 --font-mono 逐字一致、字号 13', async () => {
  const mod = await requireTerminalThemeModule();
  expect(mod.TERMINAL_FONT_FAMILY, '§A.5 字体族必须与 --font-mono 逐字一致').toBe(TERMINAL_FONT_FAMILY);
  expect(mod.TERMINAL_FONT_SIZE, '§A.5 字号与 CodeBlock 的 text-[13px] 一致').toBe(TERMINAL_FONT_SIZE);
  expect(mod.TERMINAL_FONT_SIZE).toBe(13);
});

test('TU-124 §A.6 文法自证：两档 44 个值全部通过；合同明列的"必须拒绝"清单全部被拒', async () => {
  const mod = await requireTerminalThemeModule();
  for (const mode of ['light', 'dark']) {
    for (const key of THEME_KEYS) {
      expect(isValidColorValue(mod.TERMINAL_THEME_BASE[mode][key]), `TU-124 接受：${mode}.${key}`).toBe(true);
    }
  }
  for (const bad of INVALID_COLOR_VALUES) {
    expect(isValidColorValue(bad), `§A.6 必须拒绝：${JSON.stringify(bad)}`).toBe(false);
  }
  for (const ok of ['#abc', '#abcd', '#aabbcc', '#aabbccdd', 'rgb(0, 0, 0)', 'rgba(1,2,3,0.5)', 'hsl(360, 100%, 50%)', 'hsla(1, 2%, 3%, 1)']) {
    expect(isValidColorValue(ok), `§A.6 必须接受：${JSON.stringify(ok)}`).toBe(true);
  }
});

test('TU-125 §A.2 ⑨ 六槽以外的键名不产生额外键（结果仍然恰好 22 键）', async () => {
  const mod = await requireTerminalThemeModule();
  const theme = mod.resolveTerminalTheme({
    mode: 'dark',
    tokens: { '--color-success': '#00ff00', '--color-error': '#ff0000', '--font-mono': 'x', '--radius-md': '4px' },
  });
  expect(Object.keys(theme).sort(), '§A.2 返回与基座同 22 键同形状（§E 明确不产出额外键）').toEqual([...THEME_KEYS].sort());
  for (const key of TOKEN_SLOT_KEYS) {
    expect(theme[key], `TU-125 未被覆盖的槽 ${key} 取 base`).toBe(mod.TERMINAL_THEME_BASE.dark[key]);
  }
  const slotNames = new Set(Object.values(SLOT_TO_TOKEN));
  expect([...slotNames].sort(), '自证：SLOT_TO_TOKEN 覆盖的 token 名与 §A.2 表一致').toEqual([
    '--color-accent', '--color-accent-muted', '--color-accent-subtle', '--color-canvas', '--color-ink',
  ]);
});
