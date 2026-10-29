#!/usr/bin/env node
// r151b 审计后修复:卡片区真组件渲染(esbuild 打包 + react-dom/server,同 check-r151b-baseline-ui 的做法)。
//   · S6:目标会话(本窗格会话)在「放任」档时,卡片正文不折叠、没有【展开】;其它档超两行照常折叠。
//         经 ChatInput 渲染,按本会话的权限档(permissionModeBySession)决定,不在测试里直接塞 noFold。
//   · F1:"处理这条消息"已排在前端队列里时,卡片原因为"已排队，当前回合结束后处理",【处理】不可点,【忽略】可点。
//   · r151w/r151x:卡片是与 TaskNoticeRow 同款的居中折叠行 —— 折叠态只有标题行 + 展开(不渲染正文节点),
//         标题行是唯一的展开控件(button + aria-expanded/aria-controls)、动作行紧跟标题行(展开时按钮不被正文推走)。
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
// r151w 判官整改:一整段没有换行的长正文。新契约不再按宽度测量,但长单段在折叠态同样不能有正文预览,
// 且必须有展开入口(验收 A9 覆盖客户端行为)。
const LONG_ONE_LINE = '这是一整段没有换行的长正文，用来验证折叠态不显示任何正文预览、只留标题行 + 展开。'.repeat(8);
const M2 = '22222222-0000-4000-8000-000000000002';
// r151x:两行正文 + 尾随换行。新契约不再数行数 —— 有正文就有【展开】,不再有「死 toggle」判定。
const M3 = '33333333-0000-4000-8000-000000000003';
// r151x:正文为空(占位不算正文)→ 占位可见、没有【展开】、标题行不是按钮。
const M4 = '44444444-0000-4000-8000-000000000004';
const card = { id: M1, createdAt: '2026-10-15T01:00:00.000Z', status: 'pending', chainId: M1, hop: 1,
  from: { kind: 'user', sessionId: null, title: '' }, to: { sessionId: B, title: '乙' },
  body: LONG, bodyBytes: 60, via: null, heldReason: 'target-card', heldText: '等待你确认后处理' };
const cardOneLine = { ...card, id: M2, chainId: M2, body: LONG_ONE_LINE, bodyBytes: Buffer.byteLength(LONG_ONE_LINE) };
const cardTrailingNewline = { ...card, id: M3, chainId: M3, body: '第一行\n第二行\n', bodyBytes: 0 };
const cardEmpty = { ...card, id: M4, chainId: M4, body: '', bodyBytes: 0 };
const origError = console.error;
console.error = (...a) => { if (!String(a[0] || '').includes('useLayoutEffect')) origError(...a); }; // SSR 对 useLayoutEffect 的固定告警
// zustand 在服务端渲染时读 getInitialState()(不是 getState()):测试里两份一起写,渲染才看得到这里摆的状态
const put = (store, patch) => { Object.assign(store.getInitialState(), patch); store.setState(patch); };
put(r.useXsStore, { enabled: true, inbox: { [B]: [card, cardOneLine, cardTrailingNewline, cardEmpty] } });
const renderFor = (mode) => {
  put(r.useStore, { permissionModeBySession: { ...(r.useStore.getState().permissionModeBySession || {}), [B]: mode } });
  return r.renderInput({ sessionId: B, permKey: B });
};
const bodyTag = (html) => (html.match(/<div[^>]*data-testid="xs-card-body"[^>]*>/) || [''])[0];
const btn = (html, id) => (html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`)) || [''])[0];
const DISABLED = /\sdisabled=""/; // disabled 属性(类名里的 disabled:opacity-40 不算)
try {
  // ── S6 r151x:折叠态只有标题行 + 展开(正文容器隐藏且为空)──
  // 用户 2026-10-29 21:20 修订:折叠态不显示正文预览,有正文(哪怕 1 行)就有【展开】;
  // 旧的 line-clamp:2 / 按换行数判定「放得下」全部作废。展开后的居中由验收套件读 computed textAlign 覆盖。
  // 正文容器仍在 DOM(旧断言按 testid 取它量高度),但折叠态 hidden 且不带文本;原文另有一份不可见副本供行内文本匹配。
  const cardMarkup = (html, id) => (html.split('data-testid="xs-card"')
    .find((part) => part.includes(`data-message-id="${id}"`)) || '');
  const toggleTag = (markup) => (markup.match(/<[a-z]+[^>]*data-testid="xs-card-toggle"[^>]*>/) || [''])[0];
  const bodyDiv = (markup) => (markup.match(/<div[^>]*data-testid="xs-card-body"[^>]*>([\s\S]*?)<\/div>/) || ['', '']);
  const assertFoldedBody = (markup, label) => {
    const [tag, inner] = bodyDiv(markup);
    assert.ok(tag, `${label}:正文容器仍在 DOM(旧断言要按 testid 量高度)`);
    assert.match(tag, /hidden=""/, `${label}:折叠态正文容器 hidden(高度 0)`);
    assert.equal(inner.trim(), '', `${label}:折叠态正文容器里不留原文`);
    assert.match(markup, /<span hidden="" aria-hidden="true">/, `${label}:原文有不进无障碍树的不可见副本(行内文本匹配用)`);
  };
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']) {
    const html = renderFor(mode);
    const markup = cardMarkup(html, M1);
    assert.ok(markup, `${mode} 档:卡片渲染出来了`);
    assertFoldedBody(markup, `${mode} 档`);
    assert.ok(markup.includes('第 1 行'), `${mode} 档:原文仍在行内(只是不可见)`);
    assert.ok(!/-webkit-line-clamp/.test(html), `${mode} 档:不再用 line-clamp 折叠`);
    assert.ok(markup.includes('data-testid="xs-card-expand"'), `${mode} 档:有【展开】`);
    // r151w 折叠行契约:根是通用折叠行、标题行是唯一的可展开控件(button + aria),动作行紧跟标题行
    assert.match(html, /data-testid="xs-card"[^>]*data-cgui="xs-notice"/, `${mode} 档:根是通用折叠行`);
    assert.match(markup, /<button[^>]*data-testid="xs-card-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]*xs-card-body/, `${mode} 档:标题行是可展开按钮且带 aria-expanded/aria-controls(默认收起)`);
    const idxToggle = markup.indexOf('data-testid="xs-card-toggle"');
    const idxReason = markup.indexOf('data-testid="xs-card-reason"');
    assert.ok(idxToggle >= 0 && idxToggle < idxReason, `${mode} 档:DOM 顺序为 标题行 → 动作行(正文容器隐藏)`);
    // 展开提示在标题行按钮内部(整行只有一个交互控件,读屏不会念两遍)
    const toggleOpen = markup.slice(idxToggle, markup.indexOf('</button>', idxToggle));
    assert.ok(toggleOpen.includes('data-testid="xs-card-expand"'), `${mode} 档:展开提示在标题行按钮内部`);
  }
  // 长单段(无换行):新契约下同样只显示标题行 + 展开,折叠态没有任何正文预览。
  const oneLineHtml = renderFor('default');
  const oneLineMarkup = cardMarkup(oneLineHtml, M2);
  assert.ok(oneLineMarkup, '前提:长单段卡片渲染出来了');
  assertFoldedBody(oneLineMarkup, '长单段');
  assert.ok(oneLineMarkup.includes('data-testid="xs-card-expand"'), '长单段(无换行)也有【展开】');
  const oneLineToggle = toggleTag(oneLineMarkup);
  assert.ok(/^<button/.test(oneLineToggle) && /aria-expanded="false"/.test(oneLineToggle), '长单段:标题行是 BUTTON(能点开)');
  console.log('✓ 长单段:无换行正文折叠态无预览,标题行是 BUTTON + 展开入口');
  // 两行 + 尾随换行:新契约不再数行数 —— 有正文就有【展开】(旧「两行不加尾随换行」的死 toggle 场景消失)。
  const tnMarkup = cardMarkup(oneLineHtml, M3);
  assert.ok(tnMarkup, '前提:两行 + 尾随换行的卡片渲染出来了');
  assertFoldedBody(tnMarkup, '两行 + 尾随换行');
  assert.ok(tnMarkup.includes('data-testid="xs-card-expand"'), '两行 + 尾随换行:有正文就有【展开】(1 行也算)');
  assert.ok(/^<button/.test(toggleTag(tnMarkup)), '两行 + 尾随换行:标题行是 BUTTON');
  console.log('✓ 两行 + 尾随换行:同样只显示标题行 + 展开');
  // 正文为空:占位可见,但没有【展开】、标题行也不是按钮(占位不是正文)。
  const emptyMarkup = cardMarkup(oneLineHtml, M4);
  assert.ok(emptyMarkup, '前提:空正文卡片渲染出来了');
  const [emptyTag, emptyInner] = bodyDiv(emptyMarkup);
  assert.ok(emptyTag && !/hidden=""/.test(emptyTag), '空正文:正文容器可见(占位要能读到)');
  assert.ok(emptyInner.includes('（正文不可用）'), '空正文:显示占位文案');
  assert.ok(!emptyMarkup.includes('data-testid="xs-card-expand"'), '空正文:没有【展开】');
  assert.ok(!/^<button/.test(toggleTag(emptyMarkup)) && !/aria-expanded/.test(toggleTag(emptyMarkup)),
    '空正文:标题行不是按钮、不带 aria-expanded');
  console.log('✓ 空正文:占位可见、不可展开、标题行不是按钮');
  const bypass = renderFor('bypassPermissions');
  assert.ok(bodyTag(bypass), '前提:「放任」档卡片正文渲染出来了');
  assert.doesNotMatch(bodyTag(bypass), /hidden=""/, '「放任」档:正文容器可见');
  assert.doesNotMatch(bodyTag(bypass), /line-clamp/, '「放任」档:正文不折叠');
  const bypassOneLineBody = (bypass.slice(bypass.indexOf(`data-message-id="${M2}"`)).match(/<div[^>]*data-testid="xs-card-body"[^>]*>/) || [''])[0];
  assert.doesNotMatch(bypassOneLineBody, /line-clamp/, '「放任」档:长单段正文也不折叠');
  assert.ok(!bypass.includes('data-testid="xs-card-expand"'), '「放任」档:没有【展开】(已是全文)');
  assert.ok(bypass.includes('第 12 行'), '正文全文在');
  // 「放任」档标题行不是按钮、不带 aria-expanded(不留点了没变化的死按钮)
  const bypassToggle = (bypass.match(/<[a-z]+[^>]*data-testid="xs-card-toggle"[^>]*>/) || [''])[0];
  assert.ok(bypassToggle && !/^<button/.test(bypassToggle) && !/aria-expanded/.test(bypassToggle), '「放任」档:标题行不是按钮、不带 aria-expanded');
  console.log('✓ S6:「放任」档正文全文展示、无展开控件;其余档折叠态只有标题行 + 展开');

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
