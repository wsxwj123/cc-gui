// r201l 复现探针:页面观测。只读 [data-cgui="message-list"] 里的 DOM,一次 page.evaluate 读完。
// 按页面先后顺序列出锚点:P0 / P1 / P1B / P2 / S(各段正文或思考的文字,不算实时行里的预览)、
// STEER(「已并入」小标)、MSG(并入消息原文)、TAIL(重新接上的尾巴容器)、LIVE(实时行;带它的文字和旁边有没有「上次更新」)。

export async function snap(page, steerText = '') {
  return await page.evaluate((steerTextArg) => {
    const ml = document.querySelector('[data-cgui="message-list"]');
    if (!ml) return { hasList: false, seq: [], lives: [], stopBtns: document.querySelectorAll('[data-cgui="stop-btn"]').length };
    const seq = [];
    const lives = [];
    let steerCount = 0;
    const push = (k, extra = {}) => {
      const last = seq[seq.length - 1];
      if (last && last.k === k && k !== 'LIVE' && k !== 'TAIL') return;
      seq.push({ k, ...extra });
    };
    const walker = document.createTreeWalker(ml, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) {
        if (n.hasAttribute('data-live-line')) {
          const holder = n.parentElement;
          const near = holder ? holder.innerText : '';
          const info = {
            text: n.innerText.replace(/\s+/g, ' ').trim(),
            lastUpdate: /上次更新/.test(near),
            inTail: !!n.closest('[data-turn-role="reattach-tail"]'),
          };
          lives.push(info);
          push('LIVE', info);
        } else if (n.getAttribute('data-turn-role') === 'reattach-tail') {
          push('TAIL');
        }
        continue;
      }
      const pe = n.parentElement;
      if (!pe || pe.closest('[data-live-line]')) continue;
      const t = n.nodeValue || '';
      if (!t.trim()) continue;
      if (/^\s*已并入\s*$/.test(t)) { steerCount += 1; push('STEER'); }
      else if (steerTextArg && t.includes(steerTextArg)) push('MSG');
      else if (t.includes('R201L-P1B-')) push('P1B');
      else if (t.includes('R201L-P1-')) push('P1');
      else if (t.includes('R201L-P0-')) push('P0');
      else if (t.includes('R201L-P2-')) push('P2');
      else if (t.includes('R201L-S-')) push('S');
    }
    return {
      hasList: true,
      seq,
      lives,
      steerCount,
      stopBtns: document.querySelectorAll('[data-cgui="stop-btn"]').length,
      streamFail: document.body.innerText.includes('会话流连接失败'),
    };
  }, steerText);
}

/** 把一次读数压成一行:P0>LIVE(…)>STEER>TAIL>P1 */
export function seqLine(s) {
  return (s.seq || []).map((x) => (x.k === 'LIVE' ? `LIVE[${x.lastUpdate ? '重接' : '直播'}${x.inTail ? '·尾巴里' : ''}:${(x.text || '').slice(0, 40)}]` : x.k)).join(' > ');
}

/** 去掉实时行里每秒都变的计时与预览,只留结构(用于判断「布局变了没有」)。 */
export function shapeLine(s) {
  return (s.seq || []).map((x) => (x.k === 'LIVE' ? `LIVE${x.lastUpdate ? '(重接)' : ''}${x.inTail ? '(尾巴里)' : ''}` : x.k)).join('>');
}

/** 实时行是不是排在「已并入」气泡上面(= 这次要修的现象)。没有实时行或没有并入气泡时返回 null。 */
export function liveAboveSteer(s) {
  const ks = (s.seq || []).map((x) => x.k);
  const iSteer = ks.indexOf('STEER');
  const iLive = ks.lastIndexOf('LIVE');
  if (iSteer < 0 || iLive < 0) return null;
  return iLive < iSteer;
}

/** 实时行后面还有没有正文 / 思考锚点(实时行不在最下面)。没有实时行返回 null。 */
export function contentBelowLive(s) {
  const ks = (s.seq || []).map((x) => x.k);
  const iLive = ks.lastIndexOf('LIVE');
  if (iLive < 0) return null;
  return ks.slice(iLive + 1).some((k) => ['P0', 'P1', 'P1B', 'P2', 'S', 'STEER', 'MSG', 'TAIL'].includes(k));
}
