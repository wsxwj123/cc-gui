// r143 界面验收:侧栏搜索的"退出"手段(死状态)+ 回合在跑时的 Esc 语义。
//
// 考的是 .devflow/PLAN-r143-sidebar-search.md §3.1/§3.2 + REVIEW-PLAN-r143 §5.2 的产品契约,
// 只按用户看得见的东西判定(判据与修前预期见 .devflow/TEST-PLAN-r143.md §2):
//   S1(核心):搜索把侧栏过滤成只剩命中一条时,在搜索框按 Escape ⇒ 搜索词清空、列表恢复完整。
//            **修前必红**(当前侧栏搜索没绑 Escape,这一击会冒泡到会话级语义,搜索词留在框里)。
//   S2(回归网):点**搜索结果行** ⇒ 搜索词清空、列表恢复、被点会话成为当前会话。
//            修前应绿(这是 handlePickHit 的既有行为),用来锁住这条链路不被 S1 的改动弄坏。
//   S3(核心·本轮新发现的产品缺陷):回合正在跑时,搜索框里**有词** ⇒ 按一次 Escape 应清词 **且不停回合**。
//            **修前必红**(escAction.js:15 —— 有流时第一击就是 stop;:50 —— 焦点在 INPUT 不让行,
//            于是这一击落到 App.jsx:7636 的 handleStopRef.current?.(),回合被停)。
//   S4(阴性对照):回合正在跑时,搜索框里**没有词** ⇒ 按 Escape 回合**照旧被停**。
//            修前修后都应绿 —— 它守的是"P1 只在有词时接管"没有把既有的会话级 Esc 语义整段吞掉。
//   S5(新契约·P3):有词时搜索框出现 × ⇒ 点它清词、列表恢复;没有词时 × 不存在。
//            **修前必红**(× 这个出口本来就不存在)。
//   S5b(新契约·P3 第二出口):有词时出现过滤态说明行(「已按搜索词过滤 …」),
//            行内的「清空」(data-cgui="sidebar-search-clear-hint")也能清词、列表恢复。
//            **修前必红**;它与 S5 的 × 是**两个不同出口**,两个句柄不许互相替代。
//   S5c(新契约·P3 计数口径):说明行的「匹配 N 条会话」只数**标题匹配**的会话,
//            不数"只有消息正文命中"的那条(口径 = 标题匹配 + 已加载项目 + 未归档,见 TEST-PLAN §6.4)。
//            **修前必红**(说明行本来就不存在)。
//   S6(守卫·P1 不许越权):会话重命名输入框里按 Esc ⇒ 取消重命名,**且搜索词必须原样留着**。
//            修前绿(重命名框自己消费了这一击);落地 P1 后若没有"可编辑目标守卫"就会红 ——
//            因为 React 17+ 只在根容器挂监听、按 fiber 树模拟传播,输入框里的
//            `stopImmediatePropagation()` 挡不住冒泡到侧栏根。
//   S7(守卫·P1 不许越权):挂着授权卡时,焦点在**侧栏内的非可编辑元素**上按 Esc ⇒
//            卡片被拒掉,**且搜索词不许被清**。修前绿(App.jsx:7618 的 escYieldCardId 让行给卡片);
//            落地 P1 后若没有同样的让行判据,这一击会被侧栏吞掉 —— 卡片永远拒不掉。
//   S9(守卫·P1 不许越权):确认框(confirmDialog)开着、焦点在**侧栏内的非可编辑元素**上按 Esc ⇒
//            确认框被取消,**且搜索词不许被清**。修前绿(确认框的监听在 document 冒泡,
//            而会话级监听在 window,中间没人截断);落地 P1 后若没有 `[data-cgui-confirm]` 让行就会红。
//
// 只由 run.sh 调起(它负责起隔离实例 + dev server 并注入 R143_UI_BASE / R143_CTL)。
import { test, expect } from '@playwright/test';
import { B, CNT, CNT_ARCH, CNT_MSG_ONLY, CNT_TOKEN, NAV, POOL, live } from './helpers/fixtures.mjs';
import {
  armPermissionCard, boot, clearSearchBtn, clearSearchHintBtn, confirmHost, denyBtn, disarmPermissionCard,
  filterHint, hitRow, openDeleteConfirm, openFixtureProject, releaseAllRuns, releaseChunk2, searchInput,
  sendPrompt, sessionRow, sessionRows, startRenameSession, stopBtn, switchTo, waitTurnRunning,
} from './helpers/ui.mjs';

const CTL = process.env.R143_CTL;

// 跑回合的那条 / 当"被过滤见证"的那条,按用例分开:回合跑完后应用会改写会话标题,
// 同一轮运行里再拿旧标记去找那条会话行就会找不到(TEST-PLAN §5 的夹具纪律)。
const RUN_OF = { S3: POOL[0], S4: POOL[1], S4b: POOL[2], S7: POOL[3] };
const WITNESS_OF = { S3: POOL[5], S4: POOL[4], S4b: POOL[5] };

/** 把搜索词打进侧栏搜索框并等界面真的按它过滤(前提条件,失败要说清是哪一步)。 */
async function searchAndAssertFiltered(page, mark, hiddenMark = B.mark) {
  const search = searchInput(page);
  await search.click();
  await search.fill(mark);
  await expect(search, '搜索词应进到搜索框').toHaveValue(mark, { timeout: 5_000 });
  await expect(sessionRow(page, mark), '被搜索的那条会话行应可见(项目已展开)').toBeVisible({ timeout: 10_000 });
  await expect(sessionRow(page, hiddenMark), '搜索期间别的那条会话应被过滤掉').toBeHidden({ timeout: 10_000 });
  return search;
}

/** 开一条会话 → 发一条 → 等这一轮真的跑起来(有第一块文字 + 停止键在)。 */
async function startTurn(page, fx, prompt) {
  await switchTo(page, fx.mark);
  await sendPrompt(page, prompt);
  await waitTurnRunning(page, fx.sid, prompt);
}

/** 按完 Escape 之后现场的快照 —— 留给"修前红"的基线当原始报文(焦点落点也在里面)。 */
async function escSnapshot(page, search) {
  return {
    search: await search.inputValue(),
    stopBtns: await stopBtn(page).count(),
    activeElement: await page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return 'none';
      const h = a.getAttribute && a.getAttribute('data-cgui');
      return `${a.tagName}${h ? `[data-cgui=${h}]` : ''}`;
    }),
  };
}

// 收尾:放行本用例里所有还停着的回合,别把假 CLI 晾在"等控制文件"上。
test.afterEach(async () => { releaseAllRuns(CTL); });

test('S1 [核心] 搜索中按 Escape:搜索词清空、被过滤的会话重新出现', async ({ page }) => {
  await boot(page);
  await openFixtureProject(page, NAV.mark);
  // 基线:项目展开后能看到另一条会话(否则后面的"恢复"断言无从谈起)
  await expect(sessionRow(page, B.mark), '基线:夹具项目下应能看到另一条会话').toBeVisible({ timeout: 20_000 });

  const search = await searchAndAssertFiltered(page, NAV.mark);

  // 用户按下 Escape —— 这是本套件唯一新增的产品契约
  await search.press('Escape');

  // ① 搜索词必须清空(修前红在这里:当前侧栏搜索没有 Escape 处理器,这一击会冒泡到会话级语义)
  await expect(search, '在侧栏搜索框按 Escape 应清空搜索词').toHaveValue('', { timeout: 5_000 });
  // ② 被过滤掉的会话必须重新出现(列表从"只剩命中一条"恢复完整)
  await expect(sessionRow(page, B.mark), '清空搜索词后侧栏列表应恢复完整').toBeVisible({ timeout: 10_000 });
});

test('S2 [回归网] 点搜索结果行:搜索词清空、列表恢复、被点会话成为当前会话', async ({ page }) => {
  const pick = POOL[2];   // 不占用 S3/S4 跑回合的那两条(标题会被改写)
  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await expect(sessionRow(page, B.mark), '基线:夹具项目下应能看到另一条会话').toBeVisible({ timeout: 20_000 });

  const search = await searchAndAssertFiltered(page, pick.mark);

  // 点的是搜索结果行(原生 button.sidebar-item / 未来的 data-cgui="search-hit"),不是侧栏会话行
  const hit = hitRow(page, pick.mark);
  await expect(hit, '标记的搜索结果行应出现(全局消息搜索)').toBeVisible({ timeout: 15_000 });
  await hit.click();

  await expect(search, '点搜索结果行后搜索词应被清空').toHaveValue('', { timeout: 5_000 });
  await expect(sessionRow(page, B.mark), '清空后侧栏列表应恢复完整').toBeVisible({ timeout: 10_000 });
  // 阳性对照:被点的那条确实成了当前会话(证明这一下真的走了拾取链路,不是"点了没反应")
  await expect(page.locator('[role=button].sidebar-item.active').filter({ hasText: pick.mark }).first(),
    '被点的会话应成为当前会话').toBeVisible({ timeout: 10_000 });
});

test('S2b [契约] 命中行必须带产品句柄 data-cgui="search-hit"', async ({ page }) => {
  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await expect(sessionRow(page, B.mark), '基线:夹具项目下应能看到另一条会话').toBeVisible({ timeout: 20_000 });

  // 搜 NAV(默认的"被过滤见证"就是 B)⇒ B 被过滤掉,NAV 那行是"会话行 + 命中行都在"的那种
  const search = await searchAndAssertFiltered(page, NAV.mark);
  const hit = hitRow(page, NAV.mark);

  // ① 命中行必须真的带这个句柄 —— 少了它,helpers 的双选择器会**静默退回**"侧栏里的原生 button",
  //    没人报警,而"命中行 vs 会话行"的消歧又变回靠标签/时序的隐式约定。
  await expect(hit, '命中行应带 data-cgui="search-hit"').toHaveAttribute('data-cgui', 'search-hit', { timeout: 15_000 });
  // ② 阴性一半:会话行的句柄是 session-row,不是 search-hit(两个元素不许共用一个句柄)
  await expect(sessionRow(page, NAV.mark), '会话行的句柄应是 session-row').toHaveAttribute('data-cgui', 'session-row');
  await expect(sessionRow(page, NAV.mark), '会话行不该带 search-hit').not.toHaveAttribute('data-cgui', 'search-hit');

  // 收尾:清掉搜索词,别把过滤态留给后面的用例(本用例自己不做别的断言)
  await clearSearchHintBtn(page).click();
  await expect(search, '收尾:搜索词应被清空').toHaveValue('', { timeout: 5_000 });
});

test('S2c [契约·冷启动异步分支] 项目会话列表还没加载时点命中行:搜索词照样清空、会话照样打开', async ({ page }) => {
  // 冷启动 = 这一页从没展开过夹具项目 ⇒ `sessionsByProject[hash]` 里没有这条会话
  // ⇒ handlePickHit 走 `if (!known)` 那条异步分支(UnifiedSidebar.jsx:875-885:
  //    先用命中行造最小对象顶上,再 fetchSessions(hash).then() 用完整对象补齐)。
  // 注意:全程不再点第二次,断言的就是"这一下"(清词发生在 :886,与那一轮往返无关)。
  await boot(page);
  // 前提:冷启动 ⇒ 侧栏里**一条会话行都没有**(项目没展开、会话列表没加载)——
  // 这就是"走 !known 那条异步分支"的判据(不能用 searchAndAssertFiltered:它要求会话行已存在)
  await expect(sessionRows(page), '前提:冷启动时侧栏还没有该项目的会话行').toHaveCount(0);
  const search = searchInput(page);
  await search.click();
  await search.fill(NAV.mark);
  await expect(search, '搜索词应进到搜索框').toHaveValue(NAV.mark, { timeout: 5_000 });

  const hit = hitRow(page, NAV.mark);
  await expect(hit, '冷启动时也应出现消息命中行').toBeVisible({ timeout: 15_000 });
  await hit.click();

  // ① 搜索词照样被清空(修前/修后都该如此 —— 这条锁的是"冷启动那条路不许漏清词")
  await expect(search, '冷启动点命中行后搜索词也应被清空').toHaveValue('', { timeout: 5_000 });
  // ② 会话照样被打开(命中行造的最小对象顶上 + 异步补齐之后仍然停在它上面)
  await expect(page.locator('[role=button].sidebar-item.active').filter({ hasText: NAV.mark }).first(),
    '冷启动点命中行后,被点的会话应成为当前会话(异步补齐不抢走选择)').toBeVisible({ timeout: 20_000 });
  // ③ 补齐之后侧栏真的把该项目的会话列出来了(证明异步那一轮确实跑过,不是"压根没走这条路")
  await expect(sessionRow(page, B.mark), '异步补齐后该项目会话应已进侧栏').toBeVisible({ timeout: 20_000 });
});

test('S3 [核心·新缺陷] 回合在跑时按一次 Escape:搜索词清空,回合不许被停', async ({ page }) => {
  const run = RUN_OF.S3;
  const witness = WITNESS_OF.S3;
  const prompt = 'R143 S3:这一轮要一直跑着,直到测试自己放行第二块。';

  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await expect(sessionRow(page, witness.mark), '基线:夹具项目下的会话行都应在').toBeVisible({ timeout: 20_000 });
  await startTurn(page, run, prompt);

  // 在侧栏里搜索一条**标题稳定**的别的会话(NAV 不跑回合):列表被过滤,窗格里的回合不受影响
  const search = await searchAndAssertFiltered(page, NAV.mark, witness.mark);
  await expect(stopBtn(page), '前提:按 Escape 之前这一轮确实在跑').toHaveCount(1, { timeout: 5_000 });

  await search.press('Escape');
  await page.waitForTimeout(1_500);   // 给停止链路落定的时间:不留这段,"停止键还在"可能只是还没传过去
  const snap = await escSnapshot(page, search);
  console.log(`[r143] S3 按 Escape 之后:${JSON.stringify(snap)}`);

  // ① 搜索词必须被清空(修前红在这里)
  expect.soft(snap.search, '① 在侧栏搜索框按 Escape 应清空搜索词').toBe('');
  // ② 这一轮必须还在跑(修前红:被会话级 Esc 停掉了)
  expect.soft(snap.stopBtns, '② 搜索词非空时按 Escape 不该停掉正在跑的回合(停止键应还在)').toBe(1);
  // ③ 硬证据:放行假 CLI 的第二块,画得出来才说明这一轮真的没被停(①②都可能被时序骗过,这条不会)
  releaseChunk2(CTL, run.sid);
  await expect.soft(page.getByText(live.chunk2(run.sid), { exact: false }).first(),
    '③ 放行第二块后应看到它 —— 这一轮没被 Escape 停掉').toBeVisible({ timeout: 20_000 });
  // ④ 清空后侧栏列表恢复完整
  await expect(sessionRow(page, witness.mark), '④ 清空搜索词后侧栏列表应恢复完整').toBeVisible({ timeout: 10_000 });
});

test('S4 [阴性对照] 搜索词为空时按 Escape:回合仍然照旧被停', async ({ page }) => {
  const run = RUN_OF.S4;
  const prompt = 'R143 S4:这一轮要一直跑着,用来验证空搜索词时的 Esc 语义没变。';

  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await startTurn(page, run, prompt);

  const search = searchInput(page);
  await search.click();   // 焦点落在搜索框里,但框里没有词
  await expect(search, '前提:这一击要在搜索框里按,且框里没有搜索词').toHaveValue('');

  await search.press('Escape');

  // 空搜索词 ⇒ 侧栏不许接管,这一击照旧落到会话级语义:把正在跑的回合停掉
  // (判据 = 界面不再认为这一轮在跑:停止键消失 —— 与 r118/r119 的既有口径一致)
  await expect(stopBtn(page), '搜索词为空时按 Escape,回合应照旧被停(停止键应消失)')
    .toHaveCount(0, { timeout: 15_000 });
  // ⚠️ 这里**不**再断言"放行第二块不该画出来":实测该断言会 flaky(2026-10-02 单跑 3 次:红/红/绿)。
  //    原因是"停止是否真的下达到子进程"本身偶发不成立(`.phase` 已走到 `chunk2`),那属 r119 的考题面
  //    (停止链路/不许谎报),不是 r143 的侧栏搜索面 —— 详见 TEST-PLAN §3.8。本用例只守"这一击归会话级语义"。
});

test('S4b [守卫·IME] 组字中按 Escape:侧栏不许接管(词留着),也不许把回合停掉', async ({ page }) => {
  const run = RUN_OF.S4b;
  const prompt = 'R143 S4b:这一轮要一直跑着,用来验证 IME 组字时的 Esc 不接管。';

  await boot(page);

  // ── 前置自证(先做,此刻没有搜索词也没有回合 ⇒ 派发不产生任何副作用)────────────
  // 浏览器里造不出真输入法组字序列,只能派发一个带 isComposing 的 keydown(≈"候选词期间按 Esc")。
  // 但"派发了"不等于"监听者看得到":这里用一个**原生捕获监听**取回事件的真实读数,
  // 证明这一击在原生层就是 isComposing=true(否则本用例只是"测不到",不能算数)。
  const seen = await page.evaluate(() => new Promise((resolve) => {
    const el = document.querySelector('[data-cgui="sidebar-search"]');
    const onKey = (e) => {
      window.removeEventListener('keydown', onKey, true);
      resolve({ isComposing: e.isComposing, keyCode: e.keyCode, key: e.key });
    };
    window.addEventListener('keydown', onKey, true);
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
  }));
  expect(seen.isComposing, `前置自证:原生监听应看到 isComposing=true(实测 ${JSON.stringify(seen)})`).toBe(true);
  expect(seen.key, '前置自证:这一击的 key 是 Escape').toBe('Escape');
  test.info().annotations.push({
    type: 'IME 近似',
    description: `派发 isComposing=true 的 keydown(原生读数 ${JSON.stringify(seen)}),非真输入法组字 —— 见 TEST-PLAN §4`,
  });

  // ── 正式场景:搜索词非空 + 回合在跑 ⇒ 组字中的这一击谁都不许接 ────────────────
  await openFixtureProject(page, NAV.mark);
  await startTurn(page, run, prompt);

  const search = await searchAndAssertFiltered(page, NAV.mark, B.mark);
  await expect(stopBtn(page), '前提:这一轮确实在跑').toHaveCount(1, { timeout: 5_000 });

  await search.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(1_500);   // 给停止链路落定的时间(同 S3)

  // ① 组字中的这一击不许被侧栏搜索接管 ⇒ 搜索词原样留着
  await expect(search, '组字中按 Escape 不该被侧栏搜索接管(搜索词应原样留着)').toHaveValue(NAV.mark);
  // ② 也不许把它当"停回合":会话级 Esc 自己也有 isComposing 守卫(App.jsx:7609)
  await expect(stopBtn(page), '组字中按 Escape 不该把正在跑的回合停掉').toHaveCount(1, { timeout: 5_000 });
  // ③ 硬证据:放行第二块,画得出来才算这一轮真的没被停
  releaseChunk2(CTL, run.sid);
  await expect(page.getByText(live.chunk2(run.sid), { exact: false }).first(),
    '放行第二块后应看到它 —— 组字中的那一击没停掉回合').toBeVisible({ timeout: 20_000 });
});

test('S5 [新契约·P3] 有词时出现 × 清空钮:点它清词并恢复列表;无词时它不存在', async ({ page }) => {
  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await expect(sessionRow(page, B.mark), '基线:夹具项目下应能看到另一条会话').toBeVisible({ timeout: 20_000 });

  // 阴性一半(不依赖产品改动,先做):没有搜索词时不该有清空出口
  await expect(clearSearchBtn(page), '没有搜索词时不该出现 × 清空钮').toBeHidden();

  const search = await searchAndAssertFiltered(page, NAV.mark);

  // 有词 ⇒ × 出现(修前红在这里:这个出口本来就不存在)
  await expect(clearSearchBtn(page), '有搜索词时应出现 × 清空钮').toBeVisible({ timeout: 10_000 });
  await clearSearchBtn(page).click();

  await expect(search, '点 × 后搜索词应被清空').toHaveValue('', { timeout: 5_000 });
  await expect(sessionRow(page, B.mark), '清空后侧栏列表应恢复完整').toBeVisible({ timeout: 10_000 });
  await expect(clearSearchBtn(page), '清空后 × 应自己消失').toBeHidden({ timeout: 5_000 });
});

test('S5b [新契约·P3 第二出口] 过滤态说明行出现,行内「清空」也能清词', async ({ page }) => {
  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await expect(sessionRow(page, B.mark), '基线:夹具项目下应能看到另一条会话').toBeVisible({ timeout: 20_000 });

  await expect(filterHint(page), '没有搜索词时不该出现过滤态说明行').toBeHidden();

  const search = await searchAndAssertFiltered(page, NAV.mark);

  await expect(filterHint(page), '有搜索词时应出现过滤态说明行').toBeVisible({ timeout: 10_000 });
  await expect(filterHint(page), '说明行要说清"这是被搜索词过滤了"').toContainText('已按搜索词过滤', { timeout: 5_000 });
  // 第二出口:说明行里的「清空」(与 S5 的 × 是两个不同句柄)
  await expect(clearSearchHintBtn(page), '说明行里应有「清空」出口').toBeVisible({ timeout: 5_000 });
  await clearSearchHintBtn(page).click();

  await expect(search, '点说明行里的「清空」后搜索词应被清空').toHaveValue('', { timeout: 5_000 });
  await expect(sessionRow(page, B.mark), '清空后侧栏列表应恢复完整').toBeVisible({ timeout: 10_000 });
  await expect(filterHint(page), '清空后说明行应自己消失').toBeHidden({ timeout: 5_000 });
});

test('S5c [新契约·P3 计数口径] 说明行只数"标题匹配"的会话,不数只有消息命中的', async ({ page }) => {
  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await expect(sessionRow(page, B.mark), '基线:夹具项目下应能看到另一条会话').toBeVisible({ timeout: 20_000 });

  const search = await searchAndAssertFiltered(page, CNT_TOKEN);

  // ① 口径:标题匹配 + 已加载项目 + 未归档 = **3**(CNT 那三条)
  await expect(filterHint(page), '说明行应出现').toBeVisible({ timeout: 10_000 });
  await expect(filterHint(page), '计数口径 = 标题匹配的会话数(3 条),不是 4 条')
    .toContainText(/匹配\s*3\s*条会话/, { timeout: 5_000 });
  // ② 阳性对照:侧栏此刻确实只剩这 3 行(数出来的东西和列表一致)
  await expect(sessionRows(page), '过滤后侧栏应只剩标题匹配的那 3 条会话行').toHaveCount(CNT.length, { timeout: 10_000 });
  // ③ 反向对照:那条"只有消息里含词"的会话 —— 消息搜索能搜到它(下面),但标题不匹配 ⇒ 不算进 N、也没有侧栏行
  await expect(sessionRow(page, CNT_MSG_ONLY.mark), '标题不含词的会话不该出现在侧栏行里').toBeHidden();
  await expect(page.locator('[data-cgui="sidebar"] button.sidebar-item')
    .filter({ hasText: CNT_MSG_ONLY.sid.slice(0, 8) }).first(),
    '它的消息命中应当出现在搜索结果里(证明"没数它"是因为口径,不是因为搜不到)').toBeVisible({ timeout: 15_000 });

  // 收尾:用说明行里的「清空」退出(顺带证明 S5b 的出口在别的搜索词下也成立)
  await clearSearchHintBtn(page).click();
  await expect(search, '清空后搜索词应为空').toHaveValue('', { timeout: 5_000 });
});

test('S5d [新契约·P3 计数口径] 已归档的会话即使标题匹配,也不算进「匹配 N 条会话」', async ({ page }) => {
  // 夹具里 CNT_ARCH 那条:标题含 R143CNTMARK,但服务端标了归档(`<sid>.jsonl.archived`)。
  // 计数契约 = 标题匹配 + 已加载项目 + **未归档** ⇒ N 仍是 3(CNT 那三条),不是 4。
  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await expect(sessionRow(page, B.mark), '基线:夹具项目下应能看到另一条会话').toBeVisible({ timeout: 20_000 });

  const search = await searchAndAssertFiltered(page, CNT_TOKEN);

  await expect(filterHint(page), '说明行应出现').toBeVisible({ timeout: 10_000 });
  await expect(filterHint(page), '已归档那条不该被算进去 ⇒ 计数仍是 3 条')
    .toContainText(/匹配\s*3\s*条会话/, { timeout: 5_000 });
  await expect(sessionRows(page), '过滤后侧栏应只剩未归档的那 3 条').toHaveCount(CNT.length, { timeout: 10_000 });
  // 反向对照:那条已归档的会话标题确实含词(所以"没数它"只能是因为归档),
  // 但它不在侧栏行里(归档会话默认视图不列)
  await expect(sessionRow(page, CNT_ARCH.mark), '已归档的会话不该出现在侧栏行里').toBeHidden();

  await clearSearchHintBtn(page).click();
  await expect(search, '收尾:搜索词应被清空').toHaveValue('', { timeout: 5_000 });
});

test('S6 [守卫] 重命名输入框里按 Esc:取消重命名,且不许顺手清掉搜索词', async ({ page }) => {
  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await expect(sessionRow(page, B.mark), '基线:夹具项目下应能看到另一条会话').toBeVisible({ timeout: 20_000 });

  // 先让搜索词非空(= P1 的接管前提成立),再进重命名态
  const search = await searchAndAssertFiltered(page, NAV.mark);
  const rename = await startRenameSession(page, NAV.mark);
  await expect(search, '前提:重命名框开着时搜索词还在').toHaveValue(NAV.mark);

  await rename.press('Escape');   // 焦点在重命名输入框里 —— 这一击的语义是"取消重命名"

  await expect(rename, '重命名框应被取消(输入框消失)').toBeHidden({ timeout: 5_000 });
  await expect(search, '重命名框里的 Esc 不该被侧栏的搜索接管:搜索词必须原样留着')
    .toHaveValue(NAV.mark, { timeout: 5_000 });
  // 一致性:词没被清 ⇒ 列表仍应处在"过滤后"的状态(B 那条不该出现)
  await expect(sessionRow(page, B.mark), '搜索词没被清 ⇒ 列表不该恢复完整').toBeHidden();
});

test('S7 [守卫] 挂着授权卡时按 Esc:卡片被拒掉,不许被侧栏搜索吞掉', async ({ page }) => {
  const run = RUN_OF.S7;
  const prompt = 'R143 S7:这一轮会挂一张授权卡,用来验证 Esc 到底归谁。';

  await boot(page);
  await openFixtureProject(page, NAV.mark);
  armPermissionCard(CTL, run.sid);          // 这一轮的假 CLI 会在吐完第一块后发 can_use_tool
  await startTurn(page, run, prompt);

  // 搜索词非空(= P1 的接管前提成立),同时把 B 那条过滤掉(它此刻是"看不见的行")
  const search = await searchAndAssertFiltered(page, NAV.mark, B.mark);
  await expect(denyBtn(page), '授权卡应出现(卡在 = 拒绝键在)').toHaveCount(1, { timeout: 30_000 });

  // 焦点落在**侧栏内的非可编辑元素**上:键盘用户 Tab 到会话行就是这个落点
  // (点会话行之后的落点见 TEST-PLAN §8.1 实验 A)。焦点在侧栏内 ⇒ 侧栏根能收到这一击。
  await sessionRow(page, NAV.mark).focus();
  await page.keyboard.press('Escape');

  // ① 这一击应归卡片:卡片被拒掉(拒绝键消失)
  await expect(denyBtn(page), '卡片挂着时按 Esc 应把卡片拒掉(拒绝键消失)').toBeHidden({ timeout: 15_000 });
  // ② 卡片是这一层最上面的那层 ⇒ 搜索词不该被清
  await expect(search, '卡片才是这一击的对象,搜索词不该被清掉').toHaveValue(NAV.mark, { timeout: 5_000 });

  disarmPermissionCard(CTL, run.sid);       // 收尾:这条会话以后别再挂卡
});

test('S9 [守卫] 确认框开着时按 Esc:确认框被取消,不许被侧栏搜索吞掉', async ({ page }) => {
  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await expect(sessionRow(page, B.mark), '基线:夹具项目下应能看到另一条会话').toBeVisible({ timeout: 20_000 });

  const search = await searchAndAssertFiltered(page, NAV.mark);
  await openDeleteConfirm(page, NAV.mark);   // ⋯ → 删除会话 ⇒ confirmDialog(点完只弹框,不真删)

  // 确认框自己把焦点给了取消键(在侧栏外)—— 这里把焦点移回**侧栏内**的非可编辑元素,
  // 复现"用户把焦点移回侧栏再按 Esc"(Tab 到会话行的落点)。
  // 焦点不在侧栏内的话这一击压根到不了 P1,这条守卫就白测了。
  await sessionRow(page, NAV.mark).focus();
  await page.keyboard.press('Escape');

  // ① 确认框必须被取消(document 冒泡上的监听接住这一击)
  await expect(confirmHost(page), '确认框应被取消(Esc = 取消)').toHaveCount(0, { timeout: 10_000 });
  // ② 确认框才是这一层最上面的那层 ⇒ 搜索词不该被清
  await expect(search, '确认框才是这一击的对象,搜索词不该被清掉').toHaveValue(NAV.mark, { timeout: 5_000 });
});

test('S8 [核心·P1 绑根节点的唯一正面证据] 焦点在侧栏会话行、无浮层、有词 ⇒ Esc 清词并恢复列表', async ({ page }) => {
  // 这条与 S7/S9 是同一落点、但**不带任何浮层**:它测的正是 P1"绑在侧栏根节点"这个设计决策本身 ——
  // 焦点不在搜索框里(所以绑 input 收不到),而在侧栏内的非可编辑元素(会话行)上。
  // 修前:那一击冒泡到会话级 Esc(空闲态落 'arm' = 什么都不做)⇒ 搜索词留着 ⇒ 红。
  await boot(page);
  await openFixtureProject(page, NAV.mark);
  await expect(sessionRow(page, B.mark), '基线:夹具项目下应能看到另一条会话').toBeVisible({ timeout: 20_000 });

  const search = await searchAndAssertFiltered(page, NAV.mark, B.mark);

  // 焦点落在侧栏会话行上(键盘用户 Tab 到会话行的落点;点会话行之后的落点见实验 A)
  await sessionRow(page, NAV.mark).focus();
  const focused = await page.evaluate(() => {
    const a = document.activeElement;
    const root = document.querySelector('[data-cgui="sidebar"]');
    return { inSidebar: !!(a && root && root.contains(a)), tag: a?.tagName || 'none', cgui: a?.getAttribute?.('data-cgui') || null };
  });
  expect(focused.inSidebar, `前提:这一击的事件源必须在侧栏内(实测 ${JSON.stringify(focused)})`).toBe(true);
  expect(focused.cgui, '前提:焦点应落在会话行上(不是搜索框)').toBe('session-row');

  await page.keyboard.press('Escape');

  // ① 搜索词被清空(修前红在这里:焦点在会话行上,绑 input 的监听收不到)
  await expect(search, '① 焦点在侧栏会话行上按 Escape,也应清空搜索词').toHaveValue('', { timeout: 5_000 });
  // ② 被过滤掉的会话重新出现(列表恢复完整)
  await expect(sessionRow(page, B.mark), '② 清空后侧栏列表应恢复完整').toBeVisible({ timeout: 10_000 });
});
