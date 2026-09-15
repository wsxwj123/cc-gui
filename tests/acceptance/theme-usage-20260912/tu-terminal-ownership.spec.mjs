// TU-4xx：R39 终端面板底部「当前连接不拥有该终端」。
//
// BRIEF 已核实的结论：那行字来自服务端的 `TERM_FORBIDDEN`（判据 = 你不是该终端当前持有者），
// **单个连接、自己开的终端不会出现**；能触发的现实形态只有"同一 terminalId 被另一条活跃 ws 接管"。
// 因此本套件**刻意不写**"制造一次 takeover 让它出现"的用例（那需要第二条 ws 抢同一个 terminalId，
// 且 BRIEF 明确本批不改这块、不补 term-detached）；这里只验需求书点名可测的那一半：
// **单连接自开终端不得出现该行**。BRIEF 的结论由"不得出现"这条负向断言 + 代码里的保护层共同支撑。
//
// 反向断言的强度保障：除了每步查一次，另在页面里挂一个 MutationObserver 记录"这行字曾经出现过"
// 的次数 —— 一闪而过的形态也逃不掉。
import { test, expect } from '@playwright/test';
import {
  getRuntime, openFixtureSession, openTerminalPanel, closePanelTerminals,
} from './helpers/tu-runtime.mjs';

const FORBIDDEN_LINE = '当前连接不拥有该终端';
const SHELL_PROMPT = /@[^\s@]+\s.*[%$#]\s*$/;

/** 在页面里挂"这行字有没有出现过"的观察器（只观察，不改 DOM）。 */
async function installForbiddenWatcher(page) {
  await page.evaluate((needle) => {
    window.__tuForbiddenHits = 0;
    window.__tuForbiddenSamples = [];
    const check = () => {
      if (document.body && document.body.innerText.includes(needle)) {
        window.__tuForbiddenHits += 1;
        if (window.__tuForbiddenSamples.length < 3) {
          window.__tuForbiddenSamples.push(document.body.innerText.slice(0, 400));
        }
      }
    };
    window.__tuForbiddenObserver = new MutationObserver(check);
    window.__tuForbiddenObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    check();
  }, FORBIDDEN_LINE);
}

async function forbiddenHits(page) {
  return await page.evaluate(() => window.__tuForbiddenHits || 0);
}

test('TU-401 单连接自开终端：开→输入→改窗口尺寸→收起→展开→关闭，全程不得出现「当前连接不拥有该终端」', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  await openFixtureSession(page, { baseURL });
  try {
    await openTerminalPanel(page);
    await installForbiddenWatcher(page);

    // 输入一条命令（走真实 shell）
    await page.keyboard.type("echo TU_OWN_$(( 6 * 7 ))");
    await page.keyboard.press('Enter');
    await expect(page.getByText('TU_OWN_42').first(), '终端必须真的能跑命令（否则这条负向断言没意义）')
      .toBeVisible({ timeout: 20_000 });

    // 面板收起 → 展开（这条路径会让终端脱离/重挂，正是最容易冒出归属提示的地方）
    const toggle = page.getByRole('button', { name: '终端', exact: true }).first();
    await toggle.click();
    await expect(page.getByText('TU_OWN_42')).toBeHidden();
    await toggle.click();
    await expect(page.getByText(SHELL_PROMPT).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('TU_OWN_42').first(), '重新展开后旧输出仍在（同一连接仍是持有者）').toBeVisible();

    // 改浏览器窗口尺寸 → 触发终端 resize 帧
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByText(SHELL_PROMPT).first()).toBeVisible({ timeout: 20_000 });

    // 关标签（结束该 shell）：这一步是"关自己持有的终端"，也不得被判不拥有
    const closeTab = page.getByRole('button', { name: /关闭此标签/ }).first();
    if (await closeTab.count()) {
      await closeTab.click().catch(() => null);
    }

    expect(await page.getByText(FORBIDDEN_LINE).count(),
      `R39：单连接自开终端不得出现「${FORBIDDEN_LINE}」（当前 DOM 里仍有）`).toBe(0);
    const hits = await forbiddenHits(page);
    const samples = await page.evaluate(() => window.__tuForbiddenSamples);
    expect(hits, `R39：整段生命周期里「${FORBIDDEN_LINE}」一次都不许出现（观察到 ${hits} 次）。样本：${JSON.stringify(samples)}`).toBe(0);
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

/** 在页面里开一条自己的 ws，按契约协议跑一段 term-* 交互，返回收到的全部帧。 */
async function driveTerminalProtocol(page, baseURL, { terminals = 1 } = {}) {
  const wsUrl = `${baseURL.replace(/^http/, 'ws')}/ws`;
  return await page.evaluate(async ({ wsUrl, terminals }) => {
    const id = (n) => `tu-${Date.now().toString(36)}-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const socket = new WebSocket(wsUrl);
    const frames = [];
    const waiters = [];
    socket.addEventListener('message', (event) => {
      let value;
      try { value = JSON.parse(String(event.data)); } catch { value = { type: '__invalid__', raw: String(event.data) }; }
      frames.push(value);
      for (const waiter of [...waiters]) waiter();
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('ws open failed')), { once: true });
    });
    const next = (predicate, timeoutMs = 15_000) => {
      const found = frames.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`timeout waiting for frame; seen=${frames.map(f => f.type).join(',')}`));
        }, timeoutMs);
        function check() {
          const hit = frames.find(predicate);
          if (!hit) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(hit);
        }
        waiters.push(check);
      });
    };

    const opened = [];
    for (let n = 0; n < terminals; n += 1) {
      const tid = id(n);
      socket.send(JSON.stringify({ type: 'term-open', id: tid, cols: 80, rows: 24 }));
      const openedFrame = await next(m => m.type === 'term-opened' && m.id === tid);
      opened.push(openedFrame);
      const marker = `TU_PROTO_${n}_${Math.random().toString(36).slice(2, 6)}`;
      socket.send(JSON.stringify({
        type: 'term-in', id: tid, generation: openedFrame.generation,
        data: `printf '${marker}=%s\\n' "$(( 40 + ${n} + 2 ))"\n`,
      }));
      await next(m => m.type === 'term-out' && m.id === tid
        && typeof m.data === 'string' && m.data.includes(`${marker}=${42 + n}`));
      // 改尺寸：契约 §敏感面 明确本批不动 term-resize 语义
      socket.send(JSON.stringify({ type: 'term-resize', id: tid, generation: openedFrame.generation, cols: 100, rows: 30 }));
      socket.send(JSON.stringify({ type: 'term-in', id: tid, generation: openedFrame.generation, data: 'true\n' }));
      opened[n].marker = marker;
    }
    // 全部交互做完后仍持有：关掉自己开的每一个
    for (const frame of opened) {
      socket.send(JSON.stringify({ type: 'term-close', id: frame.id, generation: frame.generation }));
    }
    for (const frame of opened) {
      await next(m => m.type === 'term-closed' && m.id === frame.id, 8_000).catch(() => null);
    }
    socket.close();
    return { frames, ids: opened.map(f => f.id) };
  }, { wsUrl, terminals });
}

test('TU-402 协议面：一条 ws 自开一个终端跑完 open/in/resize/close，全程不得出现 TERM_FORBIDDEN', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  const { frames, ids } = await driveTerminalProtocol(page, baseURL, { terminals: 1 });

  const errors = frames.filter(f => f.type === 'term-error');
  expect(errors, `TU-402 自开的终端不得收到任何 term-error（收到 ${JSON.stringify(errors)}）`).toEqual([]);
  const forbidden = frames.filter(f => JSON.stringify(f).includes('TERM_FORBIDDEN') || JSON.stringify(f).includes(FORBIDDEN_LINE));
  expect(forbidden, `R39：单连接自开终端不得被判不拥有；命中的帧 ${JSON.stringify(forbidden)}（终端 ${ids.join(',')}）`).toEqual([]);
  expect(frames.some(f => f.type === 'term-out'), '自证：这段交互确实在真 shell 里跑出了输出').toBe(true);
});

test('TU-403 协议面：同一条 ws 同时持有两个终端，两个都不许被判不拥有', async ({ page }) => {
  const { baseURL } = getRuntime();
  await page.goto(baseURL);
  const { frames } = await driveTerminalProtocol(page, baseURL, { terminals: 2 });

  const errors = frames.filter(f => f.type === 'term-error');
  expect(errors, `TU-403 同一连接自开两个终端不得收到 term-error：${JSON.stringify(errors)}`).toEqual([]);
  const forbidden = frames.filter(f => JSON.stringify(f).includes('TERM_FORBIDDEN'));
  expect(forbidden, 'R39：同连接多终端也不得被判不拥有').toEqual([]);
  const opened = frames.filter(f => f.type === 'term-opened');
  expect(opened.length, '自证：两个终端都开起来了').toBe(2);
});
