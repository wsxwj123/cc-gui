// T-4xx · 历史操作完成后的备份入口：**不许把整份原文倒进界面**，点它界面不得无响应
//（用户实报：编辑消息重发 → 出现「查看备份」→ 一点整个界面卡死）。
//
// 修前现场（已留证）：历史操作会为会话留一份 .histbak-* 原文副本；「查看备份」把这份 16.9MB /
//   1691 万字符的副本**整份**倒进弹层 <pre> → 正文 347 万 px 高、界面 38.1s 对任何操作没应答。
// 修后口径（用户已拍板）：备份照留（服务端一个字没动），**砍掉应用内全文查看**，
//   入口改成「在访达中显示」→ POST /api/sessions/:sid/backups/:ref/reveal（路径只由服务端取）。
//
// 本文件三条用例：
//   T-402 端点契约：请求发出、成功、**响应里没有全文**；非法/不存在的引用拿不到内容
//   T-401 界面行为：入口换了新文案、**不再有把全文塞进 DOM 的路径**、点它界面全程有响应
//   T-403 取证：用户实报的"裁剪历史"路径确实留下整份原文备份（与 T-401 是同一件事的两半）
//   （T-402/T-403 排在 T-401 前面：T-401 修前会把浏览器主线程占住几十秒，历史上偶发过
//    "跑完它之后隔离实例不再应答"，取证型用例不该被它拖累。）
//
// 说明（如实标注的偏差）：用户实报的入口是"编辑消息重新发送"产生的**裁剪历史**备份；
//   界面用例走的是同一族历史操作里的「官方兼容体检与清理」（都写 .histbak-*、都进同一个入口），
//   因为前者要在 UI 里走编辑→重发（重发要真回合，本隔离实例没有可用凭据）。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ensureFixtures, primeBigSession, projectDir, SESSION_BIG } from './helpers/fixtures.mjs';
import { getRuntime, openApp, openSession, dismissOverlays, clickThroughOverlays } from './helpers/runtime.mjs';

const fx = ensureFixtures();

/**
 * 判据（修后口径）：
 *   · 点入口这个动作本身 ≤3s（修前 38.3s）
 *   · 点完之后界面最久 ≤1s 没应答（修前 38.1s 全程冻住）
 *   · 界面里不得出现高度 >20 万 px 的块（修前备份正文 347.9 万 px），
 *     也不得有任何一段文本节点超过 30 万字符（修前 <pre> 里 1691 万字符）
 */
const MAX_CLICK_MS = 3_000;
const MAX_UNRESPONSIVE_MS = 1_000;
const MAX_BLOCK_HEIGHT_PX = 200_000;
const MAX_TEXT_NODE_CHARS = 300_000;

/** 入口文案随平台走（实现里就这么写的）：mac 访达 / Windows 资源管理器 / 其余文件管理器。 */
const REVEAL_BUTTON = /^在(访达|资源管理器|文件管理器)中显示$/;

/**
 * 界面有多"重"：最高的块有多高、最长的单个文本节点有多少字符。
 * 这两条是"有没有再往 DOM 里灌全文"的硬指标 —— 与按钮文案无关，修前一定会爆。
 * （在页面里跑，别引用外面任何东西。）
 */
function measureDomWeight() {
  let maxHeight = 0;
  let tallest = '';
  for (const el of document.querySelectorAll('*')) {
    const h = el.getBoundingClientRect().height;
    if (h > maxHeight) { maxHeight = h; tallest = `${el.tagName}.${String(el.className || '').slice(0, 40)}`; }
  }
  let maxText = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) { if (node.length > maxText) maxText = node.length; node = walker.nextNode(); }
  return { maxHeight: Math.round(maxHeight), tallest, maxText };
}

/**
 * 界面响应探针：从测试进程里每 ~100ms 问页面一句"你还在吗"（一次极廉价的 evaluate），
 * 记下两次回答之间的最大间隔。主线程被排版占住时页面答不出来，这个最大间隔就是
 * 用户肉眼看到的"卡死"时长（语义：这段时间里点什么都没反应）。
 * 刻意不用页面里的定时器采样：主线程被占住时页面自己的定时器也在排队，读回来的数会失真。
 */
function startResponsivenessProbe(page) {
  const state = { max: 0, polls: 0, stopped: false };
  const loop = (async () => {
    let last = Date.now();
    while (!state.stopped) {
      try { await page.evaluate(() => 1); } catch { break; }
      const now = Date.now();
      if (now - last > state.max) state.max = now - last;
      last = now;
      state.polls += 1;
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return { state, stop: async () => { state.stopped = true; await loop; return state; } };
}

/** 右侧那条"历史操作完成"的提示条：认它自己的关闭按钮（公开 aria-label），再从它往上取容器。 */
const backupNotice = (page) => page.getByRole('button', { name: '关闭备份入口' }).locator('..');
/** 入口按钮（文案随平台走）。 */
const revealEntry = (page) => backupNotice(page).getByRole('button', { name: REVEAL_BUTTON });

/** 走一遍真实链路，把"历史操作完成 + 备份入口已出现"这一步做到位，返回这次备份的体积。 */
async function reachBackupNotice(page) {
  await openApp(page);
  await openSession(page, fx.markers.big);
  await dismissOverlays(page);

  // ⋮ → 官方兼容体检与清理（会话级常驻入口）
  await page.locator('[data-cgui="session-menu"] button').last().click();
  const repairEntry = page.locator('button[title^="官方兼容体检与清理"]');
  await expect(repairEntry).toBeVisible({ timeout: 20_000 });
  await clickThroughOverlays(page, repairEntry);

  // 体检结果：夹具会话里确实有空 text 块 → 出现「清理（自动备份原文件）」
  const cleanButton = page.getByRole('button', { name: '清理（自动备份原文件）', exact: true });
  await expect(cleanButton, '夹具大会话里应能体检出可清理的空内容块').toBeVisible({ timeout: 60_000 });
  await cleanButton.click();

  await expect(backupNotice(page), '历史操作完成后应出现结果提示条').toBeVisible({ timeout: 60_000 });
  await expect(backupNotice(page)).toContainText('官方兼容修复完成');

  // 体检弹层的遮罩会挡住右下角提示条，先把它关掉
  const modalClose = page.locator('div.glass-popover').last().getByRole('button', { name: '关闭', exact: true });
  await modalClose.last().click({ timeout: 10_000 });
  await expect(backupNotice(page)).toBeVisible();

  const backups = fs.readdirSync(projectDir()).filter((n) => n.startsWith(`${SESSION_BIG}.jsonl.histbak-`));
  expect(backups.length, '历史操作应在会话目录留下 .histbak-* 备份').toBeGreaterThan(0);
  const backupBytes = Math.max(...backups.map((n) => fs.statSync(path.join(projectDir(), n)).size));
  expect(backupBytes, '备份是整个会话的原文副本（备份本身照留，只是界面不再整车倒进来）').toBeGreaterThan(15 * 1024 * 1024);
  return { backupBytes };
}

test.describe('历史操作备份查看', () => {
  test.beforeEach(() => { primeBigSession(); });
  test.setTimeout(240_000);

  // 这一条故意排在 T-401 前面：T-401 会把浏览器主线程占住 39 秒，历史上偶发过
  // "跑完 T-401 之后隔离实例不再应答"（见 TEST-RUN 的遗留风险）。T-403 只是取证，
  // 不该被排在它后面拖累。
  test('T-403 用户实报的「裁剪历史」路径同样留下一整份会话原文备份（卡死的直接来源）', async ({ request }) => {
    const { baseURL } = getRuntime();
    // 先确认实例还活着：这条若是被"实例没了"害红的，必须报成环境问题而不是产品问题
    const health = await request.get(`${baseURL}/api/health`).catch(() => null);
    if (!health?.ok()) {
      throw new Error(`ENVIRONMENT_BLOCKED: 隔离实例 ${baseURL} 此刻不可用（HTTP ${health?.status() ?? 'no response'}）`);
    }
    const sessionFile = path.join(projectDir(), `${SESSION_BIG}.jsonl`);
    const sessionBytes = fs.statSync(sessionFile).size;

    // 与产品客户端同一条合同：先 dryRun 预览，再带令牌与基准版本提交。
    const preview = await request.post(`${baseURL}/api/sessions/${SESSION_BIG}/trim`, {
      data: { projectHash: fx.projectHash, fromTimestamp: new Date(Date.UTC(2026, 8, 12, 10, 30)).toISOString(), dryRun: true },
    });
    expect(preview.status(), '裁剪预览应当成功').toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.previewToken, '裁剪预览必须给出预览令牌').toBeTruthy();

    const submit = await request.post(`${baseURL}/api/sessions/${SESSION_BIG}/trim`, {
      data: {
        projectHash: fx.projectHash,
        fromTimestamp: new Date(Date.UTC(2026, 8, 12, 10, 30)).toISOString(),
        dryRun: false, baseVersion: previewBody.baseVersion, previewToken: previewBody.previewToken,
      },
    });
    expect(submit.status(), '裁剪提交应当成功').toBe(200);
    const submitted = await submit.json();
    expect(submitted.backupRef, '裁剪完成必须给出备份引用（界面上的备份入口就是按它取文件的）').toBeTruthy();

    const backups = fs.readdirSync(projectDir()).filter((n) => n.startsWith(`${SESSION_BIG}.jsonl.histbak-`));
    expect(backups.length).toBeGreaterThan(0);
    const biggest = Math.max(...backups.map((n) => fs.statSync(path.join(projectDir(), n)).size));
    expect(biggest, `裁剪留下的备份 ${biggest} 字节，会话本身 ${sessionBytes} 字节 —— 备份是整份原文`)
      .toBeGreaterThan(sessionBytes * 0.9);

    // 修前这份整份原文就是被倒进 DOM 的东西（正文 347 万 px 高、界面冻 38.1s）。
    // 修后连"交给浏览器"这条网线都掐了：接口只回元数据，正文一律不进 HTTP 响应 ——
    // 所以就算界面哪天再想整车渲染，也拿不到原文。这是"不再有把全文塞进 DOM 的路径"的最后一道闸。
    const fetched = await request.get(`${baseURL}/api/sessions/${SESSION_BIG}/backups/${submitted.backupRef}`);
    expect(fetched.status()).toBe(200);
    const rawBody = await fetched.text();
    const body = JSON.parse(rawBody);
    expect(body.bytes, '备份元数据要报出真实体积（整份会话原文 16.9MB，备份照留）').toBeGreaterThan(15 * 1024 * 1024);
    expect(rawBody.length, `这次的响应体只有 ${rawBody.length} 字符 —— 正文不该再走 HTTP`).toBeLessThan(10_000);
    expect(body.content, '响应里不该再有 content 全文').toBeUndefined();
    expect(body.fileName, '只给展示用文件名，不给完整服务器路径').toBeTruthy();
    expect(String(body.path || ''), '响应里不该带服务器上的完整路径').toBe('');
  });

  test('T-401 备份入口不再把全文塞进界面，点它界面全程有响应（修前 38.1s 冻住）', async ({ page }) => {
    const { backupBytes } = await reachBackupNotice(page);

    // ① 入口形态：不再有「查看备份」，换成「在访达中显示」
    expect(await page.getByRole('button', { name: '查看备份' }).count(), '「查看备份」这个入口应当已经不存在').toBe(0);
    const reveal = revealEntry(page);
    await expect(reveal, '应换成"在访达中显示"这类入口').toBeVisible();
    if (process.platform === 'darwin') {
      await expect(reveal).toHaveText('在访达中显示'); // 平台上就这么写的（Win/Linux 另有文案）
    }

    const before = await page.evaluate(measureDomWeight);

    const probe = startResponsivenessProbe(page);
    // 先等探针真的跑起来（这个会话有 16.9MB 文本在消息列表里，刚关掉体检弹层时浏览器要重绘
    // 一大阵，第一轮问答可能要等一两秒），否则基线会读成"0 次"。
    await expect.poll(() => probe.state.polls, { timeout: 60_000, message: '界面响应探针必须跑起来' }).toBeGreaterThan(2);

    const clickAt = Date.now();
    await reveal.click();
    const clickMs = Date.now() - clickAt;
    console.log(`[T-401] 点「${(await reveal.textContent())?.trim()}」用时 ${clickMs}ms（上限 ${MAX_CLICK_MS}ms）`);

    // 给这次交互（请求 + 服务端在文件管理器里定位文件 + 界面更新）留出完成时间，
    // 期间探针一直在问"你还在吗"。
    await page.waitForTimeout(2_000);
    const freeze = await probe.stop().catch(() => null);
    console.log(`[T-401] 界面最久多久没应答：${freeze?.max ?? 'n/a'}ms（上限 ${MAX_UNRESPONSIVE_MS}ms）`);

    // 这一条只看"界面还有没有反应、有没有再灌全文"。至于"这台机器能不能真的在访达里定位文件"
    // 属于环境能力：界面报错就如实标成环境阻断（请求本身发没发出去、服务端答了什么，见 T-402）。
    const noticeText = (await backupNotice(page).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const leftovers = noticeText.replace('官方兼容修复完成', '').replace(String(await reveal.textContent()).trim(), '').replace('×', '').trim();
    if (leftovers) {
      throw new Error(`ENVIRONMENT_BLOCKED: 界面回报"${leftovers}" —— 本环境可能没法在文件管理器里定位文件（请求已发出，服务端答复见 T-402）`);
    }

    const after = await page.evaluate(measureDomWeight);
    const dialogCount = await page.locator('div[role="dialog"]').count();
    console.log(`[T-401] 界面里最重的块：点之前 ${before.maxHeight}px / 最长文本 ${before.maxText} 字符`
      + `（最高：${before.tallest}）；点之后 ${after.maxHeight}px / 最长文本 ${after.maxText} 字符（最高：${after.tallest}）`);
    console.log(`[T-401] 备份文件 ${(backupBytes / 1048576).toFixed(1)}MB；弹层数量 ${dialogCount}`);

    const problems = [];
    if (clickMs > MAX_CLICK_MS) problems.push(`点入口用了 ${clickMs}ms（上限 ${MAX_CLICK_MS}ms）`);
    if ((freeze?.max ?? 0) > MAX_UNRESPONSIVE_MS) problems.push(`界面最久 ${freeze?.max}ms 对任何操作没应答（上限 ${MAX_UNRESPONSIVE_MS}ms）`);
    if (after.maxHeight > MAX_BLOCK_HEIGHT_PX) {
      problems.push(`界面里出现了 ${after.maxHeight}px 高的块（上限 ${MAX_BLOCK_HEIGHT_PX}px；最高的那个是 ${after.tallest}）`);
    }
    if (after.maxText > MAX_TEXT_NODE_CHARS) {
      problems.push(`界面里有一整段 ${after.maxText} 字符的文本（上限 ${MAX_TEXT_NODE_CHARS} 字符 —— 这份备份是 ${(backupBytes / 1048576).toFixed(1)}MB 原文）`);
    }
    if (dialogCount > 0) problems.push(`还开着 ${dialogCount} 个弹层（应用内全文查看这条路径应当已经去掉）`);
    expect(problems, `备份入口又把整份原文倒进界面了：\n- ${problems.join('\n- ')}`).toEqual([]);
  });

  test('T-402 「在访达中显示」端点：请求发出且成功，响应里没有全文内容', async ({ request }) => {
    const { baseURL } = getRuntime();
    const health = await request.get(`${baseURL}/api/health`).catch(() => null);
    if (!health?.ok()) {
      throw new Error(`ENVIRONMENT_BLOCKED: 隔离实例 ${baseURL} 此刻不可用（HTTP ${health?.status() ?? 'no response'}）`);
    }
    // 先做一次真历史操作，拿到一个真备份引用
    const from = new Date(Date.UTC(2026, 8, 12, 10, 30)).toISOString();
    const preview = await request.post(`${baseURL}/api/sessions/${SESSION_BIG}/trim`, {
      data: { projectHash: fx.projectHash, fromTimestamp: from, dryRun: true },
    });
    expect(preview.status()).toBe(200);
    const previewBody = await preview.json();
    const submit = await request.post(`${baseURL}/api/sessions/${SESSION_BIG}/trim`, {
      data: { projectHash: fx.projectHash, fromTimestamp: from, dryRun: false, baseVersion: previewBody.baseVersion, previewToken: previewBody.previewToken },
    });
    expect(submit.status()).toBe(200);
    const backupRef = (await submit.json()).backupRef;
    expect(backupRef).toBeTruthy();

    const reveal = await request.post(`${baseURL}/api/sessions/${SESSION_BIG}/backups/${backupRef}/reveal`);
    const raw = await reveal.text();
    if (reveal.status() !== 200) {
      // 这条只可能是"这台机器开不了文件管理器"（无头/无图形会话）—— 如实报成环境阻断，
      // 而不是产品问题；但请求确实发出去了、服务端也确实答复了，这一点如实写进报错里。
      throw new Error(`ENVIRONMENT_BLOCKED: 备份定位请求已发出、服务端答复 HTTP ${reveal.status()}（${raw.slice(0, 200)}）—— 本环境没法在文件管理器里定位文件`);
    }
    expect(raw.length, `定位接口的响应不该带上正文（整份备份 16.9MB，响应只有 ${raw.length} 字符）`).toBeLessThan(10_000);
    expect(raw.includes('"content"'), '定位接口的响应里不该有 content 全文').toBe(false);
    console.log(`[T-402] POST …/backups/${backupRef}/reveal → 200，响应体 ${raw.length} 字符：${raw.slice(0, 80)}`);

    // 备份引用不认识 / 明显想拿它当路径穿越时：拿不到内容，也开不了东西
    const unknown = await request.post(`${baseURL}/api/sessions/${SESSION_BIG}/backups/bugs-no-such-ref-000/reveal`);
    expect([400, 404], `不存在的备份引用应当被拒，实际 HTTP ${unknown.status()}`).toContain(unknown.status());
    const traversal = await request.post(`${baseURL}/api/sessions/${SESSION_BIG}/backups/${encodeURIComponent('../../etc/passwd')}/reveal`);
    expect([400, 404], `带路径段的引用必须被拒（接口绝不接受客户端传路径），实际 HTTP ${traversal.status()}`).toContain(traversal.status());
  });

});
