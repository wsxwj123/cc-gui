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
  return {
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

// ---------------- 折叠态「正文不显示」的统一口径(INTERFACE 第 9 节) ----------------
// 用户 2026-10-29 21:20 修订:折叠态只显示标题行 + 状态 + 「展开全文」,正文不显示;
// 有正文(哪怕 1 行)就有展开入口;展开才显示完整正文。三处(收件箱 / 接收 / 发送)统一。
// 口径(全套件只用这一条,不再有「两行预览 / line-clamp / 高度 ≤ 2 行」):
//   正文节点**不在 DOM**,或存在但**可见高度为 0**(display:none / 高度 0 / visibility:hidden)。
// 这样既允许实现「折叠时干脆不渲染」,也允许「渲染但收起」,两种实现同一条断言都能过。
export const BODY = { inbox: 'xs-card-body', receive: 'peer-message-body', send: 'xs-send-body' };
export const EXPAND_TESTID = { inbox: 'xs-card-expand', receive: 'peer-message-expand', send: 'xs-send-expand' };

/** 读一行里正文节点的可观察事实(不在 DOM 也返回结构化结果,不抛错)。 */
export const bodyFacts = (row, bodyTestId) => row.evaluate((el, tid) => {
  const n = el.querySelector(`[data-testid="${tid}"]`);
  if (!n) return { inDom: false, shown: false, height: 0, width: 0, display: null, visibility: null, text: '', scrollHeight: 0, clientHeight: 0 };
  const s = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  return {
    inDom: true,
    shown: r.height >= 1 && s.display !== 'none' && s.visibility !== 'hidden',
    height: r.height,
    width: r.width,
    display: s.display,
    visibility: s.visibility,
    text: n.textContent || '',
    scrollHeight: n.scrollHeight,
    clientHeight: n.clientHeight,
  };
}, bodyTestId);

const brief = (f) => `{ 在DOM: ${f.inDom}, 可见高: ${Math.round(f.height)}px, display: ${f.display}, visibility: ${f.visibility} }`;

/** soft 断言:折叠态正文不显示(统一口径);返回可观察事实供后续断言复用。 */
export async function expectFolded(row, bodyTestId, what = '正文') {
  const f = await bodyFacts(row, bodyTestId);
  expect.soft(f.shown, `${what}在折叠态不应显示(统一口径:节点不在 DOM 或可见高度为 0;实测 ${brief(f)})`).toBe(false);
  return f;
}

/** 硬等:正文显示出来(展开后的状态切换),返回正文 locator。 */
export async function waitBodyShown(row, bodyTestId, what = '正文') {
  await expect.poll(async () => (await bodyFacts(row, bodyTestId)).shown,
    { timeout: 5_000, message: `${what}应在展开后出现(可见)` }).toBe(true);
  return row.getByTestId(bodyTestId);
}

/** 硬等:正文不再显示(收起后的状态切换)。 */
export async function waitBodyHidden(row, bodyTestId, what = '正文') {
  await expect.poll(async () => (await bodyFacts(row, bodyTestId)).shown,
    { timeout: 5_000, message: `${what}应在收起后消失(节点不在 DOM 或可见高度 0)` }).toBe(false);
}

/**
 * 旧口径(r151x,2026-10-29 21:20):「正文水平居中」= 每行没占满宽度的文字左右留白相等。
 * 用户 2026-10-29 修正版式后此口径作废:新口径是「窄块 + 块居中 + 块内两端对齐」,见下方 textJustifyFacts。
 * 这个函数暂时只留给 B5 用(不属于本轮的改动范围;B5 仍断言每行居中,产品按新口径改后会红,需另行迁移)。
 * 只看视觉结果,不认 CSS 写法:把正文里每一行文本的可见矩形,换算成相对**正文内容框**
 * (content box,扣掉 border/padding)的左右留白;没占满整行的行,左右留白应基本相等(容差 2px),
 * 且至少有一行两侧留白都 ≥4px(证明真的有可见的居中留白)。
 * 左对齐时短行的左侧留白恒 ≈0、右侧留白几十像素,左右差远超容差 → 与居中的区分非常开;
 * 而 text-align:center 与「用 flex 把内容块 / 每一行居中」两种实现都能通过,不会绑死写法。
 * 返回 { inDom, centered, textAlign, contentWidth, narrowLines, lines } 供断言与失败信息复用。
 * 注意:夹具应包含**不同长度的短行** —— 只把容器整体居中、文字仍左对齐的实现会让短行贴着内容框左边。
 */
export const textCenterFacts = (row, bodyTestId) => row.evaluate((el, tid) => {
  const b = el.querySelector(`[data-testid="${tid}"]`);
  if (!b) return { inDom: false, centered: false, textAlign: null, contentWidth: 0, narrowLines: 0, lines: [] };
  const cs = getComputedStyle(b);
  const num = (v) => parseFloat(v) || 0;
  const box = b.getBoundingClientRect();
  const contentLeft = box.left + num(cs.borderLeftWidth) + num(cs.paddingLeft);
  const contentRight = box.right - num(cs.borderRightWidth) - num(cs.paddingRight);
  const contentWidth = Math.max(0, contentRight - contentLeft);
  const lines = [];
  const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = n.data || '';
    let offset = 0;
    // 按换行符切源文本行:pre-wrap 下每个 \n 结束一个行盒,逐行量才能看出「短行有没有居中」。
    for (const seg of data.split('\n')) {
      const start = offset;
      offset += seg.length + 1; // +1 跳过分隔用的换行符
      if (!seg.trim()) continue;
      const range = document.createRange();
      range.setStart(n, start);
      range.setEnd(n, start + seg.length);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        lines.push({ width: r.width, left: r.left - contentLeft, right: contentRight - r.right });
      }
    }
  }
  // 只对「没有占满整行」的行判左右留白:满宽行两侧都 ≈0,不携带对齐信息。
  const narrow = lines.filter((x) => x.width < contentWidth - 4);
  const TOL = 2;
  const balanced = narrow.every((x) => Math.abs(x.left - x.right) <= TOL);
  const hasVisibleGutter = narrow.some((x) => Math.min(x.left, x.right) >= 4);
  return {
    inDom: true,
    centered: contentWidth > 0 && narrow.length > 0 && balanced && hasVisibleGutter,
    textAlign: cs.textAlign,
    contentWidth,
    narrowLines: narrow.length,
    lines: lines.map((x) => ({ width: Math.round(x.width), left: Math.round(x.left), right: Math.round(x.right) })),
  };
}, bodyTestId);

// ---------------- r151z:展开正文「窄块 + 两端对齐 + 块居中」判据 ----------------
// 用户 2026-10-29 修正:不是每行文字各自居中,而是正文内容块**比该行内容窄、整体水平居中**,
// 块内文字**两端对齐**(text-align: justify)。旧口径 textCenterFacts(每行左右留白相等)作废。
//
// 判据(实现无关,只看布局结果;阈值集中在 JUSTIFY):
//   ① visible:正文节点在 DOM 且可见(展开态);
//   ② justify:正文节点本身或任一直含文字的内层容器,生效的 computed text-align 含 justify;
//   ③ narrow :块宽 ≤ 行内容宽 × 0.92 —— 相对阈值,不写死 px;1280 与分屏窄窗格都成立,块与行同宽(比值 100%)直接红;
//   ④ centered:块左留白与右留白差 ≤ 2px(块在行内容框里水平居中,不是贴左/贴右);
//   ⑤ wrap   :正文折成 ≥2 行,才有「非末行」可判;
//   ⑥ fill   :每个非末行的文字 Range 宽度 ≥ 块内容宽 - 8px(justify 把非末行拉到块宽;末行不强制)。
//
// 为什么能区分「每行文字居中」和「窄块 + 两端对齐」:
//   - 每行居中(text-align:center):② 红(computed 是 center,不是 justify);而且居中的文字 Range
//     并不铺满块宽 → ⑥ 红。两条互相独立,不会因为「看起来左右对称」就混过去。
//   - 正文块与行同宽:③ 红(比值 ≈100%),即使 text-align 写成 justify 也红 —— 那只是整行两端对齐,不是窄块。
//   - 窄块但贴左/贴右:④ 红(左右留白差 = 行宽-块宽)。
//   - 只有当「窄块 + 块居中 + 块内 justify + 非末行铺满」同时成立才全绿。
// 判据自检:justifyProbeFacts() 在页面里现搭 4 个探针(正例 / 每行居中 / 与行同宽 / 窄块贴左),用同一份
// 测量与判定代码量,证明三个反例都被判红、正例判绿 —— 判据不是空转,也不是永远红。
export const JUSTIFY = { MAX_BLOCK_RATIO: 0.92, GAP_TOL: 2, FILL_TOL: 8 };
const JUSTIFY_MEASURE = '__r151zJustifyMeasure';

/** 把测量函数装到页面 window 上(真实行与反例探针共用同一份代码;幂等)。 */
async function installJustifyMeasure(page) {
  await page.evaluate((key) => {
    if (window[key]) return;
    window[key] = (rowEl, bodyEl) => {
      const num = (v) => parseFloat(v) || 0;
      const text = (el) => String(el.textContent || '').replace(/\s+/g, ' ').trim();
      const contentBox = (el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const left = r.left + num(s.borderLeftWidth) + num(s.paddingLeft);
        const right = r.right - num(s.borderRightWidth) - num(s.paddingRight);
        return { left, right, width: Math.max(0, right - left) };
      };
      const bodyStyle = getComputedStyle(bodyEl);
      const bodyRect = bodyEl.getBoundingClientRect();
      const shown = bodyRect.height >= 1 && bodyStyle.display !== 'none' && bodyStyle.visibility !== 'hidden';

      // 「正文内容块」:正文节点本身;若它只包着「装全部文字」的唯一块级子容器(max-width / justify 放内层),就下钻。
      const allText = text(bodyEl);
      let block = bodyEl;
      for (;;) {
        const kids = Array.from(block.children);
        if (kids.length !== 1) break;
        const kid = kids[0];
        if (!/^(block|flow-root|flex|grid|list-item)$/.test(getComputedStyle(kid).display)) break;
        if (!allText || text(kid) !== allText) break;
        block = kid;
      }

      const row = contentBox(rowEl);
      const blockRect = block.getBoundingClientRect();
      const blockContent = contentBox(block);
      const leftGap = blockRect.left - row.left;
      const rightGap = row.right - blockRect.right;

      // 生效的文字对齐:块本身 + 任何直接含文字的子孙(justify 落在内层容器上也算)。
      const aligns = [];
      const addAlign = (el) => {
        const a = getComputedStyle(el).textAlign || '';
        if (!aligns.includes(a)) aligns.push(a);
      };
      addAlign(block);
      for (const el of block.querySelectorAll('*')) {
        if (Array.from(el.childNodes).some((n) => n.nodeType === 3 && String(n.data || '').trim())) addAlign(el);
      }

      // 逐行量文字 Range:正文是 pre-wrap 纯文本,\n 结束一个行盒 → 每段最后一个 rect 是该段末行(justify 不拉末行)。
      const lines = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const data = String(n.data || '');
        if (!data.trim()) continue;
        let offset = 0;
        for (const seg of data.split('\n')) {
          const start = offset;
          offset += seg.length + 1;
          if (!seg.trim()) continue;
          const range = document.createRange();
          range.setStart(n, start);
          range.setEnd(n, start + seg.length);
          const rects = Array.from(range.getClientRects()).filter((r) => r.width >= 1 && r.height >= 1);
          rects.forEach((r, i) => lines.push({ width: r.width, last: i === rects.length - 1 }));
        }
      }
      const nonLast = lines.filter((x) => !x.last);
      return {
        inDom: true,
        shown,
        bodyHeight: bodyRect.height,
        rowWidth: row.width,
        blockWidth: blockRect.width,
        widthRatio: row.width > 0 ? blockRect.width / row.width : 0,
        leftGap,
        rightGap,
        gapDiff: Math.abs(leftGap - rightGap),
        blockContentWidth: blockContent.width,
        textAlign: getComputedStyle(block).textAlign,
        innerAligns: aligns,
        justify: aligns.includes('justify'),
        lineCount: lines.length,
        nonLastCount: nonLast.length,
        nonLastWidths: nonLast.map((x) => x.width),
        lastWidths: lines.filter((x) => x.last).map((x) => x.width),
        lines: lines.slice(0, 12).map((x) => ({ w: Math.round(x.width), last: x.last })),
      };
    };
  }, JUSTIFY_MEASURE);
}

/** 读展开态正文的「窄块 / 两端对齐 / 块居中」可观察事实(不判定,判定见 justifyVerdict)。 */
export async function textJustifyFacts(row, bodyTestId) {
  await installJustifyMeasure(row.page());
  return row.evaluate((rowEl, { tid, key }) => {
    const b = rowEl.querySelector(`[data-testid="${tid}"]`);
    if (!b) {
      return {
        inDom: false, shown: false, bodyHeight: 0, rowWidth: 0, blockWidth: 0, widthRatio: 0,
        leftGap: 0, rightGap: 0, gapDiff: 0, blockContentWidth: 0,
        textAlign: null, innerAligns: [], justify: false,
        lineCount: 0, nonLastCount: 0, nonLastWidths: [], lastWidths: [], lines: [],
      };
    }
    return window[key](rowEl, b);
  }, { tid: bodyTestId, key: JUSTIFY_MEASURE });
}

/**
 * 纯判定:把 textJustifyFacts 的事实换算成逐条 check(id/ok/detail),阈值只在这里定义。
 * 返回 { ok, checks };调用方逐条 soft 断言,失败信息自带实测值(= 红点)。
 */
export function justifyVerdict(f) {
  const facts = f || {};
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  add('visible', facts.inDom && facts.shown,
    `正文节点应在展开态可见(实测 inDom=${Boolean(facts.inDom)},可见高 ${Math.round(facts.bodyHeight || 0)}px)`);
  add('justify', facts.justify,
    `块内文字应两端对齐:生效的 text-align 应含 justify(实测 block=${facts.textAlign},内层=[${(facts.innerAligns || []).join(', ')}])`);
  add('narrow', facts.rowWidth > 0 && facts.widthRatio <= JUSTIFY.MAX_BLOCK_RATIO,
    `正文块应明显窄于该行内容宽(实测 块 ${Math.round(facts.blockWidth || 0)}px / 行内容 ${Math.round(facts.rowWidth || 0)}px = `
    + `${((facts.widthRatio || 0) * 100).toFixed(1)}%,要求 ≤${(JUSTIFY.MAX_BLOCK_RATIO * 100).toFixed(0)}%;与行同宽 = 比值 100%)`);
  add('centered', facts.inDom && facts.gapDiff <= JUSTIFY.GAP_TOL,
    `正文块应在行内容框里水平居中(实测 左留白 ${Math.round(facts.leftGap || 0)}px / 右留白 ${Math.round(facts.rightGap || 0)}px,`
    + `差 ${Math.round(facts.gapDiff || 0)}px,要求 ≤${JUSTIFY.GAP_TOL}px)`);
  add('wrap', facts.nonLastCount >= 1,
    `正文应折成多行,才有「非末行」可判两端对齐(实测 共 ${facts.lineCount || 0} 行,非末行 ${facts.nonLastCount || 0} 行)`);
  const short = (facts.nonLastWidths || []).filter((w) => w < (facts.blockContentWidth || 0) - JUSTIFY.FILL_TOL);
  add('fill', facts.nonLastCount >= 1 && short.length === 0,
    `非末行文字应铺满正文块宽度(块内容宽 ${Math.round(facts.blockContentWidth || 0)}px,`
    + `${short.length}/${facts.nonLastCount || 0} 行短于 内容宽-${JUSTIFY.FILL_TOL}px`
    + `${short.length ? `,最窄 ${Math.round(Math.min(...short))}px` : ''})`);
  return { ok: checks.every((x) => x.ok), checks };
}

/**
 * 判据自检:在页面里现搭 4 个探针,用与真实行完全相同的测量(installJustifyMeasure)去量。
 *   good                     窄块(300/452)+ 块居中 + justify   → 应绿
 *   perLineCentered          与行同宽 + text-align:center        → 应红(每行文字居中)
 *   fullWidthJustify         与行同宽 + justify                  → 应红(整行两端对齐,不是窄块)
 *   narrowJustifyNotCentered 窄块 + justify + 贴左               → 应红(块没有水平居中)
 */
export async function justifyProbeFacts(page) {
  await installJustifyMeasure(page);
  return page.evaluate((key) => {
    const measure = window[key];
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:480px;';
    // 必须挂进文档:脱离文档的节点没有布局,量出来全是 0(探针会假红)
    document.body.appendChild(host);
    const make = (style, bodyText) => {
      const row = document.createElement('div');
      row.style.cssText = 'width:480px;box-sizing:border-box;padding:10px 14px;';
      const body = document.createElement('div');
      body.style.cssText = `box-sizing:border-box;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;${style}`;
      body.textContent = bodyText;
      row.appendChild(body);
      host.appendChild(row);
      return { row, body };
    };
    const probeText = '两端对齐的判据必须能区分窄块和整行：文字被拉到正文块两端时，每个非末行都会铺满这一块的宽度，末行保持原样。'
      + '只看每一行有没有居中是不够的，整行居中同样可以让每行看起来对称，却不会把文字拉到正文块的两端；'
      + '而只有整体居中的窄块，才需要单独确认块的位置，以及块内文字确实两端对齐。';
    const cases = {
      good: make('width:300px;margin:0 auto;text-align:justify;', probeText),
      perLineCentered: make('width:100%;text-align:center;', probeText),
      fullWidthJustify: make('width:100%;text-align:justify;', probeText),
      narrowJustifyNotCentered: make('width:300px;margin:0;text-align:justify;', probeText),
    };
    const out = {};
    for (const [name, one] of Object.entries(cases)) out[name] = measure(one.row, one.body);
    host.remove();
    return out;
  }, JUSTIFY_MEASURE);
}

/** soft 断言:折叠态「有正文就有展开入口」,提示文案是「展开全文」;返回提示节点。 */
export async function expectExpandEntry(row, expandTestId, what = '正文') {
  const el = row.getByTestId(expandTestId);
  const n = await el.count();
  expect.soft(n, `有${what}就应有展开入口 [data-testid="${expandTestId}"](哪怕只有 1 行)`).toBeGreaterThan(0);
  if (n === 0) return el;
  await expect.soft(el.first(), `展开提示文案应是「${EXPAND}」`).toHaveText(EXPAND);
  return el;
}

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
