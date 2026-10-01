// r140 界面操作层(由 r118 的 helpers/ui.mjs 复制而来,**r118 原目录只读**)。
// 原有函数一字不动,只在末尾追加 r140 需要的仪器:
//   ① 按会话的闸门/慢启动控制(holdSession / releaseSession / setSlowStartFor)
//   ② 页内 MutationObserver 连续录制(泄漏帧只活几百毫秒,采样式"观察窗内没看到"不算数)
//   ③ 会话文件读取、进程存活、桩件相位读取
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { live, readTranscript } from './fixtures.mjs';

// INTERFACE §A 的逐字文案
export const TAKEOVER = '↪ 此运行已在另一处查看';
export const BANNER = '这个会话仍在后台工作中 · 新内容会随生成自动追加';
export const BANNER_LOOSE = '这个会话仍在后台工作中';   // 只认主干(横幅尾部措辞若改,断言仍指向同一条横幅)

export const takeoverCount = (page) => page.getByText(TAKEOVER.replace('↪ ', ''), { exact: false }).count();
export const bannerCount = (page) => page.getByText(BANNER_LOOSE, { exact: false }).count();

/** 进应用并压掉旅游浮层/更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch {} });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

/**
 * 打开某条夹具会话。实测:夹具项目不进侧栏常规列表(显示"没有找到项目"),第一次必须走搜索;
 * 打开一次之后它的会话才作为侧栏行出现(见 sessionRow)。
 */
export async function openSessionBySearch(page, mark) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索项目/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(page.getByRole('button', { name: new RegExp(mark) }).first()).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await page.getByRole('button', { name: new RegExp(mark) }).first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
}

/** 侧栏里那条会话(实测 = div[role=button].sidebar-item,名字是会话标题)。 */
export const sessionRow = (page, mark) => page.locator('[role=button].sidebar-item').filter({ hasText: mark }).first();

/** 用户切会话:点另一条会话的行(INTERFACE §A 的切换方式)。 */
export async function switchTo(page, mark) {
  const row = sessionRow(page, mark);
  await expect(row, `侧栏里应能看到会话 ${mark}`).toBeVisible({ timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(500);   // 让窗格把会话换过来再开始观察(换的过程中界面还是旧会话)
}

export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话/).last();

/** 在一个会话里发一条消息(打字 + Enter)。 */
export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

/** 等这一轮"正在生成":假 CLI 吐出第一块文字 + 停止按钮可用。 */
export async function waitTurnRunning(page, sid, prompt) {
  await expect(page.getByText(live.chunk1(sid, prompt), { exact: false }).first(), '回合应吐出第一块文字')
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^停止/ }), '回合进行中应有可用的停止按钮').toBeEnabled({ timeout: 10_000 });
}

/** 一条消息的文字是否出现在正文的消息卡里(排除侧栏标题那一处)。 */
export async function messageVisible(page, text) {
  const inCards = page.locator('[data-message-id], .chat-user-bubble, .markdown-content').filter({ hasText: text });
  if (await inCards.count()) return await inCards.first().isVisible();
  return (await page.locator('body').innerText()).includes(text);
}

/** 界面此刻的几项可判断状态(全部取用户看得见的东西)。 */
export async function readState(page) {
  const body = await page.locator('body').innerText();
  const stop = page.getByRole('button', { name: /^停止/ });
  return {
    takeover: body.includes('此运行已在另一处查看'),
    banner: body.includes(BANNER_LOOSE),
    stops: await stop.count(),
    stopEnabled: (await stop.count()) ? await stop.first().isEnabled() : false,
    body,
  };
}

/**
 * 在一段时间窗里反复采样(竞态类用例靠它,不用固定 sleep 赌时序):
 * 每 `every` 毫秒取一次状态,返回全部采样。窗口内任一采样不满足断言即失败。
 */
export async function sampleWindow(page, { ms = 6_000, every = 500 } = {}) {
  const samples = [];
  const deadline = Date.now() + ms;
  for (;;) {
    samples.push(await readState(page));
    if (Date.now() >= deadline) return samples;
    await page.waitForTimeout(every);
  }
}

/**
 * 一条用户消息在正文里被画成了几个气泡(text 为 null 时数会话里的全部用户消息)。
 * 用它数"这句话画了几遍"——不能拿整页文字数,因为助手回复里可能引用到同一段文字。
 */
export const userBubbleCount = (page, text) => {
  const all = page.locator('.chat-user-bubble');
  return (text == null ? all : all.filter({ hasText: text })).count();
};
/** 助手的一段话被画成了几个块(一段话只该出现一次)。 */
export const assistantBlockCount = (page, text) =>
  page.locator('.markdown-content').filter({ hasText: text }).count();

/** 在"别的会话"的页面上找某段文字的痕迹:整页文字 / 用户气泡 / 任何叶子文字。 */
export const scanForText = (page, text) => page.evaluate((t) => ({
  body: (document.body.innerText || '').includes(t),
  bubbles: [...document.querySelectorAll('.chat-user-bubble')].filter((el) => (el.textContent || '').includes(t)).length,
  leaves: [...document.querySelectorAll('body *')]
    .filter((el) => !el.children.length && (el.textContent || '').includes(t)).length,
}), text);

export const rel = (ctl, sid, suffix) => path.join(ctl, `${sid}${suffix}`);

/**
 * 放行这个实例里**所有**停住的回合(按假 CLI 自己落的 <sid>.started 找)。
 * 用于收尾:运行时新建的会话 id 是应用生成的,测试手上没有,只能这样兜底。
 */
export function releaseAllRuns(ctl) {
  let names = [];
  try { names = fs.readdirSync(ctl); } catch { return; }
  for (const name of names) {
    const m = /^(.+)\.started$/.exec(name);
    if (!m) continue;
    fs.writeFileSync(path.join(ctl, `${m[1]}.chunk`), 'x');
    fs.writeFileSync(path.join(ctl, `${m[1]}.done`), 'x');
    fs.writeFileSync(path.join(ctl, `${m[1]}.go`), 'x');
    // r141:空回合在等 <sid>.land,被闸住的 assistant 记录也在等它 —— 收尾一并放行,
    // 免得用例中途失败时留一个挂在 waitFor('land') 上的假 CLI 进程。
    fs.writeFileSync(path.join(ctl, `${m[1]}.land`), 'x');
    fs.writeFileSync(path.join(ctl, `${m[1]}.land-user`), 'x');
  }
}
/** 让下一次交互式回合"慢启动":收到请求后先静默这么久(毫秒)再吐第一条事件。 */
export const setSlowStart = (ctl, ms) => fs.writeFileSync(path.join(ctl, 'slow-ms'), String(ms));
export const clearSlowStart = (ctl) => { try { fs.unlinkSync(path.join(ctl, 'slow-ms')); } catch { /* 本来就没有 */ } };
export const releaseChunk2 = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.chunk'), String(Date.now()));
export const releaseTurnEnd = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.done'), String(Date.now()));

// ===================== r140 追加 =====================

/** 按会话的慢启动(毫秒):只影响这一条会话的进程,不碰别的会话。 */
export const setSlowStartFor = (ctl, sid, ms) => fs.writeFileSync(rel(ctl, sid, '.slow-ms'), String(ms));
export const clearSlowStartFor = (ctl, sid) => { try { fs.unlinkSync(rel(ctl, sid, '.slow-ms')); } catch { /* */ } };
/** 把这条会话的回合无限期憋住(界面表现为"连接中",不会产出任何内容)。 */
export const holdSession = (ctl, sid) => setSlowStartFor(ctl, sid, 3_600_000);
/** 精确放行:桩件立刻开始吐这一回合(不必等慢启动毫秒数走完)。 */
export const releaseSession = (ctl, sid) => { try { fs.unlinkSync(rel(ctl, sid, '.go')); } catch { /* */ } fs.writeFileSync(rel(ctl, sid, '.go'), String(Date.now())); };
/** 错误注入:这一回合以 error result 收场,文本由测试给。 */
export const injectError = (ctl, sid, text) => fs.writeFileSync(rel(ctl, sid, '.error'), String(text));
export const clearError = (ctl, sid) => { try { fs.unlinkSync(rel(ctl, sid, '.error')); } catch { /* */ } };
/** 用量注入(探超窗横幅用)。 */
export const injectUsage = (ctl, sid, usage) => fs.writeFileSync(rel(ctl, sid, '.usage'), JSON.stringify(usage));
export const clearUsage = (ctl, sid) => { try { fs.unlinkSync(rel(ctl, sid, '.usage')); } catch { /* */ } };

/** 清掉相位文件:用于"同会话第二轮"前把上一轮的相位抹掉,好让"phase=chunk1"成为**本轮专属**信号。 */
export const clearPhase = (ctl, sid) => { try { fs.unlinkSync(rel(ctl, sid, '.phase')); } catch { /* 本来就没有 */ } };
/** 桩件此刻走到哪一段(没有这个文件 = 还没吐任何东西)。 */
export const phaseOf = (ctl, sid) => { try { return fs.readFileSync(rel(ctl, sid, '.phase'), 'utf8').trim(); } catch { return null; } };
/** 等桩件走到某一段(证明"泄漏路径确实被走到"),超时抛错。 */
export async function waitForPhase(ctl, sid, want, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const p = phaseOf(ctl, sid);
    if (p === want) return p;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等 <${sid}>.phase = ${want} 超时(现在是 ${p})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 这一轮桩件进程的 pid(<sid>.started 里带着;r140 的桩件才写 pid)。 */
export function runPid(ctl, sid) {
  try {
    const m = /pid=(\d+)/.exec(fs.readFileSync(rel(ctl, sid, '.started'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
/** 进程还活着吗(kill -0)。 */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export const runAlive = (ctl, sid) => pidAlive(runPid(ctl, sid));

/**
 * 页内连续录制器:装一个 MutationObserver,把**任何**进入 DOM 的文字都过一遍。
 * 为什么用它:泄漏帧可能只活 200–300ms(甚至同一帧内加进去又撤掉),"每 500ms 采样一次没看到"
 * 是弱断言 —— 而 MutationObserver 的回调是微任务级的,addedNodes 即使已经被摘掉,textContent
 * 仍然读得到,所以"曾经出现过"一定被记下。
 */
export async function startRecorder(page, { name = 'r140', markers = [] } = {}) {
  await page.evaluate(({ name: n, markers: ms }) => {
    const w = window;
    w.__r140 = w.__r140 || {};
    const st = { markers: ms.slice(), hits: [], muts: 0, texts: [], startedAt: Date.now() };
    w.__r140[n] = st;
    const cap = (s) => String(s == null ? '' : s).slice(0, 200);
    const note = (t, kind) => {
      if (!t) return;
      const s = cap(t);
      if (st.texts.length < 4000) st.texts.push(s);
      for (const m of st.markers) if (String(t).includes(m)) st.hits.push({ marker: m, kind, at: Date.now() - st.startedAt, snippet: s });
    };
    const obs = new MutationObserver((recs) => {
      st.muts += recs.length;
      for (const r of recs) {
        if (r.type === 'childList') {
          r.addedNodes.forEach((x) => note(x.textContent, 'added'));
          r.removedNodes.forEach((x) => note(x.textContent, 'removed'));
          // 一段话可能被拆成多个兄弟节点分别插入:同一个微任务里再扫一次变化点的父节点拼接文本,
          // 这样"整段话"级别的标记不会因为被拆成多块而漏掉。
          const pt = r.target && r.target.textContent;
          if (pt && pt.length < 20_000) note(pt, 'parent');
        } else if (r.type === 'characterData') {
          note(r.oldValue, 'chardata-before');
          note(r.target && r.target.data, 'chardata-after');
        } else if (r.type === 'attributes') {
          note(r.oldValue, 'attr-before');
          note(r.target && r.target.getAttribute && r.target.getAttribute(r.attributeName), 'attr-after');
        }
      }
    });
    obs.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, characterDataOldValue: true,
      attributes: true, attributeOldValue: true, attributeFilter: ['value', 'placeholder', 'title', 'aria-label'],
    });
    st.stop = () => { try { obs.takeRecords().forEach((r) => { if (r.type === 'characterData') note(r.target && r.target.data, 'flush'); }); } catch { /* */ } obs.disconnect(); };
  }, { name, markers });
}

/** 取出录制结果(不停)。 */
export async function dumpRecorder(page, name = 'r140') {
  return page.evaluate((n) => {
    const st = (window.__r140 || {})[n];
    if (!st) return null;
    const per = {};
    for (const h of st.hits) per[h.marker] = (per[h.marker] || 0) + 1;
    return { muts: st.muts, hits: st.hits, per, texts: st.texts.slice(0, 4000), elapsed: Date.now() - st.startedAt };
  }, name);
}

/** 停掉录制器并取出结果。 */
export async function stopRecorder(page, name = 'r140') {
  return page.evaluate((n) => {
    const st = (window.__r140 || {})[n];
    if (!st) return null;
    if (st.stop) st.stop();
    const per = {};
    for (const h of st.hits) per[h.marker] = (per[h.marker] || 0) + 1;
    return { muts: st.muts, hits: st.hits, per, texts: st.texts.slice(0, 4000), elapsed: Date.now() - st.startedAt };
  }, name);
}

/** 某个标记被记到几次。 */
export const hitsFor = (state, marker) => (state && state.per && state.per[marker]) || 0;

/** 录制器在窗口里有没有见过含这段子串的文字(用于阳性对照:证明录制器确实录到了东西)。 */
export const textSeen = (state, sub) => !!(state && state.texts && state.texts.some((t) => t.includes(sub)));

/** 录制结果里"某一类"的原始记录(失败时打进断言消息,便于定位)。 */
export const hitsDump = (state, marker) =>
  JSON.stringify((state && state.hits ? state.hits.filter((h) => h.marker === marker) : []).slice(0, 6));

/** 会话文件里某段文字出现了几次(role 省略时数所有行)。 */
export const transcriptCount = (sid, text, role) =>
  readTranscript(sid).filter((l) => (!role || l.type === role) && JSON.stringify(l).includes(text)).length;

// ===================== r141 追加(落盘闸门 + 逐拍 DOM 观察) =====================
// 闸门语义见 helpers/fake-claude.mjs 顶部注释(C1/C2/C3)。
/** 开【assistant 记录】闸门:此后该会话的 assistant 记录推迟到 <sid>.land 出现才写盘。 */
export const holdTranscript = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.hold'), '1');
/** 放行:被闸住的记录立刻写盘(产生时刻的 timestamp 原样保留)。 */
export const releaseLand = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.land'), String(Date.now()));
/** 开【user 记录】闸门(C2 的另一个选项:默认不开)。 */
export const holdUserTranscript = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.hold-user'), '1');
export const releaseLandUser = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.land-user'), String(Date.now()));
/** 吸收开关:回合在飞时收到的 stdin user 行只当被吸收(§5.0 第 2 条)。 */
export const setAbsorb = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.absorb'), '1');
export const clearR141Ctl = (ctl, sid) => {
  for (const s of ['.hold', '.land', '.hold-user', '.land-user', '.absorb', '.absorbed', '.go',
    '.sameuuid', '.trimhist', '.stream.jsonl']) {
    try { fs.unlinkSync(rel(ctl, sid, s)); } catch { /* 本来就没有 */ }
  }
};
/** 本会话被吸收过几条(证据面)。 */
export const absorbedCount = (ctl, sid) => { try { return fs.readFileSync(rel(ctl, sid, '.absorbed'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

/**
 * 逐拍快照:页面上所有带 data-turn-uuid 的节点(历史行 = MessageList 行,本地条目 =
 * visibleChat 那段 map;直播气泡【没有】这个属性,不会混进来)。
 * local = uuid 以 chat- 开头(chat-assistant-<ms> / chat-user-<ms> / chat-stopped-<ms> …)。
 */
export const turnNodes = (page) => page.evaluate(() => [...document.querySelectorAll('[data-turn-uuid]')].map((e) => ({
  uuid: e.getAttribute('data-turn-uuid'),
  role: e.getAttribute('data-turn-role'),
  local: /^chat-/.test(String(e.getAttribute('data-turn-uuid') || '')),
  text: (e.textContent || '').replace(/\s+/g, ' ').slice(0, 160),
})));
/** 含某段文字的节点(= 这条回复被画了几遍)。 */
export const copiesOf = async (page, marker) => (await turnNodes(page)).filter((n) => n.text.includes(marker));
/** 页面里此刻有没有"本地定稿副本"(chat-assistant-*)。 */
export const localCopyCount = async (page) =>
  (await turnNodes(page)).filter((n) => /^chat-assistant-/.test(String(n.uuid || ''))).length;
/** 用户气泡画了几遍(按文字,含本地与历史两个来源)。 */
export const userCopiesOf = async (page, text) => (await turnNodes(page)).filter((n) => n.role === 'user' && n.text.includes(text));

// ---- r141-P2 追加:判据① 的"输入"仪器 -------------------------------------
/** 开"两侧同 uuid"(复刻真 CLI 实测形态,见 TEST-PLAN 的 P-2 结论)。 */
export const sameUuid = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.sameuuid'), '1');
/** 开"历史正文更短":jsonl 记录只写正文前 60% ⇒ 判据③ 的覆盖下限必不成立。 */
export const trimHist = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.trimhist'), '1');
/** 假 CLI 自己记的"流侧 assistant 事件"(每条:uuid / fileUuid / messageId / text)。 */
export const readStreamLog = (ctl, sid) => {
  try {
    return fs.readFileSync(rel(ctl, sid, '.stream.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

/**
 * 页内 SSE 探针:把 window.fetch 包一层,把 /api/chat 的 SSE 流 tee 一份出来解析,
 * 把每条 assistant 事件的 uuid/messageId 记进 window.__r141.<name>.sse。
 * 为什么必须 tee 而不是只看假 CLI 的日志:判据① 的数据来源是【客户端解析到的 event.uuid】
 * —— 传输层/解析层把字段吃掉的话,假 CLI 那边看着对齐、到 A4 的收集点也是空的。
 * 只读 tee,不改任何请求、不影响主流程。必须在 page.goto 之前调用(addInitScript)。
 */
export async function startSseProbe(page, name = 'p2') {
  await page.addInitScript((n) => {
    const w = window;
    w.__r141 = w.__r141 || {};
    w.__r141[n] = { sse: [], seen: 0, urls: [] };
    const orig = w.fetch;
    w.fetch = async function patched(input, init) {
      const res = await orig.call(this, input, init);
      try {
        const url = String((input && input.url) || input || '');
        if (url.includes('/api/chat')) {
          const st = w.__r141[n];
          st.seen += 1;
          st.urls.push(url.slice(0, 80));
          const clone = res.clone();
          (async () => {
            const reader = clone.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              const parts = buf.split('\n');
              buf = parts.pop();
              for (const raw of parts) {
                const line = raw.replace(/^data:\s*/, '').trim();
                if (!line || line === '[DONE]') continue;
                let o; try { o = JSON.parse(line); } catch { continue; }
                if (o && o.type === 'assistant') {
                  st.sse.push({
                    uuid: o.uuid || null,
                    messageId: (o.message && o.message.id) || null,
                    at: Date.now(),
                    text: ((o.message && o.message.content) || []).map((b) => b.text || '').join(''),
                  });
                }
              }
            }
          })().catch(() => {});
        }
      } catch { /* 探针不许影响主流程 */ }
      return res;
    };
  }, name);
}
export const dumpSseProbe = (page, name = 'p2') => page.evaluate((n) => (window.__r141 || {})[n] || null, name);

