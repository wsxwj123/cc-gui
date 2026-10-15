#!/usr/bin/env node
// r151b 审计后修复:卡片区真组件渲染(esbuild 打包 + react-dom/server,同 check-r151b-baseline-ui 的做法)。
//   · S6:目标会话(本窗格会话)在「放任」档时,卡片正文不折叠、没有【展开】;其它档超 8 行照常折叠。
//         经 ChatInput 渲染,按本会话的权限档(permissionModeBySession)决定,不在测试里直接塞 noFold。
//   · F1:"处理这条消息"已排在前端队列里时,卡片原因为"已排队，当前回合结束后处理",【处理】不可点,【忽略】可点。
// 无 client/node_modules(裸检出)时明确跳过并打印,不静默转绿。
// node tests/unit/check-r151b-xs-card-render.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const clientDir = join(root, 'client');
const requireCjs = createRequire(import.meta.url);

{
  const mem = new Map();
  const storage = {
    get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); }, clear: () => mem.clear(),
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
    location: { href: 'http://127.0.0.1:6997/', origin: 'http://127.0.0.1:6997', protocol: 'http:', host: '127.0.0.1:6997', hostname: '127.0.0.1', port: '6997', pathname: '/', search: '', hash: '', reload: noop, assign: noop, replace: noop },
    history: { pushState: noop, replaceState: noop, state: null },
    requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: (t) => clearTimeout(t),
    document: { documentElement: el(), body: el(), head: el(), createElement: el, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', hidden: false, cookie: '', compatMode: 'CSS1Compat' },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'MacIntel', language: 'zh-CN', clipboard: { writeText: async () => {} } }, configurable: true }); } catch { /* */ }
  globalThis.fetch = async (url) => { throw new Error(`check-r151b-xs-card-render:渲染期间不应发请求 ${url}`); };
}

async function loadRenderer() {
  let esbuild;
  try {
    esbuild = requireCjs(join(clientDir, 'node_modules/esbuild'));
    requireCjs(join(clientDir, 'node_modules/react-dom/server'));
  } catch { return null; }
  const work = mkdtempSync(join(tmpdir(), 'cgui-r151b-card-'));
  const entry = join(work, 'entry.jsx');
  const src = (p) => JSON.stringify(join(clientDir, 'src', p));
  writeFileSync(entry, [
    "import React from 'react';",
    "import { renderToStaticMarkup } from 'react-dom/server';",
    `import { ChatInput } from ${src('components/ChatInput.jsx')};`,
    `import { useStore } from ${src('stores/sessionStore.js')};`,
    `import { useXsStore, XS_PROMPT_PLACEHOLDER } from ${src('utils/xsession.js')};`,
    'export { useStore, useXsStore, XS_PROMPT_PLACEHOLDER };',
    'const noop = () => {};',
    'export const renderInput = (props) => renderToStaticMarkup(React.createElement(ChatInput, { onSend: noop, onStop: noop, ...props }));',
  ].join('\n'));
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

const r = await loadRenderer();
if (!r) {
  console.log('! 跳过 check-r151b-xs-card-render:未找到 client/node_modules/esbuild 或 react-dom(裸检出环境)');
  process.exit(0);
}
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const M1 = '11111111-0000-4000-8000-000000000001';
const LONG = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join('\n');
const card = { id: M1, createdAt: '2026-10-15T01:00:00.000Z', status: 'pending', chainId: M1, hop: 1,
  from: { kind: 'user', sessionId: null, title: '' }, to: { sessionId: B, title: '乙' },
  body: LONG, bodyBytes: 60, via: null, heldReason: 'target-card', heldText: '等待你确认后处理' };
const origError = console.error;
console.error = (...a) => { if (!String(a[0] || '').includes('useLayoutEffect')) origError(...a); }; // SSR 对 useLayoutEffect 的固定告警
// zustand 在服务端渲染时读 getInitialState()(不是 getState()):测试里两份一起写,渲染才看得到这里摆的状态
const put = (store, patch) => { Object.assign(store.getInitialState(), patch); store.setState(patch); };
put(r.useXsStore, { enabled: true, inbox: { [B]: [card] } });
const renderFor = (mode) => {
  put(r.useStore, { permissionModeBySession: { ...(r.useStore.getState().permissionModeBySession || {}), [B]: mode } });
  return r.renderInput({ sessionId: B, permKey: B });
};
const bodyTag = (html) => (html.match(/<div[^>]*data-testid="xs-card-body"[^>]*>/) || [''])[0];
const btn = (html, id) => (html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`)) || [''])[0];
const DISABLED = /\sdisabled=""/; // disabled 属性(类名里的 disabled:opacity-40 不算)
try {
  // ── S6 ──
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']) {
    const html = renderFor(mode);
    assert.match(bodyTag(html), /-webkit-line-clamp:8/, `${mode} 档:超 8 行折叠`);
    assert.ok(html.includes('data-testid="xs-card-expand"'), `${mode} 档:有【展开】`);
  }
  const bypass = renderFor('bypassPermissions');
  assert.ok(bodyTag(bypass), '前提:卡片渲染出来了');
  assert.doesNotMatch(bodyTag(bypass), /line-clamp/, '「放任」档:正文不折叠');
  assert.ok(!bypass.includes('data-testid="xs-card-expand"'), '「放任」档:没有【展开】(已是全文)');
  assert.ok(bypass.includes('第 12 行'), '正文全文在');
  console.log('✓ S6:「放任」档卡片正文不折叠,其余五档超 8 行照常折叠');

  // ── F1 卡片排队态 ──
  let html = renderFor('default');
  assert.ok(btn(html, 'xs-card-process') && !DISABLED.test(btn(html, 'xs-card-process')), '没排队时【处理】可点');
  const q = r.useStore.getState().enqueueMessage(B, { text: r.XS_PROMPT_PLACEHOLDER, queuedAt: Date.now(), hidden: true, opts: { hiddenUserMessage: true, xsProcess: { messageId: M1, sessionId: B } } });
  assert.ok(q, '前提:入队成功');
  put(r.useStore, { messageQueue: r.useStore.getState().messageQueue });
  html = renderFor('default');
  assert.match(html, /data-testid="xs-card-reason"[^>]*>已排队，当前回合结束后处理</, '原因:已排队');
  assert.match(btn(html, 'xs-card-process'), DISABLED, '已排队:【处理】不可再点');
  assert.ok(btn(html, 'xs-card-dismiss') && !DISABLED.test(btn(html, 'xs-card-dismiss')), '已排队:【忽略】仍可点');
  assert.match(html, /data-status="pending"/, '消息仍是 pending');
  console.log('✓ F1:已排队的卡片显示"已排队",【处理】不可点、【忽略】可点');
} finally {
  console.error = origError;
  r.cleanup();
}
console.log('PASS check-r151b-xs-card-render');
process.exit(0);
