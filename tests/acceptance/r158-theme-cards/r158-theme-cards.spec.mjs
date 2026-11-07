// r158-theme-cards：展开后的工具卡与回答里的代码块 / Markdown 的颜色跟随主题，工具卡有统一骨架，Bash 终端块，Edit 逐字 diff，代码块折叠与复制。
// 判据全部来自 .devflow/r158-theme-cards-接口.md 的行为清单 B1–B15 和错误契约（E1 / E2），只看页面上用户能看到的东西
// （接口文件列出的 data-* 锚点、公开文案、计算样式）；不读源码、不读 React state。命名：Bn 对应行为清单第 n 条。
// 产品里还没有新钩子时，需要新钩子的用例以「断言失败 / 等不到钩子」变红；B15 读的 data-entry-state 是现有行为，实现前就是绿的。
import { test, expect } from '@playwright/test';
import {
  THEMES, LIGHT, DARK, norm, textOf, copied, openFixture, openFull, releaseAll, expandAllGroups, expandAllCards, scrollToEnd, cardAt, openCard,
  themeSnapshot, themeProblems, lumProblems, contrastProblems, foldColorProblems, cardRoots, mdRoots, parseColor, lum, over,
} from './helpers/ui.mjs';
import { PY_CODE, PY_LINES, BASH_LONG_LINE, GREP_MARKS, LONG_DESC, END_ANCHOR_X } from './helpers/fixtures.mjs';

const NO_CARD = '页面上没有 [data-tool-card]（接口文件点名的钩子还不存在）';
/** 夹具第 1…11 项的 data-tool-name。 */
const TOOL_NAMES = ['Bash', 'Bash', 'Read', 'Edit', 'Write', 'Grep', 'WebFetch', 'mcp__demo__search', 'Bash', 'Bash', 'NotebookEdit'];
const STATES = ['ok', 'err', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'run', 'stopped', 'ok'];

// ───────────────────────── B15（现有行为，实现前就应当绿）─────────────────────────

// 直播会话（f* / e2）的假命令行会停在半路：每条用例收尾都放开闸门，让它自己结束，别拖累下一条。
test.afterEach(async () => { releaseAll(); });

// ───────────────────────── 颜色类：B1 / B2 / B3 / B12（每个主题只采一次快照，四条共用）─────────────────────────
const COLOR_TIMEOUT = 420_000;
async function collect(browser, themes, build) {
  const out = [];
  for (const theme of themes) {
    const snap = await themeSnapshot(browser, theme);
    out.push(...themeProblems(snap, theme), ...build(snap, theme));
  }
  return out;
}
const shape = (snap, theme) => [
  ...(snap.cards.length === 11 ? [] : [`${theme.key}：${NO_CARD}（采到 ${snap.cards.length} 张，应为 11 张）`]),
  ...(snap.pres.length >= 3 ? [] : [`${theme.key}：pre[data-code-block] 只采到 ${snap.pres.length} 个（应 ≥ 3：python / bash / 坏 JSON 的 cgui-ui）`]),
];

test('B1 浅色主题没有黑块：三个浅色主题里工具卡与代码块背景亮度 ≥ 0.70，子树不透明背景与画布亮度差 ≤ 0.35', async ({ browser }) => {
  test.setTimeout(COLOR_TIMEOUT);
  const problems = await collect(browser, LIGHT, (snap, theme) => [...shape(snap, theme), ...lumProblems(snap, theme, cardRoots(snap))]);
  expect(problems, '浅色主题下的工具卡 / 代码块不该有黑块').toEqual([]);
});

test('B2 深色主题没有亮块：四个深色主题里工具卡与代码块背景亮度 ≤ 0.30，子树不透明背景与画布亮度差 ≤ 0.35', async ({ browser }) => {
  test.setTimeout(COLOR_TIMEOUT);
  const problems = await collect(browser, DARK, (snap, theme) => [...shape(snap, theme), ...lumProblems(snap, theme, cardRoots(snap))]);
  expect(problems, '深色主题下的工具卡 / 代码块不该有浅粉 / 浅蓝 / 浅绿的亮块').toEqual([]);
});

test('B3 文字够清楚：七个主题里卡头标题、终端命令 / 输出、代码、diff 行、行内代码对各自背景的对比度 ≥ 4.5', async ({ browser }) => {
  test.setTimeout(COLOR_TIMEOUT);
  const problems = await collect(browser, THEMES, (snap, theme) => [...shape(snap, theme), ...contrastProblems(snap, theme, ['title', 'cmd', 'out', 'code', 'diff', 'inline'])]);
  expect(problems, '各类文字与背景的对比度应 ≥ 4.5').toEqual([]);
});

test('B16 折叠行与正文靠颜色区分：七个主题里工作组头 / 思考折叠行 / 卡头标题的文字对比度 ≥ 4.5，且比正文段落文字低至少 3.0（折叠行比正文淡）', async ({ browser }) => {
  test.setTimeout(COLOR_TIMEOUT);
  const problems = await collect(browser, THEMES, (snap, theme) => foldColorProblems(snap, theme));
  expect(problems, '折叠行文字应比正文淡且仍然清楚').toEqual([]);
});

const differs = (a, b) => ['r', 'g', 'b'].some((k) => Math.abs(a[k] - b[k]) >= 1) || Math.abs(a.a - b.a) >= 0.01;
test('B12 Markdown 跟随主题：引用块非斜体且有左边框，表格圆角 + 斑马纹，行内代码有淡底且与正文同色；它们也满足亮度与对比度要求', async ({ browser }) => {
  test.setTimeout(COLOR_TIMEOUT);
  const problems = await collect(browser, THEMES, (snap, theme) => {
    const k = theme.key; const { bq, table, inline } = snap.md; const out = [];
    if (!bq) out.push(`${k}：找不到 blockquote`);
    else {
      if (bq.fontStyle === 'italic') out.push(`${k}：blockquote font-style 是 italic`);
      if (!(parseFloat(bq.bw) >= 2 && !/^(none|hidden)$/.test(bq.bs))) out.push(`${k}：blockquote 左边框宽 ${bq.bw}、样式 ${bq.bs}（应 ≥ 2px 且可见）`);
    }
    if (!table) out.push(`${k}：找不到 table`);
    else {
      if (!(parseFloat(table.r) > 0 || parseFloat(table.rp) > 0)) out.push(`${k}：表格与紧邻外层容器的 border-radius 都是 0（table=${table.r}，外层=${table.rp}）`);
      const eff = (r) => { const td = r.td ? parseColor(r.td) : null; return td && td.a > 0.01 ? td : parseColor(r.tr); };
      if (table.rows.length < 2) out.push(`${k}：表体行数 ${table.rows.length}，不足以比较奇偶行`);
      else if (!differs(eff(table.rows[0]), eff(table.rows[1]))) out.push(`${k}：表体第 1 行（奇）与第 2 行（偶）背景相同`);
    }
    if (!inline) out.push(`${k}：找不到行内代码 foo()`);
    else {
      if (!(parseColor(inline.bg).a > 0)) out.push(`${k}：行内代码没有底色（背景不透明度 0）`);
      const a = parseColor(inline.fg); const b = parseColor(inline.parentFg);
      if (differs(a, b)) out.push(`${k}：行内代码文字色 ${inline.fg} 与正文文字色 ${inline.parentFg} 不同`);
    }
    return [...out, ...lumProblems(snap, theme, mdRoots(snap)), ...contrastProblems(snap, theme, ['inline', 'bq', 'table'])];
  });
  expect(problems, 'Markdown 元素应跟随主题').toEqual([]);
});

// ───────────────────────── B4 统一骨架 / B5 状态看得出来（完整夹具：f4 / f5，含直播回合里的第 9 项）─────────────────────────
const cardFacts = (page) => page.evaluate(() => [...document.querySelectorAll('[data-tool-card]')].map((c) => {
  const q = (s) => c.querySelector(s);
  const t = (s) => { const e = q(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
  const head = q('[data-tool-card-head]'); const meta = q('[data-tool-card-meta]');
  const parts = ['[data-tool-card-icon]', '[data-tool-card-name]', '[data-tool-card-title]', '[data-tool-card-meta]'].map(q);
  const inOrder = parts.every(Boolean) && parts.every((e, i) => i === 0 || (parts[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  // r158 主会话修订（2026-11-07，用户：所有折叠行都不要展开箭头）：原判据“卡头末尾必须有三角”改为“卡头里没有任何展开箭头”。
  const arrows = head ? [...head.querySelectorAll('svg')].filter((s) => /chevron|caret/i.test(s.getAttribute('class') || '')).length + (/[▸▾▴▶◂]/.test(head.textContent || '') ? 1 : 0) : 0;
  return { tool: c.getAttribute('data-tool-name'), status: c.getAttribute('data-status'), head: !!head, inOrder, arrows, name: t('[data-tool-card-name]'), title: t('[data-tool-card-title]'), meta: t('[data-tool-card-meta]') };
}));
/** 回合里的折叠行（工作组头 / 思考折叠行 / 工具卡头）有没有展开箭头：只数 class 带 chevron / caret 的 svg 与 [data-strip-caret]。 */
const foldArrows = (pg) => pg.evaluate(() => {
  const bad = (s) => /chevron|caret/i.test(s.getAttribute('class') || '');
  const turns = [...document.querySelectorAll('[data-turn-uuid]')];
  return {
    turns: turns.length,
    groups: document.querySelectorAll('[data-work-group-head]').length,
    // 思考折叠行 = 展开的工作组里、不是组头本身、带脑图标的按钮（组里有思考时组头图标也是脑图标，要排除）。
    brains: document.querySelectorAll('[data-work-group-state="open"] button:not([data-work-group-head]) svg[class*="brain" i]').length,
    chevrons: turns.flatMap((t) => [...t.querySelectorAll('svg')]).filter(bad).length,
    carets: document.querySelectorAll('[data-strip-caret]').length,
  };
});
/** 夹具序号 → 期望（小标签 / 标题 / 右侧信息的判据）。 */
const WANT = {
  1: ['Bash', 'ok', 'Bash', (s) => s === '列出目录', (m) => m === ''],
  2: ['Bash', 'err', 'Bash', (s) => s === 'pytest tests/test_refs.py -q', (m) => m === ''],
  3: ['Read', 'ok', 'Read', (s) => s === 'section.md', (m) => m.includes('12 行')],
  4: ['Edit', 'ok', 'Edit', (s) => s === 'section.md', (m) => m.includes('+2') && m.includes('−2')],
  5: ['Write', 'ok', 'Write', (s) => s === 'new.txt', (m) => m.includes('+3') && !m.includes('−')],
  6: ['Grep', 'ok', 'Grep', (s) => s === 'barium', (m) => m.includes('4 行')],
  7: ['WebFetch', 'ok', 'WebFetch', (s) => s === 'https://example.org/a', (m) => m === ''],
  8: ['mcp__demo__search', 'ok', 'demo', (s) => s === 'search', () => true],
  9: ['Bash', 'run', 'Bash', (s) => s === 'sleep 999', (m) => m === ''],
  10: ['Bash', 'stopped', 'Bash', (s) => s.includes('echo stopped'), (m) => m.includes('已停止')],
  11: ['NotebookEdit', 'ok', 'NotebookEdit', (s) => /a\W*1/.test(s), () => true],
};


const sides = (loc) => loc.evaluate((el) => { const cs = getComputedStyle(el); return ['Top', 'Right', 'Bottom', 'Left'].map((s) => ({ w: parseFloat(cs[`border${s}Width`]), st: cs[`border${s}Style`], c: cs[`border${s}Color`] })); });
const shown = (ss) => ss.filter((s) => s.w > 0 && s.st !== 'none' && s.st !== 'hidden');
const red = (ss) => shown(ss).map((s) => { const c = parseColor(s.c); return c.r - c.g; });


// ───────────────────────── B6 Bash 终端块 / B7 复制命令 ─────────────────────────
/** 元素自己和后代里「直接带文字」的节点的最大 红−绿（状态条文字偏红的判据，与 B5 的 红−绿 ≥ 30 同口径）。 */
const textRedness = (loc) => loc.evaluate((el) => {
  const rows = [el, ...el.querySelectorAll('*')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())).map((e) => getComputedStyle(e).color);
  return rows;
}).then((cs) => Math.max(-999, ...cs.map((s) => { const c = parseColor(s); return c.r - c.g; })));

test('B6 Bash 终端块：命令行带 $ 与命令、输出区、状态条（成功 / 退出码 / 无输出），运行中没有状态条', async ({ page }) => {
  await openFull(page, 'f6');
  await expect.poll(async () => await page.locator('[data-tool-card]').count(), { timeout: 10_000, message: NO_CARD }).toBe(11);
  const b1 = await openCard(page, 1);
  const cmd1 = await textOf(b1.locator('[data-term-cmd]'));
  expect([cmd1.includes('$'), cmd1.includes('ls -la /tmp/ws')], `第 1 项 [data-term-cmd]「${cmd1}」应含 $ 与 ls -la /tmp/ws`).toEqual([true, true]);
  const out1 = await textOf(b1.locator('[data-term-out]'));
  expect(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].filter((w) => !new RegExp(`\\b${w}\\b`).test(out1)), `第 1 项 [data-term-out]「${out1}」缺少的输出行`).toEqual([]);
  const foot1 = await textOf(b1.locator('[data-term-foot]'));
  expect([foot1.includes('成功'), foot1.includes('输出 6 行')], `第 1 项 [data-term-foot]「${foot1}」应含「成功」与「输出 6 行」`).toEqual([true, true]);
  const b2 = await openCard(page, 2);
  const foot2 = await textOf(b2.locator('[data-term-foot]'));
  expect([foot2.includes('退出码 1'), foot2.includes('输出 3 行')], `第 2 项 [data-term-foot]「${foot2}」应含「退出码 1」与「输出 3 行」（不计 Exit code 1 那一行）`).toEqual([true, true]);
  const lines2 = (await b2.locator('[data-term-out]').innerText()).split('\n').map((s) => s.trim());
  expect(lines2.includes('Exit code 1'), `第 2 项 [data-term-out] 不该含「Exit code 1」这一行（实为 ${JSON.stringify(lines2)}）`).toBe(false);
  expect(lines2.some((s) => s.startsWith('FAILED tests/test_refs.py::test_unit_normalised')), '第 2 项输出区应保留 FAILED 那一行').toBe(true);
  expect(await textRedness(b2.locator('[data-term-foot]')), '第 2 项状态条文字颜色应偏红（红−绿 ≥ 30）').toBeGreaterThanOrEqual(30);
  const b9 = await openCard(page, 9);
  expect(await b9.locator('[data-term-cmd]').count(), '第 9 项（运行中）有命令行').toBe(1);
  expect(await b9.locator('[data-term-foot]').count(), '第 9 项（运行中）没有状态条').toBe(0);
  // 输出为空的成功 Bash（附加夹具 x 的第 1 张卡）：状态条写「无输出」
  await openFixture(page, 'x');
  const bx = await openCard(page, 1);
  const footx = await textOf(bx.locator('[data-term-foot]'));
  expect(footx, '输出为空的成功 Bash，状态条应含「无输出」').toContain('无输出');
});

test('B7 复制命令：点命令行里的「复制」写入剪贴板的是命令原文（不带 $），按钮变「已复制」约 1.5 秒后恢复', async ({ page }) => {
  await openFixture(page, 'h', { clipboard: true });
  const body = await openCard(page, 1);
  const btn = body.locator('[data-term-cmd] button').filter({ hasText: /^\s*(已)?复制\s*$/ });
  await expect(btn, '命令行里应有文字为「复制」的按钮').toHaveText(/^\s*复制\s*$/, { timeout: 5_000 });
  await btn.click();
  await expect(btn, '点击后按钮文字应变为「已复制」').toHaveText(/^\s*已复制\s*$/, { timeout: 1_000 });
  const t1 = Date.now();
  expect(await copied(page), '写入剪贴板的文本应恰为命令原文').toEqual(['ls -la /tmp/ws']);
  await expect(btn, '约 1.5 秒后应恢复为「复制」').toHaveText(/^\s*复制\s*$/, { timeout: 4_000 });
  const dt = Date.now() - t1;
  expect(dt, `「已复制」应持续约 1.5 秒（实测约 ${dt} 毫秒）`).toBeGreaterThan(900);
  expect(dt).toBeLessThan(2_600);
});

// ───────────────────────── B8 Diff ─────────────────────────
const diffFacts = (loc) => loc.evaluate((b) => ({
  lines: [...b.querySelectorAll('[data-diff-line]')].map((l) => {
    const c = l.cloneNode(true); const s = c.querySelector('[data-diff-sign]'); const sign = s ? s.textContent : null; if (s) s.remove();
    return { kind: l.getAttribute('data-diff-line'), sign, text: c.textContent.trim(), bg: getComputedStyle(l).backgroundColor, words: [...l.querySelectorAll('[data-diff-word]')].map((w) => [w.getAttribute('data-diff-word'), w.textContent]) };
  }),
  stats: [...b.querySelectorAll('[data-diff-stat]')].map((e) => e.textContent.replace(/\s+/g, '')),
}));
const OLD = ['其中 barium 的暴露剂量单位写成了 mg/L,与原文不符。', '暴露组血压显著降低(p = 0.07)。'];
const NEW = ['其中 barium 的暴露剂量单位应为 µg/L,已按原文更正。', '暴露组血压呈下降趋势(p = 0.07,未达显著)。'];

test('B8 Diff：删 / 增各两行带符号列与底色，没有 @@ 行，文件头统计 +2 −2，逐字高亮只加深不同的那段；Write 只有 3 行新增、统计 +3', async ({ page }) => {
  await openFixture(page, 'h');
  const body = await openCard(page, 4);
  const f = await diffFacts(body);
  const del = f.lines.filter((l) => l.kind === 'del'); const add = f.lines.filter((l) => l.kind === 'add');
  expect([del.length, add.length, f.lines.length], `Edit 的 [data-diff-line] 应为 del 2、add 2、共 4（不产生 @@ 行 / 上下文行），实为 ${JSON.stringify(f.lines.map((l) => l.kind))}`).toEqual([2, 2, 4]);
  expect(del.map((l) => l.sign), '删除行符号列应为 −（U+2212）').toEqual(['−', '−']);
  expect(add.map((l) => l.sign), '新增行符号列应为 +').toEqual(['+', '+']);
  expect(del.map((l) => l.text), '删除行内容文字（不带符号）').toEqual(OLD);
  expect(add.map((l) => l.text), '新增行内容文字（不带符号）').toEqual(NEW);
  expect([...del, ...add].filter((l) => !(parseColor(l.bg).a > 0)).map((l) => l.kind), '删除行与新增行整行都应有底色（背景不透明度 > 0）').toEqual([]);
  expect(f.stats, '展开后的文件头应恰有一个 [data-diff-stat]，文字 +2 −2').toEqual(['+2−2']);
  expect(await cardAt(page, 4).locator('[data-diff-stat]').count(), '整张卡里只有这一个 [data-diff-stat]').toBe(1);
  const meta = await textOf(cardAt(page, 4).locator('[data-tool-card-meta]'));
  expect([meta.includes('+2'), meta.includes('−2')], `卡头右侧信息「${meta}」应含 +2 与 −2`).toEqual([true, true]);
  expect(del.map((l) => l.words), '删除行里被加深的词：第 1 对 / 第 2 对').toEqual([[['del', '写成了 mg/L,与原文不符']], [['del', '显著降低(p = 0.07']]]);
  expect(add.map((l) => l.words), '新增行里被加深的词：第 1 对 / 第 2 对').toEqual([[['add', '应为 µg/L,已按原文更正']], [['add', '呈下降趋势(p = 0.07,未达显著']]]);
  const w = await diffFacts(await openCard(page, 5));
  expect([w.lines.map((l) => l.kind), w.stats], 'Write：只有 3 行 add，统计 +3').toEqual([['add', 'add', 'add'], ['+3']]);
});

// ───────────────────────── B9 其余卡不丢信息 ─────────────────────────
test('B9 其余卡不丢信息：Read 行数与内容、Grep 逐行、WebFetch 渲染成标题和列表、MCP 参数与结果、兜底卡输入 / 结果、已停止卡信息', async ({ page }) => {
  await openFixture(page, 'h');
  await expect.poll(async () => await page.locator('[data-tool-card]').count(), { timeout: 10_000, message: NO_CARD }).toBe(10);
  await expandAllCards(page);
  const body = (n) => cardAt(page, n).locator('[data-tool-card-body]');
  const meta = (n) => textOf(cardAt(page, n).locator('[data-tool-card-meta]'));
  const problems = [];
  const t3 = await textOf(body(3)); const head3 = await textOf(cardAt(page, 3).locator('[data-tool-card-head]'));
  if (!head3.includes('section.md')) problems.push(`Read 卡头「${head3}」缺文件名 section.md`);
  if (!(await meta(3)).includes('12 行')) problems.push(`Read 右侧信息「${await meta(3)}」缺「12 行」`);
  if (!/\bL1\b/.test(t3) || !/\bL12\b/.test(t3)) problems.push(`Read 展开后应见 L1 与 L12（实为「${t3}」）`);
  if (!(await meta(6)).includes('4 行')) problems.push(`Grep 右侧信息「${await meta(6)}」缺「4 行」`);
  const g = (await body(6).innerText()).split('\n').map((s) => s.trim());
  for (const mk of GREP_MARKS) { const hit = g.filter((s) => s.includes(mk)); if (hit.length !== 1 || GREP_MARKS.filter((o) => o !== mk && hit[0].includes(o)).length) problems.push(`Grep 展开后「${mk}」应独占一行（含它的行：${JSON.stringify(hit)}）`); }
  const web = await body(7).evaluate((b) => ({ h: [...b.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((e) => e.textContent.trim()), li: [...b.querySelectorAll('li')].map((e) => e.textContent.trim()), raw: b.innerText.includes('# 示例页面摘要') }));
  if (JSON.stringify(web.h) !== JSON.stringify(['示例页面摘要'])) problems.push(`WebFetch 标题应渲染成标题元素「示例页面摘要」（实为 ${JSON.stringify(web.h)}）`);
  if (JSON.stringify(web.li) !== JSON.stringify(['要点甲', '要点乙'])) problems.push(`WebFetch 两条列表应渲染成列表项（实为 ${JSON.stringify(web.li)}）`);
  if (web.raw) problems.push('WebFetch 正文里还有未渲染的「# 示例页面摘要」纯文本');
  const t8 = await textOf(body(8));
  if (!t8.includes('query') || !t8.includes('found 3')) problems.push(`MCP 展开后应含 query 与 found 3（实为「${t8}」）`);
  const t11 = await textOf(body(11));
  if (!t11.includes('输入') || !t11.includes('结果') || !/\bok\b/.test(t11)) problems.push(`兜底卡展开后应含「输入」「结果」与 ok（实为「${t11}」）`);
  if (!(await meta(10)).includes('已停止')) problems.push(`已停止卡右侧信息「${await meta(10)}」缺「已停止」`);
  const t10 = await textOf(body(10));
  if (!t10.includes('echo stopped')) problems.push(`已停止卡展开后应能看到输入参数 echo stopped（实为「${t10}」）`);
  expect(problems, '各类卡展开后的信息').toEqual([]);
});

// ───────────────────────── B10 代码块外观与折叠 / B11 复制代码 ─────────────────────────
const blockOf = (page, lang) => page.locator('pre[data-code-block]').filter({ has: page.locator('[data-code-lang]', { hasText: new RegExp(`^\\s*${lang}\\s*$`) }) });
/** 块里「看得见」的代码行数：按文字所在的行盒去重，并扣掉被块内 overflow 裁掉的行。 */
const visibleLines = (loc) => loc.evaluate((pre) => {
  const turn = pre.closest('[data-turn-uuid]') || document.body;
  const clips = (n) => { const o = []; for (let p = n.parentElement; p && p !== turn.parentElement; p = p.parentElement) { const cs = getComputedStyle(p); if (/(hidden|auto|scroll|clip)/.test(`${cs.overflowX} ${cs.overflowY}`)) o.push(p.getBoundingClientRect()); } return o; };
  const tops = [];
  const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.nodeValue.trim() || n.parentElement.closest('button, [data-code-lang]')) continue;
    const range = document.createRange(); range.selectNodeContents(n); const cl = clips(n);
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      let top = r.top; let bottom = r.bottom;
      for (const c of cl) { top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
      if (bottom - top >= r.height * 0.6) tops.push(r.top);
    }
  }
  tops.sort((a, b) => a - b);
  let count = 0; let last = -1e9;
  for (const t of tops) if (t - last > 6) { count += 1; last = t; }
  return count;
});
const MORE = '展开剩余 23 行 ▾';

test('B10 代码块外观与折叠：python 围栏跟随主题、有语言标签与复制无运行、默认 5 行 + 展开剩余 23 行 + 收起；bash 围栏有运行和复制、无折叠', async ({ page }) => {
  await openFixture(page, 'h');
  await scrollToEnd(page);
  const chat = page.locator('[data-turn-uuid]');
  const py = blockOf(page, 'python');
  await expect(py, 'python 围栏应是 pre[data-code-block]，语言标签 [data-code-lang] 文字为 python').toHaveCount(1, { timeout: 8_000 });
  expect(await py.getAttribute('data-code-tone'), 'python 块的 data-code-tone').toBe('theme');
  expect([await py.locator('button', { hasText: '复制' }).count(), await py.locator('button', { hasText: '运行' }).count()], 'python 块子树里：有「复制」、没有「运行」').toEqual([1, 0]);
  expect(await visibleLines(py), '默认只显示前 5 行').toBe(5);
  await expect(chat.getByText(MORE, { exact: true }), `底部按钮「${MORE}」`).toHaveCount(1);
  expect(await chat.getByText(/展开剩余/).count(), '页面上只有 python 块有折叠按钮（3 行的 bash 没有）').toBe(1);
  await chat.getByText(MORE, { exact: true }).click();
  expect(await visibleLines(py), '点开后 28 行全部显示').toBe(28);
  const top = chat.getByText('收起 ▴', { exact: true }); const bottom = chat.getByText('收起', { exact: true });
  await expect(top, '展开后顶部出现「收起 ▴」').toHaveCount(1);
  await expect(bottom, '展开后底部按钮变「收起」').toHaveCount(1);
  expect((await top.boundingBox()).y < (await bottom.boundingBox()).y, '「收起 ▴」在顶部、「收起」在底部').toBe(true);
  await top.click();
  expect(await visibleLines(py), '点顶部「收起 ▴」回到 5 行').toBe(5);
  await chat.getByText(MORE, { exact: true }).click();
  await chat.getByText('收起', { exact: true }).click();
  expect(await visibleLines(py), '点底部「收起」回到 5 行').toBe(5);
  const sh = blockOf(page, 'bash');
  await expect(sh, 'bash 围栏应是 pre[data-code-block]').toHaveCount(1);
  expect([await sh.locator('button', { hasText: '运行' }).count(), await sh.locator('button', { hasText: '复制' }).count()], 'bash 块子树里：有「运行」和「复制」').toEqual([1, 1]);
  expect(await visibleLines(sh), 'bash 块 3 行全部显示').toBe(3);
});

test('B11 复制代码：折叠状态下点 python 围栏的「复制」，剪贴板是完整 28 行代码，按钮短暂变「已复制」', async ({ page }) => {
  await openFixture(page, 'h', { clipboard: true });
  await scrollToEnd(page);
  const py = blockOf(page, 'python');
  await expect(py, 'python 围栏应是 pre[data-code-block]').toHaveCount(1, { timeout: 8_000 });
  expect(await visibleLines(py), '前置：处于折叠状态（只显示 5 行）').toBe(5);
  // r158 主会话修订：定位条件要同时认「复制」和「已复制」（同 B7 的写法）——Playwright 每次断言都会重新按这个条件找按钮，
  // 只认「复制」的话，按钮一变成「已复制」就找不到它了，任何实现都过不了。
  const btn = py.locator('button', { hasText: /^\s*(已)?复制\s*$/ });
  await expect(btn, '点击前按钮文字应为「复制」').toHaveText(/^\s*复制\s*$/);
  await btn.click();
  await expect(btn, '点击后按钮文字短暂变为「已复制」').toHaveText(/^\s*已复制\s*$/, { timeout: 1_000 });
  const got = await copied(page);
  expect(got.length, '只应写入一次剪贴板').toBe(1);
  expect(got[0].replace(/\n+$/, ''), '剪贴板应是完整 28 行代码（含被折叠的部分）').toBe(PY_CODE);
  expect(got[0].replace(/\n+$/, '').split('\n').length).toBe(28);
});

/** 找到「代码」切换所在块里的代码视图，返回它背景（往上第一个有底色的祖先）的亮度。 */
async function codeViewLum(tab) {
  const r = await tab.evaluate((t) => {
    let view = null;
    for (let c = t; c && !view; c = c.parentElement) {
      const hits = [...c.querySelectorAll("*")].filter((e) => e.getClientRects().length > 0 && e.textContent.includes("演示段落</p>"));
      view = hits.find((e) => /^(PRE|CODE|TEXTAREA)$/.test(e.tagName)) || hits[hits.length - 1] || null;
    }
    if (!view) return null;
    const bg = (e) => getComputedStyle(e).backgroundColor;
    const chain = []; for (let p = view; p; p = p.parentElement) chain.push(bg(p));
    const cc = []; for (let p = document.querySelector('[data-turn-uuid]'); p; p = p.parentElement) cc.push(bg(p));
    return { chain, cc };
  });
  if (!r) return null;
  const canvas = r.cc.map(parseColor).find((c) => c.a >= 0.99) || { r: 255, g: 255, b: 255, a: 1 };
  const own = r.chain.map(parseColor).find((c) => c.a >= 0.02);
  return lum(own ? over(own, canvas) : canvas);
}
test('B13 不该变的保持原样：html 围栏切到「代码」后仍是深色底（三个浅色主题下也是），「代码」「预览」切换仍在；坏 JSON 的 cgui-ui 围栏降级成跟随主题的代码块', async ({ page }) => {
  test.setTimeout(240_000);
  for (const theme of LIGHT) {
    await openFixture(page, 'h', { theme });
    await scrollToEnd(page);
    const chat = page.locator('[data-turn-uuid]');
    const [codeTab, previewTab] = [chat.getByText('代码', { exact: true }), chat.getByText('预览', { exact: true })];
    await expect(codeTab, `${theme.key}：html 块应有「代码」切换`).toHaveCount(1, { timeout: 8_000 });
    await expect(previewTab, `${theme.key}：html 块应有「预览」切换`).toHaveCount(1);
    await codeTab.click();
    const l = await codeViewLum(codeTab);
    expect(l, `${theme.key}：切到「代码」后应能找到代码视图`).not.toBeNull();
    expect(l, `${theme.key}：html 块的代码视图仍应是深色底（亮度 ≤ 0.30）`).toBeLessThanOrEqual(0.3);
    await expect(codeTab).toHaveCount(1);
    await expect(previewTab, `${theme.key}：切到代码后「预览」切换仍在`).toHaveCount(1);
  }
  const bad = page.locator('pre[data-code-block]').filter({ hasText: '{"items":[' });
  await expect(bad, '坏 JSON 的 cgui-ui 围栏应降级成 pre[data-code-block]').toHaveCount(1);
  expect(await bad.getAttribute('data-code-tone'), '降级的代码块 data-code-tone').toBe('theme');
});

// ───────────────────────── B14 窄屏不撑破 ─────────────────────────
const hScroll = (loc) => loc.evaluate((el) => {
  const sc = [el, ...el.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowX));
  return { n: sc.length, right: Math.round(el.getBoundingClientRect().right), vw: window.innerWidth };
});
const pageWidths = (page) => page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
/** 每张卡的卡头：标题是否有截断样式、右侧信息是否不换行、卡头自身有没有被撑出去。 */
const headLayout = (page) => page.evaluate(() => [...document.querySelectorAll('[data-tool-card]')].map((c, i) => {
  const t = c.querySelector('[data-tool-card-title]'); const m = c.querySelector('[data-tool-card-meta]'); const h = c.querySelector('[data-tool-card-head]');
  const ts = t && getComputedStyle(t); const tp = t && t.parentElement && getComputedStyle(t.parentElement); const ms = m && getComputedStyle(m);
  const ell = (s) => !!s && (s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none'));
  const mh = m ? m.getBoundingClientRect().height : 0;
  return {
    i: i + 1, titleCut: ell(ts) || ell(tp), metaOneLine: !m || mh === 0 || /^(nowrap|pre)$/.test(ms.whiteSpace) || mh <= parseFloat(ms.lineHeight || '0') * 1.6 + 2,
    headFits: !h || h.scrollWidth <= h.clientWidth + 1,
  };
}));

test('B14 窄屏不撑破：375px 下页面无横向滚动，长代码行 / 长命令在块内横向滚动，卡头标题截断、右侧信息不换行', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctxs = [];
  const newPage = async () => { const ctx = await browser.newContext({ baseURL: process.env.BASE_URL, viewport: { width: 1280, height: 900 } }); ctx.setDefaultTimeout(15_000); ctxs.push(ctx); return ctx.newPage(); };
  let page = await newPage();
  const NARROW = { width: 375, height: 800 };
  const problems = [];
  await openFixture(page, 'h');
  await expandAllCards(page);
  await scrollToEnd(page);
  await page.setViewportSize(NARROW);
  await page.waitForTimeout(500);
  // r158 主会话修订：应用从桌面宽度缩到手机宽度会重建界面，工作组与工具卡的展开状态随之丢失（现状行为，与本任务无关），缩窄后要重新展开。
  await expandAllGroups(page);
  await expandAllCards(page);
  await scrollToEnd(page);
  const [sw, vw] = await pageWidths(page);
  if (sw > vw) problems.push(`主夹具：documentElement.scrollWidth ${sw} > 视口宽 ${vw}`);
  const sh = blockOf(page, 'bash');
  if (!(await sh.count())) problems.push('找不到 bash 围栏代码块 pre[data-code-block]');
  else { const s = await hScroll(sh); if (s.n < 1 || s.right > s.vw + 1) problems.push(`bash 块（含超长代码行）应在块内横向滚动且不超出视口：${JSON.stringify(s)}`); }
  const cards = await headLayout(page);
  if (cards.length === 0) problems.push(NO_CARD);
  for (const c of cards) {
    if (!c.titleCut) problems.push(`第 ${c.i} 张卡标题没有截断样式（text-overflow: ellipsis 或 line-clamp）`);
    if (!c.metaOneLine) problems.push(`第 ${c.i} 张卡右侧信息换行了`);
    if (!c.headFits) problems.push(`第 ${c.i} 张卡的卡头被撑宽`);
  }
  // 附加夹具：超长描述（标题）与超长命令（终端命令行）
  page = await newPage();
  await openFixture(page, "x");
  await expandAllCards(page);
  await page.setViewportSize(NARROW);
  await page.waitForTimeout(500);
  await expandAllGroups(page);
  await expandAllCards(page);
  const [sw2, vw2] = await pageWidths(page);
  if (sw2 > vw2) problems.push(`附加夹具：documentElement.scrollWidth ${sw2} > 视口宽 ${vw2}`);
  const long = page.locator('[data-tool-card]').nth(2);
  if (!(await long.count())) problems.push(`附加夹具：${NO_CARD}`);
  else {
    const cut = await long.locator('[data-tool-card-title]').evaluate((t) => ({ own: t.scrollWidth > t.clientWidth + 1, parent: t.parentElement.scrollWidth > t.parentElement.clientWidth + 1 }));
    if (!cut.own && !cut.parent) problems.push(`超长描述的标题没有被截断（标题宽度没有溢出）：${JSON.stringify(cut)}`);
    const cmd = long.locator('[data-term-cmd]');
    if (!(await cmd.count())) problems.push('超长命令的卡里找不到 [data-term-cmd]');
    else { const s = await hScroll(cmd); if (s.n < 1 || s.right > s.vw + 1) problems.push(`超长命令应在命令行块内横向滚动且不超出视口：${JSON.stringify(s)}`); }
  }
  for (const c of ctxs) await c.close();
  expect(problems, "窄屏布局").toEqual([]);
});

// ───────────────────────── 错误契约 E1 / E2 ─────────────────────────
test('E1 取不到 Exit code 的失败 Bash：状态条写「失败」（不写退出码数字），仍是错误色', async ({ page }) => {
  await openFixture(page, 'x');
  const body = await openCard(page, 2);
  const foot = await textOf(body.locator('[data-term-foot]'));
  expect(foot.includes('失败'), `状态条「${foot}」应写「失败」`).toBe(true);
  expect(/退出码\s*\d/.test(foot), `状态条「${foot}」不该写退出码数字`).toBe(false);
  expect(foot.includes('成功'), `状态条「${foot}」不该写「成功」`).toBe(false);
  expect(await textRedness(body.locator('[data-term-foot]')), '状态条仍是错误色（红−绿 ≥ 30）').toBeGreaterThanOrEqual(30);
});

const EDIT_STREAMING = {
  kind: 'tool', name: 'Edit', input: { file_path: '/tmp/ws/x.md', old_string: 'a', new_string: 'b' }, pending: 'd1', streamGate: 'g1',
  streamChunks: ['{"file_path":"/tmp/ws/x.md",', '"old_string":"a","new_string":"b"}'],
};
test('E2 Edit 的参数还在传输（没有 old_string / new_string）：展开后仍显示「参数仍在传输…」，页面不报错', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  await openFull(page, 'e2', { events: [EDIT_STREAMING] });
  const card = page.locator('[data-tool-card][data-tool-name="Edit"]');
  await expect.poll(async () => { await expandAllGroups(page); return await card.count(); }, { timeout: 20_000, message: NO_CARD }).toBe(1);
  const head = card.locator('[data-tool-card-head]');
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  await expect(card.locator('[data-tool-card-body]'), '展开后正文应显示「参数仍在传输…」').toContainText('参数仍在传输…', { timeout: 8_000 });
  expect(errors, '页面不应有未捕获异常').toEqual([]);
});

// ───────────────────────── B4 / B5 / B15：第 9 项（运行中）与第 10 项（被停止）分两个会话核对 ─────────────────────────
// 实测现状：直播期间（f* 会话）会话里所有没有结果的工具都显示为运行中，包括历史回合里没有结果的第 10 项；
// 空闲会话（h）里同样没有结果的工具显示为已停止。所以第 9 项到 f* 里核对，第 10 项到 h 里核对。
test('B4 统一骨架：11 项各一张卡，卡头四件套齐全且没有展开箭头、各项内容与状态符合约定，点卡头 aria-expanded 切换且正文只在展开时存在；回合里所有折叠行都没有展开箭头', async ({ page }) => {
  await openFull(page, 'f4');
  await expect.poll(async () => await page.locator('[data-tool-card]').count(), { timeout: 10_000, message: NO_CARD }).toBe(11);
  const live = await cardFacts(page);
  const liveFold = await foldArrows(page);
  await openFixture(page, 'h');
  await expect.poll(async () => await page.locator('[data-tool-card]').count(), { timeout: 10_000, message: `历史会话 h：${NO_CARD}` }).toBe(10);
  const hist = await cardFacts(page);
  const histFold = await foldArrows(page);
  const problems = [];
  for (const [label, a] of [['直播会话', liveFold], ['历史会话', histFold]]) {
    if (a.groups < 1) problems.push(`${label}：找不到工作组头 [data-work-group-head]（本判据的前提不成立）`);
    if (a.brains < 1) problems.push(`${label}：展开的工作组里找不到思考折叠行（脑图标），无法判断它有没有箭头（本判据的前提不成立）`);
    if (a.chevrons !== 0 || a.carets !== 0) problems.push(`${label}：回合里还有展开箭头（chevron / caret 图标 ${a.chevrons} 个、[data-strip-caret] ${a.carets} 个）`);
  }
  for (let n = 1; n <= 11; n += 1) {
    const f = n === 10 ? hist[8] : live[[0, 1, 2, 3, 4, 5, 6, 7, 10, 8, 9][n - 1]];
    const [tool, status, name, titleOk, metaOk] = WANT[n];
    if (f.tool !== tool) problems.push(`第 ${n} 项 data-tool-name=${f.tool}（应 ${tool}）`);
    if (f.status !== status) problems.push(`第 ${n} 项 data-status=${f.status}（应 ${status}）`);
    if (!f.head || !f.inOrder || f.arrows !== 0) problems.push(`第 ${n} 项卡头四件套不全、次序不对或还有展开箭头（head=${f.head} 顺序=${f.inOrder} 箭头个数=${f.arrows}）`);
    if (f.name !== name) problems.push(`第 ${n} 项小标签=「${f.name}」（应 ${name}）`);
    if (f.title === null || !titleOk(f.title)) problems.push(`第 ${n} 项标题=「${f.title}」不符`);
    if (f.meta === null || !metaOk(f.meta)) problems.push(`第 ${n} 项右侧信息=「${f.meta}」不符`);
  }
  expect(problems, '11 张卡的骨架与内容').toEqual([]);
  const head = cardAt(page, 1).locator('[data-tool-card-head]');
  const body = cardAt(page, 1).locator('[data-tool-card-body]');
  await expect(head, '第 1 项默认收起').toHaveAttribute('aria-expanded', 'false');
  await expect(body, '收起时没有正文').toHaveCount(0);
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(body, '展开后有正文').toHaveCount(1);
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(body, '再点收回后没有正文').toHaveCount(0);
});

test('B5 状态看得出来：出错卡边框偏红而完成卡不是，已停止卡虚线边框，运行中卡有转圈且无对勾、完成卡无转圈', async ({ page }) => {
  await openFull(page, 'f5');
  await expect.poll(async () => await page.locator('[data-tool-card]').count(), { timeout: 10_000, message: NO_CARD }).toBe(11);
  const err = await sides(cardAt(page, 2)); const done = await sides(cardAt(page, 1));
  expect(Math.max(-999, ...red(err)), `出错卡（第 2 项）边框 红−绿 应 ≥ 30（各边：${JSON.stringify(err)}）`).toBeGreaterThanOrEqual(30);
  expect(Math.max(-999, ...red(done)), `完成卡（第 1 项）边框不该偏红：红−绿 应 < 30（各边：${JSON.stringify(done)}）`).toBeLessThan(30);
  const runIcon = cardAt(page, 9).locator('[data-tool-card-icon]');
  expect(await runIcon.locator('.mini-spin').count(), '运行中卡（第 9 项）状态图标位应含 .mini-spin').toBeGreaterThanOrEqual(1);
  expect(await runIcon.innerText(), '运行中卡状态图标位不该有对勾字符').not.toMatch(/[✓✔☑√]/);
  expect(await cardAt(page, 1).locator('[data-tool-card-icon] .mini-spin').count(), '完成卡（第 1 项）状态图标位不该有 .mini-spin').toBe(0);
  await openFixture(page, 'h');
  await expect.poll(async () => await page.locator('[data-tool-card]').count(), { timeout: 10_000, message: `历史会话 h：${NO_CARD}` }).toBe(10);
  const stopped = await sides(cardAt(page, 10));
  expect(shown(stopped).length, '已停止卡（第 10 项）应有可见边框').toBeGreaterThan(0);
  expect(shown(stopped).map((s) => s.st), `已停止卡（第 10 项）所有可见边框应为 dashed（各边：${JSON.stringify(stopped)}）`).toEqual(shown(stopped).map(() => 'dashed'));
});

test('B15 运行中与停止后的旧行为不变：第 9 项 running、第 2 项 error、第 10 项 stopped，其余 done，点卡头展开收起不改变它', async ({ page }) => {
  await openFixture(page, 'h');
  const entries = page.locator('[data-entry-state]');
  await expect.poll(async () => await entries.count(), { timeout: 15_000, message: '展开工作组后，10 个历史工具条目各被一层 [data-entry-state] 包着' }).toBe(10);
  const states = (loc) => loc.evaluateAll((els) => els.map((e) => e.getAttribute('data-entry-state')));
  const want = ['done', 'error', 'done', 'done', 'done', 'done', 'done', 'done', 'stopped', 'done'];
  expect(await states(entries), '空闲会话：第 2 项 error、第 10 项 stopped，其余 done').toEqual(want);
  const wrapped = await page.evaluate(() => [...document.querySelectorAll('[data-tool-card]')].map((c) => { const w = c.closest('[data-entry-state]'); return w ? w.getAttribute('data-entry-state') : null; }));
  if (wrapped.length > 0) expect(wrapped, '每张工具卡外面仍有一层 [data-entry-state]，值与条目一致').toEqual(want);
  const toggle = async (list, i, expectStates, label) => {
    const entry = list.nth(i);
    const head = (await entry.locator('[data-tool-card-head]').count()) ? entry.locator('[data-tool-card-head]').first() : entry.locator('button').first();
    if (!(await head.count())) return;
    await head.click();
    expect(await states(list), `点${label}的头展开后，data-entry-state 不变`).toEqual(expectStates);
    await head.click();
    expect(await states(list), `再点一次收回后，data-entry-state 不变`).toEqual(expectStates);
  };
  for (let i = 0; i < 10; i += 1) await toggle(entries, i, want, `第 ${i + 1} 个历史条目`);
  // 直播会话：第 9 项（一直没返回）所在条目是 running
  await openFull(page, 'f15');
  const live = page.locator('[data-entry-state]');
  await expect.poll(async () => await live.count(), { timeout: 15_000, message: '直播会话里应有 11 个条目（10 个历史 + 第 9 项）' }).toBe(11);
  expect((await states(live))[10], '直播回合里一直没返回的第 9 项应是 running').toBe('running');
  await toggle(live, 10, await states(live), '第 9 项');
});
