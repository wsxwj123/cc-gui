// r121 界面验收:分屏状态下一条消息被渲染两次(老问题)。
// 依据只有 .devflow/BRIEF-r121.md(R1–R5)与 .devflow/INTERFACE-r121.md(§A 可观察身份 / §B 判定口径 B1–B6,
// §C 环境规则);没看实现代码。
//
// 判据(§A/§B):同一段**唯一文本**在**同一格内**出现的次数 = 该格内**消息块**个数
//   (.chat-user-bubble 用户气泡 + .markdown-content 助手正文块)。
//   每段文本都是本测试现造的、绝不可能重复的(带时间戳)。
// 计数**先自证**(S1):人为往一格里插一条重复,计数必须从 1 变 2、再插一条变 3 ——
//   证明"数出来是 1"不是扫描范围扫不到(空转断言)。
// 只跑一个浏览器上下文,用例之间不共享会话(每个用例一条自己的夹具会话)。
import { test, expect } from '@playwright/test';
import { POOL, SESSIONS, S, T } from './helpers/fixtures.mjs';
import * as ui from './helpers/ui.mjs';

test.describe.configure({ timeout: 300_000 });

const uniq = (tag) => `R121UQ-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)} 这条消息只该出现一次`;

/** 逐栏计数 + 整页计数,失败信息里能直接看出"哪个格、几次"。 */
async function survey(page, mk) {
  const n = await ui.paneCount(page);
  const per = [];
  for (let i = 1; i <= n; i += 1) per.push({ pane: i, ...(await ui.countInPane(page, i, mk)) });
  return { panes: per, pageTotal: await ui.countOnPage(page, mk), identities: await ui.paneIdentities(page) };
}

/** 一句话说清这批计数。 */
const show = (s) => JSON.stringify({ 逐栏: s.panes.map((p) => ({ 格: p.pane, 用户气泡: p.userBubbles, 助手块: p.assistantBlocks, 消息数: p.messageCount, 原文出现: p.rawOccurrences, 非消息出现: p.extras.length })), 整页: s.pageTotal });

/** 断言:该格内这条消息恰好 1 次(用户气泡 1 + 助手块 0 起)。 */
function expectExactlyOne(s, pane, mk) {
  const p = s.panes.find((x) => x.pane === pane);
  expect(p, `第 ${pane} 格应存在;实际 ${s.panes.length} 格`).toBeTruthy();
  expect(p.userBubbles, `第 ${pane} 格内用户消息「${mk}」应恰好 1 条,实际 ${p.userBubbles} 条(整页 ${s.pageTotal} 次)\n${show(s)}`).toBe(1);
  expect(p.messageCount, `第 ${pane} 格内消息块总数(用户+助手)应恰好 1,实际 ${p.messageCount}\n${show(s)}`).toBe(1);
}

test.describe('r121 分屏重复渲染', () => {
  // ---- S1:计数自证(先证明"数出 1"不是空转)-------------------------------------------------
  test('S1 计数自证:人为在同一格插一条重复,计数必须从 1 变 2、再插变 3', async ({ page }) => {
    const sess = POOL[0];
    await ui.boot(page);
    await ui.openSessionBySearch(page, sess.mark);
    const mk = uniq('SELFPROOF');
    ui.setCtl('max-chunks', 2); ui.setCtl('chunk-ms', 200);
    await ui.sendPrompt(page, mk);
    await page.waitForTimeout(7_000);

    const natural = await survey(page, mk);
    expectExactlyOne(natural, 1, mk);            // 天然一次(顺带就是 B1 单栏的判据)

    const inj1 = await ui.injectDuplicate(page, 1, mk);
    expect(inj1.injected, `自证前提:这一格里要能找到一个含该文本的消息块;${JSON.stringify(inj1)}`).toBe(true);
    const after2 = await survey(page, mk);
    expect(after2.panes[0].messageCount, `人为插一条重复后必须数出 2 —— 若仍是 1,说明这个计数方式扫不到,后面所有"=1"的断言都是空转\n${show(after2)}`).toBe(2);
    expect(after2.panes[0].userBubbles, '用户气泡计数也应数出 2').toBe(2);

    await ui.injectDuplicate(page, 1, mk);
    const after3 = await survey(page, mk);
    expect(after3.panes[0].messageCount, '再插一条必须数出 3').toBe(3);

    await ui.removeSelfProof(page);
    const restored = await survey(page, mk);
    expect(restored.panes[0].messageCount, '把注入的副本删掉后应回到 1').toBe(1);
    ui.clearCtl('max-chunks'); ui.clearCtl('chunk-ms');
  });

  // ---- B1:同格不重复(单栏 + 发送后数 / 分屏后数 / 关掉另一格再数)------------------------
  test('B1 单栏:发一条唯一消息,该格内恰好 1 次', async ({ page }) => {
    const sess = POOL[1];
    await ui.boot(page);
    await ui.openSessionBySearch(page, sess.mark);
    const mk = uniq('B1');
    ui.setCtl('max-chunks', 3); ui.setCtl('chunk-ms', 200);
    await ui.sendPrompt(page, mk);
    for (let i = 0; i < 8; i += 1) {            // 生成过程中每一秒都要恰好 1 次(不许"生成中多画一条")
      await page.waitForTimeout(1_000);
      expectExactlyOne(await survey(page, mk), 1, mk);
    }
    await page.waitForTimeout(4_000);            // 收尾完成后再确认一次
    expectExactlyOne(await survey(page, mk), 1, mk);

    // R1 后半句:助手的**一条**回复同理。桩每轮收尾只发一次「这一轮到此为止」,
    // 它在同一格内也应恰好画出 1 个助手块。
    const ended = '这一轮到此为止';
    const assist = await ui.countInPane(page, 1, ended);
    expect(assist.assistantBlocks, `第 1 格内助手这轮收尾回复应恰好 1 个助手块,实际 ${assist.assistantBlocks}`).toBe(1);
    ui.clearCtl('max-chunks'); ui.clearCtl('chunk-ms');
  });

  // ---- B2:消息已存在 → 开分屏 → 每格仍恰好 1 次;关掉另一格再数仍 1 -----------------------
  test('B2 消息已存在再开分屏:自己那格仍 1 次;关掉另一格再数仍 1 次', async ({ page }) => {
    const sess = POOL[2];
    await ui.boot(page);
    await ui.openSessionBySearch(page, sess.mark);
    const mk = uniq('B2');
    ui.setCtl('max-chunks', 2); ui.setCtl('chunk-ms', 200);
    await ui.sendPrompt(page, mk);
    await page.waitForTimeout(7_000);
    expectExactlyOne(await survey(page, mk), 1, mk);

    await ui.setPaneCount(page, 2);
    await page.waitForTimeout(1_500);
    const split = await survey(page, mk);
    expectExactlyOne(split, 1, mk);              // 有会话的那格
    await ui.setPaneCount(page, 1);
    await page.waitForTimeout(1_500);
    expectExactlyOne(await survey(page, mk), 1, mk);
    ui.clearCtl('max-chunks'); ui.clearCtl('chunk-ms');
  });

  // ---- B3:分屏中发送不串格(两格看不同会话)----------------------------------------------
  test('B3 两格看不同会话:A 格发的消息,A 格 1 次、B 格 0 次', async ({ page }) => {
    const a = POOL[3];
    const b = POOL[4];
    await ui.boot(page);
    await ui.openSessionBySearch(page, a.mark);
    await ui.setPaneCount(page, 2);
    await page.waitForTimeout(1_200);

    const filled = await ui.fillPaneWithSession(page, 2, b.mark);
    const ids = await ui.paneIdentities(page);
    expect(ids[1] && ids[1].ownerKey, `第 2 格应已装入会话 ${b.mark}(标记 ${b.mark});实际身份 ${JSON.stringify(ids)}`).not.toBe('');
    expect(ids[0].ownerKey.slice(0, 24), '第 1 格应仍是 A 会话').not.toBe(ids[1].ownerKey.slice(0, 24));

    const mk = uniq('B3');
    ui.setCtl('max-chunks', 2); ui.setCtl('chunk-ms', 200);
    await ui.sendInPane(page, 1, mk);
    await page.waitForTimeout(7_000);
    const s = await survey(page, mk);
    expectExactlyOne(s, 1, mk);
    expect(s.panes[1].messageCount, `B 格里不该出现 A 格发的消息(串格);实际 ${s.panes[1].messageCount}\n${show(s)}`).toBe(0);
    ui.clearCtl('max-chunks'); ui.clearCtl('chunk-ms');
  });

  // ---- B4:反复开关分屏 + 调比例,不累积 -------------------------------------------------
  test('B4 反复开关分屏/调比例 4 轮,单格内始终 1 次(不变成 2、3、4)', async ({ page }) => {
    const sess = POOL[5];
    await ui.boot(page);
    await ui.openSessionBySearch(page, sess.mark);
    const mk = uniq('B4');
    ui.setCtl('max-chunks', 2); ui.setCtl('chunk-ms', 200);
    await ui.sendPrompt(page, mk);
    await page.waitForTimeout(7_000);
    expectExactlyOne(await survey(page, mk), 1, mk);

    for (let r = 1; r <= 4; r += 1) {
      await ui.setPaneCount(page, 2); await page.waitForTimeout(700);
      await ui.setPaneCount(page, 1); await page.waitForTimeout(700);
      const s = await survey(page, mk);
      expectExactlyOne(s, 1, mk);                // 每一轮之后都必须还是 1
    }
    ui.clearCtl('max-chunks'); ui.clearCtl('chunk-ms');
  });

  // ---- B5:流式进行中开分屏,正在生成的那条仍恰好 1 次 ------------------------------------
  test('B5 流式进行中开分屏:正在生成也在开完之后恰好 1 次', async ({ page }) => {
    const sess = POOL[6];
    await ui.boot(page);
    await ui.openSessionBySearch(page, sess.mark);
    const mk = uniq('B5');
    ui.clearCtl('max-chunks');                    // 一直吐,保证开分屏时确实在生成
    ui.setCtl('chunk-ms', 700);
    await ui.sendPrompt(page, mk);
    await page.waitForTimeout(2_500);
    expect(await ui.ctlPhase(sess.sid), '开分屏之前这一轮应该在跑(桩还没到 final)').not.toBe('final');

    await ui.setPaneCount(page, 2);
    await page.waitForTimeout(1_000);
    expectExactlyOne(await survey(page, mk), 1, mk);           // 开着的那一刻
    await page.waitForTimeout(6_000);
    expectExactlyOne(await survey(page, mk), 1, mk);           // 生成继续中
    // 让这一轮自然收尾(给桩设一个刚好再吐一块的上限),再复测一次 —— 不用「停止」按钮,
    // 那颗按钮在"这一轮已经结束"时不存在,直接点会等满用例超时(踩过)。
    ui.setCtl('max-chunks', ui.ctlStreamed(sess.sid) + 1);
    await page.waitForTimeout(4_000);
    expectExactlyOne(await survey(page, mk), 1, mk);           // 生成完成后也不多一条
    ui.clearCtl('chunk-ms'); ui.clearCtl('max-chunks');
  });

  // ---- B6:反向守卫 —— 两格看同一会话时,每格各 1 次是正常的,别误判 ------------------------
  test('B6 反向守卫:两格看同一会话时,每格各 1 次是正常的(要判的是每格内不超 1、且反复操作不累积)', async ({ page }) => {
    const sess = POOL[7];
    await ui.boot(page);
    await ui.openSessionBySearch(page, sess.mark);
    const mk = uniq('B6');
    ui.setCtl('max-chunks', 2); ui.setCtl('chunk-ms', 200);
    await ui.sendPrompt(page, mk);
    await page.waitForTimeout(7_000);

    // 把同一条会话也开进第 2 格(两格看同一会话)
    await ui.setPaneCount(page, 2);
    await page.waitForTimeout(1_000);
    await ui.fillPaneWithSession(page, 2, sess.mark);
    const ids = await ui.paneIdentities(page);
    expect(ids[1] && ids[1].ownerKey, `第 2 格应装进同一条会话;实际 ${JSON.stringify(ids)}`).not.toBe('');
    expect(ids[1].ownerKey, '前置:两格确实看的是同一会话').toBe(ids[0].ownerKey);

    const s = await survey(page, mk);
    // 每格各 1 次 —— 这是**正常**的,不算重复渲染
    for (const p of s.panes) {
      expect(p.messageCount, `看同一会话时,第 ${p.pane} 格内这条仍应恰好 1 次(两格各 1 次不算重复)\n${show(s)}`).toBe(1);
    }
    // 反复操作后不累积:每格还是 1
    for (let r = 1; r <= 3; r += 1) {
      await ui.setPaneCount(page, 1); await page.waitForTimeout(700);
      await ui.setPaneCount(page, 2); await page.waitForTimeout(700);
      const s2 = await survey(page, mk);
      for (const p of s2.panes) {
        expect(p.messageCount, `第 ${r} 轮开关之后,第 ${p.pane} 格内应仍是 1 次,不许累积\n${show(s2)}`).toBe(1);
      }
    }
    ui.clearCtl('max-chunks'); ui.clearCtl('chunk-ms');
  });
});

test.afterAll(() => {
  console.log(`[r121] 收尾杀掉的桩进程:${JSON.stringify(ui.killStubs())}`);
});
