// r172-orbit-switch:逐帧采样与时间线分析。只看页面上用户能看到的东西(接口文件列出的 data-* 锚点、圆点包围盒),不读源码 / React state。
import { expect } from '@playwright/test';
import { ORBITS, phaseEvents, prepareLive, sendRound, expectPhase, expectZoomOne, openAllGates, waitIdle, ZOOM_ONE } from './ui.mjs';
import { touchCtl, collectPageErrors } from './runtime.mjs';

/** 每个旋转样式的点数(接口文件:3 个点 ↔ 4 个点)。 */
export const DOTS_OF = Object.fromEntries(ORBITS.map((o) => [o.id, o.dots]));
/** 全部用例的基础预置:界面缩放 1.0;升级标记 epoch=1(不预置的话启动时样式偏好会被重置成随机,固定样式用例就失效)。 */
export const R172_PRESETS = { ...ZOOM_ONE, 'cgui-loading-style-epoch': '1' };

// ───────────────────────── 页内逐帧采样(requestAnimationFrame) ─────────────────────────
/** 每帧记一条:墙钟 t、phase、指示器是否存在、根元素编号 rid(同一个 DOM 元素编号不变,换了元素就换号)、
 *  data-style / data-switch / data-speed / data-loading-mode、各 <i> 相对指示器中心的偏移 [dx, dy](CSS px;不受页面滚动影响)。 */
export async function startFrames(page) {
  await page.evaluate(() => {
    window.__r172Run = true;
    window.__r172F = [];
    window.__r172Seq = window.__r172Seq || 0;
    const tick = () => {
      const line = document.querySelector('[data-live-line]');
      const ind = line ? line.querySelector('[data-live-indicator]') : null;
      let rid = null;
      let dots = [];
      if (ind) {
        if (!ind.__r172id) { window.__r172Seq += 1; ind.__r172id = window.__r172Seq; }
        rid = ind.__r172id;
        const ir = ind.getBoundingClientRect();
        const ox = ir.left + ir.width / 2;
        const oy = ir.top + ir.height / 2;
        dots = [...ind.children].filter((c) => c.tagName === 'I').map((d) => {
          const r = d.getBoundingClientRect();
          return [r.left + r.width / 2 - ox, r.top + r.height / 2 - oy];
        });
      }
      window.__r172F.push({
        t: Date.now(),
        phase: line ? line.getAttribute('data-live-phase') : null,
        has: !!ind,
        rid,
        style: ind ? ind.getAttribute('data-style') : null,
        sw: ind ? ind.getAttribute('data-switch') : null,
        speed: ind ? ind.getAttribute('data-speed') : null,
        mode: ind ? ind.getAttribute('data-loading-mode') : null,
        dots,
      });
      if (window.__r172Run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function stopFrames(page) {
  return await page.evaluate(() => { window.__r172Run = false; return window.__r172F || []; });
}

export const distOf = (d) => Math.hypot(d[0], d[1]);
export const maxDist = (f) => (f.dots.length ? Math.max(...f.dots.map(distOf)) : 0);

/** [from, to] 内相邻两帧的最大间隔(毫秒)。> 250 = 机器卡顿,这次采样作废重采。 */
export function maxGap(frames, from, to) {
  let g = 0;
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i].t < from || frames[i - 1].t > to) continue;
    g = Math.max(g, frames[i].t - frames[i - 1].t);
  }
  return g;
}

/** once() 返回 { frames, win:[from,to], ... };窗口内有 > 250 毫秒的帧间隔就放掉闸门、等回合收尾、重来(最多 attempts 次),不放宽容差。 */
export async function retryClean(page, once, attempts = 3) {
  const gaps = [];
  for (let i = 0; i < attempts; i += 1) {
    const r = await once();
    const gap = maxGap(r.frames, r.win[0], r.win[1]);
    if (gap <= 250) return r;
    gaps.push(gap);
    console.log(`[R172] 第 ${i + 1} 次采样作废:窗口内相邻两帧最大间隔 ${gap}ms > 250ms,重采`);
    openAllGates();
    await waitIdle(page).catch(() => {});
  }
  throw new Error(`机器卡顿:连续 ${attempts} 次采样都有相邻两帧间隔 > 250 毫秒(各次最大间隔 ${gaps.join(', ')} ms);容差不放宽,请换个安静的时候重跑`);
}

/** 打一份紧凑的变化序列到日志(phase|switch|style|圆点数,连续相同的合并),方便看真实时间线。 */
export function logSeq(label, frames) {
  if (!frames.length) return;
  const t0 = frames[0].t;
  const seq = [];
  let last = '';
  for (const f of frames) {
    const k = `${f.phase}|${f.sw}|${f.style}|#${f.rid}|${f.dots.length}点`;
    if (k !== last) { seq.push(`+${f.t - t0}ms ${k}`); last = k; }
  }
  console.log(`[R172 ${label}] 帧数 ${frames.length};变化序列:\n  ${seq.slice(0, 60).join('\n  ')}`);
}

export function expectNoPageErrors(errors) {
  expect(errors, '全程不得出现页面错误(未捕获异常)').toEqual([]);
}

// ───────────────────────── 按阶段播放 ─────────────────────────
/**
 * 阶段表(phaseEvents 的写法:think / tool)→ 假回合,逐帧采样。phases[i].ms = 该阶段从放行起算持续多久。
 * 第 0 段在状态行出现 thinking 之后开始计时。starts[i] = 第 i 段的放行时刻(starts[0] = 第一个 thinking 被观察到的时刻)。
 */
export async function playPhaseList(page, { key, phases, presets = {}, reducedMotion = false }) {
  const errors = collectPageErrors(page);
  await prepareLive(page, { key, scenario: { events: phaseEvents(phases) }, presets: { ...R172_PRESETS, ...presets }, reducedMotion });
  await expectZoomOne(page);
  await sendRound(page);
  await startFrames(page);
  await expectPhase(page, 'thinking');
  const starts = [Date.now()];
  for (let i = 0; i < phases.length; i += 1) {
    await page.waitForTimeout(phases[i].ms);
    if (i === phases.length - 1) break;
    if (phases[i].kind === 'tool') touchCtl(`d${i}`);
    touchCtl(`g${i + 1}`);
    starts.push(Date.now());
  }
  const frames = await stopFrames(page);
  return { frames, starts, errors, tRel: starts[1], win: [starts[1] - 300, frames[frames.length - 1].t] };
}

/** 原位换样式(同一组里 思考 → 工具):思考 thinkMs(默认 4.7 秒,满足 ≥ 4.5 秒)→ 工具,工具阶段停 toolMs。 */
export function playInPlace(page, { key, presets = {}, reducedMotion = false, thinkMs = 4700, toolMs = 4500 }) {
  return playPhaseList(page, {
    key, presets, reducedMotion,
    phases: [{ kind: 'think', ms: thinkMs }, { kind: 'tool', title: 'R172 工具甲', ms: toolMs }],
  });
}

// ───────────────────────── 时间线分析 ─────────────────────────
/** 以放行工具阶段的时刻 tRel 为界,找出一次原位换样式的各个关键帧下标(找不到 = -1)。 */
export function analyseSwitch(frames, tRel) {
  let iPre = -1;
  frames.forEach((f, i) => { if (f.t < tRel && f.has) iPre = i; });
  const oldStyle = iPre >= 0 ? frames[iPre].style : null;
  const from = (pred, start = 0) => { for (let i = start; i < frames.length; i += 1) if (pred(frames[i], i)) return i; return -1; };
  const iTool = from((f) => f.t >= tRel && f.phase === 'tool');
  const jChange = from((f) => f.t >= tRel && f.has && f.style !== oldStyle);
  const jIn = from((f) => f.t >= tRel && f.has && f.sw === 'in');
  const jOut = jIn >= 0 ? from((f) => f.has && f.sw === 'out', jIn + 1) : -1;
  const jEnd = jOut >= 0 ? from((f) => f.has && f.sw === null, jOut + 1) : -1;
  return { iPre, oldStyle, iTool, jChange, jIn, jOut, jEnd };
}

/** 全部「聚拢开始」的过渡(sw 从非 in 变成 in 的那一帧),附带是否原位(同一个根元素)。 */
export function allTransitions(frames) {
  const res = [];
  for (let i = 1; i < frames.length; i += 1) {
    const f = frames[i];
    const p = frames[i - 1];
    if (!(f.has && f.sw === 'in' && !(p.has && p.sw === 'in'))) continue;
    let jOut = -1;
    let jEnd = -1;
    for (let j = i + 1; j < frames.length; j += 1) {
      if (jOut < 0) { if (frames[j].has && frames[j].sw === 'out') jOut = j; } else if (frames[j].has && frames[j].sw === null) { jEnd = j; break; }
    }
    res.push({
      iIn: i, jOut, jEnd,
      oldStyle: p.has ? p.style : null, newStyle: f.style,
      inPlace: p.has && p.rid === f.rid && jEnd >= 0 && frames[jEnd].rid === f.rid,
    });
  }
  return res;
}

/** 行为 1 / 8 共用:换样式 + in/out 时间线 + 同一个根元素。 */
export function expectTimeline(frames, a, tolerance = 200) {
  const T = (i) => frames[i].t;
  expect(a.iTool, '前置:放行后应观察到 data-live-phase=tool').toBeGreaterThanOrEqual(0);
  expect(a.jChange, `进入工具后指示器 data-style 应变成另一个 id(旧 ${a.oldStyle};整个采样里从未变过)`).toBeGreaterThanOrEqual(0);
  const newStyle = frames[a.jChange].style;
  expect(ORBITS.map((o) => o.id), `新 data-style(${newStyle})应是 16 个 id 之一`).toContain(newStyle);
  const lag = T(a.jChange) - T(a.iTool);
  expect(lag, `data-style 应在进入工具阶段后 200ms 内变化(实测 ${lag}ms,${a.oldStyle} → ${newStyle})`).toBeLessThanOrEqual(200);
  expect(a.jIn, `换样式的同时应出现 data-switch="in"(${a.oldStyle} → ${newStyle};整个采样里从未出现过 data-switch="in")`).toBeGreaterThanOrEqual(0);
  const sync = Math.abs(T(a.jIn) - T(a.jChange));
  expect(sync, `data-switch="in" 应与 data-style 变化同时出现(相差 ${sync}ms,允许 ≤ 50ms)`).toBeLessThanOrEqual(50);
  expect(a.jOut, 'data-switch 应从 in 变成 out(从未出现 out)').toBeGreaterThanOrEqual(0);
  const inMs = T(a.jOut) - T(a.jIn);
  expect(Math.abs(inMs - 1000), `data-switch="in" 应持续 1000±${tolerance}ms(实测 ${inMs}ms)`).toBeLessThanOrEqual(tolerance);
  expect(a.jEnd, 'out 之后 data-switch 属性应消失(采样结束时仍在)').toBeGreaterThanOrEqual(0);
  const outMs = T(a.jEnd) - T(a.jOut);
  expect(Math.abs(outMs - 1000), `data-switch="out" 应持续 1000±${tolerance}ms(实测 ${outMs}ms)`).toBeLessThanOrEqual(tolerance);
  const span = frames.slice(a.iPre, a.jEnd + 1);
  const rids = [...new Set(span.map((f) => (f.has ? f.rid : 'gone')))];
  expect(rids, '过渡全程指示器根元素应是同一个元素(rid 不变、中途不消失)').toEqual([frames[a.iPre].rid]);
}

/** 行为 5 / 6 共用:过渡标记消失后 500ms 内恢复正常转动。 */
export function expectResumed(frames, jEnd, label) {
  expect(jEnd, `${label}:前置:应观察到过渡标记消失`).toBeGreaterThanOrEqual(0);
  const win = frames.filter((f, i) => i >= jEnd && f.t <= frames[jEnd].t + 500);
  expect(win.length, `${label}:前置:消失后 500ms 内应采到足够多的帧(≥ 20)`).toBeGreaterThanOrEqual(20);
  const far = Math.max(...win.map(maxDist));
  expect(far, `${label}:过渡标记消失后 500ms 内至少一个圆点应离指示器中心 ≥ 3px(实测最远 ${far.toFixed(2)}px)`).toBeGreaterThanOrEqual(3);
  const bad = win.filter((f) => f.dots.length !== DOTS_OF[f.style]);
  expect(bad.slice(0, 3).map((f) => `${f.style} 应 ${DOTS_OF[f.style]} 点,实测 ${f.dots.length} 点`), `${label}:消失后 500ms 内 <i> 个数应等于当前样式的点数(不符 ${bad.length}/${win.length} 帧)`).toEqual([]);
}
