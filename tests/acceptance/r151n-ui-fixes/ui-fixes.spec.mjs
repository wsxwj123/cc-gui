// r151n 补验收:①分屏 ≥2 窗格时消息操作文字标签只留图标;②粘贴终端复制来的
// "UTF-8 字节被当 MacRoman 解码"的乱码时自动还原,正常中文/英文/法文不误改。
//
// 全部走真实 App(dev server 直出源码 + 隔离 server):S1 打开真实历史会话,
// 在真实消息操作区里读 .cgui-action-label 的计算样式;S2/S3 在首页真实 textarea 上
// 派发合成 paste(DataTransfer 携带 text/plain),看 React 受控值。
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

/** 真实 DOM 上的分屏状态:容器 data-pane-count + 操作标签数量/计算样式。
 *  标签按文本「重做/分叉」定位(修复前它们还没有 .cgui-action-label 类),
 *  同时记录其中带该类的数量,便于区分“类没加”和“类加了但规则没命中”。 */
async function paneFacts(page) {
  return page.evaluate(() => {
    const split = document.querySelector('[data-testid="pane-split"]');
    if (!split) return { found: false };
    const labels = Array.from(split.querySelectorAll('span'))
      .filter((el) => /^(重做|分叉)$/.test((el.textContent || '').trim()));
    const classed = labels.filter((el) => el.classList.contains('cgui-action-label'));
    const displays = labels.map((el) => getComputedStyle(el).display);
    return {
      found: true,
      attr: split.getAttribute('data-pane-count'),
      labelCount: labels.length,
      labelClassCount: classed.length,
      labelTexts: labels.map((el) => el.textContent),
      displays,
      allNone: labels.length > 0 && displays.every((d) => d === 'none'),
      someVisible: displays.some((d) => d !== 'none'),
      allClassed: labels.length > 0 && classed.length === labels.length,
    };
  });
}

/**
 * 在首页真实输入框上派发合成 paste。
 * 优先用 ClipboardEvent + DataTransfer;WebKit 若不给构造器塞 clipboardData,
 * 退化成普通 Event + 只读 clipboardData 对象(React 的 onPaste 只读 getData/items)。
 */
async function dispatchPaste(page, text, { simulateDefault = false } = {}) {
  return page.evaluate(({ text, simulateDefault }) => {
    const el = document.querySelector('[data-cgui="home-input"]');
    if (!el) return { ok: false, reason: 'home input not found' };
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
    const notCanceled = el.dispatchEvent(ev);
    // 合成事件不会触发浏览器的默认插入。需要还原“真实粘贴”的失败形态时,
    // 在未被 preventDefault 的情况下补一次等价于浏览器默认动作的插入(基线红证据用);
    // 修复版会 preventDefault,这里不会执行。
    let defaultValueInserted = false;
    if (notCanceled && simulateDefault) {
      const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
      try { el.setRangeText(text, start, end, 'end'); } catch { el.value += text; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      defaultValueInserted = true;
    }
    return {
      ok: true,
      eventKind,
      realDataTransfer: !!dt,
      prevented: !notCanceled,
      defaultValueInserted,
      valueAfter: el.value,
    };
  }, { text, simulateDefault });
}

const homeInput = (page) => page.locator('[data-cgui="home-input"]');

test.describe.configure({ timeout: 180_000 });

test('S1 分屏 ≥2 窗格:真实消息操作标签计算样式 display:none;切回 1 窗格恢复', async ({ page }) => {
  const errors = watchPageErrors(page);
  await boot(page);
  await openSessionBySearch(page, seed.firstText, seed.lastText);
  await expect(messageRows(page).first(), '种子会话应有已挂载消息行').toBeVisible({ timeout: 30_000 });
  // 先在真实消息操作区确认标签存在(按文本定位,修复前没有 .cgui-action-label 类)。
  await expect.poll(async () => (await paneFacts(page)).labelCount, {
    message: '真实消息操作区应有「重做/分叉」文字标签',
    timeout: 20_000,
  }).toBeGreaterThan(0);

  const single = await paneFacts(page);

  // 分屏入口收在顶栏面板坞的 rail 里(窗口级操作),先展开坞再点。
  await page.locator('[data-testid="panel-dock-toggle"]').click();
  await expect(page.locator('[data-testid="pane-count"]'), '展开面板坞后应出现分屏数量入口').toBeVisible({ timeout: 10_000 });
  await page.locator('[data-testid="pane-count"]').click();
  await page.locator('[data-testid="pane-count-2"]').click();
  await page.waitForTimeout(600);
  const split2 = await paneFacts(page);

  await page.locator('[data-testid="pane-count"]').click();
  await page.locator('[data-testid="pane-count-1"]').click();
  await page.waitForTimeout(600);
  const back1 = await paneFacts(page);

  const facts = {
    singleFound: single.found,
    singleAttr: single.attr,
    singleLabelCount: single.labelCount,
    singleLabelClassCount: single.labelClassCount,
    singleSomeVisible: single.someVisible,
    splitFound: split2.found,
    splitAttr: split2.attr,
    splitLabelCount: split2.labelCount,
    splitLabelClassCount: split2.labelClassCount,
    splitAllClassed: split2.allClassed,
    splitAllNone: split2.allNone,
    splitSomeVisible: split2.someVisible,
    splitDisplays: split2.displays,
    backFound: back1.found,
    backAttr: back1.attr,
    backLabelCount: back1.labelCount,
    backLabelClassCount: back1.labelClassCount,
    backSomeVisible: back1.someVisible,
    hasRetryOrForkLabel: single.labelTexts.some((t) => /重做|分叉/.test(t)),
    pageErrors: errors,
  };
  expect(facts, `分屏前后真实 DOM 事实:\n${JSON.stringify({ single, split2, back1, errors }, null, 2)}`).toEqual({
    singleFound: true,
    singleAttr: '1',
    singleLabelCount: expect.any(Number),
    singleLabelClassCount: expect.any(Number),
    singleSomeVisible: true,
    splitFound: true,
    splitAttr: '2',
    splitLabelCount: expect.any(Number),
    splitLabelClassCount: expect.any(Number),
    splitAllClassed: true,
    splitAllNone: true,
    splitSomeVisible: false,
    splitDisplays: expect.any(Array),
    backFound: true,
    backAttr: '1',
    backLabelCount: expect.any(Number),
    backLabelClassCount: expect.any(Number),
    backSomeVisible: true,
    hasRetryOrForkLabel: true,
    pageErrors: [],
  });
  expect(facts.singleLabelCount, '单屏真实消息操作区应有标签').toBeGreaterThan(0);
  expect(facts.singleLabelClassCount, '单屏真实消息操作标签应带 .cgui-action-label 类').toBe(facts.singleLabelCount);
  expect(facts.splitLabelCount, '分屏后真实消息操作区仍应有标签(只是 display:none)').toBeGreaterThan(0);
  expect(facts.backLabelCount, '切回单屏后真实消息操作区仍应有标签').toBeGreaterThan(0);
  expect(facts.backLabelClassCount, '切回单屏后标签应仍带 .cgui-action-label 类').toBe(facts.backLabelCount);
});

test('S2 粘贴 MacRoman 乱码还原为中文;正常中文不被篡改;无 pageerror', async ({ page }) => {
  const errors = watchPageErrors(page);
  await boot(page);
  const input = homeInput(page);
  await expect(input, '首页输入框应可见').toBeVisible({ timeout: 20_000 });
  await input.fill('');

  const paste1 = await dispatchPaste(page, MOJIBAKE, { simulateDefault: true });
  await expect(input, `乱码粘贴后应还原为「${REPAIRED}」;事件=${JSON.stringify(paste1)}`).toHaveValue(REPAIRED, { timeout: 10_000 });

  await input.fill('原有内容');
  const paste2 = await dispatchPaste(page, '当前无可用凭证');
  await expect(input, `正常中文不应被改动;事件=${JSON.stringify(paste2)}`).toHaveValue('原有内容', { timeout: 10_000 });

  expect(errors, 'S2 不应有未捕获异常').toEqual([]);
});

test('S3 正常中文/英文/法文粘贴不误改', async ({ page }) => {
  const errors = watchPageErrors(page);
  await boot(page);
  const input = homeInput(page);
  await expect(input, '首页输入框应可见').toBeVisible({ timeout: 20_000 });

  for (const [name, text] of Object.entries(NORMAL)) {
    await input.fill('原值');
    const paste = await dispatchPaste(page, text);
    await expect(input, `${name}正常文本不应被改动;粘贴前原值=原值;事件=${JSON.stringify(paste)}`).toHaveValue('原值', { timeout: 10_000 });
  }
  expect(errors, 'S3 不应有未捕获异常').toEqual([]);
});
