// UI 层(浏览器)用例:上一轮只锁了源码字面量,没起浏览器 —— 这里补上。
//
//   UI-1  meta.stale 的显示规则:true → 「统计中,数据可能略旧」出现;false → 消失(输入打桩)
//   UI-2  真机上收到 usage-updated 广播后面板静默刷新(真实例 + 真 WS,不打桩)
//
// 为什么 UI-1 打桩、UI-2 不打桩:
//   · 显示规则只取决于服务端给的 meta.stale,打桩能给"true/false 一对"最干净的输入;
//   · "广播→刷新"是链路行为(服务端重算 → WS 广播 → 页面监听 → 静默重取),任何一环打桩都
//     等于把要验的东西换掉,所以真实例、真 WS、真重扫,只观察界面。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startInstance, stopInstance, getUsage, mainHome, rmCache } from './helpers/runtime.mjs';
import { ensureFixture, projectsDir } from './helpers/fixtures.mjs';
import { assertClientDistFresh, openUsagePanel } from './helpers/ui-runtime.mjs';

const STALE_NOTE = '统计中，数据可能略旧';
// 探针记录:与 U3b 同一手法 —— 追加到某个会话文件上,让磁盘缓存的 sig 必然对不上,
// 于是实例重启后的首请求走"磁盘回放(stale=true)+后台重扫",重扫落地即广播。
const PROBE_MODEL = 'claude-opus-9-ui-probe';

let inst = null;
let base = '';
let target = '';
let sizeBefore = 0;

test.beforeAll(async () => {
  const fresh = assertClientDistFresh();
  console.log(`[ui] dist=${new Date(fresh.distAt).toISOString()}`);
  const { reused, stats } = ensureFixture();
  console.log(`[ui] 夹具 ${stats.files} 文件 / ${(stats.bytes / 1048576).toFixed(1)}MB / ${reused ? '复用' : '新造'}`);

  // 造"磁盘缓存已存在、且与当前夹具 sig 不一致"的初态(U2/UI-2 的前提),不依赖别的套件先跑过:
  //   ① 先删掉旧缓存,在**干净夹具**上冷扫一次 → 落盘一份不含探针的缓存;
  //   ② 再改夹具 → 那份缓存就成了"旧值"。
  // ①的删是必须的:上一轮 UI-2 跑完留下的缓存本身就含探针记录,不清的话"探针出现在界面上"
  // 可能是首帧回放的旧值(断言恒真),而不是广播刷新的结果。
  rmCache(mainHome());
  const prime = await startInstance({ home: mainHome(), label: 'ui-prime' });
  const primed = await getUsage();
  await stopInstance(prime);
  if (primed.status !== 200 || !primed.body?.total) throw new Error(`预热实例没拿到用量(HTTP ${primed.status})`);
  // stale=false = 这一发真的是现算的冷扫(不是回放),缓存内容才与当前夹具一致
  expect(primed.body.meta?.stale, `预热必须是冷扫(无缓存时 meta.stale=false),实际 ${JSON.stringify(primed.body.meta)}`).toBe(false);
  console.log(`[ui] 已造出磁盘缓存(冷扫 ${primed.ms.toFixed(0)}ms / ${primed.body.total.sessionCount} 会话)`);

  target = path.join(projectsDir(), '-p23', 's042.jsonl');
  sizeBefore = fs.statSync(target).size;
  fs.appendFileSync(target, JSON.stringify({
    type: 'assistant', uuid: 'u-ui-probe', timestamp: '2026-09-14T14:00:00.000Z',
    message: { id: 'msg_ui_probe', model: PROBE_MODEL, usage: { input_tokens: 900_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + '\n');

  inst = await startInstance({ home: mainHome(), label: 'ui-stale' });
  base = `http://127.0.0.1:${inst.port}`;
  console.log(`[ui] 实例 pid=${inst.pid} port=${inst.port};夹具已加一行(${PROBE_MODEL})→ 缓存 sig 必然对不上`);
});

test.afterAll(async () => {
  await stopInstance(inst);
  // 夹具复原。这一步没跑到(进程被杀)→ 下一次跑套件时 fixtures.mjs 的对账会当场认出漂移并重造。
  if (target) fs.truncateSync(target, sizeBefore);
});

// ── UI-1:显示规则(输入打桩,true/false 一对)────────────────────────────
test('UI-1 meta.stale=true 时出现「统计中,数据可能略旧」,false 时消失', async ({ page }) => {
  let stale = true;
  const payload = {
    total: { input: 1_234_000, output: 56_000, cacheRead: 0, cacheWrite: 0, sessionCount: 3 },
    byModel: [
      { model: 'ui-fixture-alpha', input: 1_000_000, output: 50_000, cacheRead: 0, cacheWrite: 0, calls: 10 },
      { model: 'ui-fixture-beta', input: 234_000, output: 6_000, cacheRead: 0, cacheWrite: 0, calls: 4 },
    ],
    byProject: [], byDay: [],
    meta: { scannedAt: 1_760_000_000_000, stale },
  };
  await page.route('**/api/usage', (route) => route.fulfill({
    status: 200, contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ ...payload, meta: { scannedAt: payload.meta.scannedAt, stale } }),
  }));
  await openUsagePanel(page, base);

  const note = page.getByText(STALE_NOTE);
  await expect(page.getByText('ui-fixture-alpha').first(),
    '前提:面板确实渲染了打桩数据(不是"没渲染所以文案也不在")').toBeVisible();
  await expect(note, 'stale=true 表示"这是磁盘回放的旧值,后台在核对" —— 必须如实说明').toHaveCount(1);
  await expect(note).toBeVisible();

  stale = false;   // 服务端已核对完 = 手上这份就是当前数据,再挂"可能略旧"是假话
  await page.getByRole('button', { name: '刷新', exact: true }).first().click();
  await expect(note, 'stale=false 时那句提示必须消失').toHaveCount(0);
  await expect(page.getByText('ui-fixture-alpha').first(),
    '提示消失后数据仍在 —— 证明上一条不是"面板崩了"').toBeVisible();
});

// ── UI-2:广播 → 静默刷新(真实例、真 WS、真重扫)──────────────────────────
test('UI-2 重算广播落地后面板静默刷新:stale 提示消失 + 新数据出现 + 不闪 loading', async ({ page }) => {
  // 面板的中间态是"瞬间"的(重扫 250ms 就落地了),靠"某一刻去截图"必然与它赛跑。
  // 所以从页面脚本一开始就挂一个状态时间线:只在状态变化时记录一条
  // { loading: 是否在"正在统计全部会话"帧, stale: 是否有那句提示 }。
  // 于是"那句提示**出现过**"与"loading 之后再没闪过"都变成对时间线的判定,不比手速。
  await page.addInitScript(() => {
    window.__uiTimeline = [];
    const sample = () => {
      const t = document.body?.innerText || '';
      return { loading: t.includes('正在统计全部会话'), stale: t.includes('统计中，数据可能略旧') };
    };
    let last = null;
    const tick = () => {
      const s = sample();
      if (!last || last.loading !== s.loading || last.stale !== s.stale) {
        window.__uiTimeline.push({ t: Date.now(), ...s });
        last = s;
      }
    };
    const install = () => { new MutationObserver(tick).observe(document.body, { childList: true, subtree: true, characterData: true }); tick(); };
    if (document.body) install();
    else document.addEventListener('DOMContentLoaded', install);
  });

  const usageReqs = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/usage') usageReqs.push(Date.now()); });

  await openUsagePanel(page, base);
  const before = usageReqs.length;

  // 1) 首帧是磁盘回放:夹具刚被改过,sig 必然对不上 → 服务端如实标 stale=true。
  //    面板是异步拿这份响应的,所以等"时间线上出现过 stale 帧",而不是"此刻正好看得见"。
  await expect.poll(async () => (await page.evaluate(() => window.__uiTimeline)).some((e) => e.stale),
    { message: '首请求是磁盘回放(stale=true),面板必须如实说明"数据可能略旧"', timeout: 15_000 }).toBe(true);

  // 2) 重扫由面板自己的首请求触发;落地即广播 usage-updated → 面板静默重取。
  //    全程没有任何用户操作:新模型出现在界面上 = 广播链路真的通了。
  await expect(page.getByText(PROBE_MODEL).first(),
    `广播之后面板必须自己把新数据取回来(byModel 里应出现 ${PROBE_MODEL};首帧的旧值里没有它)`).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(STALE_NOTE), '重扫落地后 stale 回 false,那句提示必须消失').toHaveCount(0);

  const timeline = await page.evaluate(() => window.__uiTimeline);
  // 「静默」的判据:面板**只在打开那一次**进了 loading 态。再刷新时若又闪回 loading,
  // 时间线里就会出现第二个 loading 帧(轮询/广播走的是 fetchStats(true) 静默分支)。
  expect(timeline.filter((e) => e.loading).length,
    `面板只该在打开那一次闪 loading(时间线:${JSON.stringify(timeline)})`).toBe(1);
  expect(usageReqs.length, `面板应当发起了第二次 /api/usage(静默刷新),实际 ${usageReqs.length} 次`)
    .toBeGreaterThan(before);
});
