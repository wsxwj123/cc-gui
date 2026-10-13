// r148 性能验收(黑盒,数得出来的量)。只由 run.sh 调起:tests/acceptance/r148-perf/run.sh [-g 'P2']
// 依据:.devflow/BRIEF-r148.md(P1–P8)。套件结构照抄 r146-crosstalk(假 claude + 隔离实例 + dev server),
// helpers 是从 r146 复制来的副本(r146 原目录只读),只在末尾追加了本轮的仪器(见 helpers/ui.mjs「r148 追加」)。
//
// 每条用例断言的都是一个"可数的量":
//   P1  空闲 6 秒里界面状态库通知了几次、根组件 / 会话组件 / 侧栏 / 输入框各重渲染了几次
//   P2  三个分屏 + 监控面板开着时 6 秒里「运行进程」接口被请求了几次;页面不可见时几次
//   P3  页面不可见时首页贪吃蛇走了几步
//   P4  子代理 400 条流式增量让界面状态库通知了几次;最后一段文字到没到
//   P6  主回合流式期间输入框重渲染了几次
//   P8  启动后头 1 秒里有没有发出那 5 类可以延后的请求
// P5、P7 没有界面量(服务端),见 tests/unit/check-r148-p5-*.mjs / check-r148-p7-*.mjs;
// P1 / P2 / P4 / P6 的模块级断言见 tests/unit/check-r148-*.mjs。
//
// 渲染次数怎么数的:见 helpers/ui.mjs 的 installRenderProbe(页面上的 React 开发者工具钩子,不改产品代码)。
// dev server 下组件名带后缀(SessionDetail 被打包器改名为 SessionDetail2),所以按前缀认。
import { test, expect } from '@playwright/test';
import { NAV, R148 } from './helpers/fixtures.mjs';
import {
  agentRecordCount, armMainStream, armSubagent, boot, composer, countPath, focusPane, installRenderProbe, openRightPanel,
  openSessionBySearch, readAgentRecord, recordApiRequests, releaseAllRuns, releaseChunk2, releaseTurnEnd, renderCounts,
  sendPrompt, sessionRow, setPageHidden, setPanes, startStoreCounter, storeNotifyCount, subagentToolId, waitForPhase,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;
const ACTIVE = '/api/agents/active';

test.afterEach(async () => { releaseAllRuns(CTL); });

/** 两次快照之间,名字以 prefix 开头(后面只跟数字)的组件一共渲染了几次。 */
const rendered = (a, b, prefix) => {
  const re = new RegExp(`^${prefix}\\d*$`);
  let n = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (re.test(k)) n += (b[k] || 0) - (a[k] || 0);
  return n;
};
/** 进应用 + 把夹具项目打开进侧栏。 */
async function bootWithProject(page) {
  await boot(page);
  await openSessionBySearch(page, NAV.mark);
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
}

// ───────────────────────── P1 ─────────────────────────
test('P1 空闲时不重渲染:开着一条会话什么都不做 6 秒,状态库不通知、根组件 / 会话 / 侧栏 / 输入框都不重跑', async ({ page }) => {
  await installRenderProbe(page);
  await bootWithProject(page);
  await openSessionBySearch(page, R148[0].mark);
  await page.waitForTimeout(4_000);                 // 让打开会话带起来的加载全部落定
  await startStoreCounter(page);
  const probeOk = await renderCounts(page);
  expect(rendered({}, probeOk, 'App'), '探针应已数到根组件的渲染(否则下面的 0 是假的)').toBeGreaterThan(0);
  expect(rendered({}, probeOk, 'SessionDetail'), '探针应已数到会话组件的渲染').toBeGreaterThan(0);

  const a = await renderCounts(page);
  const n0 = await storeNotifyCount(page);
  await page.waitForTimeout(6_000);
  const b = await renderCounts(page);
  const notified = (await storeNotifyCount(page)) - n0;
  const got = {
    状态库通知: notified,
    根组件: rendered(a, b, 'App'),
    会话组件: rendered(a, b, 'SessionDetail'),
    侧栏: rendered(a, b, 'UnifiedSidebar'),
    输入框: rendered(a, b, 'ChatInput'),
  };
  console.log(`[P1] 空闲 6 秒:${JSON.stringify(got)}`);
  // 修前实测:每项都是 4(每 1.5 秒一次)。留 1 的余量给偶发的一次性写入。
  for (const [k, v] of Object.entries(got)) expect(v, `空闲 6 秒里「${k}」应不动(实际 ${v} 次)`).toBeLessThanOrEqual(1);
});

// ───────────────────────── P2 ─────────────────────────
test('P2 运行进程接口只有一份轮询:3 个分屏各开一条会话 + 监控面板,6 秒里最多 6 次请求;页面不可见时停,回到可见立刻补', async ({ page }) => {
  const reqs = recordApiRequests(page);
  await bootWithProject(page);
  await setPanes(page, 3);
  for (let i = 0; i < 3; i += 1) { await focusPane(page, i); await openSessionBySearch(page, R148[1 + i].mark); }
  await openRightPanel(page, 'Subagent 监控');
  await page.waitForTimeout(2_500);

  const t1 = Date.now();
  await page.waitForTimeout(6_000);
  const visibleCount = countPath(reqs, ACTIVE, t1);
  console.log(`[P2] 可见 6 秒:${visibleCount} 次`);
  // 修前实测 20 次(根组件 1 份 + 3 个窗格各 1 份 + 监控面板 1 份,每份 4 拍)。一份轮询 = 4 拍,留 2 的余量。
  expect(visibleCount, '6 秒里的请求次数(一份轮询约 4 次)').toBeLessThanOrEqual(6);
  expect(visibleCount, '轮询不能停(各窗格的后台横幅 / 排队消息 / 自动重连都靠它)').toBeGreaterThanOrEqual(3);

  await setPageHidden(page, true);
  await page.waitForTimeout(400);                    // 在飞的那一次让它落地
  const t2 = Date.now();
  await page.waitForTimeout(4_500);
  const hiddenCount = countPath(reqs, ACTIVE, t2);
  console.log(`[P2] 不可见 4.5 秒:${hiddenCount} 次`);
  // 修前实测 15 次。1.5 秒的拍子必须停;留 1 次给"不可见时的慢拍"(若实现选择降频而不是全停)。
  expect(hiddenCount, '页面不可见 4.5 秒里的请求次数').toBeLessThanOrEqual(1);

  const t3 = Date.now();
  await setPageHidden(page, false);
  await expect.poll(() => countPath(reqs, ACTIVE, t3), { message: '回到可见应立刻补一次', timeout: 700, intervals: [50] }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(3_200);
  expect(countPath(reqs, ACTIVE, t3), '回到可见后拍子应恢复(3.9 秒里至少 3 次)').toBeGreaterThanOrEqual(3);
});

// ───────────────────────── P3 ─────────────────────────
test('P3 首页贪吃蛇:页面不可见时一步不走,回到可见从停下的地方接着走', async ({ page }) => {
  await boot(page);
  const snake = page.getByTestId('home-usage-snake');
  await expect(snake, '首页热力图上应有蛇(夹具会话带用量)').toBeVisible({ timeout: 40_000 });
  /** ms 毫秒里蛇走了几步、第一步走到哪、最后停在哪。 */
  const watch = (ms) => page.evaluate(async (dur) => {
    const el = document.querySelector('[data-testid="home-usage-snake"]');
    let n = 0; let first = null;
    const obs = new MutationObserver((list) => { for (const _m of list) { n += 1; if (first === null) first = Number(el.dataset.snakeStep); } });
    obs.observe(el, { attributes: true, attributeFilter: ['data-snake-step'] });
    await new Promise((r) => setTimeout(r, dur));
    obs.disconnect();
    return { n, first, step: Number(el.dataset.snakeStep), total: Number(el.dataset.snakeTotal) };
  }, ms);

  const seen = await watch(1_500);
  console.log(`[P3] 可见 1.5 秒走了 ${seen.n} 步(一趟 ${seen.total} 步)`);
  expect(seen.n, '可见时蛇应在走(约 100ms 一步)').toBeGreaterThanOrEqual(5);

  await setPageHidden(page, true);
  await page.waitForTimeout(250);
  const hidden = await watch(1_500);
  console.log(`[P3] 不可见 1.5 秒走了 ${hidden.n} 步`);
  expect(hidden.n, '页面不可见时蛇不该走(修前实测约 15 步)').toBe(0);

  const backP = watch(1_500);
  await setPageHidden(page, false);
  const back = await backP;
  console.log(`[P3] 回到可见 1.5 秒走了 ${back.n} 步,第一步到 ${back.first}(停在 ${hidden.step})`);
  expect(back.n, '回到可见后蛇应继续走').toBeGreaterThanOrEqual(5);
  expect(back.first, '应从停下的地方接着走(不是从头再来)').toBe((hidden.step + 1) % hidden.total);
});

// ───────────────────────── P4 ─────────────────────────
test('P4 子代理流式增量合并提交:400 条增量只让状态库通知不到 200 次,最后一段文字不丢,结束后记录完整', async ({ page }) => {
  await bootWithProject(page);
  const S = R148[4];
  await openSessionBySearch(page, S.mark);
  await page.waitForTimeout(1_500);
  await startStoreCounter(page);
  const N = 400;
  const TAIL = 'R148-SUBTAIL-END';
  // 前 360 条每 2ms 一条(像真实的流式),最后 40 条一口气到,紧跟着就是子代理的结果
  armSubagent(CTL, S.sid, { deltas: N, gapMs: 2, burstTail: 40, tail: TAIL });

  const n0 = await storeNotifyCount(page);
  await sendPrompt(page, 'r148 P4 派一个子代理');
  await waitForPhase(CTL, S.sid, 'subagent-done', 40_000);
  const tool = subagentToolId(CTL, S.sid);
  expect(tool, '假 CLI 应已派出子代理').toBeTruthy();
  releaseChunk2(CTL, S.sid);
  releaseTurnEnd(CTL, S.sid);
  await waitForPhase(CTL, S.sid, 'final', 30_000);

  let expected = '';
  for (let i = 0; i < N - 1; i += 1) expected += `R148D${i} `;
  expected += TAIL;
  // 回合结束后:文字逐字完整(含最后一段)、状态为已完成
  await expect.poll(async () => (await readAgentRecord(page, tool))?.text.length ?? -1, { message: '子代理全文应到齐', timeout: 15_000 }).toBe(expected.length);
  const rec = await readAgentRecord(page, tool);
  expect(rec.text, '子代理全文应逐字等于发出的内容(最后一段不能丢、顺序不能乱)').toBe(expected);
  expect(rec.text.endsWith(TAIL), '最后一段').toBe(true);
  await expect.poll(async () => (await readAgentRecord(page, tool))?.status, { message: '回合结束后子代理应标为已完成', timeout: 15_000 }).toBe('done');
  expect(rec.blocks.filter((t) => t === 'text').length, '连续的文字增量应并成一块').toBe(1);

  const notified = (await storeNotifyCount(page)) - n0;
  console.log(`[P4] ${N} 条子代理增量 + 整个回合:状态库通知 ${notified} 次`);
  // 修前实测:每条增量 1 次 ⇒ 400 出头。按帧合并后是"帧数"量级(几十次)+ 回合自身的少量写入。
  expect(notified, `状态库通知次数(${N} 条增量)`).toBeLessThan(N / 2);

  // 界面上也看得到:会话里出现了这次子代理的卡片
  await expect(page.getByText('R148 子代理', { exact: false }).first(), '会话里应有这次子代理的卡片').toBeVisible({ timeout: 10_000 });
  expect(await agentRecordCount(page), '打开着的会话的子代理记录不该被回收').toBeGreaterThanOrEqual(1);
});

// ───────────────────────── P6 ─────────────────────────
test('P6 流式期间输入框不跟着重渲染:主回合 300 条流式增量,会话组件每帧重跑,输入框最多 20 次;同时打字不受影响', async ({ page }) => {
  await installRenderProbe(page);
  await bootWithProject(page);
  const S = R148[5];
  await openSessionBySearch(page, S.mark);
  await page.waitForTimeout(1_500);
  armMainStream(CTL, S.sid, { deltas: 300, gapMs: 10 });
  await sendPrompt(page, 'r148 P6 流式');
  await waitForPhase(CTL, S.sid, 'stream-start', 40_000);
  await page.waitForTimeout(300);                   // 回合起步时的那几次状态切换先过去
  const a = await renderCounts(page);
  await composer(page).fill('流式期间照常打字');     // 打字本身会让输入框渲染(合理),算在余量里
  await waitForPhase(CTL, S.sid, 'stream-done', 40_000);
  const b = await renderCounts(page);
  const detail = rendered(a, b, 'SessionDetail');
  const input = rendered(a, b, 'ChatInput');
  console.log(`[P6] 流式期间:会话组件 ${detail} 次,输入框 ${input} 次`);
  expect(detail, '对照:流式确实在驱动会话组件重渲染(否则这条量不出东西)').toBeGreaterThanOrEqual(40);
  // 修前实测:输入框与会话组件一样多(约 200 次)。
  expect(input, '流式期间输入框的渲染次数').toBeLessThanOrEqual(20);
  await expect(composer(page), '流式期间打进去的字应原样在输入框里').toHaveValue('流式期间照常打字');
  await expect(page.getByText('R148M299', { exact: false }).first(), '流式正文应完整上屏').toBeVisible({ timeout: 10_000 });
  releaseChunk2(CTL, S.sid); releaseTurnEnd(CTL, S.sid);
  await waitForPhase(CTL, S.sid, 'final', 30_000);
});

test('P6 会话汇总挪进记忆化后切会话不白屏:在两条会话与首页之间来回切,页面不报错、界面还在', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await bootWithProject(page);
  // 用搜索来回打开两条会话(每次都经过"加载中 → 加载完"的切换,那正是提前 return 来回变的时刻)
  const open = async (s) => {
    await openSessionBySearch(page, s.mark);
    await expect(page.getByText(`${s.mark} 收到`, { exact: false }).first(), `应看到会话 ${s.mark} 的历史`).toBeVisible({ timeout: 15_000 });
  };
  for (let i = 0; i < 3; i += 1) { await open(R148[6]); await open(R148[7]); }
  await page.locator('[data-cgui=new-session-btn]').first().click();   // 回首页(没有选中会话 = 走提前 return 那条路)
  await expect(page.getByTestId('home-input'), '应回到首页').toBeVisible({ timeout: 15_000 });
  await open(R148[6]);
  await expect(page.locator('[data-cgui="panel-dock"]'), '界面应还在(没有白屏)').toBeVisible();
  expect(errors, `页面不该抛错:${errors.join(' | ')}`).toEqual([]);
});

// ───────────────────────── P8 ─────────────────────────
test('P8 启动时可以延后的 5 类请求不挤在第一批:头 1 秒里不发,10 秒内都发出;项目列表等首屏请求照常第一批发', async ({ page }) => {
  const reqs = recordApiRequests(page);
  await boot(page);                                  // boot 把两个版本检查接口钉成立即返回(只改响应,不影响它们何时发出)
  await expect(page.getByTestId('home-input'), '应落在首页(首页用量块才会取数)').toBeVisible({ timeout: 20_000 });
  const DEFERRED = ['/api/mcp', '/api/version-check', '/api/claude-version-check', '/api/pricing', '/api/usage'];
  await expect.poll(() => DEFERRED.filter((p) => !reqs.some((r) => r.path === p)), { message: '这 5 类请求 10 秒内都应发出(功能不变)', timeout: 10_000 }).toEqual([]);
  const t0 = reqs[0].at;
  const firstAt = (p) => reqs.find((r) => r.path === p).at - t0;
  const got = Object.fromEntries(DEFERRED.map((p) => [p, firstAt(p)]));
  console.log(`[P8] 相对第一个请求的发出时刻(ms):${JSON.stringify(got)};头 1 秒共 ${reqs.filter((r) => r.at - t0 < 1000).length} 个请求`);
  // 修前实测:前 4 个都在 110ms 左右、首页用量 173ms。
  for (const p of DEFERRED) expect(got[p], `${p} 应延后到首屏之后(相对第一个请求 ≥ 1000ms)`).toBeGreaterThanOrEqual(1000);
  for (const p of DEFERRED) expect(got[p], `${p} 也不能拖太久`).toBeLessThanOrEqual(8000);
  for (const p of ['/api/projects', '/api/providers', '/api/model']) {
    expect(reqs.some((r) => r.path === p), `${p} 应发出`).toBe(true);
    expect(firstAt(p), `${p} 是首屏要用的,不能被延后`).toBeLessThan(1000);
  }
});
