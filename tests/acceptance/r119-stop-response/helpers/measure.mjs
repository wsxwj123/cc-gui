// r119 量延迟用的页内探针。只观察用户看得见的东西(停止按钮的文字/禁用/消失、停止类提示),不碰 store。
// 关键点:光靠 playwright 侧计时会把"主线程被占住"的时间藏起来,所以**页内记时间戳**,测试侧事后取记录。
//
// 探针本身必须极便宜(每帧 O(1)):遍历全文档的写法在"流式输出把页面撑大"的场景里会自己变成卡顿源,
// 那样量到的就不是应用的问题。所以:
//   - 停止按钮只扫一次并缓存元素引用,断开了才(限流)重扫;
//   - 状态检查只读这一个元素的 textContent/属性,不读 innerText、不做布局测量;
//   - 提示文字只在小范围里看(aria live 区 + composer 容器),且每 500ms 才看一次。
// 记录:
//   inputs  按下与 Esc 的**被受理时刻**(performance.now)
//   sigs    停止按钮可观察状态的变化时刻(文字/禁用/类名/消失 任一变化)
//   hints   页面上出现「正在停止/停止中/已停止」类提示的时刻
//   frames  rAF 心跳间隔(大 = 主线程被占住)  beats  setInterval(50) 心跳(另一路证据)
// 墙上时间 = t0 + performance.now(),t0 在装入时算。

export const PROBE = () => {
  const w = window;
  if (w.__r119) return 'already';
  const STOPISH = /停止/;
  const scanStop = () => {
    try {
      for (const el of document.querySelectorAll('button,[role=button],[role=switch]')) {
        if (STOPISH.test(el.textContent || '') || STOPISH.test(el.getAttribute('aria-label') || '')) return el;
      }
    } catch { /* 忽略 */ }
    return null;
  };
  const attrOf = (el) => (el
    ? `${el.getAttribute('aria-label') || ''}|${el.getAttribute('aria-disabled') || ''}|${el.hasAttribute('disabled') ? 'disabled' : ''}|${(el.textContent || '').trim().slice(0, 24)}|${String(el.className).slice(0, 80)}`
    : 'GONE');
  const p = {
    t0: Date.now() - performance.now(), inputs: [], sigs: [], hints: [], frames: [], beats: [], marks: [],
    lastFrame: performance.now(), lastBeat: performance.now(), stopEl: null, sig: '', lastScan: 0, lastHintAt: 0, hintTxt: '',
  };
  w.__r119 = p;
  try { p.stopEl = scanStop(); } catch { /* 忽略 */ }
  p.sig = attrOf(p.stopEl);

  const put = (list, item, cap) => { list.push(item); if (list.length > cap) list.shift(); };
  document.addEventListener('pointerdown', (e) => put(p.inputs, { type: 'pointerdown', t: performance.now(), onStop: p.stopEl === e.target || (p.stopEl && p.stopEl.contains(e.target)) ? 1 : 0 }, 200), true);
  document.addEventListener('click', (e) => put(p.inputs, { type: 'click', t: performance.now(), onStop: p.stopEl === e.target || (p.stopEl && p.stopEl.contains(e.target)) ? 1 : 0 }, 200), true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') put(p.inputs, { type: 'keydown-escape', t: performance.now(), onStop: 0 }, 200); }, true);

  const checkHints = (now) => {
    try {
      const nodes = document.querySelectorAll('[role=status],[role=alert],[aria-live]');
      for (const n of nodes) {
        const m = /正在停止|停止中|已停止|停止请求/.exec((n.textContent || '').slice(0, 200));
        if (m && m[0] !== p.hintTxt) { p.hintTxt = m[0]; put(p.hints, { t: now, hint: m[0] }, 50); break; }
      }
    } catch { /* 忽略 */ }
  };
  const frame = () => {
    const now = performance.now();
    put(p.frames, { t: now, gap: now - p.lastFrame }, 1200);
    p.lastFrame = now;
    if (!p.stopEl || !p.stopEl.isConnected) {
      if (now - p.lastScan > 200) { p.lastScan = now; p.stopEl = scanStop(); }
    }
    const sig = attrOf(p.stopEl);
    if (sig !== p.sig) { p.sig = sig; put(p.sigs, { t: now, sig }, 50); }
    if (now - p.lastHintAt > 500) { p.lastHintAt = now; checkHints(now); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(() => { const now = performance.now(); put(p.beats, { t: now, gap: now - p.lastBeat }, 1000); p.lastBeat = now; }, 50);
  return 'installed';
};

export const installProbe = (page) => page.evaluate(PROBE);

export const resetProbe = (page) => page.evaluate(() => {
  const p = window.__r119; if (!p) return;
  p.inputs.length = 0; p.sigs.length = 0; p.hints.length = 0; p.marks.length = 0;
  p.frames.length = 0; p.beats.length = 0; p.lastFrame = performance.now(); p.lastBeat = performance.now();
});

export const markProbe = (page, name, payload) => page.evaluate(([n, v]) => { window.__r119.marks.push({ name: n, v: v ?? null, t: performance.now() }); }, [name, payload ?? null]);

export const readProbe = (page) => page.evaluate(() => {
  const p = window.__r119;
  return JSON.parse(JSON.stringify({
    t0: p.t0, inputs: p.inputs, sigs: p.sigs, hints: p.hints, frames: p.frames, beats: p.beats, marks: p.marks,
    sig: p.sig,                       // 此刻停止按钮的状态('GONE' = 界面上已经没有停止按钮)
    framesLen: p.frames.length, now: performance.now(),
  }));
});

/** 页面还活着吗:量一次 evaluate 的往返。主线程被占住时这个数会很大(甚至一直不返回)。 */
export async function pingPage(page) {
  const t0 = Date.now();
  try {
    await Promise.race([
      page.evaluate(() => 1),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 20_000)),
    ]);
    return { ms: Date.now() - t0, ok: true };
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, err: String(e.message) };
  }
}

/** 点「停止」按钮(真鼠标按下,不走 actionability 等待)。返回派发前后的墙上时间。 */
export async function clickStopButton(page) {
  const btn = page.getByRole('button', { name: /^停止/ }).first();
  await btn.scrollIntoViewIfNeeded();
  const box = await btn.boundingBox();
  if (!box) throw new Error('量不到「停止」按钮的位置');
  const tIssue = Date.now();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return { tIssue, tAfter: Date.now() };
}

/** 按 Esc(单次)。 */
export async function pressEsc(page) {
  const tIssue = Date.now();
  await page.keyboard.press('Escape');
  return { tIssue, tAfter: Date.now() };
}

const maxGapIn = (list, from, to) => {
  let m = 0;
  for (const x of list) if (x.t >= from && x.t <= to && x.gap > m) m = x.gap;
  return m;
};

/**
 * 从探针记录里算这一次动作的账:
 *   totalMs     用户按下 → 界面出现任何可观察变化(墙上毫秒,INTERFACE B1 说的就是这个)
 *   inputLagMs  按下 → 输入事件被主线程受理(排队;主线程被占住时这块很大)
 *   reactMs     输入事件被受理 → 界面变化(应用自己的处理耗时)
 *   maxFrameGapMs / maxBeatGapMs  该窗口(按下前 3 秒 + 按下到变化)里主线程最长一次被占住多久
 */
export function analyze(snap, tIssue, tEnd) {
  const wall = (t) => snap.t0 + t;
  const pt = tIssue - snap.t0;
  const input = snap.inputs.find((i) => wall(i.t) >= tIssue - 5) || null;
  const changes = [
    ...snap.sigs.map((s) => ({ t: s.t, kind: `停止按钮状态变化(${s.sig})` })),
    ...snap.hints.map((h) => ({ t: h.t, kind: `出现提示「${h.hint}」` })),
  ].map((c) => ({ ...c, delta: wall(c.t) - tIssue })).filter((c) => c.delta >= -5).sort((a, b) => a.delta - b.delta);
  const first = changes[0] || null;
  const upper = Math.min(first ? first.t : Infinity, (tEnd ? tEnd - snap.t0 : Infinity));
  return {
    tIssue,
    inputType: input ? input.type : null,
    inputLagMs: input ? Math.round(wall(input.t) - tIssue) : null,
    reactMs: input && first ? Math.round(first.t - input.t) : null,
    totalMs: first ? Math.round(first.delta) : null,
    changedBy: first ? first.kind : null,
    changes: changes.slice(0, 6).map((c) => ({ ms: Math.round(c.delta), kind: c.kind })),
    maxFrameGapMs: Math.round(Math.max(maxGapIn(snap.frames, pt - 3_000, pt), maxGapIn(snap.frames, pt, upper))),
    maxBeatGapMs: Math.round(Math.max(maxGapIn(snap.beats, pt - 3_000, pt), maxGapIn(snap.beats, pt, upper))),
    maxGapBeforeMs: Math.round(maxGapIn(snap.frames, pt - 3_000, pt)),
  };
}

export const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return null;
  const h = Math.floor(a.length / 2);
  return a.length % 2 ? a[h] : Math.round((a[h - 1] + a[h]) / 2);
};

/** 界面此刻显示的流式序号(桩吐的是 R119STREAM <sid8> #00012);取正文尾部,避免整页扫描。 */
export const streamIndex = (page) => page.evaluate(() => {
  const txt = (document.body.textContent || '').slice(-200_000);
  const m = [...txt.matchAll(/#(\d{5})/g)];
  return m.length ? Number(m[m.length - 1][1]) : -1;
});
