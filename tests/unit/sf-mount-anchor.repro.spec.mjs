// 【浏览器复现用例 · 待测试代理收编进锁定套件】
//
// 判据(缺陷:渐进挂载窗口上沿因消息增长右移时没有补偿):
//   用户在窗口**中段**读历史(away;mountFrom 仍为 null)时新行落地 →
//   `from = 总数 − K` 跟着往前挪、顶上几行被卸掉 → scrollTop 既不钳也不补偿 →
//   眼前那段内容整体跳上来(实测跳掉整段被卸行的高度)。
//   断言:"视口最上方那一行"的 uuid 与屏幕偏移,在新行落地前后必须一致(≤2px)。
//
// 现状:本条**不在**锁定套件里跑(套件只读,不能加文件)。它是修这条缺陷时的实测现场,
// 收编方式见下面的三个坑 —— 缺一个就复现不出来(我在这里绕了很久):
//   坑① 夹具 B 的时间戳是"未来时刻"(2026-09-13T10:xxZ,而机器现在是 02:xxZ)→ 流期截断
//       (streamHistCutoff)会把整段历史当成"本回合新行"滤掉,现场全乱。把夹具时间戳
//       整体挪到过去(或让夹具用真实过去时间)。
//   坑② 浏览器自带的 scroll anchoring 会替你补偿(Playwright 的 WebKit 会,真机 macOS
//       WKWebView 不会 —— App.jsx 注释写明)。必须在滚动容器上 `overflow-anchor: none`,
//       否则无论修没修,这条用例都是绿的。
//   坑③ "新行落地"用产品自己的刷新链:往会话 jsonl 追加两条(用户 + 回复,形状克隆夹具最后
//       两条真实转写行)+ 派发 `cgui:sessions-changed`(WS 的 file-change 走同一条 refetch 链)。
//       别走"发一条消息让假 CLI 回合收官"那条路:假 CLI 的 scenario 只在进程启动时读一次,
//       复用常驻进程时不生效,而且它会把转写写进**新**会话 id,被打开的会话永远等不到持久化轮。
//
// 跑法(需要隔离实例,见套件 run-isolated.sh):
//   cd <套件目录> && TMPDIR=/tmp ./run-isolated.sh --grep nothing   # 只为起实例则看脚本内的启动命令
//   BASE_URL=http://127.0.0.1:<port> npx playwright test -c <本目录的临时配置> \
//     tests/unit/sf-mount-anchor.repro.spec.mjs
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

test('SF-3xx 滚到中段时新行落地,视口不得被顶走', async ({ page }) => {
  await primeOverlays(page);
  await openApp(page);
  await openSessionByMarker(page, MARKER_B);
  await expect.poll(async () => await mountedRowCount(page), { timeout: 60_000 }).toBeGreaterThan(3);
  await page.waitForTimeout(2500);   // 历史全量加载稳定

  // 坑②:关掉浏览器自带的 scroll anchoring(真机 WKWebView 没有这个能力)
  await page.evaluate(() => {
    const el = document.querySelector('[data-cgui="message-list"]');
    el.style.overflowAnchor = 'none';
    document.documentElement.style.overflowAnchor = 'none';
  });

  await userScroll(page, -260, { steps: 2 });   // 小幅度上滚:离顶几屏,不触发补齐 → mountFrom 仍为 null
  await page.waitForTimeout(800);
  const m0 = await scrollMetrics(page);
  const t0 = await topVisibleRow(page);
  const p0 = await phText(page);
  expect(m0.scrollTop, '前提:还没滚到顶(不触发补齐)').toBeGreaterThan(m0.clientHeight + 200);

  appendTurn(`t${Date.now()}`);                  // 新行落地(用户 + 回复)
  await page.evaluate((sid) => {
    window.dispatchEvent(new CustomEvent('cgui:sessions-changed', { detail: { path: `/${sid}.jsonl` } }));
  }, SESSION_B);
  await expect.poll(async () => await phText(page), { timeout: 25_000, message: '新行没有落地(刷新链没生效)' })
    .not.toBe(p0);   // 窗口上沿往前挪了 = 真有行从顶上被卸掉(挂载行数不会变多,那正是缺陷本身)

  const m1 = await scrollMetrics(page);
  const t1 = await topVisibleRow(page);
  expect(t1?.uuid, '新行落地不得把视野顶走(视口最上一行应当还是同一行)').toBe(t0?.uuid);
  expect(Math.abs(t1.offsetFromBoxTop - t0.offsetFromBoxTop), '同一行的屏幕偏移不许跳').toBeLessThanOrEqual(2);
  expect(m1.scrollTop, '补偿必须真的写回 scrollTop(不是靠浏览器锚定)').not.toBe(m0.scrollTop);
});
