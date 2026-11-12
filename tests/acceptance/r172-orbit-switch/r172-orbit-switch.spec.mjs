// r172-orbit-switch-transition:随机模式换样式时先「聚拢」1 秒再「展开」1 秒;最短换样式间隔 1.5 秒 → 4 秒。
// 判据全部来自 .devflow/r172-orbit-switch-transition-接口.md 的行为清单 1–11,只看页面上用户能看到的东西
// (data-live-* / data-style / data-switch / data-speed 属性、<i> 圆点的包围盒、localStorage 键);不读源码、不读 React state、不 import 应用内部模块。
// 命名:用例标题以「行为N」开头(N 后面跟一个空格),每条行为一个用例;行为 1、2、3 在 playwright.config 里加跑 chromium 项目。
// 行为 1–8 是新行为(实现前应红);行为 9–11 是相邻回归(实现前后都应过)。
import { test, expect } from '@playwright/test';
import { ORBIT_IDS, prepareLive, sendRound, expectPhase, openAllGates } from './helpers/ui.mjs';
import { expectZoomOne } from './helpers/ui.mjs';
import { touchCtl, collectPageErrors } from './helpers/runtime.mjs';
import {
  R172_PRESETS, DOTS_OF, startFrames, stopFrames, maxDist, distOf, retryClean, logSeq, expectNoPageErrors,
  playPhaseList, playInPlace, analyseSwitch, allTransitions, expectTimeline, expectResumed,
} from './helpers/switch.mjs';

// 用例失败时直播回合会停在半路(假命令行在等放行文件):把所有闸门都放了,让它自己收尾,别拖累下一条。
test.afterEach(async () => { try { openAllGates(); } catch { /* 忽略 */ } });

// ───────────────────────── 新行为 1–8 ─────────────────────────
test('行为1 原位换样式（思考4.7秒→工具）：200ms内data-style变成另一个id并出现data-switch=in，in 1000±200ms→out 1000±200ms→属性消失，全程同一个根元素', async ({ page }) => {
  const r = await retryClean(page, () => playInPlace(page, { key: 'b1' }));
  logSeq('行为1', r.frames);
  expectTimeline(r.frames, analyseSwitch(r.frames, r.tRel));
  expectNoPageErrors(r.errors);
});

test('行为2 聚拢到中心：data-switch 从 in 变 out 的那一刻（in 最后一帧与 out 第一帧里更近的一帧），所有圆点中心离指示器中心 ≤ 1px', async ({ page }) => {
  const r = await retryClean(page, () => playInPlace(page, { key: 'b2' }));
  logSeq('行为2', r.frames);
  const a = analyseSwitch(r.frames, r.tRel);
  expect(a.jIn, '前置:换样式时应出现 data-switch="in"(整个采样里从未出现)').toBeGreaterThanOrEqual(0);
  expect(a.jOut, '前置:data-switch 应从 in 变成 out(从未出现 out)').toBeGreaterThanOrEqual(0);
  const lastIn = r.frames[a.jOut - 1];
  const firstOut = r.frames[a.jOut];
  expect(lastIn.sw, '前置:out 的前一帧应是 in').toBe('in');
  const lastInDots = lastIn.dots.map((d) => distOf(d));
  const firstOutDots = firstOut.dots.map((d) => distOf(d));
  const pick = Math.max(...lastInDots) <= Math.max(...firstOutDots) ? lastInDots : firstOutDots;
  expect(pick.length, '前置:所取那一帧应有圆点').toBeGreaterThan(0);
  expect(Math.max(...pick), `in→out 交接那一帧所有圆点离指示器中心都应 ≤ 1px(in 末帧最远 ${Math.max(...lastInDots).toFixed(2)}px、out 首帧最远 ${Math.max(...firstOutDots).toFixed(2)}px)`).toBeLessThanOrEqual(1);
  expectNoPageErrors(r.errors);
});

test('行为3 没有跳变：data-style变化前300ms到标记消失后300ms，相邻帧间隔≤60ms的同序号圆点位移≤4px', async ({ page }) => {
  const r = await retryClean(page, () => playInPlace(page, { key: 'b3' }));
  logSeq('行为3', r.frames);
  const a = analyseSwitch(r.frames, r.tRel);
  expect(a.jChange, '前置:进入工具后 data-style 应变化').toBeGreaterThanOrEqual(0);
  const T = (i) => r.frames[i].t;
  const from = T(a.jChange) - 300;
  // 标记消失后 300ms;没有过渡标记(实现前)时退而用「变化后 2.3 秒」当窗口末端,让一帧跳变也能被抓到。
  const to = a.jEnd >= 0 ? T(a.jEnd) + 300 : T(a.jChange) + 2300;
  let worst = { d: 0, desc: '无' };
  let pairs = 0;
  for (let i = 1; i < r.frames.length; i += 1) {
    const f = r.frames[i];
    const p = r.frames[i - 1];
    // 不比较根元素是否同一个:实现前换样式 = 旧指示器元素卸载、新元素挂载(rid 变了),那一帧的跳变正是要抓的东西。
    if (f.t < from || f.t > to || !f.has || !p.has || f.t - p.t > 60) continue;
    pairs += 1;
    for (let k = 0; k < Math.min(f.dots.length, p.dots.length); k += 1) {
      const d = Math.hypot(f.dots[k][0] - p.dots[k][0], f.dots[k][1] - p.dots[k][1]);
      if (d > worst.d) worst = { d, desc: `第${k}个点 @${f.t - T(a.jChange)}ms(相对换样式帧) data-switch=${f.sw} ${p.style}→${f.style}` };
    }
  }
  expect(pairs, '前置:窗口内应有足够多的相邻帧对(≥ 40)').toBeGreaterThanOrEqual(40);
  expect(worst.d, `同序号圆点相邻帧位移应 ≤ 4px(实测最大 ${worst.d.toFixed(2)}px:${worst.desc})`).toBeLessThanOrEqual(4);
  expectNoPageErrors(r.errors);
});

test('行为4 点数在中心处变化：新旧点数不同时 in 期间 <i> 个数=旧样式点数，out 期间与结束后=新样式点数', async ({ page }) => {
  test.setTimeout(300_000);
  // 思考 → 工具 → 思考 → 工具 …… 每段 4.5 秒,每次进入新阶段都满 4 秒,一轮最多 5 次换样式;抽不到点数不同的一对就再来一轮(最多 3 轮)。
  const phases = [
    { kind: 'think', ms: 4700 }, { kind: 'tool', title: 'R172 工具甲', ms: 4500 }, { kind: 'think', ms: 4500 },
    { kind: 'tool', title: 'R172 工具乙', ms: 4500 }, { kind: 'think', ms: 4500 }, { kind: 'tool', title: 'R172 工具丙', ms: 4500 },
  ];
  let chosen = null;
  let frames = [];
  let errors = [];
  const seen = [];
  for (let round = 0; round < 3 && !chosen; round += 1) {
    const r = await retryClean(page, () => playPhaseList(page, { key: 'b4', phases }));
    frames = r.frames;
    errors = r.errors;
    logSeq(`行为4 第${round + 1}轮`, frames);
    const ts = allTransitions(frames).filter((t) => t.inPlace);
    expect(ts.length, '前置:一轮 6 个阶段里应观察到至少一次原位换样式(data-switch=in → out → 消失,同一个根元素);从未观察到').toBeGreaterThan(0);
    ts.forEach((t) => seen.push(`${t.oldStyle}(${DOTS_OF[t.oldStyle]}点)→${t.newStyle}(${DOTS_OF[t.newStyle]}点)`));
    chosen = ts.find((t) => DOTS_OF[t.oldStyle] !== DOTS_OF[t.newStyle]) || null;
  }
  expect(chosen, `3 轮里没抽到点数不同的一对(抽到的:${seen.join(' ; ')})——属于概率事件,重跑即可`).not.toBeNull();
  const { oldStyle, newStyle, iIn, jOut, jEnd } = chosen;
  const inFrames = frames.slice(iIn, jOut);
  const outFrames = frames.slice(jOut).filter((f) => f.t <= frames[jEnd].t + 300);
  const badIn = inFrames.filter((f) => f.dots.length !== DOTS_OF[oldStyle]);
  expect(badIn.slice(0, 3).map((f) => `${f.dots.length}点`), `${oldStyle}→${newStyle}:in 期间 <i> 个数应=旧样式点数 ${DOTS_OF[oldStyle]}(不符 ${badIn.length}/${inFrames.length} 帧)`).toEqual([]);
  const badOut = outFrames.filter((f) => f.dots.length !== DOTS_OF[newStyle]);
  expect(badOut.slice(0, 3).map((f) => `${f.sw}:${f.dots.length}点`), `${oldStyle}→${newStyle}:out 期间与结束后 300ms 内 <i> 个数应=新样式点数 ${DOTS_OF[newStyle]}(不符 ${badOut.length}/${outFrames.length} 帧)`).toEqual([]);
  expectNoPageErrors(errors);
});

test('行为5 过渡结束后恢复正常转动：标记消失后500ms内至少一个圆点离中心≥3px，且<i>个数=当前样式点数', async ({ page }) => {
  const r = await retryClean(page, () => playInPlace(page, { key: 'b5' }));
  logSeq('行为5', r.frames);
  const a = analyseSwitch(r.frames, r.tRel);
  expect(a.jIn, '前置:换样式时应出现 data-switch="in"(整个采样里从未出现)').toBeGreaterThanOrEqual(0);
  expectResumed(r.frames, a.jEnd, '原位换样式后');
  expectNoPageErrors(r.errors);
});

test('行为6 换位置的同时换样式也走完整过渡（思考4.7秒→正文1秒→思考）：新指示器样式不同、第一帧起带 in 且画旧样式圆点（有圆点离中心≥3px）、in 1000±200ms→圆点聚拢到中心≤1px→out 1000±200ms（点数=新样式）→消失、之后恢复转动、全程同一个元素', async ({ page }) => {
  const r = await retryClean(page, async () => {
    const errors = collectPageErrors(page);
    await prepareLive(page, {
      key: 'b6',
      presets: R172_PRESETS,
      scenario: {
        events: [
          { kind: 'thinking', text: 'R172 先想一会。' }, { kind: 'wait', file: 'g1' },
          { kind: 'text', text: 'R172 正文一小段。' }, { kind: 'wait', file: 'g2' },
          { kind: 'thinking', text: 'R172 再想一会。' },
        ],
      },
    });
    await expectZoomOne(page);
    await sendRound(page);
    await startFrames(page);
    await expectPhase(page, 'thinking');
    await page.waitForTimeout(4700);
    const tRel1 = Date.now(); touchCtl('g1');
    await expectPhase(page, 'text');
    await page.waitForTimeout(1000);
    const tRel2 = Date.now(); touchCtl('g2');
    await page.waitForTimeout(3800);
    const frames = await stopFrames(page);
    return { frames, errors, tRel1, tRel2, win: [tRel1 - 300, frames[frames.length - 1].t] };
  });
  logSeq('行为6', r.frames);
  const f = r.frames;
  const iText = f.findIndex((x) => x.t >= r.tRel1 && x.phase === 'text' && x.has);
  expect(iText, '前置:应观察到正文阶段(data-live-phase=text)且带指示器').toBeGreaterThanOrEqual(0);
  const textRid = f[iText].rid;
  const iNew = f.findIndex((x, i) => i > iText && x.t >= r.tRel2 && x.has && x.rid !== textRid);
  expect(iNew, '前置:第二次进入思考时,状态行应换位置、出现一个新的指示器元素(rid 与正文阶段那个不同)').toBeGreaterThan(iText);
  let iPrev = iNew - 1;
  while (iPrev > 0 && !f[iPrev].has) iPrev -= 1;
  const prevStyle = f[iPrev].style;
  const first = f[iNew];
  expect(first.phase, '前置:新指示器出现时状态行应是 thinking 阶段').toBe('thinking');
  expect(first.style, `新出现的指示器 data-style 应与之前(${prevStyle})不同`).not.toBe(prevStyle);
  expect(ORBIT_IDS, '新 data-style 应是 16 个 id 之一').toContain(first.style);
  // 第一帧起就是聚拢(in),画的是旧样式的圆点,不是从中心开始
  expect(first.sw, `新指示器应从出现的第一帧起就带 data-switch="in"(实测 ${first.sw},样式 ${prevStyle} → ${first.style})`).toBe('in');
  expect(first.dots.length, `第一帧 <i> 个数应=旧样式 ${prevStyle} 的点数 ${DOTS_OF[prevStyle]}(实测 ${first.dots.length} 个)`).toBe(DOTS_OF[prevStyle]);
  expect(maxDist(first), `第一帧至少有一个圆点离指示器中心 ≥ 3px(不是从中心开始;实测最远 ${maxDist(first).toFixed(2)}px)`).toBeGreaterThanOrEqual(3);
  // in → out
  const jOut = f.findIndex((x, i) => i > iNew && x.has && x.sw === 'out');
  expect(jOut, 'data-switch 应从 in 变成 out(从未出现 out)').toBeGreaterThan(iNew);
  const inFrames = f.slice(iNew, jOut);
  const badIn = inFrames.filter((x) => !x.has || x.sw !== 'in' || x.dots.length !== DOTS_OF[prevStyle]);
  expect(badIn.slice(0, 3).map((x) => `${x.sw}:${x.style}:${x.dots.length}点`), `in 期间每一帧应带 data-switch="in" 且 <i> 个数=旧样式 ${prevStyle} 的点数 ${DOTS_OF[prevStyle]}(不符 ${badIn.length}/${inFrames.length} 帧)`).toEqual([]);
  const inMs = f[jOut].t - first.t;
  expect(Math.abs(inMs - 1000), `data-switch="in" 应从出现起持续 1000±200ms(实测 ${inMs}ms)`).toBeLessThanOrEqual(200);
  const lastIn = f[jOut - 1];
  const firstOut = f[jOut];
  const lastInDots = lastIn.dots.map(distOf);
  const firstOutDots = firstOut.dots.map(distOf);
  const pick = Math.max(...lastInDots) <= Math.max(...firstOutDots) ? lastInDots : firstOutDots;
  expect(pick.length, '前置:所取那一帧应有圆点').toBeGreaterThan(0);
  expect(Math.max(...pick), `in→out 交接那一帧所有圆点离指示器中心都应 ≤ 1px(in 末帧最远 ${Math.max(...lastInDots).toFixed(2)}px、out 首帧最远 ${Math.max(...firstOutDots).toFixed(2)}px)`).toBeLessThanOrEqual(1);
  // out → 消失
  const jEnd = f.findIndex((x, i) => i > jOut && x.has && x.sw === null);
  expect(jEnd, 'out 之后 data-switch 属性应消失').toBeGreaterThan(jOut);
  const outMs = f[jEnd].t - f[jOut].t;
  expect(Math.abs(outMs - 1000), `data-switch="out" 应持续 1000±200ms(实测 ${outMs}ms)`).toBeLessThanOrEqual(200);
  const outFrames = f.slice(jOut, jEnd);
  const badOut = outFrames.filter((x) => !x.has || x.sw !== 'out' || x.dots.length !== DOTS_OF[first.style]);
  expect(badOut.slice(0, 3).map((x) => `${x.sw}:${x.style}:${x.dots.length}点`), `out 期间每一帧应带 data-switch="out" 且 <i> 个数=新样式 ${first.style} 的点数 ${DOTS_OF[first.style]}(不符 ${badOut.length}/${outFrames.length} 帧)`).toEqual([]);
  expect(new Set(f.slice(iNew, jEnd + 1).map((x) => (x.has ? x.rid : 'gone'))).size, '从出现到过渡结束新指示器应是同一个元素').toBe(1);
  expect(f.slice(iNew, jEnd + 1).every((x) => x.style === first.style), `过渡期间 data-style 应恒为新样式 ${first.style}`).toBe(true);
  expectResumed(f, jEnd, '换位置换样式后');
  expectNoPageErrors(r.errors);
});

// 主会话修订(2026-11-12):原时间线以为放行后立刻进入「工具乙」。实际播出来的阶段序列是
//   工具甲 →(工具结果返回的那一刻)思考 →(约 2.6 秒后)工具乙,
// 进入工具乙时距上次换样式已超过 4 秒,换样式是对的,原断言「一直不补换」不成立。
// 改成观察「工具甲的结果返回后回到思考」这次阶段进入:它距换样式不满 4 秒,不该换;
// 下一个工具的闸门先不放,让思考阶段一直持续到越过 4 秒线,确认也不补换。
test('行为7 最短间隔4秒：思考→工具甲（换）→2.5秒后工具结果返回、状态行回到思考（不满4秒）：样式不变、没有过渡标记，越过4秒线也不补换', async ({ page }) => {
  const r = await retryClean(page, async () => {
    const errors = collectPageErrors(page);
    await prepareLive(page, {
      key: 'b7',
      presets: R172_PRESETS,
      scenario: {
        events: [
          { kind: 'thinking', text: 'R172 先想一会。' }, { kind: 'wait', file: 'g1' },
          { kind: 'tool', name: 'Bash', input: { command: 'echo r172', description: 'R172 工具甲' }, pending: 'd1' }, { kind: 'wait', file: 'g2' },
          { kind: 'tool', name: 'Bash', input: { command: 'echo r172b', description: 'R172 工具乙' }, pending: 'd2' },
        ],
      },
    });
    await expectZoomOne(page);
    await sendRound(page);
    await startFrames(page);
    await expectPhase(page, 'thinking');
    await page.waitForTimeout(4700);
    const tRelA = Date.now(); touchCtl('g1');
    await expectPhase(page, 'tool');
    await page.waitForTimeout(2500); // 进入工具甲(换样式)后 2.5 秒,工具甲的结果返回 → 状态行回到思考
    const tRelB = Date.now(); touchCtl('d1'); // 只放工具甲的结果;g2(下一个工具)先不放,思考阶段一直持续
    await page.waitForTimeout(2900); // 思考阶段持续到距换样式约 5.4 秒,越过 4 秒线
    const frames = await stopFrames(page);
    openAllGates(); // 采样结束,把剩下的闸门放掉让回合收尾
    return { frames, errors, tRelA, tRelB, win: [tRelA - 300, frames[frames.length - 1].t] };
  });
  logSeq('行为7', r.frames);
  const f = r.frames;
  const before = (t) => { let k = -1; f.forEach((x, i) => { if (x.t < t && x.has) k = i; }); return k; };
  const id0 = f[before(r.tRelA)].style;
  const id1 = f[before(r.tRelB)].style;
  expect(id1, `前置:进入工具甲(思考已满 4 秒)应换样式(进入前 ${id0})`).not.toBe(id0);
  const iSwitch = f.findIndex((x) => x.t >= r.tRelA && x.has && x.style === id1);
  const tSwitch = f[iSwitch].t;
  const iThink = f.findIndex((x) => x.t >= r.tRelB && x.has && x.phase === 'thinking');
  expect(iThink, '前置:工具甲的结果返回后,状态行应回到思考阶段(data-live-phase=thinking)').toBeGreaterThanOrEqual(0);
  const enterGap = f[iThink].t - tSwitch;
  expect(enterGap, `前置:回到思考的那一刻应距上次换样式不满 4 秒(实测 ${enterGap}ms)`).toBeLessThan(4000);
  const after = f.filter((x, i) => i >= iThink && x.has);
  expect(after.length, '前置:回到思考之后应采到足够多的帧(≥ 120)').toBeGreaterThanOrEqual(120);
  expect([...new Set(after.map((x) => x.phase))], '前置:回到思考之后到采样结束应一直是思考阶段(没有再进入别的阶段)').toEqual(['thinking']);
  const lastGap = after[after.length - 1].t - tSwitch;
  expect(lastGap, `前置:采样应持续到距上次换样式 4.5 秒之后(实测 ${lastGap}ms),才能确认不补换`).toBeGreaterThanOrEqual(4500);
  const changed = after.filter((x) => x.style !== id1);
  expect(changed.slice(0, 3).map((x) => `@回到思考后+${x.t - f[iThink].t}ms ${x.phase}:${x.style}`), `回到思考(距换样式不满 4 秒)之后一直到越过 4 秒线,data-style 应始终是 ${id1}(不符 ${changed.length}/${after.length} 帧)`).toEqual([]);
  const marked = after.filter((x) => x.sw !== null);
  expect(marked.slice(0, 3).map((x) => `@回到思考后+${x.t - f[iThink].t}ms data-switch=${x.sw}`), `回到思考之后不应出现过渡标记(出现 ${marked.length}/${after.length} 帧)`).toEqual([]);
  expectNoPageErrors(r.errors);
});

test('行为8 转速不影响过渡时长：转速 fast 时 in、out 两段仍各 1000±200ms', async ({ page }) => {
  const r = await retryClean(page, () => playInPlace(page, { key: 'b8', presets: { 'cgui-loading-speed': 'fast' } }));
  logSeq('行为8', r.frames);
  const speeds = [...new Set(r.frames.filter((x) => x.has).map((x) => x.speed))];
  expect(speeds, '前置:指示器 data-speed 应恒为 fast').toEqual(['fast']);
  expectTimeline(r.frames, analyseSwitch(r.frames, r.tRel));
  expectNoPageErrors(r.errors);
});

// ───────────────────────── 相邻回归 9–11 ─────────────────────────
test('行为9 回合里第一次出现：指示器没有 data-switch，出现后300ms内至少一个圆点离中心≥3px', async ({ page }) => {
  const r = await retryClean(page, async () => {
    const errors = collectPageErrors(page);
    await prepareLive(page, { key: 'b9', presets: R172_PRESETS, scenario: { events: [{ kind: 'thinking', text: 'R172 思考。' }] } });
    await expectZoomOne(page);
    await startFrames(page); // 先装采样器再发消息,才抓得到「第一次出现」
    await sendRound(page);
    await expectPhase(page, 'thinking');
    await page.waitForTimeout(1200);
    const frames = await stopFrames(page);
    const i0 = frames.findIndex((x) => x.has);
    const t0 = i0 >= 0 ? frames[i0].t : frames[0].t;
    return { frames, errors, win: [t0, t0 + 1000] };
  });
  logSeq('行为9', r.frames);
  const f = r.frames;
  const i0 = f.findIndex((x) => x.has);
  expect(i0, '前置:应采到状态行第一次出现指示器').toBeGreaterThanOrEqual(0);
  expect(f[i0].mode, '前置:没存过偏好 = 随机模式,指示器应带 data-loading-mode="random"').toBe('random');
  expect(f[i0].sw, `第一次出现的第一帧指示器不应有 data-switch 属性(实测 ${f[i0].sw})`).toBeNull();
  const win = f.filter((x, i) => i >= i0 && x.has && x.t <= f[i0].t + 300);
  expect(win.length, '前置:出现后 300ms 内应采到足够多的帧(≥ 10)').toBeGreaterThanOrEqual(10);
  const far = Math.max(...win.map(maxDist));
  expect(far, `出现后 300ms 内至少一个圆点应离指示器中心 ≥ 3px(实测最远 ${far.toFixed(2)}px)`).toBeGreaterThanOrEqual(3);
  expectNoPageErrors(r.errors);
});

test('行为10 固定样式不产生过渡：样式设为 orbit4，思考4.7秒→工具→思考，全程 data-style 恒为 orbit4 且从未出现 data-switch', async ({ page }) => {
  const phases = [{ kind: 'think', ms: 4700 }, { kind: 'tool', title: 'R172 工具甲', ms: 4500 }, { kind: 'think', ms: 3000 }];
  const r = await retryClean(page, () => playPhaseList(page, { key: 'b10', phases, presets: { 'cgui-loading-style': 'orbit4' } }));
  logSeq('行为10', r.frames);
  const withInd = r.frames.filter((x) => x.has);
  expect(withInd.length, '前置:应采到足够多带指示器的帧(≥ 600)').toBeGreaterThanOrEqual(600);
  const seenPhases = [...new Set(r.frames.map((x) => x.phase).filter(Boolean))];
  expect(seenPhases.includes('tool') && seenPhases.includes('thinking'), `前置:应经过思考与工具阶段(实测 ${JSON.stringify(seenPhases)})`).toBe(true);
  const styles = [...new Set(withInd.map((x) => x.style))];
  expect(styles, '全程 data-style 应恒为 orbit4').toEqual(['orbit4']);
  const marked = withInd.filter((x) => x.sw !== null);
  expect(marked.slice(0, 3).map((x) => `${x.phase}:data-switch=${x.sw}`), `固定样式从未应出现 data-switch(出现 ${marked.length} 帧)`).toEqual([]);
  expectNoPageErrors(r.errors);
});

test('行为11 减弱动画：思考4.7秒→工具，data-style 变成另一个 id、从未出现 data-switch，变化后300ms起圆点1.5秒内位置不变', async ({ page }) => {
  const r = await retryClean(page, async () => {
    const x = await playInPlace(page, { key: 'b11', reducedMotion: true, toolMs: 3500 });
    return x;
  });
  logSeq('行为11', r.frames);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), '前置:页面应处于「减弱动画」偏好').toBe(true);
  const a = analyseSwitch(r.frames, r.tRel);
  expect(a.iTool, '前置:放行后应观察到 data-live-phase=tool').toBeGreaterThanOrEqual(0);
  expect(a.jChange, `进入工具后 data-style 应变成另一个 id(旧 ${a.oldStyle})`).toBeGreaterThanOrEqual(0);
  const newStyle = r.frames[a.jChange].style;
  expect(ORBIT_IDS, `新 data-style(${newStyle})应是 16 个 id 之一`).toContain(newStyle);
  const marked = r.frames.filter((x) => x.sw !== null);
  expect(marked.slice(0, 3).map((x) => `${x.phase}:data-switch=${x.sw}`), `减弱动画下从未应出现 data-switch(出现 ${marked.length} 帧)`).toEqual([]);
  const t1 = r.frames[a.jChange].t;
  const win = r.frames.filter((x) => x.has && x.t >= t1 + 300 && x.t <= t1 + 1800);
  expect(win.length, '前置:变化后 300ms~1800ms 应采到足够多的帧(≥ 50)').toBeGreaterThanOrEqual(50);
  let maxMove = 0;
  for (const x of win) x.dots.forEach((d, k) => { maxMove = Math.max(maxMove, Math.hypot(d[0] - win[0].dots[k][0], d[1] - win[0].dots[k][1])); });
  expect(new Set(win.map((x) => x.dots.length)).size, '前置:窗口内圆点个数应不变').toBe(1);
  expect(maxMove, `静止帧:变化后 300ms 起 1.5 秒内每个圆点中心位移应 ≤ 0.05px(实测最大 ${maxMove.toFixed(3)}px,${newStyle})`).toBeLessThanOrEqual(0.05);
  expectNoPageErrors(r.errors);
});
