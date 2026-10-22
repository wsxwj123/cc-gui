// r151q 粘贴辅助:在真实输入框上派发合成 paste(DataTransfer 带 text/plain),可指定光标位置;
// 未被 preventDefault 时补一次等价于浏览器默认动作的插入(黑盒形态:用户最后看到的输入框内容)。
export const HOME_INPUT = '[data-cgui="home-input"]';
/** UTF-8 字节被当 MacRoman 解码后的乱码(按真实解码表算出来,不手抄)。 */
export const mojibake = (s) => new TextDecoder('macintosh').decode(Buffer.from(s, 'utf8'));
export const flush = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));

/** 直接设值(不进浏览器撤销栈)并通知 React;caret 缺省 = 末尾。 */
export async function setValue(page, selector, value, caret = null) {
  await page.evaluate(({ selector, value, caret }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${selector} not found`);
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const pos = caret === null ? value.length : caret;
    el.setSelectionRange(pos, pos);
  }, { selector, value, caret });
  await flush(page);
}

export async function dispatchPaste(page, selector, text, { start = null, end = null } = {}) {
  const r = await page.evaluate(({ selector, text, start, end }) => {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, reason: `${selector} not found` };
    el.focus();
    const s = start === null ? el.value.length : start;
    el.setSelectionRange(s, end === null ? s : end);
    let ev = null;
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const cand = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      if (cand.clipboardData && cand.clipboardData.getData('text/plain') === text) ev = cand;
    } catch { ev = null; }
    if (!ev) {
      ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: { getData: (t) => (t === 'text/plain' ? text : ''), items: [], files: [] } });
    }
    const ret = el.dispatchEvent(ev);
    const prevented = !ret || ev.defaultPrevented;
    if (!prevented) {
      el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok: true, prevented };
  }, { selector, text, start, end });
  await flush(page);
  return r;
}

/** 像用户打字那样插入(进浏览器撤销栈):光标先放到末尾,再 insertText。 */
export async function typeReal(page, selector, text) {
  await page.evaluate(({ selector }) => { const el = document.querySelector(selector); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, { selector });
  await page.keyboard.insertText(text);
  await flush(page);
}

/** 失焦再聚焦(结束上一段"打字",让下一步编辑在浏览器撤销栈里是独立的一步)。 */
export async function blurFocus(page, selector) {
  await page.evaluate(({ selector }) => { const el = document.querySelector(selector); el.blur(); }, { selector });
  await page.evaluate(({ selector }) => { const el = document.querySelector(selector); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, { selector });
}
