// r157-live-line：工作组（[data-work-group]）的观测面与造回合小工具。
// 只用接口文件列出的锚点（[data-work-group*]、[data-live-*]、[data-strip-item]、[data-entry-state]）加既有的 [data-cgui="…"]；不读源码、不读 React state。
import { expect } from '@playwright/test';
import { SESSIONS } from './fixtures.mjs';
import { primeOverlays, openApp, openSessionByMarker, sendInOpenSession, resetCtl, writeScenario } from './runtime.mjs';
import { liveSnap } from './live.mjs';

/** 一个带 description 的 Bash 工具调用事件（extra 里可加 pending / isError / result）。 */
export const bash = (desc, extra = {}) => ({ kind: 'tool', name: 'Bash', input: { command: `echo ${desc.length}`, description: desc }, ...extra });

/**
 * 页面快照（只读 DOM）：所有工作组（DOM 顺序，最后一个 = 本回合最新的）+ 全页的状态行 / 卡片计数。
 * 「看得见」= 非 display:none / visibility:hidden / opacity:0、有面积、没被「宽或高≈0 的 overflow:hidden 祖先」裁掉（收起动画的常见写法）。
 * 没有任何工作组时 groups 为空数组（不会抛错），让断言以"现状说明"的形式失败，而不是超时。
 */
export async function wgSnap(page) {
  return await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const shown = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        if (p !== el && /hidden|clip/.test(`${cs.overflowX} ${cs.overflowY}`)) { const r = p.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; }
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const all = (sel) => [...document.querySelectorAll(sel)];
    const inGroup = (e) => !!e.closest('[data-work-group]');
    const groups = all('[data-work-group]').map((g) => {
      const head = g.querySelector('[data-work-group-head]');
      const hl = head ? [...head.querySelectorAll('[data-live-line]')] : [];
      const l0 = hl[0] || null;
      const lt = l0 && l0.querySelector('[data-live-text]');
      const le = l0 && l0.querySelector('[data-live-elapsed]');
      const entries = [...g.querySelectorAll('[data-entry-state]')];
      const parts = []; // 头行之外、看得见的文字（子代理卡等组内容）
      const w = document.createTreeWalker(g, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const pe = n.parentElement;
        if (pe && !(head && head.contains(pe)) && n.nodeValue.trim() && shown(pe)) parts.push(n.nodeValue.trim());
      }
      return {
        state: g.getAttribute('data-work-group-state'), live: g.getAttribute('data-work-group-live'),
        hasHead: !!head, expanded: head ? head.getAttribute('aria-expanded') : null, headText: head ? norm(head.innerText) : null,
        headLines: hl.length, headInd: head ? head.querySelectorAll('[data-live-indicator]').length : 0,
        ind: l0 ? l0.querySelectorAll('[data-live-indicator]').length : 0,
        phase: l0 ? l0.getAttribute('data-live-phase') : null, lineText: lt ? norm(lt.textContent) : null, elapsed: le ? norm(le.textContent) : null,
        headError: head ? head.querySelectorAll('[data-work-group-error]').length : 0,
        entries: entries.length, entriesShown: entries.filter(shown).length, bodyText: norm(parts.join(' ')),
      };
    });
    const lines = all('[data-live-line]');
    return {
      groups, lines: lines.length, linesInGroups: lines.filter(inGroup).length, linesInHeads: lines.filter((l) => l.closest('[data-work-group-head]')).length,
      liveGroups: all('[data-work-group-live="true"]').length,
      tasksOutside: all('[data-strip-item="task"]').filter((e) => !inGroup(e)).length, tasksShown: all('[data-strip-item="task"]').filter(shown).length,
      workflowOutside: all('[data-strip-item="workflow"]').filter((e) => !inGroup(e) && shown(e)).length,
    };
  });
}
export const lastGroup = (s, n = 1) => s.groups[s.groups.length - n];
/** 最后第 n 个工作组（没有就返回空对象，方便在 expect.poll 里取字段而不抛 TypeError）。 */
export const gr = async (page, n = 1) => lastGroup(await wgSnap(page), n) || {};

/** 等「最后一个工作组承载着实时状态行」：live=true、头行里恰 1 个状态行，可选 phase / 状态词（字符串全等或正则）。
 *  没有 [data-work-group] 时失败信息直接写明现状（"页面上没有任何 [data-work-group]"），是断言失败而不是超时。 */
export async function expectLiveGroup(page, { phase, text, timeout = 15_000 } = {}) {
  await expect.poll(async () => {
    const g = lastGroup(await wgSnap(page));
    if (!g) return '页面上没有任何 [data-work-group]';
    if (g.live !== 'true') return `最后一个工作组 data-work-group-live=${g.live}`;
    if (g.headLines !== 1) return `最后一个工作组头行里的 [data-live-line] 有 ${g.headLines} 个`;
    if (phase && g.phase !== phase) return `头行状态行 data-live-phase=${g.phase}`;
    if (text !== undefined && !(text instanceof RegExp ? text.test(g.lineText) : g.lineText === text)) return `头行状态词=「${g.lineText}」`;
    return 'ok';
  }, { timeout, message: `最后一个工作组应承载实时状态行（phase=${phase ?? '任意'}，状态词=${text ?? '任意'}）` }).toBe('ok');
}

/** 前置自证（改动前就成立的那部分，不是被测改动）：页面上第一个状态行进入 phase（可选状态词）。 */
export async function waitLine(page, phase, text, timeout = 25_000) {
  const ok = (s) => s.count >= 1 && s.phase === phase && (text === undefined || (text instanceof RegExp ? text.test(s.text) : s.text === text));
  await expect.poll(async () => ok(await liveSnap(page)), { timeout, message: `前置自证：状态行应进入 ${phase}${text === undefined ? '' : `「${text}」`}` }).toBe(true);
}

/** 页内每 50 毫秒读一次最后一个工作组头行里的用时文字，返回 ms 毫秒内依次出现过的取值（连续相同的合并）。 */
export async function headElapsedTrail(page, ms = 1700) {
  return await page.evaluate((dur) => new Promise((resolve) => {
    const read = () => {
      const gs = document.querySelectorAll('[data-work-group]'); const g = gs[gs.length - 1];
      const e = g && g.querySelector('[data-work-group-head] [data-live-line] [data-live-elapsed]');
      return e ? e.textContent.trim() : null;
    };
    const seen = [read()];
    const iv = setInterval(() => { const c = read(); if (c !== seen[seen.length - 1]) seen.push(c); }, 50);
    setTimeout(() => { clearInterval(iv); resolve(seen); }, dur);
  }), ms);
}

/** 含 marker 的正文文字节点是否排在第一个状态行前面（= 状态行在正文下面）。 */
export async function lineAfterText(page, marker) {
  return await page.evaluate((mk) => {
    const live = document.querySelector('[data-live-line]');
    if (!live) return false;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeValue && n.nodeValue.includes(mk)) return !live.contains(n) && (n.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }
    return false;
  }, marker);
}

/** 与 startRound 同一套步骤，只是在「会话已打开、消息还没发」时多一个回调（B15② 在这里打开聊天模式）。 */
export async function startRoundHook(page, { key, scenario, beforeSend, text = '请开始这一轮' }) {
  resetCtl();
  writeScenario({ stepDelayMs: 120, holdBeforeResult: true, ...scenario });
  await primeOverlays(page);
  await openApp(page);
  await openSessionByMarker(page, SESSIONS[key].marker);
  if (beforeSend) await beforeSend();
  await sendInOpenSession(page, text);
}

/** 主题与外观 →「界面」页 →「聊天模式」那一行点一下（它不是 switch / checkbox，点文字即切换），再把弹层收起来。 */
export async function turnOnChatMode(page) {
  await page.locator('[data-cgui="theme-btn"]').click({ timeout: 10_000 });
  await page.getByRole('tab', { name: '界面' }).click({ timeout: 10_000 });
  await page.getByText('聊天模式', { exact: true }).click({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  if (await page.getByRole('tab', { name: '界面' }).count()) await page.locator('[data-cgui="theme-btn"]').click({ timeout: 10_000 });
}

/** 页内观察器：每次 DOM 变动记一条（第一个状态行的 phase / 状态词、页面上状态行总数、data-work-group-live=true 的个数、状态行是否在某个工作组里）。
 *  用来抓「停止中」这种只存在一两百毫秒的阶段；必须在点停止之前装，页面导航后要重装。 */
export async function installWgObserver(page) {
  await page.evaluate(() => {
    if (window.__r157Obs) window.__r157Obs.disconnect();
    window.__r157Log = [];
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const obs = new MutationObserver(() => {
      const ls = [...document.querySelectorAll('[data-live-line]')];
      if (!ls.length) return;
      const t = ls[0].querySelector('[data-live-text]');
      window.__r157Log.push({
        phase: ls[0].getAttribute('data-live-phase'), text: t ? norm(t.textContent) : null, lines: ls.length,
        wgLive: document.querySelectorAll('[data-work-group-live="true"]').length, inGroup: ls.some((l) => !!l.closest('[data-work-group]')),
      });
    });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__r157Obs = obs;
  });
}
export async function wgLog(page) { return await page.evaluate(() => (Array.isArray(window.__r157Log) ? window.__r157Log.slice() : [])); }
