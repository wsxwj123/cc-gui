// r201-steer-live-line 验收:页面处在「重新接上」状态时,实时行([data-live-line])必须始终是这一轮在对话区里的最后一样内容。
// 只通过页面观测(DOM 先后顺序,一次 page.evaluate 读完);假命令行与夹具见 helpers/。每条用例新建工作区,结束(含失败)都让假命令行尽快收尾。
import { test as base, expect } from '@playwright/test';
import { seedWorkspace, readStage, abortRound, writtenFlagExists } from './helpers/fixtures.mjs';
import { reloadApp, openWorkspaceGroup, clickSession, openNewSession, sendText, stopBtn, messageList, waitStage, waitStopGone, uniqueTag, composerBox } from './helpers/runtime.mjs';
import { snap, seqLine } from './helpers/observe.mjs';

const SCRIPTS = {
  // L1 / L2 / L7:工具 1 在收到并入后再挂 6.5 秒才返回;之后的段落缩短,整轮约 20 秒内收尾
  steerHold: { tool1Hold: 'steer', afterSteerMs: 6500, p1Count: 20, p1Ms: 250, p1bCount: 8, p1bMs: 250, tool2Ms: 1000, p2Count: 12, p2Ms: 250 },
  // L3:工具 1 约 1.5 秒返回 → 约 40 秒长思考 → 一小段正文 → 工具 2 挂 20 秒
  longThinking: { tool1Hold: 1500, p1Kind: 'thinking', p1Count: 160, p1Ms: 250, p1bCount: 8, p1bMs: 250, tool2Ms: 20_000, p2Count: 8, p2Ms: 250 },
  // L4:正文 → 工具 1 → 正文 → 工具 2 → 约 20 秒长正文
  longTail: { tool1Hold: 1500, p1Kind: 'text', p1Count: 40, p1Ms: 250, p1bCount: 8, p1bMs: 250, tool2Ms: 1500, p2Count: 80, p2Ms: 250 },
  // L5:一直看着并入,直到第二个工具调出
  watching: { tool1Hold: 'steer', afterSteerMs: 1500, p1Count: 40, p1Ms: 250, p1bCount: 8, p1bMs: 250, tool2Ms: 3000, p2Count: 8, p2Ms: 250 },
  // L6:工具 1 一直挂着(夹具收尾文件会让它结束)
  toolHang: { tool1Hold: 'gate' },
};

const test = base.extend({
  scriptName: ['steerHold', { option: true }],
  ctx: async ({ scriptName }, use) => {
    const ctx = seedWorkspace(uniqueTag('t'), SCRIPTS[scriptName]);
    await use(ctx);
    abortRound(ctx.workspaceName);
  },
});

// ───────────────────────── 操作 ─────────────────────────
async function steerByKey(page, text) {
  const box = composerBox(page).last();
  await box.fill(text);
  await box.press('ControlOrMeta+Enter');
}

async function steerByQueueButton(page, text) {
  const box = composerBox(page).last();
  await box.fill(text);
  await box.press('Enter');
  const btn = page.getByRole('button', { name: /并入/ });
  await expect(btn.first(), '回车后排队栏里应出现「⚡ 并入」按钮').toBeVisible({ timeout: 10_000 });
  await btn.first().click();
}

/** 新会话发一条消息,等到假命令行出完第一段正文并调出工具 1。 */
async function startRound(page, ctx, untilStage) {
  await openNewSession(page, ctx);
  await sendText(page, `请开始 ${uniqueTag('M')}`);
  await expect(stopBtn(page), '发出消息后应看到停止键').toBeVisible({ timeout: 20_000 });
  await waitStage(page, ctx, untilStage, 30_000);
}

/** 刷新页面 → 展开工作区 → 点开这条新会话,直到停止键出现(= 重新接上)。 */
async function reattach(page, ctx) {
  await reloadApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'fresh', ctx);
  await expect(stopBtn(page), '重开后应再次出现停止键(回合仍在跑)').toBeVisible({ timeout: 20_000 });
  await expect(messageList(page), '重开后对话区应显示').toBeVisible({ timeout: 20_000 });
}

// ───────────────────────── 判据 ─────────────────────────
const CONTENT_KINDS = ['P0', 'P1', 'P1B', 'P2', 'S', 'STEER', 'MSG'];

/** 一次观察里违反「实时行是最后一样内容」的地方;没有违反返回 null。 */
function liveLineProblem(s, { requireLive = true, requireAfterSteer = true } = {}) {
  const ks = (s.seq || []).map((x) => x.k);
  const iLive = ks.lastIndexOf('LIVE');
  if (iLive < 0) return requireLive ? '对话区里没有实时行' : null;
  const iSteer = ks.lastIndexOf('STEER');
  if (requireAfterSteer && iSteer >= 0 && iLive < iSteer) return '实时行排在「已并入」气泡之前';
  const below = ks.slice(iLive + 1).filter((k) => CONTENT_KINDS.includes(k));
  if (below.length) return `实时行之后还有内容:${below.join(',')}`;
  return null;
}

/** 轮询直到页面里出现「已并入」气泡(并入被接受后立即画出)。 */
async function waitSteerBubble(page, steerText, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await snap(page, steerText);
    if ((s.seq || []).some((x) => x.k === 'STEER')) return s;
    if (Date.now() > end) throw new Error(`${timeoutMs}ms 内页面没有画出「已并入」气泡;最后一次读数 = ${seqLine(s)}`);
    await page.waitForTimeout(200);
  }
}

/** 每 0.4 秒一次观察,直到 keepGoing() 为假或超过 maxMs。每条样本记下读数时的阶段。 */
async function observe(page, ctx, steerText, keepGoing, maxMs = 80_000) {
  const samples = [];
  const t0 = Date.now();
  for (;;) {
    const stage = readStage(ctx.workspaceName);
    if (!keepGoing(stage)) break;
    const s = await snap(page, steerText);
    s.stage = stage;
    s.dt = Date.now() - t0;
    samples.push(s);
    if (Date.now() - t0 > maxMs) break;
    await page.waitForTimeout(400);
  }
  return samples;
}

function problemsOf(samples, opts) {
  return samples
    .map((s) => ({ s, p: liveLineProblem(s, opts) }))
    .filter((x) => x.p)
    .map((x) => `+${x.s.dt}ms ${x.p} | ${seqLine(x.s)}`);
}

// ───────────────────────── 复现条 ─────────────────────────
test.describe('r201 实时行位置', () => {
  test.use({ scriptName: 'steerHold' });

  test('L1【复现】刷新后重开、工具在跑时 Cmd/Ctrl+Enter 并入:实时行始终在「已并入」气泡之后且是最后一样', async ({ page, ctx }) => {
    await startRound(page, ctx, 'tool1-sent');
    await page.waitForTimeout(800);
    await reattach(page, ctx);
    await page.waitForTimeout(1500);
    const steer = `R201L-STEERMSG-${uniqueTag('s')}`;
    await steerByKey(page, steer);
    await waitSteerBubble(page, steer);
    const samples = await observe(page, ctx, steer, (st) => st === 'tool1-sent');
    expect(samples.length, '并入气泡出现到工具返回之间应至少有 8 次观察(工具在并入后挂 6.5 秒)').toBeGreaterThanOrEqual(8);
    expect(problemsOf(samples), '工具返回前每一次观察实时行都应在「已并入」气泡之后、且之后没有任何内容').toEqual([]);
  });

  test('L2【复现】刷新后重开、回车进排队栏再点「⚡ 并入」:实时行始终在「已并入」气泡之后且是最后一样', async ({ page, ctx }) => {
    await startRound(page, ctx, 'tool1-sent');
    await page.waitForTimeout(800);
    await reattach(page, ctx);
    await page.waitForTimeout(1500);
    const steer = `R201L-STEERMSG-${uniqueTag('s')}`;
    await steerByQueueButton(page, steer);
    await waitSteerBubble(page, steer);
    const samples = await observe(page, ctx, steer, (st) => st === 'tool1-sent');
    expect(samples.length, '并入气泡出现到工具返回之间应至少有 8 次观察(工具在并入后挂 6.5 秒)').toBeGreaterThanOrEqual(8);
    expect(problemsOf(samples), '工具返回前每一次观察实时行都应在「已并入」气泡之后、且之后没有任何内容').toEqual([]);
  });

  test.describe('长思考', () => {
    test.use({ scriptName: 'longThinking' });

    test('L3【复现】刷新后重开、模型长思考时并入,第二个工具在跑期间:实时行在「已并入」气泡之后且是最后一样', async ({ page, ctx }) => {
      await startRound(page, ctx, 'p1-streaming');
      await page.waitForTimeout(2000);
      await reattach(page, ctx);
      await page.waitForTimeout(1500);
      expect(readStage(ctx.workspaceName), '并入时模型应仍在写长思考').toBe('p1-streaming');
      const steer = `R201L-STEERMSG-${uniqueTag('s')}`;
      await steerByKey(page, steer);
      await waitSteerBubble(page, steer);
      await waitStage(page, ctx, 'tool2-sent', 60_000);
      const samples = await observe(page, ctx, steer, (st) => st === 'tool2-sent');
      expect(samples.length, '第二个工具挂 20 秒,应至少有 15 次观察').toBeGreaterThanOrEqual(15);
      expect(samples.filter((s) => (s.seq || []).some((x) => x.k === 'STEER')).length, '第二个工具在跑期间应能看到「已并入」气泡').toBeGreaterThanOrEqual(10);
      expect(problemsOf(samples), '第二个工具在跑期间每一次观察实时行都应在「已并入」气泡之后、且之后没有任何内容').toEqual([]);
    });
  });

  test.describe('长正文', () => {
    test.use({ scriptName: 'longTail' });

    test('L4【复现】刷新后重开、不并入,工具 2 返回后写长正文期间:实时行在这段正文已显示的文字之后', async ({ page, ctx }) => {
      await openNewSession(page, ctx);
      await sendText(page, `请开始 ${uniqueTag('M')}`);
      await expect(stopBtn(page), '发出消息后应看到停止键').toBeVisible({ timeout: 20_000 });
      await waitStage(page, ctx, 'p1-streaming', 30_000);
      await page.waitForTimeout(2000);
      expect(readStage(ctx.workspaceName), '刷新时应在第一段正文之后、工具 2 之前').toBe('p1-streaming');
      await reattach(page, ctx);
      await waitStage(page, ctx, 'p2-streaming', 40_000); // 工具 2 返回后立即进入长正文(tool2-returned 只停留一瞬,轮询抓不到)
      const samples = await observe(page, ctx, '', () => !writtenFlagExists(ctx.workspaceName, 'P2') && !['done', 'stopped', 'aborted'].includes(readStage(ctx.workspaceName)), 40_000);
      expect(samples.length, '长正文约 20 秒,应至少有 20 次观察').toBeGreaterThanOrEqual(20);
      expect(samples.filter((s) => (s.seq || []).some((x) => x.k === 'P2')).length, '观察期间应能看到长正文已显示的文字').toBeGreaterThanOrEqual(10);
      expect(problemsOf(samples), '工具 2 返回后每一次观察实时行之后都不应有正文').toEqual([]);
    });
  });
});

// ───────────────────────── 守卫条 ─────────────────────────
test.describe('r201 守卫', () => {
  test.describe('一直看着', () => {
    test.use({ scriptName: 'watching' });

    test('L5【守卫】一直看着(不刷新)、工具在跑时 Cmd/Ctrl+Enter 并入,直到第二个工具调出:实时行之后没有内容', async ({ page, ctx }) => {
      await startRound(page, ctx, 'tool1-sent');
      const steer = `R201L-STEERMSG-${uniqueTag('s')}`;
      await steerByKey(page, steer);
      await waitSteerBubble(page, steer);
      const samples = await observe(page, ctx, steer, (st) => ['tool1-sent', 'tool1-returned', 'p1-streaming', 'p1b-streaming'].includes(st));
      expect(readStage(ctx.workspaceName), '观察应一直持续到第二个工具调出').toMatch(/^(tool2-sent|tool2-returned|p2-streaming|done)$/);
      expect(samples.length, '到第二个工具调出前应至少有 10 次观察').toBeGreaterThanOrEqual(10);
      expect(samples.filter((s) => (s.seq || []).some((x) => x.k === 'LIVE')).length, '观察期间应有实时行').toBeGreaterThanOrEqual(8);
      expect(problemsOf(samples, { requireLive: false, requireAfterSteer: true }), '每一次观察实时行之后都没有正文、思考或「已并入」气泡').toEqual([]);
    });
  });

  test.describe('刷新后工具在跑', () => {
    test.use({ scriptName: 'toolHang' });

    test('L6【守卫】刷新后重开、不并入、工具在跑:恰有 1 个实时行,它之后没有内容', async ({ page, ctx }) => {
      await startRound(page, ctx, 'tool1-sent');
      await page.waitForTimeout(800);
      await reattach(page, ctx);
      // 等实时行出现(重新接上后一小会儿才画)
      const end = Date.now() + 15_000;
      let first;
      for (;;) {
        first = await snap(page, '');
        if ((first.lives || []).length > 0 || Date.now() > end) break;
        await page.waitForTimeout(200);
      }
      const samples = await observe(page, ctx, '', (st) => st === 'tool1-sent', 3500);
      samples.unshift({ ...first, dt: 0, stage: 'tool1-sent' });
      expect(samples.length, '应至少有 6 次观察').toBeGreaterThanOrEqual(6);
      expect(samples.map((s) => (s.lives || []).length), '每一次观察对话区里都恰有 1 个实时行').toEqual(samples.map(() => 1));
      expect(problemsOf(samples), '每一次观察实时行之后都没有正文、思考或「已并入」气泡').toEqual([]);
    });
  });

  test.describe('并入被吸收后', () => {
    test.use({ scriptName: 'steerHold' });

    test('L7【守卫】L1 的会话并入被吸收、这一轮结束后:「已并入」气泡恰 1 个,前有第一段正文、后有最后一段正文,没有实时行', async ({ page, ctx }) => {
      await startRound(page, ctx, 'tool1-sent');
      await page.waitForTimeout(800);
      await reattach(page, ctx);
      await page.waitForTimeout(1500);
      const steer = `R201L-STEERMSG-${uniqueTag('s')}`;
      await steerByKey(page, steer);
      await waitSteerBubble(page, steer);
      await waitStage(page, ctx, 'done', 75_000);
      expect(await waitStopGone(page, 20_000), '这一轮结束后停止键应消失').toBe(true);
      // 页面重读历史后稳定下来
      await page.waitForTimeout(3000);
      const s = await snap(page, steer);
      const ks = (s.seq || []).map((x) => x.k);
      expect(s.steerCount, `对话区里「已并入」气泡应恰好 1 个;读数 = ${seqLine(s)}`).toBe(1);
      expect(ks.includes('P0'), `应显示模型的第一段正文;读数 = ${seqLine(s)}`).toBe(true);
      expect(ks.includes('P2'), `应显示模型最后写的那段正文;读数 = ${seqLine(s)}`).toBe(true);
      const iSteer = ks.indexOf('STEER');
      expect(ks.indexOf('P0'), `第一段正文应在「已并入」气泡之前;读数 = ${seqLine(s)}`).toBeLessThan(iSteer);
      expect(ks.lastIndexOf('P2'), `最后一段正文应在「已并入」气泡之后;读数 = ${seqLine(s)}`).toBeGreaterThan(iSteer);
      expect(s.lives.length, '回合结束后对话区里不应有实时行').toBe(0);
    });
  });
});
