// r154-ui-live-line：生成中的底部状态行 / 指示器 / 文字流光 / 展开条目 / 子代理卡 / 加载动画设置。
// 判据全部来自 .devflow/r154-ui-live-line-接口.md 的「行为清单」L1–L15，只看页面上用户能看到的东西
// （接口文件列出的 data-* 锚点、公开文案、role、计算样式）；不读源码、不读 React state。
// 命名：Ln 对应接口文件行为清单第 n 条。
// r159：L9（总栏头行静态）测的是已按用户要求去掉的「总栏」，已退役；L10 里点总栏的步骤改用工作组头行；L12 的默认样式 / 顺序按「随机」新默认改写；
//       primeOverlays 默认预置 orbit3（L6 等按三体旋转写的判据不动）。
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';
import { touchCtl, primeOverlays, openApp } from './helpers/runtime.mjs';
import {
  LIVE, IND, SUBVIEW, stopBtn, openAllGates, startRound, endRound, liveSnap, expectOneLine, expectPhase, noObject,
  parseElapsed, watchElapsed, layoutFacts, bannedWordsOnPage, indicatorColor, accentRgb, setAccent, dotsMotion, distinct,
  measureDisplacement, shineSnap, isSolidText, loopingAnimations, openStripEntries, entryStates, agentCardFacts,
  installLineObserver, lineLog, stoppingRecords,
} from './helpers/live.mjs';

// 用例失败时直播回合会停在半路（假命令行在等放行文件）：把所有闸门都放了，让它自己收尾，别拖累下一条。
test.afterEach(async () => {
  try { openAllGates(); } catch { /* 忽略 */ }
});

/** 环境不成立：在报告里留痕（annotation + 控制台一行），不算失败。 */
function markBlocked(what) {
  const info = test.info();
  info.annotations.push({ type: 'ENVIRONMENT_BLOCKED', description: what });
  console.log(`[ENVIRONMENT_BLOCKED] ${info.title.split(' ')[0]}: ${what}`);
}

const STATE_ORDER = ['data-live-indicator', 'data-live-elapsed', 'data-live-sep', 'data-live-text'];
const PHASE_VERB = { connecting: '连接中', thinking: '思考', text: '正在输出', stopping: '停止中', compacting: '正在压缩上下文' };
const TOOL_VERBS = ['读取', '编辑', '写入', '运行', '搜索', '查找', '抓取', '联网搜索', '委派子代理', '更新任务清单', '调用技能', '调用'];
const thinkingOnly = (text) => ({ events: [{ kind: 'thinking', text }] });

test('L1 底部状态行：恰好 1 个、在最后、回合结束后消失且无残留', async ({ page }) => {
  const MARK = 'R154-L1-MARK';
  await startRound(page, {
    key: 'l1',
    scenario: { events: [
      { kind: 'thinking', text: 'L1 先想一想。' },
      { kind: 'tool', name: 'Bash', input: { command: 'ls', description: 'L1 工具' }, result: 'ok' },
      { kind: 'text', text: `${MARK} 正文` },
    ] },
  });
  await expectOneLine(page);
  await expect(page.getByText(MARK).first(), '前置自证：回合的正文应已画出来').toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  expect((await liveSnap(page)).count, '生成中（稳定 1.5 秒后）：页面里仍应恰好 1 个底部状态行').toBe(1);

  const facts = await layoutFacts(page, MARK);
  expect(facts.stripRoots, '前置自证：这一回合的过程条应存在').toBeGreaterThan(0);
  expect(facts.inMessageList, '状态行应在消息列表区域里').toBe(true);
  expect(facts.after, '状态行之后不得再有本回合的正文 / 过程条 / 子代理卡（它应是最后一个）').toEqual([]);

  await endRound(page);
  await expect.poll(async () => (await liveSnap(page)).count, { timeout: 15_000, message: '回合结束后：底部状态行应消失（0 个）' }).toBe(0);
  const residue = await page.evaluate(() => ({
    live: document.querySelectorAll('[data-live-line]').length,
    beam: document.querySelectorAll('[data-agent-beam]').length,
    entryLive: document.querySelectorAll('[data-entry-live]').length,
  }));
  expect(residue, '回合结束后消息列表里不应残留 [data-live-line] / [data-agent-beam] / [data-entry-live]').toEqual({ live: 0, beam: 0, entryLive: 0 });
  await expect(page.getByText(MARK).first(), '回合结束后：正文仍在（状态行消失不是因为整页被清掉）').toBeVisible();
});

test('L2 版式顺序、用时格式（Ns → Nm Ns、每秒走一次）、stopping 时 role="status"', async ({ page }) => {
  test.setTimeout(240_000);
  const sentAt = await startRound(page, {
    key: 'l2',
    scenario: { events: [{ kind: 'thinking', text: 'L2 思考内容。' }, { kind: 'text', text: 'R154-L2-MARK 正文' }] },
  });
  // 「停止中」只存在一瞬间（点停止 → 流被中断 → 回合一两百毫秒内收尾 → 状态行整行卸载），轮询抓不住：
  // 点停止之前先在页内装好观察器，回合收尾后再读它记下的快照。
  await installLineObserver(page);
  await expectOneLine(page);
  const s = await liveSnap(page);
  expect(s.order, '状态行子节点应按 指示器 → 用时 → 分隔符 → 状态词 的顺序各出现一次').toEqual(STATE_ORDER);
  expect(s.sep, '分隔符 [data-live-sep] 的文本应恰为 ·').toBe('·');
  expect(s.elapsed, '不满 60 秒时用时应是 Ns 格式（不是 0m Ns）').toMatch(/^\d+s$/);
  expect(Math.abs(parseElapsed(s.elapsed) - (Date.now() - sentAt) / 1000), '用时应从发出消息起算（与发送时刻相差不超过 4 秒）').toBeLessThanOrEqual(4);

  const log = await watchElapsed(page, 4500);
  const secs = log.map((x) => parseElapsed(x.text));
  const gaps = log.slice(2).map((x, i) => Math.round(x.t - log[i + 1].t));
  const badSteps = secs.slice(1).filter((v, i) => v !== secs[i] + 1);
  expect(log.length - 1, `4.5 秒内用时应至少走 3 次（每秒一次），实际读到 ${JSON.stringify(log.map((x) => x.text))}`).toBeGreaterThanOrEqual(3);
  expect(badSteps, `用时每次应恰好 +1 秒，实际序列 ${JSON.stringify(secs)}`).toEqual([]);
  expect(gaps.filter((g) => g < 700 || g > 1400), `相邻两次走字的间隔应约 1 秒（700–1400 毫秒），实际间隔 ${JSON.stringify(gaps)}`).toEqual([]);

  await expect.poll(async () => (await liveSnap(page)).elapsed, {
    timeout: 100_000, intervals: [1000], message: '约 60 秒后用时应切成「Nm Ns」格式（如 1m 5s）',
  }).toMatch(/^1m \d+s$/);
  const m = await liveSnap(page);
  expect(Math.abs(parseElapsed(m.elapsed) - (Date.now() - sentAt) / 1000), '1 分钟后用时仍应从发出消息起算（相差不超过 4 秒）').toBeLessThanOrEqual(4);

  await stopBtn(page).click();
  await endRound(page);
  const stopping = stoppingRecords(await lineLog(page)); // 一条 stopping 都没有 → 直接失败："没有观察到 stopping 阶段"
  expect(stopping.filter((r) => r.role !== 'status'), 'stopping 时状态行根节点应带 role="status"（下列 stopping 快照没带）').toEqual([]);
});

test('L3 思考 / 输出 / 连接中三种状态词与 data-live-phase，且页面里没有英文循环词', async ({ page }) => {
  await startRound(page, {
    key: 'l3',
    scenario: { events: [
      { kind: 'wait', file: 'g1' },
      { kind: 'thinking', text: 'L3 思考内容。' },
      { kind: 'wait', file: 'g2' },
      { kind: 'text', text: 'R154-L3-MARK 正文' },
    ] },
  });
  const banned = [];
  const scan = async (label) => { const hit = await bannedWordsOnPage(page); if (hit.length) banned.push(`${label}: ${hit.join(',')}`); };
  await scan('发出消息后立刻');
  await expectOneLine(page);
  await expectPhase(page, 'connecting');
  let s = await liveSnap(page);
  expect.soft(s.text, 'connecting：状态词应恰为「连接中」').toBe('连接中');
  expect.soft(s.verb, 'connecting：[data-live-verb] 应为「连接中」').toBe('连接中');
  expect.soft(noObject(s), 'connecting：不应有 object').toBe(true);
  await scan('connecting');

  touchCtl('g1');
  await expectPhase(page, 'thinking');
  s = await liveSnap(page);
  expect.soft(s.text, 'thinking：状态词应恰为「思考 · 最新一句思考」').toBe('思考 · L3 思考内容。');
  expect.soft(s.object, 'thinking：object 应是最新一句思考').toBe('L3 思考内容。');
  await scan('thinking');

  touchCtl('g2');
  await expectPhase(page, 'text');
  s = await liveSnap(page);
  expect.soft(s.text, 'text：状态词应恰为「正在输出」').toBe('正在输出');
  expect.soft(noObject(s), 'text：不应有 object').toBe(true);
  await scan('text');
  expect(banned, '页面里不得出现英文循环词（Frolicking 等）或 Connecting / Writing / Compacting').toEqual([]);
});

test('L4 工具状态词：工具标题（不带动词前缀）、取不到标题回落动词短语、并行取最后一个未返回的', async ({ page }) => {
  const P60 = '0123456789'.repeat(6);
  const CMD = `echo ${'abcdefghij'.repeat(8)}`;
  // 标题上限 60 个码点，超出补一个省略号（与 r152a 折叠行同一个 toolTitle）。
  const clipTitle = (s) => { const cps = Array.from(s); return cps.length > 60 ? cps.slice(0, 60).join('') + '…' : s; };
  // 子代理（Task）放在第 1 个：它是"最后被检查"的那个，不必在链条中途等它的结果被页面认作"已返回"（子代理卡的收尾另有机制，见 L11）。
  const TOOLS = [
    { name: 'Task', input: { subagent_type: 'general-purpose', description: 'L4 子代理委派', prompt: 'p' }, text: 'L4 子代理委派' },
    { name: 'Read', input: { file_path: '/a/b/c.txt' }, text: '读取 c.txt' },
    { name: 'Bash', input: { command: 'echo hi', description: 'L4 带描述的命令' }, text: 'L4 带描述的命令' },
    { name: 'Bash', input: { command: CMD }, text: clipTitle(CMD) },
    { name: 'Grep', input: { pattern: P60, path: '/p' }, text: clipTitle(`搜索 ${P60}`) },
    { name: 'Edit', input: { file_path: '/p/q/edit-me.js', old_string: 'a', new_string: 'b' }, text: '编辑 edit-me.js' },
    { name: 'Write', input: { file_path: '/p/q/new-file.md', content: 'x' }, text: '新建 new-file.md' },
    { name: 'Glob', input: { pattern: '**/*.md' }, text: '查找文件 **/*.md' },
    { name: 'WebFetch', input: { url: 'https://example.com/docs/x', prompt: 'p' }, text: '抓取 https://example.com/docs/x' },
    { name: 'WebSearch', input: { query: 'claude code hooks' }, text: '搜索网页 claude code hooks' },
    // 入参要给一个字段:空对象在流式语义里是"入参未到",那时底部行会沿用上一个工具的标题(新规则),不测这里。
    { name: 'mcp__srv__do_thing', input: { query: 'q' }, text: '调用 do_thing' },
    { name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending', activeForm: 'x' }] }, text: '更新任务清单' },
  ];
  await startRound(page, {
    key: 'l4',
    scenario: { events: [
      { kind: 'thinking', text: 'L4 思考。' },
      ...TOOLS.map((t, i) => ({ kind: 'tool', name: t.name, input: t.input, pending: `d${i + 1}` })),
    ] },
  });
  await expectOneLine(page);
  // 状态词 = object（工具标题）或 verb + 空格 + object；不得有前导 / 尾随空格。
  const consistent = (snap) => (snap.object ? (snap.verb ? `${snap.verb} ${snap.object}` : snap.object) : snap.verb);
  const problems = [];
  for (let i = TOOLS.length - 1; i >= 0; i -= 1) {
    const t = TOOLS[i];
    if (i < TOOLS.length - 1) touchCtl(`d${i + 2}`); // 放走后一个工具的结果 → 最后一个未返回的变成 i 号
    let snap = {};
    const t0 = Date.now();
    while (Date.now() - t0 < 8_000) {
      snap = await liveSnap(page);
      if (snap.phase === 'tool' && snap.text === t.text) break;
      await page.waitForTimeout(150);
    }
    const good = snap.phase === 'tool' && snap.text === t.text && snap.text === consistent(snap);
    if (!good) problems.push(`第 ${i + 1} 个工具 ${t.name}：期望 phase=tool、状态词「${t.text}」；实际 phase=${snap.phase}、状态词「${snap.text}」（verb=${snap.verb}，object=${snap.object}）`);
  }
  expect(problems, '并行工具：每一步都应显示"最后一个未返回的工具"的标题').toEqual([]);
});

test('L5 stopping（点停止后）与 compacting 状态词', async ({ page }) => {
  test.setTimeout(200_000);
  // —— 先试 compacting：用 Agent SDK 公开的 system/status:compacting 事件造；造不出来就标环境不成立 ——
  await startRound(page, {
    key: 'l5',
    scenario: { events: [
      { kind: 'thinking', text: 'L5 思考。' },
      { kind: 'raw', payload: { type: 'system', subtype: 'status', status: 'compacting' } },
    ] },
  });
  await expectOneLine(page);
  const reached = await expectPhase(page, 'compacting', { timeout: 10_000 }).then(() => true, () => false);
  if (reached) {
    const c = await liveSnap(page);
    expect.soft(c.text, 'compacting：状态词应恰为「正在压缩上下文」').toBe('正在压缩上下文');
    expect.soft(noObject(c), 'compacting：不应有 object').toBe(true);
  } else {
    const c = await liveSnap(page);
    markBlocked(`compacting 造不出来：假命令行发了 {type:"system",subtype:"status",status:"compacting"}（Agent SDK 公开的 SDKStatusMessage 形态），`
      + `10 秒内状态行的 data-live-phase 始终不是 compacting（实际 ${c.phase}）。接口文件没写"什么输入会触发压缩中"，无法区分"产品不认这个事件"和"没实现"。`);
  }
  await endRound(page);

  // —— stopping ——
  await startRound(page, {
    key: 'l5',
    scenario: { events: [
      { kind: 'thinking', text: 'L5 停止用思考。' },
      { kind: 'tool', name: 'Bash', input: { command: 'sleep 99', description: 'L5 一直不返回的工具' }, pending: 'd1' },
    ] },
    text: '请开始第二轮',
  });
  // 「停止中」只存在一瞬间（点停止 → 流被中断 → 回合一两百毫秒内收尾 → 状态行整行卸载），轮询抓不住：
  // 点停止之前先在页内装好观察器（上面又导航过一次，旧观察器已随旧文档消失，必须重装），回合收尾后再读它记下的快照。
  await installLineObserver(page);
  await expectOneLine(page);
  await expectPhase(page, 'tool');
  await stopBtn(page).click();
  await endRound(page);
  await expect.poll(async () => (await liveSnap(page)).count, { timeout: 15_000, message: '点停止并放行后：回合最终结束，状态行消失' }).toBe(0);
  const stopping = stoppingRecords(await lineLog(page)); // 一条 stopping 都没有 → 直接失败："没有观察到 stopping 阶段"
  expect(stopping.filter((r) => r.text !== '停止中').map((r) => r.text), 'stopping：状态词应恰为「停止中」（下列 stopping 快照的状态词不是）').toEqual([]);
  expect(stopping.filter((r) => r.verb !== '停止中').map((r) => r.verb), 'stopping：[data-live-verb] 应为「停止中」（下列 stopping 快照的 verb 不是）').toEqual([]);
  expect(stopping.filter((r) => r.hasObject === true).map((r) => r.object), 'stopping：不应有 object（下列 stopping 快照里出现了 [data-live-object]）').toEqual([]);
});

test('L6 指示器：颜色跟主题强调色、data-style / data-speed、在动、减弱动画下静止', async ({ page }) => {
  test.setTimeout(200_000);
  await startRound(page, { key: 'l6', scenario: thinkingOnly('L6 思考。') });
  await expectOneLine(page);
  const ind = page.locator(IND);
  await expect(ind, '状态行里应恰有 1 个指示器').toHaveCount(1);
  await expect(ind, '默认加载动画样式应是 orbit3').toHaveAttribute('data-style', 'orbit3');
  await expect(ind, '默认转速应是 slow').toHaveAttribute('data-speed', 'slow');
  expect(await ind.locator('i').count(), '三体旋转：指示器里应有 3 个 <i> 点').toBe(3);

  // 颜色跟主题强调色
  const a0 = await accentRgb(page);
  expect(a0.rgb, '前置自证：根元素上应有 --color-accent').not.toBeNull();
  expect(await indicatorColor(page), '默认主题下指示器颜色应等于主题强调色').toBe(a0.rgb);
  await setAccent(page, '#12a34a');
  const a1 = await accentRgb(page);
  expect(a1.rgb, '前置自证：改写根元素 --color-accent 后应算成 rgb(18, 163, 74)').toBe('rgb(18, 163, 74)');
  await expect.poll(() => indicatorColor(page), { timeout: 5_000, message: '改主题强调色后指示器颜色应跟着变成新强调色' }).toBe('rgb(18, 163, 74)');
  expect(await indicatorColor(page), '指示器颜色不得是写死的 rgb(217, 119, 87)').not.toBe('rgb(217, 119, 87)');

  // 在动 / 减弱动画下静止
  const moving = await dotsMotion(page);
  expect(distinct(moving.samples), '三体旋转：600 毫秒内点的 transform 应有变化（在动）').toBeGreaterThan(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  const still = await dotsMotion(page);
  expect(distinct(still.samples), '减弱动画：600 毫秒内点的 transform 应保持不变（静止）').toBe(1);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await endRound(page);

  // 四体旋转
  await startRound(page, { key: 'l6', scenario: thinkingOnly('L6 四体。'), presets: { 'cgui-loading-style': 'orbit4' }, text: '请开始第二轮' });
  await expectOneLine(page);
  await expect(ind, '预置 orbit4 后指示器 data-style 应为 orbit4').toHaveAttribute('data-style', 'orbit4');
  expect(await ind.locator('i').count(), '四体旋转：指示器里应有 4 个 <i> 点').toBe(4);
  const moving4 = await dotsMotion(page);
  expect(distinct(moving4.samples), '四体旋转：600 毫秒内点的 transform 应有变化（在动）').toBeGreaterThan(1);
});

test('L7 转速：「快」的位移总量大于「慢」', async ({ page }) => {
  test.setTimeout(200_000);
  const total = {};
  for (const speed of ['slow', 'fast']) {
    await startRound(page, {
      key: 'l7', scenario: thinkingOnly(`L7 ${speed}。`), text: `请开始 ${speed} 轮`,
      presets: { 'cgui-loading-style': 'orbit3', 'cgui-loading-speed': speed },
    });
    await expectOneLine(page);
    await expect(page.locator(IND), `预置 cgui-loading-speed=${speed} 后指示器 data-speed 应为 ${speed}`).toHaveAttribute('data-speed', speed);
    await page.waitForTimeout(600);
    total[speed] = await measureDisplacement(page, 1000);
    await endRound(page);
  }
  expect(total.slow.dots, '前置自证：三体旋转应有 3 个点').toBe(3);
  expect(total.slow.total, '慢档 1 秒内点应有位移（在动）').toBeGreaterThan(0);
  expect(total.fast.total, `快档 1 秒内点的位移总量应大于慢档（快 ${total.fast.total.toFixed(1)}px / ${total.fast.frames} 帧，慢 ${total.slow.total.toFixed(1)}px / ${total.slow.frames} 帧）`).toBeGreaterThan(total.slow.total);
});

test('L8 文字流光：只在状态词里、同一窗格最多 1 个、约 3 秒、减弱动画下纯色、结束后 0 个', async ({ page }) => {
  test.setTimeout(200_000);
  await startRound(page, {
    key: 'l8',
    scenario: { events: [
      { kind: 'thinking', text: 'L8 思考。' },
      { kind: 'wait', file: 'g1' },
      { kind: 'tool', name: 'Bash', input: { command: 'ls', description: 'L8 工具' }, pending: 'd1' },
      { kind: 'wait', file: 'g2' },
      { kind: 'text', text: 'R154-L8-MARK 正文' },
    ] },
  });
  await expectOneLine(page);
  const problems = [];
  const check = async (label) => {
    for (let k = 0; k < 3; k += 1) {
      const sh = await shineSnap(page);
      if (sh.count !== 1) problems.push(`${label}：带流光的元素应恰 1 个，实际 ${sh.count}`);
      if (sh.outside) problems.push(`${label}：有 ${sh.outside} 个流光元素不在 [data-live-text] 里`);
      sh.items.forEach((it) => {
        if (it.name === 'none') problems.push(`${label}：流光 animation-name 不应为 none`);
        if (!(it.duration >= 2.5 && it.duration <= 3.5)) problems.push(`${label}：流光 animation-duration 应约 3 秒，实际 ${it.durationRaw}`);
      });
      await page.waitForTimeout(300);
    }
  };
  await expectPhase(page, 'thinking');
  await check('thinking');
  touchCtl('g1');
  await expectPhase(page, 'tool');
  await check('tool');
  touchCtl('d1');
  touchCtl('g2');
  await expectPhase(page, 'text');
  await check('text');
  expect(problems, '生成中（各阶段）流光应只在状态词里、恰 1 个、动画名非 none、时长约 3 秒').toEqual([]);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  const reduced = await shineSnap(page);
  expect.soft(reduced.count, '减弱动画下状态词里的流光元素仍应只有 1 个').toBeLessThanOrEqual(1);
  for (const it of reduced.items) {
    expect.soft(it.name, '减弱动画：流光 animation-name 应为 none').toBe('none');
    expect.soft(isSolidText(it), `减弱动画：状态词文字应是纯色（填充 ${it.fill}，颜色 ${it.color}，背景 ${it.bgImage}，裁剪 ${it.clip}）`).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await endRound(page);
  await expect.poll(async () => (await shineSnap(page)).count, { timeout: 15_000, message: '回合结束后：带流光的元素应为 0 个' }).toBe(0);
});

test('L10 展开后的条目：工具条目 running→done（含 error）、思考条目 data-entry-live 只给最新一块、收起时无可见动画', async ({ page }) => {
  test.setTimeout(180_000);
  await startRound(page, {
    key: 'l10',
    scenario: { events: [
      { kind: 'thinking', text: 'L10 思考一。' },
      { kind: 'tool', name: 'Bash', input: { command: 'echo a', description: 'L10 工具甲' }, pending: 'd1' },
      { kind: 'tool', name: 'Bash', input: { command: 'echo b', description: 'L10 工具乙' }, result: 'ok' },
      { kind: 'tool', name: 'Bash', input: { command: 'false', description: 'L10 工具丙' }, result: '命令失败了', isError: true },
      { kind: 'thinking', text: 'L10 思考二（最新一块）。' },
      { kind: 'wait', file: 'g1' },
      { kind: 'text', text: 'R154-L10-MARK 正文' },
    ] },
  });
  await expect(page.locator('[data-live-line]'), '前置自证：生成中的状态行应画出来').toHaveCount(1, { timeout: 40_000 });
  await page.waitForTimeout(1500);
  // 夹具里有一条历史回合：它的过程条同样是 [data-strip-root]、同样有「思考 · N 次工具调用」组，条目也带 data-entry-state。
  // 这里只数本回合的：本回合的过程条 = 页面上最后一个 [data-strip-root]（历史回合排在它前面；r159 起总栏头行没了，不能再靠 live 头行去认）。
  // 趁回合还在生成中先按序号把它钉住，之后点开过程组 / 数条目 / 查动画 / 查 data-entry-live 都限定在它里面。
  const rootCount = await page.locator('[data-strip-root]').count();
  expect(rootCount, '前置自证：应有本回合的过程条 [data-strip-root]').toBeGreaterThanOrEqual(1);
  const scope = page.locator('[data-strip-root]').nth(rootCount - 1);
  const opened = await openStripEntries(page, '[data-entry-state]', 6_000, scope);
  expect(opened, '展开过程条后：应有带 data-entry-state 的工具条目').toBe(true);
  await expect.poll(() => entryStates(page, scope), { timeout: 10_000, message: '本回合三个工具条目的状态应依次是 running / done / error（甲没结果、乙有结果、丙出错）' }).toEqual(['running', 'done', 'error']);

  // running 条目里有循环动画（强调色小圆环）；done / error 没有；减弱动画下 running 也没有
  const entries = scope.locator('[data-entry-state]');
  expect.soft((await loopingAnimations(entries.nth(0))).length, 'running 条目里应有循环动画（强调色小圆环，动画名非 none）').toBeGreaterThan(0);
  expect.soft(await loopingAnimations(entries.nth(1)), 'done 条目里不应有循环动画').toEqual([]);
  expect.soft(await loopingAnimations(entries.nth(2)), 'error 条目里不应有循环动画').toEqual([]);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  expect.soft(await loopingAnimations(entries.nth(0)), '减弱动画下 running 条目里的动画应为 none').toEqual([]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // 思考条目：最新一块思考（它后面没有别的块）才带 data-entry-live="true"
  await expect.poll(async () => await scope.locator('[data-entry-live]').count(), { timeout: 10_000, message: '本回合过程条里：最新一块思考后面还没有别的块，data-entry-live 应恰 1 个' }).toBe(1);
  expect.soft(await scope.locator('[data-entry-live]:not([data-entry-live="true"])').count(), '只有最新思考块带该属性，且值为 true；其它思考条目不带').toBe(0);
  const liveAfterTools = await scope.evaluate((root) => {
    const live = root.querySelector('[data-entry-live]');
    const tools = [...root.querySelectorAll('[data-entry-state]')];
    const last = tools[tools.length - 1];
    return !!(live && last && (last.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect.soft(liveAfterTools, '带 data-entry-live 的应是排在最后一个工具条目之后的那块思考（最新一块）').toBe(true);

  // 收起时（条目 hidden）没有任何可见的运行中动画——此刻甲还没结果
  // r159:总栏已去掉，收起 / 展开改用承载状态行的工作组自己的头行 [data-work-group-head]（本回合最后一个组）。
  const groupHead = scope.locator('[data-work-group-head]').last();
  if ((await groupHead.getAttribute('aria-expanded')) === 'true') await groupHead.click();
  await expect(groupHead, '前置自证：收起承载状态行的工作组后头行应为 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');
  // r157:实时状态行挂在最后一个工作组的头行里,组收起后它按设计仍可见,它自带的流光不算「条目动画」;
  // 条目(运行中的小圆环、思考图标的呼吸)收起后必须不可见——承载状态行的组此时只剩头行。
  expect.soft(await loopingAnimations(scope, { visibleOnly: true, exclude: '[data-live-line]' }), '过程条收起时其中不应有任何可见的运行中动画（承载状态行的头行自带的流光除外）').toEqual([]);
  await groupHead.click();
  await expect(groupHead, '再点一次应展开').toHaveAttribute('aria-expanded', 'true');

  // 思考二后面出现正文 → 它不再是最新一块
  touchCtl('g1');
  await expect.poll(async () => await scope.locator('[data-entry-live]').count(), { timeout: 15_000, message: '本回合过程条里：思考后面出现别的块之后，data-entry-live 应为 0 个' }).toBe(0);
  // 甲拿到结果 → running → done
  touchCtl('d1');
  await openStripEntries(page, '[data-entry-state]', 6_000, scope);
  await expect.poll(() => entryStates(page, scope), { timeout: 15_000, message: '甲拿到结果后：本回合三个条目应是 done / done / error' }).toEqual(['done', 'done', 'error']);
});

test('L11 子代理卡：运行中有九宫格 + 8 层边框光，结束 / 出错 / 停止后都没有，减弱动画下边框光隐藏', async ({ page }) => {
  test.setTimeout(180_000);
  const sub = (name, description) => ({ kind: 'tool', name, input: { subagent_type: 'general-purpose', description, prompt: '做点事' } });
  await startRound(page, {
    key: 'l11',
    scenario: { events: [
      { kind: 'thinking', text: 'L11 思考。' },
      { ...sub('Task', 'L11 子代理甲'), pending: 'd1' },
      { ...sub('Agent', 'L11 子代理乙'), pending: 'd2', isError: true, result: '子代理出错了' },
      { ...sub('Task', 'L11 子代理丙'), pending: 'd3' },
      { kind: 'text', text: 'R154-L11-MARK 正文' },
    ] },
  });
  for (const t of ['甲', '乙', '丙']) {
    await expect.poll(async () => (await agentCardFacts(page, `L11 子代理${t}`)).present, { timeout: 40_000, message: `前置自证：子代理卡「${t}」应画出来` }).toBe(true);
  }
  await page.waitForTimeout(1000);
  for (const t of ['甲', '乙', '丙']) {
    const f = await agentCardFacts(page, `L11 子代理${t}`);
    expect.soft(f.matrix, `运行中（${t}）：应有 1 个 [data-agent-icon="matrix"]`).toBe(1);
    expect.soft(f.matrixRects, `运行中（${t}）：九宫格内应有 8 个 rect`).toEqual([8]);
    expect.soft(f.beams, `运行中（${t}）：卡片内应有 1 个 [data-agent-beam]`).toBe(1);
    expect.soft(f.beamRects, `运行中（${t}）：边框光内应有 8 个 rect`).toEqual([8]);
    expect.soft(f.beamLayers, `运行中（${t}）：边框光内应有 8 个 [data-beam-layer]`).toEqual([8]);
  }

  // 减弱动画：边框光隐藏（display none 或不存在），九宫格静止
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  const reduced = await agentCardFacts(page, 'L11 子代理丙');
  expect.soft(reduced.beamDisplay.every((d) => d === 'none'), `减弱动画下边框光计算 display 应为 none（实际 ${JSON.stringify(reduced.beamDisplay)}）`).toBe(true);
  const matrices = page.locator('[data-agent-icon="matrix"]');
  for (let i = 0; i < await matrices.count(); i += 1) {
    expect.soft(await loopingAnimations(matrices.nth(i)), `减弱动画下九宫格应静止（第 ${i + 1} 个）`).toEqual([]);
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // 收尾：甲的结果、乙的出错结果到达，丙一直没有结果、点停止。
  // 只断言回合结束后的终态——假命令行发的 tool_result 到达后，子代理卡在回合进行中不会自己切走"运行中"（改动前的页面就是这样：
  // 实测结果到达 3 分钟后卡片仍标「运行中」），所以"回合中途完成 / 出错就切换"没法用假命令行验证，只验"结束后三张卡都没有"。
  touchCtl('d1');
  touchCtl('d2');
  await stopBtn(page).click();
  await endRound(page);
  for (const [t, state] of [['甲', '完成'], ['乙', '出错'], ['丙', '已停止']]) {
    const f = await agentCardFacts(page, `L11 子代理${t}`);
    expect.soft(f.present, `前置自证：回合结束后「${t}」的卡片仍应在页面里`).toBe(true);
    expect.soft([f.matrix, f.beams], `${state}（${t}）：九宫格与边框光都应不存在`).toEqual([0, 0]);
  }
  expect(await page.locator('[data-agent-beam]').count(), '回合结束后整页不应残留 [data-agent-beam]').toBe(0);
});

/** 主题弹层 →「界面」页。 */
async function openInterfaceTab(page) {
  await page.locator('[data-cgui="theme-btn"]').click();
  await page.getByRole('tab', { name: '界面' }).click();
  await expect(page.getByText('加载动画').first(), '前置自证：「界面」页应有「加载动画」分组').toBeVisible({ timeout: 10_000 });
}
const isSelected = (loc) => loc.evaluate((el) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-selected') === 'true');

test('L12 主题 →「界面」页：random 第一、orbit3 / orbit4 紧随，全新存储时 random 选中，转速三项默认「慢」选中', async ({ page }) => {
  await primeOverlays(page, { 'cgui-loading-style': null }); // r159：这条要的是全新存储——撤掉默认预置的 orbit3
  await openApp(page);
  await openInterfaceTab(page);
  const options = page.locator('[data-loading-option]');
  await expect(options.first(), '「界面」页应有加载动画选项 [data-loading-option]').toBeVisible({ timeout: 10_000 });
  const ids = await options.evaluateAll((els) => els.map((e) => e.getAttribute('data-loading-option')));
  // r159：网格最前面多了「随机」(random)，orbit3 / orbit4 紧随其后。
  expect(ids[0], `random 应排在所有选项最前（实际第一项 ${JSON.stringify(ids[0])}）`).toBe('random');
  expect(ids.slice(1, 3).sort(), `orbit3 / orbit4 应紧随 random 排在前面（实际第 2、3 项 ${JSON.stringify(ids.slice(1, 3))}）`).toEqual(['orbit3', 'orbit4']);
  await expect(page.locator('[data-loading-option="orbit3"]'), 'orbit3 的文字应含「三体旋转」').toContainText('三体旋转');
  await expect(page.locator('[data-loading-option="orbit4"]'), 'orbit4 的文字应含「四体旋转」').toContainText('四体旋转');
  await expect(page.locator('[data-loading-option="cli"]'), '既有选项 cli 仍在，文字含「CLI」').toContainText('CLI');
  expect(await isSelected(page.locator('[data-loading-option="random"]')), '全新存储时 random 应是选中态（aria-checked 或 data-selected）').toBe(true);
  expect(await isSelected(page.locator('[data-loading-option="cli"]')), '全新存储时 cli 不应是选中态').toBe(false);

  const group = page.locator('[role="radiogroup"]').filter({ has: page.locator('[data-loading-speed]') });
  await expect(group, '应有 1 个转速单选组（role=radiogroup，内含 [data-loading-speed]）').toHaveCount(1);
  const radios = group.getByRole('radio');
  expect(await radios.count(), '转速单选组里应有 3 个 role=radio').toBe(3);
  expect(await radios.evaluateAll((els) => els.map((e) => (e.textContent || '').trim())), '转速三项文字依次应是 慢 / 标准 / 快').toEqual(['慢', '标准', '快']);
  expect(await radios.evaluateAll((els) => els.map((e) => e.getAttribute('data-loading-speed'))), '转速三项锚点依次应是 slow / normal / fast').toEqual(['slow', 'normal', 'fast']);
  expect(await radios.evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked'))), '全新存储时转速「慢」应为 aria-checked=true，其余 false').toEqual(['true', 'false', 'false']);
});

test('L13 设置生效并持久化：点「快」、选 ring、非法转速回落 slow', async ({ page }) => {
  test.setTimeout(200_000);
  await startRound(page, { key: 'l13', scenario: thinkingOnly('L13 思考。') });
  await expectOneLine(page);
  await openInterfaceTab(page);
  const fast = page.locator('[data-loading-speed="fast"]');
  await expect(fast, '「界面」页应有转速「快」[data-loading-speed="fast"]').toHaveCount(1, { timeout: 10_000 });
  await fast.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cgui-loading-speed')), { timeout: 5_000, message: '点「快」后 localStorage["cgui-loading-speed"] 应为 fast' }).toBe('fast');
  await expect.poll(async () => (await liveSnap(page)).indicator?.speed ?? null, { timeout: 8_000, message: '点「快」后底部状态行的指示器 data-speed 应变成 fast' }).toBe('fast');
  const ring = page.locator('[data-loading-option="ring"]');
  await expect(ring, '「界面」页应有既有选项 ring').toHaveCount(1);
  await ring.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cgui-loading-style')), { timeout: 5_000, message: '选 ring 后 localStorage["cgui-loading-style"] 应为 ring' }).toBe('ring');
  await expect.poll(async () => (await liveSnap(page)).indicator?.style ?? null, { timeout: 8_000, message: '选 ring 后底部状态行里指示器的 data-style 应为 ring' }).toBe('ring');
  await page.keyboard.press('Escape');
  await endRound(page);

  // 非法转速回落 slow
  await startRound(page, {
    key: 'l13', scenario: thinkingOnly('L13 非法转速。'), text: '请开始第二轮',
    presets: { 'cgui-loading-style': 'orbit3', 'cgui-loading-speed': 'turbo' },
  });
  await expectOneLine(page);
  await expect.poll(async () => (await liveSnap(page)).indicator?.speed ?? null, { timeout: 8_000, message: '非法 cgui-loading-speed=turbo 应回落为 slow（指示器 data-speed）' }).toBe('slow');
});

test('L14 已经选过样式的人不被改：预置 ring / cli 后指示器 data-style 保持', async ({ page }) => {
  test.setTimeout(200_000);
  for (const style of ['ring', 'cli']) {
    await startRound(page, {
      key: 'l14', scenario: thinkingOnly(`L14 ${style}。`), text: `请开始 ${style} 轮`,
      presets: { 'cgui-loading-style': style },
    });
    await expectOneLine(page);
    await expect(page.locator(IND), `预置 cgui-loading-style=${style} 后生成中的指示器 data-style 应保持 ${style}（不是 orbit3）`).toHaveAttribute('data-style', style);
    expect(await page.evaluate(() => localStorage.getItem('cgui-loading-style')), `打开页面后 localStorage 里的样式仍应是 ${style}`).toBe(style);
    await endRound(page);
  }
});

test('L15 子代理视图：底部同样有 [data-live-line]，版式与状态词规则一致', async ({ page }) => {
  await startRound(page, {
    key: 'l15',
    scenario: { events: [
      { kind: 'thinking', text: 'L15 思考。' },
      { kind: 'tool', name: 'Task', input: { subagent_type: 'general-purpose', description: 'L15 子代理任务', prompt: '做点事' }, pending: 'd1' },
      { kind: 'text', text: 'R154-L15-MARK 正文' },
    ] },
  });
  // r157:子代理调用进了工作组(运行中默认收起)——先点开带这个子代理标题的那个组(夹具会话里有历史回合,不能按「最后一个」点),再按组内条目找子代理卡
  await page.locator('[data-work-group-head]').filter({ hasText: 'L15 子代理任务' }).first().click({ timeout: 40_000 });
  const card = page.locator('[data-entry-state]').filter({ hasText: 'L15 子代理任务' }).first();
  await expect(card, '前置自证：运行中的子代理卡应画出来（点开工作组后）').toHaveCount(1, { timeout: 40_000 });
  await card.hover();
  await card.locator('[title="在子代理会话窗口打开"]').click();
  await expect(page.locator(SUBVIEW), '前置自证：点「在子代理会话窗口打开」应出现子代理视图').toHaveCount(1, { timeout: 15_000 });

  await expectOneLine(page, { scope: SUBVIEW, message: '子代理视图里应恰好有 1 个底部状态行 [data-live-line]' });
  const s = await liveSnap(page, SUBVIEW);
  expect(s.order, '子代理视图的状态行：子节点顺序应是 指示器 → 用时 → 分隔符 → 状态词').toEqual(STATE_ORDER);
  expect(s.sep, '子代理视图的状态行：分隔符文本应恰为 ·').toBe('·');
  expect(s.elapsed, '子代理视图的状态行：用时应是 Ns 或 Nm Ns 格式').toMatch(/^(\d+s|\d+m \d+s)$/);
  expect(Object.keys(PHASE_VERB).concat('tool'), `data-live-phase 应是约定取值之一（实际 ${s.phase}）`).toContain(s.phase);
  if (s.phase === 'tool') {
    // 工具阶段：标题在 object 里（verb 为空）；取不到标题才回落动词短语（verb 非空、object 为空）。
    expect(s.verb === null || s.verb === '' || TOOL_VERBS.includes(s.verb), `tool 阶段的 verb 应为空或约定的工具动词之一（实际 ${s.verb}）`).toBe(true);
    expect(s.text, 'tool 阶段状态词 = object（工具标题）或 verb + 空格 + object').toBe(s.object ? (s.verb ? `${s.verb} ${s.object}` : s.object) : s.verb);
  } else if (s.phase === 'thinking') {
    expect(s.verb, 'thinking 阶段 verb 应为「思考」').toBe('思考');
    expect(s.text, 'thinking 阶段状态词 =「思考」或「思考 · 预览」').toBe(s.object ? `思考 · ${s.object}` : '思考');
  } else {
    expect(s.text, `${s.phase} 阶段状态词应恰为「${PHASE_VERB[s.phase]}」`).toBe(PHASE_VERB[s.phase]);
    expect(noObject(s), `${s.phase} 阶段不应有 object`).toBe(true);
  }
  expect(await bannedWordsOnPage(page, SUBVIEW), '子代理视图里不得出现英文循环词 / Connecting / Writing / Compacting').toEqual([]);
});
