#!/usr/bin/env node
// r151c 派工 5:二期界面元素的真组件渲染(esbuild 打包 + react-dom/server,同 check-r151b-xs-card-render 的做法)。
//   · 总开关关:接收设置、改接收设置失败的提示、暂停提示条都不渲染(空串)
//   · 暂停提示条 xs-paused-banner:文案逐字 + 【恢复自动处理】;没暂停不渲染
//   · 改接收设置失败的提示"接收设置没有保存：<原因>":只在出错的那个会话显示
//   · 接收设置 xs-inbound-select:只对会话 id 显示;取到值前不可选;选中项随 store
//   · 卡片:hop>1 时 xs-card-hop"连锁第 N 次";AI 发来的来源"来自 <标题> · <目录名>"
// 无 client/node_modules(裸检出)时明确跳过并打印,不静默转绿。
// node tests/unit/check-r151c-xs-ui-render.mjs
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
    location: { href: 'http://127.0.0.1:6996/', origin: 'http://127.0.0.1:6996', protocol: 'http:', host: '127.0.0.1:6996', hostname: '127.0.0.1', port: '6996', pathname: '/', search: '', hash: '', reload: noop, assign: noop, replace: noop },
    history: { pushState: noop, replaceState: noop, state: null },
    requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: (t) => clearTimeout(t),
    document: { documentElement: el(), body: el(), head: el(), createElement: el, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', hidden: false, cookie: '', compatMode: 'CSS1Compat' },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'MacIntel', language: 'zh-CN', clipboard: { writeText: async () => {} } }, configurable: true }); } catch { /* */ }
  globalThis.fetch = async (url) => { throw new Error(`check-r151c-xs-ui-render:渲染期间不应发请求 ${url}`); };
}

async function loadRenderer() {
  let esbuild;
  try {
    esbuild = requireCjs(join(clientDir, 'node_modules/esbuild'));
    requireCjs(join(clientDir, 'node_modules/react-dom/server'));
  } catch { return null; }
  const work = mkdtempSync(join(tmpdir(), 'cgui-r151c-ui-'));
  const entry = join(work, 'entry.jsx');
  const src = (p) => JSON.stringify(join(clientDir, 'src', p));
  writeFileSync(entry, [
    "import React from 'react';",
    "import { renderToStaticMarkup } from 'react-dom/server';",
    `import { XsInboundSelect, XsInboundNotice, XsPausedBanner } from ${src('components/XsSessionControls.jsx')};`,
    `import { XsInbox } from ${src('components/XsInbox.jsx')};`,
    `import { useXsStore } from ${src('utils/xsession.js')};`,
    'export { useXsStore };',
    'const h = React.createElement;',
    'export const render = { banner: () => renderToStaticMarkup(h(XsPausedBanner)),',
    '  select: (sessionId) => renderToStaticMarkup(h(XsInboundSelect, { sessionId })),',
    '  notice: (sessionId) => renderToStaticMarkup(h(XsInboundNotice, { sessionId })),',
    '  inbox: (sessionId) => renderToStaticMarkup(h(XsInbox, { sessionId, onSend: () => {} })) };',
  ].join('\n'));
  const rawPlugin = {
    name: 'r151c-raw',
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, (a) => ({ path: join(a.resolveDir, a.path.replace(/\?raw$/, '')), namespace: 'r151c-raw' }));
      build.onLoad({ filter: /.*/, namespace: 'r151c-raw' }, (a) => ({ contents: readFileSync(a.path, 'utf8'), loader: 'text' }));
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
  console.log('! 跳过 check-r151c-xs-ui-render:未找到 client/node_modules/esbuild 或 react-dom(裸检出环境)');
  process.exit(0);
}
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const M1 = '11111111-0000-4000-8000-000000000001';
const M2 = '22222222-0000-4000-8000-000000000002';
// zustand 在服务端渲染时读 getInitialState()(不是 getState()):两份一起写,渲染才看得到这里摆的状态
const put = (store, patch) => { Object.assign(store.getInitialState(), patch); store.setState(patch); };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tagOf = (html, id) => (html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`)) || [''])[0];
const origError = console.error;
console.error = (...a) => { if (!String(a[0] || '').includes('useLayoutEffect')) origError(...a); }; // SSR 对 useLayoutEffect 的固定告警
try {
  // ── 总开关关:三者都不渲染(即使 store 里留着暂停 / 接收设置 / 提示) ──
  put(r.useXsStore, { enabled: false, autoPaused: true, inboundBySession: { [A]: 'auto' }, inboundError: { [A]: '接收设置没有保存：x' } });
  assert.equal(r.render.banner(), '', '关:没有暂停提示条');
  assert.equal(r.render.select(A), '', '关:没有接收设置');
  assert.equal(r.render.notice(A), '', '关:没有失败提示');
  console.log('✓ 总开关关:接收设置、失败提示、暂停提示条都不渲染');

  // ── 暂停提示条 ──
  put(r.useXsStore, { enabled: true, autoPaused: false, autoLimit: 20, inboundBySession: {}, inboundError: {} });
  assert.equal(r.render.banner(), '', '没暂停:不渲染');
  put(r.useXsStore, { autoPaused: true });
  const banner = r.render.banner();
  assert.ok(tagOf(banner, 'xs-paused-banner'), '暂停:出现 xs-paused-banner');
  assert.ok(text(banner).includes('跨会话自动处理已暂停（10 分钟内已自动处理 20 次）。'), '文案逐字');
  assert.match(banner, /<button[^>]*>\s*恢复自动处理\s*<\/button>/, '带【恢复自动处理】');
  console.log('✓ 暂停提示条:暂停时出现(文案逐字 + 【恢复自动处理】),没暂停不渲染');

  // ── 改接收设置失败的提示:只在出错的会话显示 ──
  put(r.useXsStore, { inboundError: { [A]: '接收设置没有保存：写入偏好失败' } });
  assert.ok(text(r.render.notice(A)).includes('接收设置没有保存：写入偏好失败'), '出错的会话:显示提示');
  assert.equal(r.render.notice(B), '', '别的会话不显示');
  assert.equal(r.render.notice(null), '', '没有会话不显示');
  console.log('✓ 改接收设置失败的提示只在出错的会话显示');

  // ── 接收设置 ──
  assert.equal(r.render.select(null), '', '没落盘的会话(没有会话 id)不显示');
  let sel = r.render.select(A);
  assert.match(tagOf(sel, 'xs-inbound-select'), /^<select/, '是 <select>');
  assert.match(tagOf(sel, 'xs-inbound-select'), /\sdisabled=""/, '还没取到值:不可选');
  assert.ok(text(sel).includes('收到跨会话消息时：'), '标签文字');
  assert.match(sel, /<option value="card"[^>]*>等你确认<\/option>/);
  assert.match(sel, /<option value="auto"[^>]*>自动处理<\/option>/);
  put(r.useXsStore, { inboundBySession: { [A]: 'auto' } });
  sel = r.render.select(A);
  assert.doesNotMatch(tagOf(sel, 'xs-inbound-select'), /\sdisabled=""/, '取到值后可选');
  assert.match(sel, /<option value="auto" selected="">自动处理<\/option>/, '选中项随 store(auto)');
  put(r.useXsStore, { inboundBySession: { [A]: 'card' } });
  assert.match(r.render.select(A), /<option value="card" selected="">等你确认<\/option>/, '选中项随 store(card)');
  console.log('✓ 接收设置:只对会话 id 显示,取到值前不可选,选中项随 store');

  // ── 卡片:连锁次数与来源目录名 ──
  const card = (id, hop) => ({ id, createdAt: '2026-10-16T01:00:00.000Z', status: 'pending', chainId: id, hop,
    from: { kind: 'session', sessionId: A, title: '甲', project: 'proj-a' }, to: { sessionId: B, title: '乙' },
    body: '正文', bodyBytes: 6, via: null, heldReason: 'chain-limit', heldText: '连锁次数已达上限' });
  put(r.useXsStore, { inbox: { [B]: [card(M1, 5), card(M2, 1)] } });
  const inbox = r.render.inbox(B);
  const one = (id) => inbox.slice(inbox.indexOf(`data-message-id="${id}"`)).split('data-testid="xs-card"')[0];
  assert.match(one(M1), /data-testid="xs-card-hop"[^>]*>连锁第 5 次</, 'hop 5:连锁第 5 次');
  assert.ok(!one(M2).includes('xs-card-hop'), 'hop 1:不显示');
  assert.match(one(M1), /data-testid="xs-card-from"[^>]*>来自 甲 · proj-a</, '来源:来自 <标题> · <目录名>');
  console.log('✓ 卡片:hop>1 显示"连锁第 N 次";AI 发来的来源带目录名');
} finally {
  console.error = origError;
  r.cleanup();
}
console.log('PASS check-r151c-xs-ui-render');
process.exit(0);
