// A. 粘贴乱码还原收紧(行为 1–3)。真实 App(共享实例 + dev server)里的首页输入框,合成 paste。
import { test, expect } from '@playwright/test';
import { boot } from '../r151b-xsession-p1/helpers/ui.mjs';
import { seedSession, uniq } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { HOME_INPUT, mojibake, setValue, dispatchPaste, typeReal, blurFocus, flush } from './helpers/paste.mjs';

test.describe.configure({ timeout: 120_000 });
const UNDO = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
// Mac 用 Option 键打出的符号对 / 正常外文 / 还原后会落在私用区的串
const KEEP = ['∆µ = 5 kJ', '≈∞', '∆Ω', '∆π', '«é»', 'Größe', 'Ôéé'];
const TRUE_MOJIBAKE_SRC = ['✻ API error · Retrying in 0s', '当前无可用凭证'];

async function openHome(page) {
  seedSession(`q-paste-${uniq('')}`); // 共享实例里至少要有一个项目,首页输入框才会出现
  await boot(page);
  const input = page.locator(HOME_INPUT);
  await expect(input, '首页输入框应可见').toBeVisible({ timeout: 30_000 });
  return input;
}

test('Q01 粘贴 Option 符号对 / 正常外文 / 私用区串 → 输入框内容与原文逐字相同', async ({ page }) => {
  const input = await openHome(page);
  const got = [];
  for (const text of KEEP) {
    await setValue(page, HOME_INPUT, '');
    await dispatchPaste(page, HOME_INPUT, text);
    got.push({ text, value: await input.inputValue() });
  }
  expect(got, '每一条粘贴后的输入框内容').toEqual(KEEP.map((text) => ({ text, value: text })));
});

test('Q02 (相邻) 真乱码仍被还原(‚úª…¬∑ → ✻…·;ÂΩì… → 当前无可用凭证),光标前后原有文字保留', async ({ page }) => {
  expect(mojibake(TRUE_MOJIBAKE_SRC[0]), '前置:本机解码表算出的乱码与接口文件示例一致').toBe('‚úª API error ¬∑ Retrying in 0s');
  const input = await openHome(page);
  const prefix = '前文'; const suffix = '后文';
  const got = [];
  for (const original of TRUE_MOJIBAKE_SRC) {
    await setValue(page, HOME_INPUT, prefix + suffix, prefix.length);
    await dispatchPaste(page, HOME_INPUT, mojibake(original), { start: prefix.length });
    got.push({ original, value: await input.inputValue() });
  }
  expect(got).toEqual(TRUE_MOJIBAKE_SRC.map((original) => ({ original, value: prefix + original + suffix })));
});

test('Q03 乱码被还原后按一次撤销 → 输入框回到粘贴之前的内容', async ({ page }) => {
  // 新开的页面,撤销栈是干净的;粘贴前的内容用程序设值(不进撤销栈),这样撤销栈里只可能有"还原这一步"
  const input = await openHome(page);
  const before = '原有内容'; const original = '当前无可用凭证';
  await setValue(page, HOME_INPUT, before);
  await dispatchPaste(page, HOME_INPUT, mojibake(original));
  expect(await input.inputValue(), '前置:乱码已被还原并接在原有内容后').toBe(before + original);
  const canUndo = await page.evaluate(() => document.queryCommandEnabled('undo'));
  await page.keyboard.press(UNDO);
  await flush(page);
  const afterUndo = await input.inputValue();

  // 对照(放在主流程之后,不污染撤销栈):程序设值 + 原生 execCommand('insertText') 一步 + 撤销一次,应退回设值时的内容。
  // 退回 = 本环境(WebKit 无头)的撤销能表达"粘贴前非空的内容",主断言看输入框内容;
  // 退不回 = 环境把程序设值之后的撤销做成"整个清空",此时改看"撤销栈里确有这一步"(queryCommandEnabled('undo'))。
  await setValue(page, HOME_INPUT, '对照');
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.focus(); el.setSelectionRange(el.value.length, el.value.length); document.execCommand('insertText', false, 'X'); }, HOME_INPUT);
  await flush(page);
  const ctrlTyped = await input.inputValue();
  await page.keyboard.press(UNDO);
  await flush(page);
  const envOk = ctrlTyped === '对照X' && (await input.inputValue()) === '对照';
  const note = `canUndo=${canUndo};按撤销后输入框=${JSON.stringify(afterUndo)};环境对照可表达非空粘贴前内容=${envOk}`;
  test.info().annotations.push({ type: 'note', description: note });
  console.log(`Q03-OBSERVED ${note}`);
  if (envOk) expect(afterUndo, `按一次撤销后应回到粘贴之前的内容(${note})`).toBe(before);
  else expect(canUndo, `还原应走浏览器原生编辑,撤销栈里才有这一步(${note})`).toBe(true);
});
