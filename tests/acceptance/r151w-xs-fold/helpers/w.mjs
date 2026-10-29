// r151w 夹具层(只走 HTTP / 文件 / 外部进程记录,不 import 产品代码)。
// 复用一期(r151b)的实例、临时 HOME、seedSession 与界面操作;复用二期的假模型接口与垫片,本套件不访问外网。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  seedSession, uniq, makeWorkspace, encodeProjectDir, ctlDir, homeDir, prefsPath, newSid, realCliPath,
} from '../../r151b-xsession-p1/helpers/fixtures.mjs';
import {
  xs, shared, waitFor, readStream, writeScript, touchCtl, turnRecords, get, API,
} from '../../r151b-xsession-p1/helpers/api.mjs';
import {
  boot, openSessionBySearch, openSessionSettings, recordRequests, composer, sendPrompt, sidebar,
} from '../../r151b-xsession-p1/helpers/ui.mjs';
import { REFUSAL_P2, SM, inboundOk, profileTurn, aiCalls, addScript, resultJson } from '../../r151c-xsession-p2/helpers/p2.mjs';

export {
  seedSession, uniq, makeWorkspace, encodeProjectDir, ctlDir, homeDir, prefsPath, newSid, realCliPath,
  xs, shared, waitFor, readStream, writeScript, touchCtl, turnRecords, get, API,
  boot, openSessionBySearch, openSessionSettings, recordRequests, composer, sendPrompt, sidebar,
  REFUSAL_P2, SM, inboundOk, profileTurn, aiCalls, addScript, resultJson,
};

export const api = xs();
export const ALL = 'pending,queued,claimed,processing,done,dismissed';
export const TOOL_GUI = SM;
export const TOOL_NATIVE = 'SendMessage';
export const REJECT_TITLE = '原生发送被拒';
export const EXPAND = '展开全文';
export const COLLAPSE = '收起';
export const EMPTY = {
  inbox: '（正文不可用）',
  receive: '（内容未能解析）',
  send: '（正文未记录）',
};

/** 一条唯一标记(带时间戳,避免用例之间串)。 */
export const mark = (tag) => uniq(`R151W${tag}`);
export const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 两条会话:来源 A / 目标 B。 */
export function seedPair(tag) {
  const m = mark(tag);
  const A = seedSession(`w-${tag}-a-${m}`, { title: `${m} 来源` });
  const B = seedSession(`w-${tag}-b-${m}`, { title: `${m} 目标` });
  return { m, A, B };
}

/** 给目标投一条待处理消息;返回消息对象。 */
export async function sendInbox(A, B, body) {
  const [m] = await api.send(A ? A.sid : null, [B.sid], body);
  expect(m && m.id, '前置:POST /api/xsession/messages 应返回一条消息').toBeTruthy();
  return m;
}

export const inbox = (page) => page.getByTestId('xs-inbox');
export const cardOf = (page, id) => page.locator(`[data-testid="xs-card"][data-message-id="${id}"]`);
export const peerRows = (page) => page.getByTestId('peer-message');
export const sendRows = (page) => page.getByTestId('xs-send-notice');

/** 元素的计算样式 + 盒子;正文折叠只看这几个可观察量。 */
export const styleOf = (loc) => loc.evaluate((el) => {
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const lh = parseFloat(s.lineHeight);
  return {
    clamp: s.webkitLineClamp || s.getPropertyValue('-webkit-line-clamp') || '',
    height: r.height,
    width: r.width,
    top: r.top,
    left: r.left,
    right: r.right,
    bottom: r.bottom,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: s.overflowY,
    boxShadow: s.boxShadow,
    fontSize: parseFloat(s.fontSize),
    lineHeight: Number.isFinite(lh) ? lh : parseFloat(s.fontSize) * 1.5,
    outlineStyle: s.outlineStyle,
    outlineWidth: s.outlineWidth,
    disabled: Boolean(el.disabled),
    tag: el.tagName,
    role: el.getAttribute('role'),
    ariaExpanded: el.getAttribute('aria-expanded'),
  };
});

export const pageHeight = (page) => page.evaluate(() => window.innerHeight);
export const pageWidth = (page) => page.evaluate(() => window.innerWidth);

/**
 * 在页面上发一条消息,让假 CLI 照 steps 演(消息里带 R151S:<脚本名>)。
 * 返回脚本名;await expectText 给定时等这段文字出现(= 这一轮跑完)。
 * 只驱动界面已有的输入框,不直接打 /api/chat,保证界面自己订阅这一轮的事件流。
 */
export async function liveTurn(page, markText, tag, steps, expectText) {
  const name = uniq(`s${tag}`);
  writeScript(name, steps);
  await sendPrompt(page, `${markText} ${tag} R151S:${name}`);
  if (expectText) await expect(page.getByText(expectText).first(), `这一轮应跑完(${expectText})`).toBeVisible({ timeout: 30_000 });
  return name;
}

/** 成功发送的 GUI 通道工具结果文本(形状照 INTERFACE 第 6 节)。 */
export function guiResult({ targets, delivery = 'card', note = '等待你确认后处理', notice = '发送后不会同步收到回复。' }) {
  return JSON.stringify({
    results: targets.map((t) => ({ to: t.sid, ok: true, id: String(t.shortId || t.sid).slice(0, 8), name: t.title, delivery, note })),
    notice,
  });
}

/** 一条 GUI 发送脚本:tool_use → tool_result → 一句收尾。 */
export function guiSendSteps({ id, input, resultText, isError = false, say }) {
  return [
    { toolUse: { id, name: TOOL_GUI, input } },
    { toolResult: { tool_use_id: id, content: [{ type: 'text', text: resultText }], is_error: isError } },
    { say },
  ];
}

// ---------------- 历史夹具(会话记录 jsonl) ----------------
const TS0 = Date.parse('2026-10-03T08:00:00.000Z');
const ts = (n) => new Date(TS0 + n * 1000).toISOString();
const assistantMsg = (n, sid, content, stop = 'end_turn') => ({
  id: `msg_${sid.slice(0, 8)}_${n}`, type: 'message', role: 'assistant', model: 'r151-chat', content,
  stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
});

/**
 * 一条会话记录:首条提问 + assistant 的 tool_use + user 的 tool_result + 收尾。
 * tool_use 的 name/input 与 tool_result 的 text 由调用方给;形状照 INTERFACE 第 6 节第 3 条。
 */
export function sendHistoryLines(sid, { toolId, toolName = TOOL_GUI, input, resultText, isError = false, firstPrompt, finalText = '这一轮结束' }) {
  const u0 = { type: 'user', uuid: `${sid}-u0`, parentUuid: null, timestamp: ts(0), message: { role: 'user', content: firstPrompt } };
  const a1 = {
    type: 'assistant', uuid: `${sid}-a1`, parentUuid: u0.uuid, timestamp: ts(1), requestId: `req_${sid.slice(0, 6)}_1`,
    message: assistantMsg(1, sid, [{ type: 'tool_use', id: toolId, name: toolName, input }], 'tool_use'),
  };
  const u1 = {
    type: 'user', uuid: `${sid}-u1`, parentUuid: a1.uuid, timestamp: ts(2),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text: resultText }], is_error: isError }] },
  };
  const a2 = {
    type: 'assistant', uuid: `${sid}-a2`, parentUuid: u1.uuid, timestamp: ts(3), requestId: `req_${sid.slice(0, 6)}_2`,
    message: assistantMsg(2, sid, [{ type: 'text', text: finalText }]),
  };
  return [u0, a1, u1, a2];
}

/** 历史里一条 peer 消息的 user 行(写法照 x23 里取自真 CLI 实录的夹具)。 */
export function peerLine(sid, n, { parentUuid = null, from = 'gui:user', name = null, body = null, promptSource = 'system' } = {}) {
  const content = body === null ? 'R151W 无法识别的文本' : `Another Claude session sent a message:\n<cross-session-message from="${from}" from-name="${name || ''}">\n${body}\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.`;
  return {
    type: 'user', uuid: `${sid}-p${n}`, parentUuid, timestamp: ts(n), isMeta: true, promptSource, turnOrigin: 'peer',
    origin: { kind: 'peer', from, ...(name ? { name } : {}), ...(body === null ? {} : { body }), hostInjected: true },
    message: { role: 'user', content },
  };
}

/** 带 peer 行的历史会话:首条提问 + 若干 peer 行 + 收尾回复。返回 { sid, cwd, file, title, reply }。 */
export function seedPeerHistory(tag, peers, { title } = {}) {
  const m = mark(tag);
  const sid = newSid();
  const t = title || `${m} 历史接收`;
  const lines = [
    { type: 'user', uuid: `${sid}-u0`, parentUuid: null, timestamp: ts(0), message: { role: 'user', content: `${t} 首条提问` } },
    ...peers.map((p, i) => peerLine(sid, i + 1, p)),
    {
      type: 'assistant', uuid: `${sid}-a9`, parentUuid: null, timestamp: ts(20), requestId: `req_${sid.slice(0, 6)}`,
      message: assistantMsg(9, sid, [{ type: 'text', text: `${t} 回复` }]),
    },
  ];
  return seedSession(`w-${tag}-${m}`, { sid, title: t, firstPrompt: `${t} 首条提问`, lines });
}

/** 预置一轮发送历史(D10/D11):返回 { sid, cwd, file, title, reply }。 */
export function seedSendHistory(tag, opts) {
  const m = mark(tag);
  const title = `${m} 历史发送`;
  const sid = newSid();
  const firstPrompt = `${title} 首条提问`;
  return seedSession(`w-${tag}-${m}`, {
    sid, title, firstPrompt,
    lines: sendHistoryLines(sid, { ...opts, firstPrompt, finalText: `${title} 回复` }),
  });
}

/** 读目标会话的收件列表(按状态)。 */
export async function msgsOf(sid, status = ALL) {
  const r = await api.list(sid, status);
  return (r.body && Array.isArray(r.body.messages)) ? r.body.messages : [];
}

/** 轮询直到消息进入某状态。 */
export async function waitStatus(sid, id, status, ms = 20_000) {
  return waitFor(async () => {
    const m = (await msgsOf(sid)).find((x) => x.id === id);
    return m && m.status === status ? m : null;
  }, ms);
}

/** 让会话忙住(假 CLI 等放行文件);返回放行函数。 */
export async function holdSession(page, sid, run) {
  const go = `w-go-${run}`;
  writeScript(`w-hold-${run}`, [{ waitFile: go }, { waitFile: go }, { say: `R151W 忙完了 ${run}` }]);
  await sendPrompt(page, `R151W ${run} R151S:w-hold-${run}`);
  expect(await waitFor(() => turnRecords().some((t) => t.sid === sid && t.text.includes(`w-hold-${run}`)), 15_000), '前置:目标会话正在跑一个会忙住的回合').toBeTruthy();
  return () => touchCtl(go);
}

/** 打开设置页「会话」分区里的总开关,并拨到 on/off(界面入口,幂等)。 */
export async function setToggleUI(page, on) {
  await openSessionSettings(page);
  const toggle = page.getByTestId('xsession-settings-section').getByTestId('xsession-toggle');
  await expect(toggle, '前置:设置页「会话」分区里有跨会话总开关').toBeVisible({ timeout: 10_000 });
  const want = on ? 'true' : 'false';
  if ((await toggle.getAttribute('aria-checked')) !== want) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', want, { timeout: 10_000 });
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

/** 直接改偏好文件里的总开关(不进设置页):缺失 = 关。 */
export async function setToggleFile(on) {
  const f = prefsPath(homeDir());
  let p = {};
  try { p = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { p = {}; }
  if (on) p.xsEnabled = true; else delete p.xsEnabled;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(p, null, 2));
  await api.put('/api/xsession/config', { enabled: Boolean(on) }).catch(() => null);
}

/** 数一行的两个展开控件(用于 E3 唯一性):返回 [{tag, name, expanded}]。 */
export const expandControls = (loc) => loc.evaluate((el) => [...el.querySelectorAll('button,[role="button"]')]
  .map((b) => ({
    tag: b.tagName,
    name: (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim(),
    expanded: b.getAttribute('aria-expanded'),
    visible: Boolean(b.getClientRects().length),
  }))
  .filter((x) => x.visible && /展开|收起/.test(x.name)));

/** 面板坞 → 分屏数。 */
export async function setPanes(page, n) {
  const now = await page.locator('[data-testid="pane"]').count();
  if (now === n) return;
  const probe = page.locator('[data-testid="pane-count"]').first();
  if (!(await probe.isVisible().catch(() => false))) await page.locator('[data-testid="panel-dock-toggle"]').click();
  await expect(probe).toBeVisible({ timeout: 10_000 });
  if (!(await page.getByTestId(`pane-count-${n}`).first().isVisible().catch(() => false))) await probe.click();
  await page.getByTestId(`pane-count-${n}`).first().click();
  await page.keyboard.press('Escape').catch(() => {});
  await expect.poll(() => page.locator('[data-testid="pane"]').count(), { timeout: 10_000 }).toBe(n);
}

/** 把第 i 格(1 起)设为当前,再用侧栏搜索打开一条会话。 */
export async function fillPane(page, i, searchMark) {
  const pane = page.locator('[data-testid="pane"]').nth(i - 1);
  const hint = pane.getByText(/点左侧任一会话填入本分屏/).first();
  if (await hint.isVisible().catch(() => false)) await hint.click();
  else await pane.getByPlaceholder(/输入消息|开始一个新会话/).last().click();
  await page.waitForTimeout(300);
  await openSessionBySearch(page, searchMark);
  await page.waitForTimeout(500);
}

/** 浏览器里当前是否有横向溢出。 */
export const overflowX = (page) => page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
  bodyScrollWidth: document.body.scrollWidth,
}));

/** Tab / Shift+Tab 到满足判定条件的元素(最多 max 次);返回命中的可访问名或 null。 */
export async function tabUntil(page, predSource, max = 120, { shift = false } = {}) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    const hit = await page.evaluate((src) => {
      const el = document.activeElement;
      if (!el) return null;
      // eslint-disable-next-line no-new-func
      const pred = new Function('el', `return (${src});`);
      if (!pred(el)) return null;
      return (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    }, predSource);
    if (hit) return hit;
  }
  return null;
}

/** 先把焦点放到输入框,再 Shift+Tab 往回找(收件箱在输入框之前,不受侧栏会话数影响)。 */
export async function tabBackFromComposer(page, predSource, max = 60) {
  const box = page.getByPlaceholder(/输入消息|开始一个新会话/).last();
  await box.click();
  return tabUntil(page, predSource, max, { shift: true });
}

/** 当前焦点元素的描述(调试 / 焦点不丢的断言)。 */
export const activeElementFacts = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el) return null;
  const s = getComputedStyle(el);
  return {
    tag: el.tagName,
    testid: el.getAttribute('data-testid'),
    name: (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    outlineStyle: s.outlineStyle,
    outlineWidth: s.outlineWidth,
    boxShadow: s.boxShadow,
  };
});


/** 等这一轮流式结束(停止按钮消失);只用于假 CLI 的短回合。 */
export async function waitTurnDone(page) {
  await expect.poll(async () => page.getByRole('button', { name: /^停止/ }).count(), { timeout: 30_000, message: '这一轮应跑完' }).toBe(0);
  await page.waitForTimeout(250);
}

/**
 * 顶栏「主题与外观」→「界面」页 →「聊天模式」开关(r122 实测的入口)。
 * 点一次切换一次;返回切换后开关的 aria-pressed / 文案,便于断言。
 */
export async function toggleChatMode(page) {
  await page.locator('button[title="主题与外观"]').first().click({ timeout: 10_000 });
  const uiTab = page.locator('.glass-popover button').filter({ hasText: /^界面$/ }).first();
  await uiTab.click({ timeout: 10_000 });
  const item = page.locator('.glass-popover button').filter({ hasText: '聊天模式' }).first();
  await item.click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const state = await item.evaluate((el) => ({
    pressed: el.getAttribute('aria-pressed'),
    checked: el.getAttribute('aria-checked'),
    cls: el.className,
  })).catch(() => null);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  return state;
}
