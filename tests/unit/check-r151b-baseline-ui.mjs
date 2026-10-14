#!/usr/bin/env node
// r151b T-X0:跨会话通信「总开关关 = 界面无新元素」基线(真组件渲染:esbuild 打包 + react-dom/server)。
// 改动前(master 960965f6,工作树尚未改任何产品代码)录制;实现落地后不得重录。
// 一期要往下面三个宿主组件里加元素(INTERFACE X.3.4):助手回复操作行的转发按钮(TurnBubble)、输入框上方的卡片区
// (ChatInput)、侧栏会话行 / 折叠项目行的待处理条数(UnifiedSidebar)。总开关关着(store 默认状态,没有任何跨会话数据)时,
// 这三个组件渲染出来的 HTML 必须与改动前逐字相同,且不出现任何 xs-* / xsession-* 测试标识。
// 设置页里放总开关的那个块不在本基线内(开关本身必须一直可见,才能被打开)。
// 无 client/node_modules(裸检出)时明确跳过并打印,不静默转绿。
// node tests/unit/check-r151b-baseline-ui.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const clientDir = join(root, 'client');
const requireCjs = createRequire(import.meta.url);

// ── 浏览器全局的最小替身:只为让被打包进来的模块顶层代码能执行;渲染走 react-dom/server,不触发任何副作用 ──
{
  const mem = new Map();
  const storage = {
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => mem.clear(),
  };
  const noop = () => {};
  const el = () => ({
    style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, removeAttribute: noop, getAttribute: () => null, appendChild: noop, removeChild: noop,
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  });
  globalThis.window = globalThis;
  Object.assign(globalThis, {
    localStorage: storage, sessionStorage: storage,
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    location: { href: 'http://127.0.0.1:6999/', origin: 'http://127.0.0.1:6999', protocol: 'http:', host: '127.0.0.1:6999', hostname: '127.0.0.1', port: '6999', pathname: '/', search: '', hash: '', reload: noop, assign: noop, replace: noop },
    history: { pushState: noop, replaceState: noop, state: null },
    requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: (t) => clearTimeout(t),
    document: { documentElement: el(), body: el(), head: el(), createElement: el, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', hidden: false, cookie: '', compatMode: 'CSS1Compat' },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'MacIntel', language: 'zh-CN', clipboard: { writeText: async () => {} } }, configurable: true }); } catch { /* */ }
  // 渲染期间禁止任何网络请求(SSR 不跑 effect;真有人在渲染路径上发请求就让它显形)
  globalThis.fetch = async (url) => { throw new Error(`check-r151b-baseline-ui:渲染期间不应发请求 ${url}`); };
}

async function loadRenderer() {
  let esbuild;
  try {
    esbuild = requireCjs(join(clientDir, 'node_modules/esbuild'));
    requireCjs(join(clientDir, 'node_modules/react-dom/server'));
  } catch {
    return null;
  }
  const work = mkdtempSync(join(tmpdir(), 'cgui-r151b-ui-'));
  const entry = join(work, 'entry.jsx');
  const src = (p) => JSON.stringify(join(clientDir, 'src', p));
  writeFileSync(entry, [
    "import React from 'react';",
    "import { renderToStaticMarkup } from 'react-dom/server';",
    `import { TurnBubble } from ${src('components/TurnBubble.jsx')};`,
    `import { ChatInput } from ${src('components/ChatInput.jsx')};`,
    `import { UnifiedSidebar } from ${src('components/UnifiedSidebar.jsx')};`,
    `import { useStore } from ${src('stores/sessionStore.js')};`,
    'export { useStore };',
    'const noop = () => {};',
    'export const renderTurn = (turn) => renderToStaticMarkup(React.createElement(TurnBubble, { turn, onRetry: noop, onRetryTool: noop, onFork: noop }));',
    'export const renderInput = (props) => renderToStaticMarkup(React.createElement(ChatInput, { onSend: noop, onStop: noop, ...props }));',
    'export const renderSidebar = () => renderToStaticMarkup(React.createElement(UnifiedSidebar));',
  ].join('\n'));
  // vite 的 `?raw` 导入:按文件全文字符串加载(同 helpers/vite-raw-hooks.mjs 的口径)
  const rawPlugin = {
    name: 'r151b-raw',
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, (a) => ({ path: join(a.resolveDir, a.path.replace(/\?raw$/, '')), namespace: 'r151b-raw' }));
      build.onLoad({ filter: /.*/, namespace: 'r151b-raw' }, (a) => ({ contents: readFileSync(a.path, 'utf8'), loader: 'text' }));
    },
  };
  await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: join(work, 'bundle.cjs'), jsx: 'automatic',
    nodePaths: [join(clientDir, 'node_modules')], plugins: [rawPlugin], logLevel: 'silent',
    loader: { '.js': 'jsx', '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty', '.md': 'text' },
  });
  const mod = requireCjs(join(work, 'bundle.cjs'));
  return { ...mod, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

const testids = (html) => [...new Set([...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]))].sort();
const cguiMarks = (html) => [...new Set([...html.matchAll(/data-cgui="([^"]+)"/g)].map((m) => m[1]))].sort();
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const XS_ID = /^(xs-|xsession-)/;

// ── 改动前录下的基线 ──────────────────────────────────────────────────────────────
const RECORD = process.env.R151B_PRINT_OBSERVED === '1'; // 只用于首次录制时打印观测值;录完写死在下面,之后不要再用它重录
const EXPECTED = {
  'turn-text': { testids: [], cgui: [], len: 3486, sha: 'c53262c447fb12d3' },
  'turn-tool': { testids: [], cgui: [], len: 5699, sha: 'fc13521a59eee3c0' },
  'input-idle': { testids: ['permission-mode-selector'], cgui: ['attach-btn', 'composer', 'composer-input', 'mode-selector', 'send-btn'], len: 3333, sha: '7e99c29e2c559931' },
  'input-streaming': { testids: ['permission-mode-selector'], cgui: ['attach-btn', 'composer', 'composer-input', 'mode-selector', 'queue-btn', 'stop-btn'], len: 4099, sha: '992c6c419dcae4ff' },
  sidebar: { testids: ['session-actions-btn'], cgui: ['add-project-btn', 'new-session-btn', 'project-row', 'session-actions', 'session-row', 'sidebar', 'sidebar-search'], len: 8338, sha: '71538d6ce1e7c510' },
  'sidebar-collapsed': { testids: [], cgui: ['add-project-btn', 'new-session-btn', 'project-row', 'sidebar', 'sidebar-search'], len: 6049, sha: '63f8dca8e993e3de' },
};

const renderer = await loadRenderer();
if (!renderer) {
  console.log('! 跳过 check-r151b-baseline-ui:未找到 client/node_modules/esbuild 或 react-dom(裸检出环境)');
  process.exit(0);
}
try {
  const { renderTurn, renderInput, renderSidebar, useStore } = renderer;
  const SID1 = 'a1a1a1a1-0000-4000-8000-0000000000a1';
  const SID2 = 'a2a2a2a2-0000-4000-8000-0000000000a2';
  const SID3 = 'a3a3a3a3-0000-4000-8000-0000000000a3';
  const OLD = Date.parse('2020-01-02T03:04:05Z'); // 远在过去:相对时间文案多年内不变,渲染结果稳定
  const P1 = { hash: '-r151b-proj-one', path: '/r151b/proj-one', name: 'proj-one', lastActivity: OLD, sessionCount: 2 };
  const P2 = { hash: '-r151b-proj-two', path: '/r151b/proj-two', name: 'proj-two', lastActivity: OLD - 1000, sessionCount: 1 };
  const sess = (sessionId, projectHash, firstPrompt, t) => ({ sessionId, projectHash, firstPrompt, lastActivity: t, modified: t, mtime: t, messageCount: 4, cwd: projectHash === P1.hash ? P1.path : P2.path });

  const observed = {};
  const record = (name, html) => {
    observed[name] = { testids: testids(html), cgui: cguiMarks(html), len: html.length, sha: sha(html) };
    const xs = observed[name].testids.filter((t) => XS_ID.test(t));
    assert.deepEqual(xs, [], `${name}:总开关关时不得出现跨会话的测试标识`);
  };

  // zustand 5 在服务端渲染时读的是 getInitialState()(useSyncExternalStore 的服务端快照),setState 进不去 ——
  // 所以种数据要同时改初始状态对象与当前状态。
  const seed = (patch) => { Object.assign(useStore.getInitialState(), patch); useStore.setState(patch); };

  // ① 助手回复(转发按钮的宿主):旧形态纯文本一条、有序块(文本 + 工具调用)一条
  const turnText = renderTurn({ uuid: 'r151b-turn-1', sessionId: SID1, role: 'assistant', text: 'R151B 回复正文', thinking: '', toolCalls: [] });
  assert.ok(turnText.includes('R151B 回复正文'), '回复正文确实渲染出来了(否则本场景测不到操作行)');
  record('turn-text', turnText);
  const toolCall = { id: 'toolu_r151b', name: 'Read', input: { file_path: '/r151b/proj-one/a.txt' }, result: { content: 'x' } };
  const turnTool = renderTurn({
    uuid: 'r151b-turn-2', sessionId: SID1, role: 'assistant', text: 'R151B 看过了', thinking: '', toolCalls: [toolCall],
    blocks: [{ type: 'tool_use', toolCall }, { type: 'text', content: 'R151B 看过了' }],
  });
  assert.ok(turnTool.includes('R151B 看过了'), '有序块的正文确实渲染出来了');
  record('turn-tool', turnTool);
  // ② 输入框(卡片区的宿主):空闲、运行中
  record('input-idle', renderInput({ sessionId: SID1, permKey: SID1 }));
  record('input-streaming', renderInput({ sessionId: SID1, permKey: SID1, isStreaming: true }));
  // ③ 侧栏(待处理条数的宿主):P1 展开、P2 折叠
  seed({
    projects: [P1, P2],
    sessionsByProject: { [P1.hash]: [sess(SID1, P1.hash, 'R151B 会话一', OLD), sess(SID2, P1.hash, 'R151B 会话二', OLD - 500)], [P2.hash]: [sess(SID3, P2.hash, 'R151B 会话三', OLD - 1000)] },
    expandedProjects: [P1.hash],
    selectedProject: P1,
    selectedSession: null,
  });
  const sidebar = renderSidebar();
  assert.ok(sidebar.includes('R151B 会话一') && sidebar.includes('R151B 会话二'), '展开项目的会话行确实渲染出来了');
  assert.ok(!sidebar.includes('R151B 会话三'), '折叠项目的会话行不渲染');
  record('sidebar', sidebar);
  // 全部折叠
  seed({ expandedProjects: [] });
  const sidebarCollapsed = renderSidebar();
  assert.ok(!sidebarCollapsed.includes('R151B 会话一'), '全部折叠时没有会话行');
  record('sidebar-collapsed', sidebarCollapsed);

  if (RECORD) {
    console.log(JSON.stringify(observed, null, 1));
    console.log('R151B_PRINT_OBSERVED:以上为观测值(未与基线比较)');
  } else {
    for (const [name, want] of Object.entries(EXPECTED)) {
      assert.deepEqual(observed[name].testids, want.testids, `${name}:测试标识集合与改动前相同`);
      assert.deepEqual(observed[name].cgui, want.cgui, `${name}:data-cgui 标记集合与改动前相同`);
      assert.equal(observed[name].len, want.len, `${name}:渲染结果长度与改动前相同`);
      assert.equal(observed[name].sha, want.sha, `${name}:渲染结果与改动前逐字相同`);
    }
    assert.deepEqual(Object.keys(observed).sort(), Object.keys(EXPECTED).sort(), '渲染场景与基线一一对应');
    console.log('PASS check-r151b-baseline-ui');
  }
} finally {
  renderer.cleanup();
}
process.exit(0);
