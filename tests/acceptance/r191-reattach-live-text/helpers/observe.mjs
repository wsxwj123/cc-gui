// r191-reattach-live-text:页面观测。只读 DOM,只用 [data-cgui="message-list"](对话区,不含侧栏与输入框)与 [data-cgui="stop-btn"]。
// 每「读一次」都在一次 page.evaluate 里完成(不做先问元素在不在、再读内容的两步写法)。

/** 读一次页面:各标记在对话区文字里出现的次数、P1 / P2 已显示到的最大片号、停止键个数、整页有没有「会话流连接失败」。 */
export async function snap(page) {
  return await page.evaluate(() => {
    const ml = document.querySelector('[data-cgui="message-list"]');
    const text = ml ? ml.innerText : '';
    const count = (s) => text.split(s).length - 1;
    const maxPiece = (name) => {
      let m = 0;
      for (const x of text.matchAll(new RegExp(`R191-${name}-(\\d{3})`, 'g'))) m = Math.max(m, Number(x[1]));
      return m;
    };
    return {
      hasList: !!ml,
      p0First: count('R191-P0-001'),
      p1First: count('R191-P1-001'),
      p2First: count('R191-P2-001'),
      p1Stopped: count('R191-P1-STOPPED'),
      p1Last: count('R191-P1-160'),
      p2Last: count('R191-P2-040'),
      maxP1: maxPiece('P1'),
      maxP2: maxPiece('P2'),
      stopBtns: document.querySelectorAll('[data-cgui="stop-btn"]').length,
      streamFail: document.body.innerText.includes('会话流连接失败'),
    };
  });
}

/** 连续读页面:每 everyMs 毫秒读一次,读满 durationMs 毫秒,返回所有读数。 */
export async function sampleFor(page, durationMs, everyMs) {
  const samples = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    samples.push(await snap(page));
    await page.waitForTimeout(everyMs);
  }
  return samples;
}

/** 轮询读页面直到 pred(snap) 为真;超时返回 null。 */
export async function waitSnap(page, pred, timeoutMs, everyMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await snap(page);
    if (pred(s)) return s;
    if (Date.now() >= end) return null;
    await page.waitForTimeout(everyMs);
  }
}
