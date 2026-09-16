// r121 界面操作层:只按用户看得见的东西定位(侧栏会话行、分屏控件、每格输入框、消息气泡)。
// 依据只有 .devflow/BRIEF-r121.md 与 .devflow/INTERFACE-r121.md §A(可观察身份)。
// 落点不写死:分屏容器优先认合同钩子([data-testid=pane-split] / [data-testid=pane] / [data-pane-id]),
// 认不到就退回"可见布局"(「分屏 N」标题),两条路都认不到就**如实报红**,不去猜、也不假装覆盖。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const UI_BASE = process.env.R121_UI_BASE || 'http://127.0.0.1:6700';
export const API_BASE = process.env.R121_API_BASE || 'http://127.0.0.1:6701';

/** 对隔离实例直调接口(准备/核对用,不作为界面断言)。 */
export async function api(method, url, body) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json };
}

/** 进应用并压掉旅游浮层/更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const url of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}

/** 反复点掉「稍后 / 以后再说 / 已知晓」这类一次性浮层(别用「跳过」当关键词,会误命中产品自己的按钮)。 */
export async function dismissOverlays(page, passes = 6) {
  for (let i = 0; i < passes; i += 1) {
    let hit = false;
    for (const label of ['稍后', '以后再说', '已知晓']) {
      const btn = page.locator('button').filter({ hasText: label }).last();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(120);
        hit = true;
      }
    }
    if (!hit) return;
  }
}

/** 侧栏里打开带 mark 的夹具会话(夹具项目第一次必须走搜索,打开一次之后才作为侧栏行出现)。 */
export async function openSessionBySearch(page, mark) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索项目/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(page.getByRole('button', { name: new RegExp(mark) }).first()).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 90_000 });
  await page.getByRole('button', { name: new RegExp(mark) }).first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
}

// ---------------------------------------------------------------------------
// 分屏身份(INTERFACE §A:认 [data-testid=pane-split] 容器,或按可见布局判断"左右两格")
// ---------------------------------------------------------------------------

/** 探针:把当前页面里"跟分屏有关"的东西如实抓一份出来(给探路脚本和失败信息用)。 */
export const splitFacts = (page) => page.evaluate(() => {
  const testids = [...document.querySelectorAll('[data-testid]')]
    .map((el) => el.getAttribute('data-testid'))
    .filter((id, i, a) => a.indexOf(id) === i && /pane|split|分屏/i.test(id));
  const paneAttrs = [...document.querySelectorAll('[data-pane-id]')].map((el) => ({
    paneId: el.getAttribute('data-pane-id'), ownerKey: el.getAttribute('data-owner-key'), generation: el.getAttribute('data-generation'),
  }));
  // 「分屏 N」这类标题:实测同一栏里会出现两次(栏标题 + 空栏提示),按编号去重才是真实栏数。
  const headers = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length) continue;
    if (el.closest('header,[role=banner],aside')) continue;
    const t = (el.textContent || '').trim();
    if (/^分屏\s\d+( · 当前)?$/.test(t)) headers.push(t);
  }
  const composerish = [...document.querySelectorAll('textarea,[contenteditable="true"],[role=textbox]')]
    .filter((el) => el.getClientRects().length).length;
  return {
    testids,
    paneAttrCount: paneAttrs.length,
    paneAttrs,
    headerTexts: [...new Set(headers)],
    composerish,
    splitControlCount: document.querySelectorAll('[data-testid="pane-split"]').length,
  };
});

/** 当前真实栏数:合同钩子优先,退回「分屏 N」标题去重;都没有 = 1 栏(单栏布局没有「分屏 N」标题)。 */
export async function paneCount(page) {
  return await page.evaluate(() => {
    const byTestid = document.querySelectorAll('[data-testid="pane"]').length;
    if (byTestid) return byTestid;
    const byAttr = document.querySelectorAll('[data-pane-id]').length;
    if (byAttr) return byAttr;
    const idx = new Set();
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length) continue;
      if (el.closest('header,[role=banner],aside')) continue;
      const m = /^分屏\s(\d+)( · 当前)?$/.exec((el.textContent || '').trim());
      if (m) idx.add(m[1]);
    }
    return idx.size || 1;
  });
}

/** 把第 n 栏(1 起)标上只属于测试页面的作用域属性(产品不认识这个属性),供断言限定在这一栏内。 */
async function markPane(page, n) {
  const ok = await page.evaluate((index) => {
    for (const el of document.querySelectorAll('[data-r121-scope]')) el.removeAttribute('data-r121-scope');
    // 单栏(没有分屏)时,[data-testid=pane] 就是那一格 —— 直接用它,不做"往上爬"的兜底。
    // 兜底一旦爬过头会把整页(含侧栏)当成一格,计数就永远≥1、还可能把别的栏算进来。
    const candidates = [...document.querySelectorAll('[data-testid="pane"]')];
    if (candidates.length) {
      const target = candidates[index - 1];
      if (!target) return false;
      target.setAttribute('data-r121-scope', String(index));
      return true;
    }
    const byAttr = [...document.querySelectorAll('[data-pane-id]')];
    if (byAttr.length) {
      const target = byAttr[index - 1];
      if (!target) return false;
      target.setAttribute('data-r121-scope', String(index));
      return true;
    }
    // 退回可见布局:找「分屏 index」标题,往上爬到"刚好罩住本栏、不碰别的栏标题"的那层容器。
    const headers = [...document.querySelectorAll('*')].filter((el) =>
      !el.children.length
      && !el.closest('header,[role=banner],aside')
      && /^分屏\s\d+( · 当前)?$/.test((el.textContent || '').trim()));
    const mine = headers.filter((el) => new RegExp(`^分屏\\s${index}( |$)`).test((el.textContent || '').trim()));
    if (!mine.length) {
      // 单栏:输入框往上找能罩住消息列表的那层。
      const composer = document.querySelector('textarea, [contenteditable="true"]');
      let node = composer && composer.parentElement;
      let hops = 0;
      while (node && node.parentElement && hops < 10 && !node.querySelector('[data-message-id], .chat-user-bubble, .markdown-content')) {
        node = node.parentElement; hops += 1;
      }
      if (node) { node.setAttribute('data-r121-scope', String(index)); return true; }
      return false;
    }
    const mineIdx = ((mine[0].textContent || '').trim().match(/^分屏\s(\d+)/) || [])[1];
    let node = mine[0];
    while (node.parentElement) {
      const parent = node.parentElement;
      const reachesOther = headers.some((h) => {
        const other = ((h.textContent || '').trim().match(/^分屏\s(\d+)/) || [])[1];
        return other && other !== mineIdx && parent.contains(h);
      });
      if (reachesOther) break;
      node = parent;
    }
    node.setAttribute('data-r121-scope', String(index));
    return true;
  }, n);
  if (!ok) throw new Error(`第 ${n} 栏既没有合同钩子(pane-split/pane/pane-id),也看不到「分屏 ${n}」标题 —— 无法把断言限定在单栏内`);
  return page.locator(`[data-r121-scope="${n}"]`).first();
}

export const paneScope = markPane;

/** 展开面板坞(幂等:坞已经开着就什么都不做,那颗按钮是开关,重复点会把坞关掉)。 */
export async function openPanelDock(page) {
  const probe = page.locator('[data-cgui="panel-dock"] button').filter({ hasText: /^通用$/ }).first();
  if (await probe.isVisible().catch(() => false)) return true;
  const toggle = page.locator('[data-testid="panel-dock-toggle"]');
  if (await toggle.count()) await toggle.click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);
  return await probe.isVisible().catch(() => false);
}

/**
 * 把分屏数设成 n(INTERFACE §A:入口在顶部/侧栏;认 [data-testid=pane-split] 容器或可见文案)。
 * 三条路依次试:面板坞里的「分屏」按钮 / 直接可见的 [data-testid=pane-split] / 可见的「分屏」按钮。
 */
/**
 * 把分屏数设成 n。
 * 实测(探路)分屏入口是**面板坞里那颗文字为「分屏」的按钮** [data-testid="pane-count"],
 * 点开才露出 1–6 的数字选项 [data-testid="pane-count-1..6"]。
 * 注意:[data-testid="pane-split"] 是**装窗格的容器**,不是入口控件,别拿它当控件点(点它什么都不发生)。
 */
export async function setPaneCount(page, n) {
  if ((await paneCount(page)) === n) return n;
  // 每一处点击前都先 count();force 只免掉可操作性检查,不免掉"等元素出现",
  // 直接对不存在的 locator 点会一直等到用例超时(踩过:整个用例卡满 5 分钟)。
  const clickIfThere = async (loc) => {
    if (!(await loc.count().catch(() => 0))) return false;
    if (!(await loc.first().isVisible().catch(() => false))) return false;
    await loc.first().click({ force: true }).catch(() => {});
    return true;
  };

  await openPanelDock(page);
  const ctl = page.getByTestId('pane-count').first();
  if (!(await ctl.count()) || !(await ctl.isVisible().catch(() => false))) {
    throw new Error('面板坞里找不到「分屏」入口([data-testid=pane-count])');
  }
  if (!(await page.getByTestId(`pane-count-${n}`).first().isVisible().catch(() => false))) {
    await clickIfThere(ctl);                       // 展开数字选项
    await page.waitForTimeout(500);
  }
  const picked =
    (await clickIfThere(page.getByTestId(`pane-count-${n}`)))                      // 钩子优先
    || (await clickIfThere(page.getByRole('button', { name: String(n), exact: true })));
  if (!picked) {
    const menu = await page.evaluate(() => [...document.querySelectorAll('[data-cgui="panel-dock"] button,button,[role=menuitem],[role=option]')]
      .filter((el) => el.getClientRects().length).map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 24)).filter(Boolean));
    throw new Error(`点开「分屏」之后找不到数字 ${n} 的选项;此刻可见按钮:${JSON.stringify(menu.slice(0, 40))}`);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await expect.poll(() => paneCount(page), { message: `选了 分屏=${n} 之后应有 ${n} 栏`, timeout: 10_000 }).toBe(n);
  return n;
}

/** 关掉当前分屏(回到单栏):把分屏数设回 1。 */
export const closeSplit = (page) => setPaneCount(page, 1);

/** 每栏的身份合同钩子:[data-testid=pane] 的 data-pane-id / data-owner-key / data-generation。 */
export const paneIdentities = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="pane"]')]
  .map((e) => ({
    paneId: e.getAttribute('data-pane-id'),
    ownerKey: e.getAttribute('data-owner-key') || '',
    generation: e.getAttribute('data-generation'),
    width: Math.round(e.getBoundingClientRect().width),
    left: Math.round(e.getBoundingClientRect().left),
  })));

/**
 * 关掉第 n 栏(不结束会话):点该栏里的关闭按钮([data-testid="pane-close"],title「关闭此窗格」)。
 * 关完栏数应减少;如果这一栏本来就是最后一栏就不点(产品不给单栏关闭按钮)。
 */
export async function closePane(page, n) {
  const before = await paneCount(page);
  if (before <= 1) return false;
  const scope = await markPane(page, n);
  const btn = scope.locator('[data-testid="pane-close"]').first();
  if (!(await btn.count())) return false;
  await btn.click({ force: true }).catch(() => {});
  await expect.poll(() => paneCount(page), { message: `关掉第 ${n} 栏后栏数应减少(点的是「关闭此窗格」)`, timeout: 10_000 }).toBeLessThan(before);
  await page.waitForTimeout(600);
  return true;
}

/**
 * 把某条会话"填进第 n 栏":先把这一栏设为当前(点它的空栏提示或输入框),再用侧栏搜索打开会话。
 * 实测:新开出来的分屏是空栏,显示「点左侧任一会话填入本分屏(此栏已高亮为当前)」;
 * 点一下该栏就把它设为当前,之后从侧栏打开的会话落进这一栏。
 */
export async function fillPaneWithSession(page, n, mark) {
  const scope = await markPane(page, n);
  const hint = scope.getByText(/点左侧任一会话填入本分屏/).first();
  if (await hint.count() && await hint.isVisible().catch(() => false)) {
    await hint.click({ force: true }).catch(() => {});
  } else {
    const box = scope.locator('textarea, [contenteditable="true"]').first();
    if (await box.count()) await box.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(400);
  await openSessionBySearch(page, mark);
  await page.waitForTimeout(600);
  return (await paneIdentities(page))[n - 1] || null;
}

// ---------------------------------------------------------------------------
// 每格输入框 / 发送
// ---------------------------------------------------------------------------

/** 某一栏里的输入框(不给 scope 就是整页第一个可见的输入框)。 */
export function composerIn(page, scope) {
  const root = scope || page;
  const cands = [
    root.getByRole('textbox', { name: /打开命令/ }),
    root.getByPlaceholder(/输入消息|开始一个新会话/),
    root.locator('textarea'),
  ];
  for (const c of cands) if (c) return c.first();
  return root.locator('textarea').first();
}

/** 在第 n 栏输入并发送一条消息,返回这条消息的唯一标记。 */
export async function sendInPane(page, n, text, { pressEnter = true } = {}) {
  const scope = await markPane(page, n);
  const box = composerIn(page, scope);
  await expect(box, `第 ${n} 栏应有一个可输入的输入框`).toBeVisible({ timeout: 20_000 });
  await box.click({ force: true }).catch(() => {});
  await box.fill(text);
  if (pressEnter) await box.press('Enter');
  return text;
}

export const composer = (page) => composerIn(page, null);
export const stopButton = (page) => page.getByRole('button', { name: /^停止/ });

/** 在整页(不分屏)输入并发送。 */
export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

// ---------------------------------------------------------------------------
// 计数(INTERFACE §A/§B:同一段唯一文本在同一格内出现的次数 —— 精确计数)
// ---------------------------------------------------------------------------

/**
 * 在一栏内精确数"这段唯一文本被画了几次"(INTERFACE §A:「消息条数:以消息气泡为计」)。
 * 三路独立计数:
 *   userBubbles      该栏内含这段文本的**用户气泡**(.chat-user-bubble)个数 —— 主判据
 *   assistantBlocks  该栏内含这段文本的**助手正文块**(.markdown-content)个数
 *   rawOccurrences   该栏可见文字里这段文本逐次匹配的次数
 *   extras           该栏里其余含这段文本的宿主(排除消息块后的),用于解释 raw 比气泡多在哪
 *                    (实测:回滚点弹层 glass-popover 会把已发出的消息原文列一遍,它不是消息气泡)
 * 重复渲染时 userBubbles 与 rawOccurrences(扣掉 extras)都会翻倍。
 */
export async function countInPane(page, n, marker) {
  const scope = await markPane(page, n);
  return await scope.evaluate((el, mk) => {
    const text = el.innerText || '';
    let rawOccurrences = 0;
    let from = 0;
    for (;;) { const i = text.indexOf(mk, from); if (i < 0) break; rawOccurrences += 1; from = i + mk.length; }
    const userBubbles = [...el.querySelectorAll('.chat-user-bubble')].filter((b) => (b.textContent || '').includes(mk)).length;
    const assistantBlocks = [...el.querySelectorAll('.markdown-content')].filter((b) => (b.textContent || '').includes(mk)).length;
    // 其余宿主:最深的、非消息块、含该文本的元素(如弹层里列出的原文)
    const extras = [...el.querySelectorAll('*')]
      .filter((x) => (x.textContent || '').includes(mk) && ![...x.children].some((c) => (c.textContent || '').includes(mk)))
      .filter((x) => !x.closest('.chat-user-bubble') && !x.closest('.markdown-content'))
      .map((x) => ({ tag: x.tagName, cls: String(x.className || '').slice(0, 60) }));
    // 主判据 = 消息块个数;弹层那类不算消息
    const messageCount = userBubbles + assistantBlocks;
    return { userBubbles, assistantBlocks, messageCount, rawOccurrences, extras, paneChars: text.length };
  }, marker);
}

/** 只取主判据(消息块个数),失败信息里好读。 */
export const msgCount = async (page, n, marker) => (await countInPane(page, n, marker)).messageCount;

/** 整页(所有栏)里这段文本各出现几次,按栏分组 —— 用于"有没有串格"。 */
export async function countPerPane(page, marker) {
  const total = await paneCount(page);
  const out = [];
  for (let i = 1; i <= total; i += 1) out.push({ pane: i, ...(await countInPane(page, i, marker)) });
  return out;
}

/** 全页可见文字里这段文本出现几次(含侧栏;用来判断"到底是不是只在某一栏/某一处")。 */
export const countOnPage = (page, marker) => page.evaluate((mk) => {
  const text = document.body.innerText || '';
  let n = 0; let from = 0;
  for (;;) { const i = text.indexOf(mk, from); if (i < 0) break; n += 1; from = i + mk.length; }
  return n;
}, marker);

/**
 * 计数方式的**自证**:人为把一栏里含 marker 的第一个消息块克隆一份插回原地,
 * 再数一次。如果计数是空的(比如扫描范围根本没扫到这类节点),这次也会数不出 2。
 * 只改测试页面的 DOM,不改产品行为;用完由 removeSelfProof 还回去。
 */
export async function injectDuplicate(page, n, marker) {
  const scope = await markPane(page, n);
  return await scope.evaluate((el, mk) => {
    const host = [...el.querySelectorAll('.chat-user-bubble, .markdown-content, [data-message-id]')]
      .find((b) => (b.textContent || '').includes(mk));
    if (!host) return { injected: false, reason: '这一栏里找不到含该标记的消息块' };
    const clone = host.cloneNode(true);
    clone.setAttribute('data-r121-injected-dup', '1');
    host.parentElement.appendChild(clone);
    return { injected: true, parentTag: host.parentElement.tagName };
  }, marker);
}

export async function removeSelfProof(page) {
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-r121-injected-dup]')) el.remove(); });
}

// ---------------------------------------------------------------------------
// 桩控制(INTERFACE §C:"正在生成"必须由测试可控)
// ---------------------------------------------------------------------------

export function ctlPath(name) {
  const ctl = process.env.R121_CTL;
  if (!ctl) throw new Error('R121_CTL 未设置(run.sh 负责)');
  return path.join(ctl, name);
}
export function setCtl(name, value) { fs.mkdirSync(process.env.R121_CTL, { recursive: true }); fs.writeFileSync(ctlPath(name), String(value)); }
export function clearCtl(name) { try { fs.unlinkSync(ctlPath(name)); } catch { /* 本来就没有 */ } }
export const ctlExists = (name) => fs.existsSync(ctlPath(name));
export function ctlStreamed(sid) { try { return Number(fs.readFileSync(ctlPath(`${sid}.streamed`), 'utf8').trim()) || 0; } catch { return 0; } }
export function ctlPhase(sid) { try { return fs.readFileSync(ctlPath(`${sid}.phase`), 'utf8').trim(); } catch { return null; } }

/** 收尾:只按桩自己落下的 pid 文件收,不按进程名/端口批量杀。 */
export function killStubs() {
  const ctl = process.env.R121_CTL;
  if (!ctl) return [];
  let names = [];
  try { names = fs.readdirSync(ctl); } catch { return []; }
  const killed = [];
  for (const name of names) {
    if (!/\.pid$/.test(name)) continue;
    const pid = Number(fs.readFileSync(path.join(ctl, name), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 'SIGKILL'); killed.push(pid); } catch { /* 已经退了 */ }
  }
  return killed;
}
