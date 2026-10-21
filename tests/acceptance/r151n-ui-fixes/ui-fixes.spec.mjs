// r151n 补验收:①分屏 ≥2 窗格时消息操作文字标签只留图标;②粘贴终端复制来的
// "UTF-8 字节被当 MacRoman 解码"的乱码时自动还原,正常中文/英文/法文不误改。
//
// 全部走真实 App(dev server 直出源码 + 隔离 server):
//   S1 打开真实历史会话,按文本「重做/分叉」定位真实消息操作按钮,主断言是
//      「真实 pane 元素数 + 两栏都可见 + 文本标签计算样式 display」这些用户可观察行为;
//      data-pane-count / .cgui-action-label 只是修复自带的实现钩子,仅作辅助记录。
//   S2/S2b/S3 在真实 textarea 上派发合成 paste(DataTransfer 携带 text/plain):
//      S2 首页输入框,S2b 会话内 composer,S3 正常文本不误改(并验证未被 preventDefault、
//      按浏览器默认插入后值 = 原值 + 粘贴原文)。
// 不 import 产品代码;不改产品代码。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { boot, openSessionBySearch, messageRows } from './helpers/ui.mjs';

const seed = JSON.parse(fs.readFileSync(process.env.R151N_SEED_FILE, 'utf8'));

const MOJIBAKE = '‚úª 500 ÂΩìÂâçÊó†ÂèØÁî®Âá≠ËØÅ';
const REPAIRED = '✻ 500 当前无可用凭证';
const NORMAL = {
  中文: '当前无可用凭证，请稍后重试',
  英文: 'No credentials available.',
  法文: 'Aucun identifiant disponible — vérifiez la configuration.',
};

/** 记录页面未捕获异常(任何一条都算失败)。 */
function watchPageErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err && err.stack ? err.stack : err)));
  return errors;
}

/**
 * 真实 DOM 上的分屏状态。主口径全部是可观察行为:
 *   - 真实窗格元素([data-testid="pane"],分屏修复前就有,不是这次新增的钩子)数量与可见性;
 *   - 消息操作按钮(按文本「重做/分叉」定位,修复前这些 span 还没有 .cgui-action-label 类)
 *     是否仍在、按钮本身是否可见;
 *   - 这些按钮里的「重做/分叉」文字标签的计算样式 display(用户实际看得到/看不到的东西)。
 * data-pane-count 与 .cgui-action-label 只作为辅助诊断字段返回,不参与主断言。
 */
async function paneFacts(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, '');
    const shown = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const split = document.querySelector('[data-testid="pane-split"]');
    if (!split) return { found: false, panes: [], buttons: [], labels: [] };

    const panes = Array.from(split.querySelectorAll('[data-testid="pane"]')).map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        index: i,
        visible: shown(el),
        display: getComputedStyle(el).display,
        width: Math.round(r.width),
        height: Math.round(r.height),
        hasMessages: !!el.querySelector('[data-cgui="message-list"] [data-turn-uuid]'),
      };
    });

    const buttons = [];
    const labels = [];
    for (const btn of split.querySelectorAll('button')) {
      const btnText = norm(btn.textContent);
      if (!/^(重做|分叉)$/.test(btnText)) continue;
      const spans = Array.from(btn.querySelectorAll('span'))
        .filter((el) => /^(重做|分叉)$/.test(norm(el.textContent)));
      const r = btn.getBoundingClientRect();
      buttons.push({
        text: btnText,
        visible: shown(btn),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
      for (const el of spans) {
        const cs = getComputedStyle(el);
        const sr = el.getBoundingClientRect();
        labels.push({
          text: norm(el.textContent),
          display: cs.display,
          visibility: cs.visibility,
          rendered: sr.width > 0 && sr.height > 0,
          classed: el.classList.contains('cgui-action-label'), // 辅助诊断,非主断言
        });
      }
    }

    return {
      found: true,
      attr: split.getAttribute('data-pane-count'), // 辅助诊断,非主断言
      paneCount: panes.length,
      allPanesVisible: panes.length > 0 && panes.every((p) => p.visible),
      panes,
      buttons,
      buttonCount: buttons.length,
      allButtonsVisible: buttons.length > 0 && buttons.every((b) => b.visible),
      labels,
      labelCount: labels.length,
      allLabelsHidden: labels.length > 0 && labels.every((l) => l.display === 'none'),
      allLabelsShown: labels.length > 0 && labels.every((l) => l.display !== 'none'),
      allLabelsRendered: labels.length > 0 && labels.every((l) => l.rendered),
    };
  });
}

/**
 * 在真实 textarea 上派发合成 paste。
 * 优先用 ClipboardEvent + DataTransfer;WebKit 若不给构造器塞 clipboardData,
 * 退化成普通 Event + 只读 clipboardData 对象(React 的 onPaste 只读 getData/items)。
 *
 * 合成事件不会触发浏览器默认插入。`simulateBrowserDefault` 打开时,若事件未被
 * preventDefault,就在光标处补一次等价于浏览器默认动作的插入并派发 input —— 这正是
 * “正常文本粘贴后,用户看到的应是原文追加”的黑盒形态;修复版对乱码会 preventDefault
 * 并自己插入还原文本,不会走这条补插分支。
 */
async function dispatchPaste(page, selector, text, { simulateBrowserDefault = false } = {}) {
  return page.evaluate(({ selector, text, simulateBrowserDefault }) => {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, reason: `${selector} not found` };
    // 把光标放到末尾,让“浏览器默认插入”的落点确定(React 受控值已由 fill 写好)。
    try {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    } catch { /* 非文本控件 */ }

    let dt = null;
    try {
      dt = new DataTransfer();
      dt.setData('text/plain', text);
    } catch { dt = null; }
    const clipboardData = dt || {
      getData: (type) => (type === 'text/plain' ? text : ''),
      items: [],
      files: [],
    };
    let ev = null;
    let eventKind = 'Event';
    try {
      const candidate = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
      if (candidate.clipboardData && candidate.clipboardData.getData('text/plain') === text) {
        ev = candidate;
        eventKind = 'ClipboardEvent';
      }
    } catch { /* WebKit 老版本没有 ClipboardEvent 构造器 */ }
    if (!ev) {
      ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: clipboardData });
    }

    const valueBefore = el.value;
    const dispatchReturn = el.dispatchEvent(ev);
    const prevented = !dispatchReturn || ev.defaultPrevented;

    let insertedByDefault = false;
    if (!prevented && simulateBrowserDefault) {
      const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
      try { el.setRangeText(text, start, end, 'end'); } catch { el.value += text; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      insertedByDefault = true;
    }
    return {
      ok: true,
      eventKind,
      realDataTransfer: !!dt,
      dispatchReturn, // 未被取消 = true
      prevented, // 派发者是否 preventDefault
      defaultPrevented: ev.defaultPrevented,
      insertedByDefault,
      valueBefore,
      valueAfter: el.value,
    };
  }, { selector, text, simulateBrowserDefault });
}

const HOME_INPUT = '[data-cgui="home-input"]';
const COMPOSER_INPUT = '[data-cgui="composer-input"]';
const homeInput = (page) => page.locator(HOME_INPUT);
const composerInput = (page) => page.locator(COMPOSER_INPUT);

test.describe.configure({ timeout: 180_000 });

test('S1 分屏 ≥2 窗格:真实两栏可见、消息操作按钮仍在且文字标签 display:none;切回 1 窗格恢复', async ({ page }) => {
  const errors = watchPageErrors(page);
  await boot(page);
  await openSessionBySearch(page, seed.firstText, seed.lastText);
  await expect(messageRows(page).first(), '种子会话应有已挂载消息行').toBeVisible({ timeout: 30_000 });

  // 单屏基线(可观察行为):1 个真实窗格、可见;消息操作按钮在;文字标签未被隐藏。
  await expect.poll(async () => {
    const f = await paneFacts(page);
    return f.found && f.paneCount === 1 && f.allPanesVisible
      && f.buttonCount > 0 && f.allButtonsVisible
      && f.labelCount > 0 && f.allLabelsShown && f.allLabelsRendered;
  }, {
    message: '单屏应只有 1 个可见真实窗格,且消息操作按钮/「重做/分叉」文字标签可见',
    timeout: 20_000,
  }).toBe(true);
  const single = await paneFacts(page);

  // 分屏入口收在顶栏面板坞的 rail 里(窗口级操作),先展开坞再点。
  await page.locator('[data-testid="panel-dock-toggle"]').click();
  await expect(page.locator('[data-testid="pane-count"]'), '展开面板坞后应出现分屏数量入口').toBeVisible({ timeout: 10_000 });
  await page.locator('[data-testid="pane-count"]').click();
  await page.locator('[data-testid="pane-count-2"]').click();

  // 条件等待,不 sleep:真实 pane 元素变成 2 个且都可见。
  await expect.poll(async () => {
    const f = await paneFacts(page);
    return f.found && f.paneCount === 2 && f.allPanesVisible;
  }, {
    message: '切换到 2 窗格后应出现 2 个真实 pane 元素且都可见(不靠 data-pane-count)',
    timeout: 20_000,
  }).toBe(true);

  // 消息操作按钮仍在(用户仍能点重做/分叉),只是文字标签被隐藏。
  await expect.poll(async () => {
    const f = await paneFacts(page);
    return f.buttonCount > 0 && f.allButtonsVisible;
  }, {
    message: '2 窗格时消息操作按钮应仍存在且可见(图标形态)',
    timeout: 20_000,
  }).toBe(true);

  // 主断言:2 窗格时「重做/分叉」文字标签的计算样式 display:none(用户看不到文字)。
  await expect.poll(async () => {
    const f = await paneFacts(page);
    return f.labelCount > 0 && f.allLabelsHidden;
  }, {
    message: '2 窗格时「重做/分叉」文字标签计算样式应为 display:none',
    timeout: 20_000,
  }).toBe(true);
  const split2 = await paneFacts(page);

  // 切回 1 窗格:真实 pane 数回落为 1,文字标签恢复显示。
  await page.locator('[data-testid="pane-count"]').click();
  await page.locator('[data-testid="pane-count-1"]').click();
  await expect.poll(async () => {
    const f = await paneFacts(page);
    return f.found && f.paneCount === 1 && f.allPanesVisible
      && f.buttonCount > 0 && f.allButtonsVisible
      && f.labelCount > 0 && f.allLabelsShown && f.allLabelsRendered;
  }, {
    message: '切回 1 窗格后应回到 1 个可见窗格,且「重做/分叉」文字标签恢复显示',
    timeout: 20_000,
  }).toBe(true);
  const back1 = await paneFacts(page);

  const facts = {
    singlePaneCount: single.paneCount,
    singlePanesVisible: single.allPanesVisible,
    singleButtonCount: single.buttonCount,
    singleButtonsVisible: single.allButtonsVisible,
    singleLabelCount: single.labelCount,
    singleLabelsShown: single.allLabelsShown,
    splitPaneCount: split2.paneCount,
    splitPanesVisible: split2.allPanesVisible,
    splitButtonCount: split2.buttonCount,
    splitButtonsVisible: split2.allButtonsVisible,
    splitLabelCount: split2.labelCount,
    splitLabelsHidden: split2.allLabelsHidden,
    splitLabelDisplays: split2.labels.map((l) => l.display),
    backPaneCount: back1.paneCount,
    backPanesVisible: back1.allPanesVisible,
    backButtonCount: back1.buttonCount,
    backButtonsVisible: back1.allButtonsVisible,
    backLabelCount: back1.labelCount,
    backLabelsShown: back1.allLabelsShown,
    pageErrors: errors,
  };
  expect(facts, `分屏前后真实 DOM 事实:\n${JSON.stringify({ single, split2, back1, errors }, null, 2)}`).toEqual({
    singlePaneCount: 1,
    singlePanesVisible: true,
    singleButtonCount: expect.any(Number),
    singleButtonsVisible: true,
    singleLabelCount: expect.any(Number),
    singleLabelsShown: true,
    splitPaneCount: 2,
    splitPanesVisible: true,
    splitButtonCount: expect.any(Number),
    splitButtonsVisible: true,
    splitLabelCount: expect.any(Number),
    splitLabelsHidden: true,
    splitLabelDisplays: expect.any(Array),
    backPaneCount: 1,
    backPanesVisible: true,
    backButtonCount: expect.any(Number),
    backButtonsVisible: true,
    backLabelCount: expect.any(Number),
    backLabelsShown: true,
    pageErrors: [],
  });
  expect(facts.singleButtonCount, '单屏消息操作按钮应存在').toBeGreaterThan(0);
  expect(facts.splitButtonCount, '分屏消息操作按钮应仍存在(只是文字隐藏)').toBeGreaterThan(0);
  expect(facts.backButtonCount, '切回单屏消息操作按钮应仍在').toBeGreaterThan(0);

  // 辅助(非主断言):实现钩子与可观察行为一致即可。
  expect(single.attr, '辅助:data-pane-count 应与真实 pane 数一致').toBe('1');
  expect(split2.attr, '辅助:data-pane-count 应与真实 pane 数一致').toBe('2');
  expect(back1.attr, '辅助:data-pane-count 应与真实 pane 数一致').toBe('1');
});

test('S2 首页输入框:粘贴 MacRoman 乱码还原为中文;正常中文按原文放行;无 pageerror', async ({ page }) => {
  const errors = watchPageErrors(page);
  await boot(page);
  const input = homeInput(page);
  await expect(input, '首页输入框应可见').toBeVisible({ timeout: 20_000 });
  await input.fill('');

  const paste1 = await dispatchPaste(page, HOME_INPUT, MOJIBAKE, { simulateBrowserDefault: true });
  expect(paste1.prevented, `乱码应被 preventDefault 并由修复逻辑还原;事件=${JSON.stringify(paste1)}`).toBe(true);
  expect(paste1.defaultPrevented, '乱码粘贴事件应 defaultPrevented 为 true').toBe(true);
  expect(paste1.dispatchReturn, '乱码粘贴的 dispatchEvent 应返回 false(已取消)').toBe(false);
  await expect(input, `乱码粘贴后应还原为「${REPAIRED}」;事件=${JSON.stringify(paste1)}`).toHaveValue(REPAIRED, { timeout: 10_000 });

  await input.fill('原有内容');
  const paste2 = await dispatchPaste(page, HOME_INPUT, '当前无可用凭证', { simulateBrowserDefault: true });
  expect(paste2.prevented, `正常中文不应被 preventDefault;事件=${JSON.stringify(paste2)}`).toBe(false);
  expect(paste2.defaultPrevented, '正常中文粘贴事件不应被取消').toBe(false);
  expect(paste2.dispatchReturn, '正常中文粘贴的 dispatchEvent 应返回 true(未被取消)').toBe(true);
  expect(paste2.insertedByDefault, '正常中文应走浏览器默认插入(合成补插)').toBe(true);
  await expect(input, `正常中文应原样追加,不被篡改;事件=${JSON.stringify(paste2)}`)
    .toHaveValue('原有内容当前无可用凭证', { timeout: 10_000 });

  expect(errors, 'S2 不应有未捕获异常').toEqual([]);
});

test('S2b 会话内 ChatInput:同一合成粘贴走真实 composer,乱码还原、正常中文不篡改、无 pageerror', async ({ page }) => {
  const errors = watchPageErrors(page);
  await boot(page);
  await openSessionBySearch(page, seed.firstText, seed.lastText);
  await expect(messageRows(page).first(), '种子会话应有已挂载消息行').toBeVisible({ timeout: 30_000 });
  const input = composerInput(page);
  await expect(input, '打开真实会话后应挂载会话内输入框 [data-cgui="composer-input"]').toBeVisible({ timeout: 30_000 });
  await input.fill('');

  const paste1 = await dispatchPaste(page, COMPOSER_INPUT, MOJIBAKE, { simulateBrowserDefault: true });
  expect(paste1.prevented, `会话内乱码应被 preventDefault 并还原;事件=${JSON.stringify(paste1)}`).toBe(true);
  expect(paste1.defaultPrevented, '会话内乱码粘贴事件应 defaultPrevented 为 true').toBe(true);
  expect(paste1.dispatchReturn, '会话内乱码粘贴的 dispatchEvent 应返回 false').toBe(false);
  await expect(input, `会话内乱码粘贴后应还原为「${REPAIRED}」;事件=${JSON.stringify(paste1)}`).toHaveValue(REPAIRED, { timeout: 10_000 });

  await input.fill('原有内容');
  const paste2 = await dispatchPaste(page, COMPOSER_INPUT, '当前无可用凭证', { simulateBrowserDefault: true });
  expect(paste2.prevented, `会话内正常中文不应被 preventDefault;事件=${JSON.stringify(paste2)}`).toBe(false);
  expect(paste2.defaultPrevented, '会话内正常中文粘贴事件不应被取消').toBe(false);
  expect(paste2.dispatchReturn, '会话内正常中文粘贴的 dispatchEvent 应返回 true(未被取消)').toBe(true);
  expect(paste2.insertedByDefault, '会话内正常中文应走浏览器默认插入(合成补插)').toBe(true);
  await expect(input, `会话内正常中文应原样追加,不被篡改;事件=${JSON.stringify(paste2)}`)
    .toHaveValue('原有内容当前无可用凭证', { timeout: 10_000 });

  expect(errors, 'S2b 不应有未捕获异常').toEqual([]);
});

test('S3 正常中文/英文/法文粘贴:未被 preventDefault,按原文追加、不误改', async ({ page }) => {
  const errors = watchPageErrors(page);
  await boot(page);
  const input = homeInput(page);
  await expect(input, '首页输入框应可见').toBeVisible({ timeout: 20_000 });

  for (const [name, text] of Object.entries(NORMAL)) {
    await input.fill('原值');
    const paste = await dispatchPaste(page, HOME_INPUT, text, { simulateBrowserDefault: true });
    expect(paste.prevented, `${name}正常文本不应被 preventDefault;事件=${JSON.stringify(paste)}`).toBe(false);
    expect(paste.defaultPrevented, `${name}正常文本粘贴事件不应被取消`).toBe(false);
    expect(paste.dispatchReturn, `${name}正常文本粘贴的 dispatchEvent 应返回 true(未被取消)`).toBe(true);
    expect(paste.insertedByDefault, `${name}正常文本应走浏览器默认插入(合成补插)`).toBe(true);
    await expect(input, `${name}正常文本应按原文追加;事件=${JSON.stringify(paste)}`)
      .toHaveValue(`原值${text}`, { timeout: 10_000 });
  }
  expect(errors, 'S3 不应有未捕获异常').toEqual([]);
});
