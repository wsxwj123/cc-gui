// r186-reattach-live-row:页面观测。只读 DOM,只用接口文件列出的锚点
// ([data-live-line] / [data-live-indicator] / [data-work-group-head] / [data-entry-state] / [data-turn-uuid] / [data-cgui="message-list"])。
import { expect } from '@playwright/test';

/** 状态行的现状:总数、在折叠头里 / 不在折叠头里各几个、转圈指示总数、各状态行所在回合容器的文字(没有容器为 null)。 */
export async function liveInfo(page) {
  return await page.evaluate(() => {
    const lines = [...document.querySelectorAll('[data-live-line]')];
    const inHead = lines.filter((l) => !!l.closest('[data-work-group-head]'));
    return {
      lines: lines.length,
      inHead: inHead.length,
      outHead: lines.length - inHead.length,
      indicators: document.querySelectorAll('[data-live-indicator]').length,
      heads: document.querySelectorAll('[data-work-group-head]').length,
      stopBtns: document.querySelectorAll('[data-cgui="stop-btn"]').length,
      turnTexts: lines.map((l) => { const t = l.closest('[data-turn-uuid]'); return t ? t.innerText : null; }),
    };
  });
}

/** 一句话描述现状,放进断言信息里(失败时能直接看出页面上实际是什么样)。 */
export function describeLive(i) {
  return `状态行 ${i.lines} 个(折叠头里 ${i.inHead}、折叠头外 ${i.outHead});转圈指示 ${i.indicators} 个;折叠头 ${i.heads} 个;停止键 ${i.stopBtns} 个`;
}

/** 页面上有没有「可见的」工具条目([data-entry-state]),文字含 desc。可见 = 非 display:none / visibility:hidden / opacity:0、有面积、没被宽或高≈0 的 overflow:hidden 祖先裁掉。 */
export async function toolCardVisible(page, desc) {
  return await page.evaluate((d) => {
    const shown = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        if (p !== el && /hidden|clip/.test(`${cs.overflowX} ${cs.overflowY}`)) { const r = p.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; }
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return [...document.querySelectorAll('[data-entry-state]')].some((e) => (e.textContent || '').includes(d) && shown(e));
  }, desc);
}

/** 等 R186TOOL-1、R186TOOL-2 的工具卡的可见性都等于 want(15 秒内);失败信息写明实际值。 */
export async function expectCards(page, want, label) {
  await expect.poll(async () => ({
    t1: await toolCardVisible(page, 'R186TOOL-1'),
    t2: await toolCardVisible(page, 'R186TOOL-2'),
  }), { timeout: 15_000, message: label }).toEqual({ t1: want, t2: want });
}

/** 消息区的可见文字(消息区还没挂上返回空串)。 */
export async function readList(page) {
  return await page.evaluate(() => {
    const ml = document.querySelector('[data-cgui="message-list"]');
    return ml ? ml.innerText : '';
  });
}
export const stripDigits = (s) => s.replace(/[0-9]+/g, '');

/** 等页面上出现至少 1 个状态行,再让页面稳定 settleMs 毫秒,返回现状。 */
export async function settledLive(page, settleMs = 1500) {
  await expect.poll(async () => (await liveInfo(page)).lines, { timeout: 20_000, message: '页面上应出现带实时状态的行([data-live-line])' }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(settleMs);
  return await liveInfo(page);
}
