import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import WebSocket from 'ws';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const expectedWorktree = path.resolve(suiteDir, '..', '..', '..');  // 本套件所在 worktree;不钉死本机家目录,显式传 WORKTREE 时仍以 WORKTREE 为准

export class EnvironmentBlocked extends Error {
  constructor(message) {
    super(`ENVIRONMENT_BLOCKED: ${message}`);
    this.name = 'EnvironmentBlocked';
  }
}

export function getRuntime({ requireManifest = false } = {}) {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance');
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new EnvironmentBlocked('BASE_URL must use http or https');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new EnvironmentBlocked('BASE_URL must be loopback; remote and user instances are refused');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if ([6677, 6689].includes(port)) {
    throw new EnvironmentBlocked('ports 6677 and 6689 are protected user instances');
  }

  const worktree = path.resolve(process.env.WORKTREE || expectedWorktree);
  const manifestPath = path.resolve(
    process.env.FIRST_BATCH_FIXTURES || path.join(suiteDir, 'fixture-manifest.local.json'),
  );
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    rejectSecretFields(manifest);
    if (!manifest.dataRoot) {
      throw new EnvironmentBlocked('fixture manifest must declare dataRoot for the isolated server');
    }
    const dataRoot = path.resolve(manifest.dataRoot);
    const allowedRoot = path.join(worktree, 'tests', 'acceptance', 'first-batch-20260910', '.artifacts');
    if (dataRoot !== allowedRoot && !dataRoot.startsWith(`${allowedRoot}${path.sep}`)) {
      throw new EnvironmentBlocked('fixture dataRoot must be inside this suite .artifacts directory');
    }
  } else if (requireManifest) {
    throw new EnvironmentBlocked(`create ${manifestPath} from fixture-manifest.example.json`);
  }
  return { baseURL: url.toString().replace(/\/$/, ''), worktree, manifest, manifestPath };
}

function rejectSecretFields(value, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (/(secret|password|cookie|authorization|api.?key|resume.?token)/i.test(key)) {
      throw new EnvironmentBlocked(`fixture manifest must not contain credential field ${at}`);
    }
    rejectSecretFields(child, at);
  }
}

export function fixtureSection(name) {
  const { manifest } = getRuntime({ requireManifest: true });
  const section = manifest?.[name];
  if (!section) throw new EnvironmentBlocked(`fixture manifest section ${name} is required`);
  return section;
}

export function uniqueId(prefix) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  return `${prefix}_${suffix}`.slice(0, 64);
}

export function wsURL(baseURL) {
  const url = new URL('/ws', baseURL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export async function openSocket(baseURL) {
  const socket = new WebSocket(wsURL(baseURL));
  const messages = [];
  const waiters = new Set();
  socket.on('message', raw => {
    let item;
    try { item = JSON.parse(String(raw)); } catch { item = { type: '__invalid_json__', raw: String(raw) }; }
    messages.push(item);
    for (const waiter of [...waiters]) waiter();
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    send(value) { socket.send(JSON.stringify(value)); },
    async next(predicate, timeoutMs = 10_000) {
      const found = messages.find(predicate);
      if (found) return found;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out waiting for WebSocket event; observed types: ${messages.map(x => x.type).join(',')}`));
        }, timeoutMs);
        function check() {
          const match = messages.find(predicate);
          if (!match) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(match);
        }
        waiters.add(check);
      });
    },
    close() { if (socket.readyState < WebSocket.CLOSING) socket.close(); },
    messages,
  };
}

export async function createTerminal(client, id, extra = {}) {
  client.send({ type: 'term-open', id, cols: 80, rows: 24, ...extra });
  const opened = await client.next(m => m.type === 'term-opened' && m.id === id);
  if (!opened.generation || !opened.resumeToken) {
    throw new Error('CONTRACT_NOT_IMPLEMENTED: term-opened lacks generation or resumeToken');
  }
  return opened;
}

export async function closeTerminal(client, opened) {
  if (!opened || client.socket.readyState !== WebSocket.OPEN) return;
  client.send({ type: 'term-close', id: opened.id, generation: opened.generation });
  await client.next(m => m.type === 'term-closed' && m.id === opened.id).catch(() => {});
}

/** `GET /api/terminal/status`：HTTP 200 `{available,platform,active,maxTerminals:4}`。 */
export async function terminalStatus(request, baseURL) {
  const response = await request.get(`${baseURL}/api/terminal/status`);
  expect(response.status()).toBe(200);
  return await response.json();
}

const CLEANUP_TIMEOUT_MS = 2_500;

/**
 * 顺序无关清理：结束本测试自己创建的终端，无论它此刻被哪个连接附着还是已分离。
 * 实例实测的合同语义（两条路都要走）：
 *   - 仍被连接附着的终端：只有该连接能结束，其他连接重连会被 `TERM_ATTACH_CONFLICT` 拒绝，
 *     所以先拿传入的候选连接逐个直接 term-close；
 *   - 已分离（term-detach / 面板收起 / 连接断开）的终端：原连接已不拥有（term-close 回
 *     `TERM_FORBIDDEN`），必须由新连接用 resumeToken 接管（term-open id+generation+token）后 term-close。
 * 已关闭/已自然退出/记录过期的终端两条路都会被拒，等同于无事可做。
 * 清理是尽力而为且永不抛出：绝不用清理失败掩盖测试体内真正的失败；套件跑完后
 * `GET /api/terminal/status` 的 active 才是最终证据。
 */
export async function disposeTerminal(baseURL, terminal, ...ownerClients) {
  if (!terminal || !terminal.id || !terminal.generation || !terminal.resumeToken) return;
  for (const client of ownerClients) {
    if (!client || client.socket.readyState !== WebSocket.OPEN) continue;
    client.send({ type: 'term-close', id: terminal.id, generation: terminal.generation });
    const ack = await client.next(
      m => m.id === terminal.id && ['term-closed', 'term-error'].includes(m.type), CLEANUP_TIMEOUT_MS,
    ).catch(() => null);
    if (ack?.type === 'term-closed') return;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const client = await openSocket(baseURL).catch(() => null);
    if (!client) return;
    try {
      client.send({
        type: 'term-open', id: terminal.id, generation: terminal.generation, resumeToken: terminal.resumeToken,
      });
      const outcome = await client.next(
        m => m.id === terminal.id && ['term-opened', 'term-error'].includes(m.type), CLEANUP_TIMEOUT_MS,
      ).catch(() => null);
      if (outcome?.type === 'term-opened') {
        client.send({ type: 'term-close', id: terminal.id, generation: outcome.generation });
        await client.next(m => m.type === 'term-closed' && m.id === terminal.id, CLEANUP_TIMEOUT_MS).catch(() => {});
        return;
      }
      // 旧连接刚断开时服务端可能还视其为附着方，稍等重试一次；其余拒绝=已无存活的该终端
      if (outcome?.code !== 'TERM_ATTACH_CONFLICT') return;
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch {
      return;
    } finally {
      client.close();
    }
  }
}

export async function runShellCalculation(client, opened, expression, expected) {
  const label = `CALC_${Math.random().toString(36).slice(2, 8)}`;
  client.send({
    type: 'term-in',
    id: opened.id,
    generation: opened.generation,
    data: `printf '${label}=%s\\n' \"$(( ${expression} ))\"\n`,
  });
  const event = await client.next(
    m => m.type === 'term-out' && m.id === opened.id && m.generation === opened.generation &&
      typeof m.data === 'string' && m.data.includes(`${label}=${expected}`),
  );
  return event;
}

export function requirePath(section, key) {
  const value = section?.[key];
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new EnvironmentBlocked(`fixture field ${key} must be an app-relative path beginning with /`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 公开 UI 点选导航：本产品没有“按会话/文件寻址的 URL”（任何路径都渲染首页），
// 夹具只能像真实用户那样点出来。全部定位器只用 role/text/keyboard 与实例上
// 真实存在的公开钩子；不读 localStorage/sessionStorage，不发明深链。
//
// 观测到的导航契约（隔离实例实测，详见 README「夹具导航」）：
//   1) 会话：侧栏搜索框「搜索项目 / 会话 / 消息 (≥2 字符)…」输入夹具会话内的唯一标记
//      （manifest 的 sessionSearchMarker）→ 点搜索结果行（role=button，行内含标记）→ 会话打开。
//      搜索覆盖默认不进侧栏的 worktree 项目，故无需先改任何设置。
//   2) 文件：文件浏览器的根取“当前活动会话”的项目（无会话时只提示“请先选择一个会话或项目”），
//      所以先按 1) 打开该项目的夹具会话，再点顶栏「设置」展开面板坞、点「文件」开面板，
//      最后点文件树里的文件名（manifest 的 fileName）。
// 偶发浮层（新手引导卡「使用指引」、更新提示）会盖住侧栏顶部；点击前统一先关掉并带重试。
// ---------------------------------------------------------------------------

const OVERLAY_DISMISS_BUTTONS = ['关闭指引', '跳过', '稍后'];

/** 关掉会遮挡点击的临时浮层（新手引导 / 更新提示）。幂等：没有浮层时什么都不做。 */
export async function dismissTransientOverlays(page) {
  for (const name of OVERLAY_DISMISS_BUTTONS) {
    const button = page.getByRole('button', { name, exact: true });
    if ((await button.count()) && (await button.first().isVisible().catch(() => false))) {
      await button.first().click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

/** 点击前先清浮层；被浮层挡住就重试（实例上浮层会偶发重现，故重试是必需的）。 */
export async function clickThroughOverlays(page, target, { attempts = 4, timeout = 4_000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await dismissTransientOverlays(page);
    try {
      await target.click({ timeout });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await page.waitForTimeout(300);
    }
  }
}

/**
 * 结束终端面板里"本页面自己开的"shell（合同入口：终端标签"关闭此标签(结束对应进程)"按钮
 * 结束该 shell，实测对存活 shell 生效：active 递减、标签消失）。
 * 面板处于收起态时先点顶栏"终端"展开再关；没有终端标签时无事可做。
 * 用例收尾必须调用它或让 shell 自然退出：关闭浏览器页面不会结束 shell，不清理就会占满
 * maxTerminals=4 名额，让后面的用例开不出终端（顺序相关的根源）。
 * 尽力而为、永不抛出，避免收尾失败掩盖测试体内真正的失败。
 */
export async function closePanelTerminals(page) {
  const closeTab = page.getByRole('button', { name: /关闭此标签/ });
  const toggle = page.getByRole('button', { name: '终端', exact: true }).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await closeTab.count())) return;
    if (!(await closeTab.first().isVisible().catch(() => false))) {
      await toggle.click({ timeout: 4_000 }).catch(() => null);
      await page.waitForTimeout(400);
      continue;
    }
    await closeTab.first().click({ timeout: 4_000 }).catch(() => null);
    await page.waitForTimeout(400);
  }
}

/** 首次导航时打开被测实例首页（已在应用内则不动，避免重复加载）。 */
async function openAppHome(page) {
  if (page.url() === 'about:blank') {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  }
}

function requireUiString(section, key) {
  const value = section?.[key];
  if (typeof value !== 'string' || !value) {
    throw new EnvironmentBlocked(`fixture field ${key} is required for public-UI navigation`);
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 用侧栏搜索打开夹具会话（= 定位夹具项目）。
 * section.projectName 只做导航方向自检：打开的会话必须落在夹具项目里。
 */
export async function openFixtureSession(page, section, { markerKey = 'sessionSearchMarker' } = {}) {
  const marker = requireUiString(section, markerKey);
  const projectName = requireUiString(section, 'projectName');
  await openAppHome(page);
  await dismissTransientOverlays(page);
  const search = page.getByRole('textbox', { name: /搜索项目/ }).first();
  await search.fill(marker);
  const result = page.getByRole('button', { name: new RegExp(escapeRegExp(marker)) }).first();
  await expect(result).toBeVisible();
  await clickThroughOverlays(page, result);
  await page.keyboard.press('Escape'); // 关掉搜索浮层，回到普通界面
  await expect(page.getByRole('textbox', { name: /打开命令/ }).first()).toBeVisible();
  await expect(page.getByRole('banner')).toContainText(projectName);
  await dismissTransientOverlays(page); // 收尾：不给后续断言留下遮挡点击的浮层
}

async function openDockPanel(page, name) {
  const panelButton = page.getByRole('button', { name, exact: true }).first();
  if (!(await panelButton.count())) {
    // 面板坞默认收起：先点顶栏「设置」把它展开，面板按钮才会出现。
    await clickThroughOverlays(page, page.getByRole('button', { name: /^设置/ }).first());
  }
  await expect(panelButton).toBeVisible();
  await clickThroughOverlays(page, panelButton);
}

/** 经公开 UI 打开夹具项目里的 markdown 文件（文件预览 = 产品公开渲染 Markdown 的一个表面）。 */
export async function openFixtureFile(page, section) {
  const fileName = requireUiString(section, 'fileName');
  await openAppHome(page);
  const node = page.getByText(fileName, { exact: true }).first();
  if (!(await node.count())) {
    await openFixtureSession(page, section); // 文件面板的根取当前活动会话的项目
    await openDockPanel(page, '文件');
  }
  await expect(node).toBeVisible();
  await clickThroughOverlays(page, node);
  await dismissTransientOverlays(page); // 收尾：不给后续断言留下遮挡点击的浮层
}

export async function expectImageDecoded(locator) {
  await locator.waitFor({ state: 'visible' });
  const decoded = await locator.evaluate(img => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0);
  if (!decoded) throw new Error('image element is visible but browser decoding failed');
}

export function suitePath(...parts) {
  return path.join(suiteDir, ...parts);
}
