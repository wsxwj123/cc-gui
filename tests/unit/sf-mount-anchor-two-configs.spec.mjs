// 【浏览器复现用例 · 待测试代理收编进锁定套件】
//
// 判据(0.2.383 必修-1):挂载窗口上沿因消息增长右移时,那条"锚定补偿"必须在
// **两种配置下各验一次** —— 默认(浏览器原生 scroll anchoring 开着)与容器
// `overflow-anchor:none`(等价真机 WKWebView)。
//
// 为什么必须两种都跑:Chromium/WebView2 与(本机的)Playwright WebKit **默认就开着
// 原生 scroll anchoring**,它已经先按被卸行高把 scrollTop 改好了。补偿若拿**变化后**
// 的 scrollTop 当基准(相对口径),就会在原生锚定的结果上再加一遍位移量 →
// 朝反方向多滚**一整个被卸行高**(实测 300px)。而 sf-mount-anchor.repro.spec.mjs
// 为了复现"原型缺陷"必须在容器上写 `overflow-anchor:none` —— 那正好是这个叠加
// 唯一不会发生的配置。所以只跑那一种 = 没验。
//
// 同一套现场,两种配置的通过判据完全一样:
//   新行落地前后,"视口最上方那一行"的 uuid 不变、屏幕偏移 ≤2px。
// 默认配置下**不**断言"scrollTop 被改过" —— 补偿在原生锚定已生效时收敛为不写
// (目标值 == 当前位置),写不写是引擎的事,视野不动才是判据。
//
// 跑法(与 repro 同:需要隔离实例,见套件 run-isolated.sh;本文件不在锁定套件里跑):
//   起实例 → BASE_URL=http://127.0.0.1:<port> npx playwright test -c <临时配置> <本文件>
//
// 现场三点(与 repro 逐字同,缺一个就复现不出来):夹具时间戳不影响本场景(不开流)、
// 新行走产品自己的 refetch 链(追加 jsonl + cgui:sessions-changed)。
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../node_modules/@playwright/test/index.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, mountedRowCount, scrollMetrics, userScroll,
  topVisibleRow,
} from '../acceptance/stripfold-20260913/helpers/runtime.mjs';
import { MARKER_B, SESSION_B, projectDir } from '../acceptance/stripfold-20260913/helpers/fixtures.mjs';

const SESSION_FILE = path.join(projectDir(), `${SESSION_B}.jsonl`);

const phText = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-cgui="message-list"]');
  return (el.querySelector('[data-turn-placeholder]')?.textContent || '').trim().replace(/\s+/g, '').slice(0, 8);
});

/** 追加一轮(用户 + 回复):形状克隆夹具最后两条真实转写行,只换 uuid/时间/正文。 */
function appendTurn(tag) {
  const lines = fs.readFileSync(SESSION_FILE, 'utf8').trim().split('\n');
  const lastUser = [...lines].reverse().find((l) => JSON.parse(l).type === 'user');
  const lastTurn = [...lines].reverse().find((l) => JSON.parse(l).type === 'assistant');
  const at = new Date().toISOString();
  const mk = (tpl, over) => JSON.stringify({ ...JSON.parse(tpl), ...over });
  fs.appendFileSync(SESSION_FILE, `${[
    mk(lastUser, { uuid: `sf-u-9${tag}`, timestamp: at, parentUuid: null, message: { role: 'user', content: `追加轮 ${tag}` } }),
    mk(lastTurn, {
      uuid: `sf-a-append-${tag}`, timestamp: at, parentUuid: `sf-u-9${tag}`,
      message: { ...JSON.parse(lastTurn).message, id: `sfA_append_${tag}`, content: [{ type: 'text', text: `追加轮 ${tag} 回复` }] },
    }),
  ].join('\n')}\n`);
}

/** 同一现场跑一次;disableNativeAnchor 只切"是否关掉浏览器自带锚定"这一个变量。 */
async function scene(page, { disableNativeAnchor }) {
  await primeOverlays(page);
  await openApp(page);
  await openSessionByMarker(page, MARKER_B);
  await expect.poll(async () => await mountedRowCount(page), { timeout: 60_000 }).toBeGreaterThan(3);
  await page.waitForTimeout(2500);   // 历史全量加载稳定

  if (disableNativeAnchor) {
    await page.evaluate(() => {
      const el = document.querySelector('[data-cgui="message-list"]');
      el.style.overflowAnchor = 'none';
      document.documentElement.style.overflowAnchor = 'none';
    });
  }

  await userScroll(page, -260, { steps: 2 });   // 小幅度上滚:离顶几屏,不触发补齐 → mountFrom 仍为 null
  await page.waitForTimeout(800);
  const m0 = await scrollMetrics(page);
  const t0 = await topVisibleRow(page);
  const p0 = await phText(page);
  expect(m0.scrollTop, '前提:还没滚到顶(不触发补齐)').toBeGreaterThan(m0.clientHeight + 200);

  appendTurn(`t${Date.now()}${disableNativeAnchor ? 'n' : 'a'}`);   // 新行落地(用户 + 回复)
  await page.evaluate((sid) => {
    window.dispatchEvent(new CustomEvent('cgui:sessions-changed', { detail: { path: `/${sid}.jsonl` } }));
  }, SESSION_B);
  await expect.poll(async () => await phText(page), { timeout: 25_000, message: '新行没有落地(刷新链没生效)' })
    .not.toBe(p0);   // 窗口上沿往前挪了 = 真有行从顶上被卸掉

  const m1 = await scrollMetrics(page);
  const t1 = await topVisibleRow(page);
  console.log(`[two-config] ${disableNativeAnchor ? 'overflow-anchor:none' : '默认(原生锚定开)'}`
    + `｜scrollTop ${m0.scrollTop} → ${m1.scrollTop}`
    + `｜最上一行 ${t0?.uuid}@${t0?.offsetFromBoxTop}px → ${t1?.uuid}@${t1?.offsetFromBoxTop}px`);
  expect(t1?.uuid, '新行落地不得把视野顶走(视口最上一行应当还是同一行)').toBe(t0?.uuid);
  expect(Math.abs(t1.offsetFromBoxTop - t0.offsetFromBoxTop), '同一行的屏幕偏移不许跳(≤2px)').toBeLessThanOrEqual(2);
  return { m0, m1, t0, t1 };
}

test('SF-3xx-A 默认配置(原生 scroll anchoring 开着,≈WebView2):新行落地不得把视野顶走', async ({ page }) => {
  test.setTimeout(120_000);
  const r = await scene(page, { disableNativeAnchor: false });
  // 默认配置下由引擎自己补,应用层写不写都行 —— 只认"视野不动"。原生锚定若把
  // scrollTop 改了,这里应当看得见变化(它替我们做了),不作断言,只落日志。
  expect(r.m1.scrollTop, '默认配置下原生锚定会把 scrollTop 减掉被卸高度').not.toBe(Number.NaN);
});

test('SF-3xx-B 容器 overflow-anchor:none(≈真机 WKWebView):同一现场同样不得把视野顶走', async ({ page }) => {
  test.setTimeout(120_000);
  const r = await scene(page, { disableNativeAnchor: true });
  // 没有原生锚定兜底 → 应用补偿必须真的写回(不写就是原缺陷)。
  expect(r.m1.scrollTop, '补偿必须真的写回 scrollTop(这条配置下没有浏览器兜底)').not.toBe(r.m0.scrollTop);
});
