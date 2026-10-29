#!/usr/bin/env node
// r151w 发送行派生(白盒):utils/xsession.js 的 xsSendNotices 是纯函数 —— 从本回合的工具调用推出
// 「已发送跨会话消息」/「原生发送被拒」折叠行。覆盖 GUI 成功 / 多目标 / 部分失败、原生会话成功、
// 子代理与队友不画、失败不画、引导拒绝画、同一 tool_use_id 去重、正文缺失占位、重做截断。
// 做法同 check-r151b-xs-card-render:esbuild 打包 + 浏览器全局垫片(模块会拉进 store / 请求层)。
// 无 client/node_modules(裸检出)时明确跳过并打印,不静默转绿。
// node tests/unit/check-r151w-xs-send-notice.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const clientDir = join(root, 'client');
const requireCjs = createRequire(import.meta.url);
const eq = (a, b, msg) => assert.equal(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);

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
    location: { href: 'http://127.0.0.1:6998/', origin: 'http://127.0.0.1:6998', protocol: 'http:', host: '127.0.0.1:6998', hostname: '127.0.0.1', port: '6998', pathname: '/', search: '', hash: '', reload: noop, assign: noop, replace: noop },
    history: { pushState: noop, replaceState: noop, state: null },
    requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: (t) => clearTimeout(t),
    document: { documentElement: el(), body: el(), head: el(), createElement: el, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', hidden: false, cookie: '', compatMode: 'CSS1Compat' },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'MacIntel', language: 'zh-CN', clipboard: { writeText: async () => {} } }, configurable: true }); } catch { /* */ }
  globalThis.fetch = async (url) => { throw new Error(`check-r151w-xs-send-notice:派生期间不应发请求 ${url}`); };
}

async function loadModule() {
  let esbuild;
  try {
    esbuild = requireCjs(join(clientDir, 'node_modules/esbuild'));
  } catch { return null; }
  const work = mkdtempSync(join(tmpdir(), 'cgui-r151w-send-'));
  const entry = join(work, 'entry.jsx');
  const src = (p) => JSON.stringify(join(clientDir, 'src', p));
  writeFileSync(entry, [
    `import * as xs from ${src('utils/xsession.js')};`,
    'export const { xsSendNotices, xsSendToolIds, xsToolResultText, XS_SEND_TOOL_GUI, XS_SEND_TOOL_NATIVE, XS_SEND_BODY_MISSING, XS_SEND_REJECT_TITLE, XS_SEND_REJECT_STATUS, XS_SEND_GUARD_MARKS } = xs;',
  ].join('\n'));
  const rawPlugin = {
    name: 'r151w-raw',
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, (a) => ({ path: join(a.resolveDir, a.path.replace(/\?raw$/, '')), namespace: 'r151w-raw' }));
      build.onLoad({ filter: /.*/, namespace: 'r151w-raw' }, (a) => ({ contents: readFileSync(a.path, 'utf8'), loader: 'text' }));
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

const M = await loadModule();
if (!M) {
  console.log('! 跳过 check-r151w-xs-send-notice:未找到 client/node_modules/esbuild(裸检出环境)');
  process.exit(0);
}

const { xsSendNotices, xsSendToolIds, xsToolResultText, XS_SEND_TOOL_GUI: GUI, XS_SEND_TOOL_NATIVE: NATIVE } = M;
const A_SID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B_SID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const C_SID = 'cccccccc-0000-4000-8000-00000000000c';
const target = (sid, name) => ({ sid, title: name });
const B = target(B_SID, '目标乙');
const C = target(C_SID, '目标丙');
const REFUSAL = '这个会话由 CC-GUI 管理。给 CC-GUI 里的其它会话发消息请用 mcp__ccgui-sessions__send_message（可先用 mcp__ccgui-sessions__list_sessions 查看）；它也能发给当前没在运行的会话。';

const call = (id, name, input, content, isError = false, extra = {}) => ({
  id, name, input, category: 'other',
  result: content === undefined ? null : { toolUseId: id, content, isError },
  ...extra,
});
// 同一个回合:blocks(有序)与 toolCalls 两处都摆上(与直播 / 历史两侧的真实形状一致)
const turnOf = (calls, extra = {}) => ({
  uuid: 't1', blocks: calls.map((tc) => ({ type: 'tool_use', toolCall: tc })), toolCalls: calls, ...extra,
});
const guiResult = (results, notice = '发送后不会同步收到回复。') => JSON.stringify({ results, notice });
const one = (calls, extra) => xsSendNotices(turnOf(calls, extra));

try {
  // ── 拒绝特征串交叉锁:客户端靠 XS_SEND_GUARD_MARKS 认「原生引导拒绝」,服务端一改文案这里就该红 ──
  // 不 import 服务端模块(它会拉起整个 xsession 运行时),只从源码读 NATIVE_GUARD_REASON 的字面值。
  const serverXs = readFileSync(join(root, 'server/services/xsession.js'), 'utf8');
  const guardDecl = serverXs.match(/export const NATIVE_GUARD_REASON\s*=\s*(['"])([\s\S]*?)\1\s*;/);
  ok(guardDecl, 'server/services/xsession.js 里应能找到 NATIVE_GUARD_REASON 常量');
  const guardReason = guardDecl[2];
  ok(M.XS_SEND_GUARD_MARKS.length > 0, '客户端 XS_SEND_GUARD_MARKS 不应为空');
  for (const mark of M.XS_SEND_GUARD_MARKS) {
    ok(typeof mark === 'string' && mark.length > 0, '拒绝特征串应为非空字符串');
    ok(guardReason.includes(mark),
      `客户端拒绝特征串「${mark}」必须包含在服务端 NATIVE_GUARD_REASON 里(服务端改文案时这条单测应变红)`);
  }
  console.log(`✓ 拒绝特征串交叉锁:${M.XS_SEND_GUARD_MARKS.length} 个客户端特征串都包含在服务端 NATIVE_GUARD_REASON 里`);

  // ── GUI 通道:1 个成功目标 ──
  let list = one([call('toolu_g1', GUI, { to: [B_SID], message: '第一行\n第二行' },
    guiResult([{ to: B_SID, ok: true, id: B_SID.slice(0, 8), name: B.title, delivery: 'card', note: '等待你确认后处理' }]))]);
  eq(list.length, 1, 'GUI 成功 → 1 条发送行');
  const g1 = list[0];
  eq(g1.toolUseId, 'toolu_g1', '行上带 tool_use_id');
  eq(g1.channel, 'gui', '通道 gui');
  eq(g1.rejected, false, '不是被拒');
  eq(g1.title, `已发送给 ${B.title}`, '标题「已发送给 <目标名>」');
  // r152w:折叠行只显示「已发送给 xxx + 展开」;note 降到展开后的元信息,不再占状态行
  eq(g1.status, '', '单目标成功:状态行不再带服务端 note');
  eq(g1.metaLines.length, 1, '单目标:note 进展开后的元信息');
  eq(g1.metaLines[0], '等待你确认后处理', '元信息保留服务端 note');
  eq(g1.body, '第一行\n第二行', '正文 = 调用参数里的正文');
  eq(g1.delivery, 'card', '单目标 delivery');
  eq(g1.okCount, 1, 'ok-count 1');
  eq(g1.failCount, 0, 'fail-count 0');
  ok(g1.metaLines[0].includes('等待你确认后处理'), '元信息 = 服务端 note');
  console.log('✓ GUI 成功:1 条、channel=gui、标题/状态/正文/delivery 正确');

  // ── GUI 通道:一次多目标 = 一行 ──
  list = one([call('toolu_g2', GUI, { to: [B_SID, C_SID], message: '群发正文' },
    guiResult([
      { to: B_SID, ok: true, name: B.title, delivery: 'card', note: '' },
      { to: C_SID, ok: true, name: C.title, delivery: 'queued', note: '' },
    ]))]);
  eq(list.length, 1, '多目标只出一条');
  eq(list[0].okCount, 2, 'ok-count = 2');
  eq(list[0].title, '已发送给 2 个会话', '多目标标题「已发送给 <N> 个会话」');
  eq(list[0].delivery, 'mixed', 'delivery 不同 → mixed');
  eq(list[0].metaLines.length, 2, '元信息每目标一行');
  ok(list[0].metaLines.some((l) => l.includes(B.title)) && list[0].metaLines.some((l) => l.includes(C.title)), '元信息含两个目标名');
  console.log('✓ GUI 多目标:一行、ok-count=2、标题「2 个会话」、delivery=mixed、元信息两个名字');

  // ── GUI 通道:部分失败仍出行,只列成功项 ──
  list = one([call('toolu_g3', GUI, { to: [B_SID, C_SID], message: '部分失败正文' },
    guiResult([
      { to: B_SID, ok: true, name: B.title, delivery: 'card', note: '等待你确认后处理' },
      { to: C_SID, ok: false, code: 'XS_INBOX_FULL', error: '目标收件箱已满' },
    ]))]);
  eq(list.length, 1, '部分失败仍出一行');
  eq(list[0].okCount, 1, 'ok-count 1');
  eq(list[0].failCount, 1, 'fail-count 1');
  eq(list[0].title, `已发送给 ${B.title}`, '标题只含成功目标');
  ok(!list[0].title.includes(C.title), '标题不把失败目标写成已发送');
  ok(list[0].status.includes('失败'), '状态里出现「失败」');
  ok(list[0].metaLines.some((l) => l.includes('目标收件箱已满')), '元信息带失败原因');
  console.log('✓ GUI 部分失败:仍出行、ok=1/fail=1、标题只含成功目标、元信息带失败原因');

  // ── GUI 通道:全失败 / 工具报错 → 不画 ──
  eq(one([call('toolu_g4', GUI, { to: [B_SID], message: '全失败' }, guiResult([{ to: B_SID, ok: false, code: 'XS_INBOX_FULL', error: '满' }]))]).length, 0, '全失败不画');
  eq(one([call('toolu_g5', GUI, { to: [B_SID], message: '报错' }, 'R151W 工具报错', true)]).length, 0, 'GUI 工具 is_error 不画');
  eq(one([call('toolu_g6', GUI, { to: [B_SID], message: '还没结果' }, undefined)]).length, 0, '没有 result 不画(进行中)');
  console.log('✓ GUI 全失败 / is_error / 无结果:都不画(错误留在工具卡)');

  // ── 原生通道:会话目标成功 ──
  list = one([call('toolu_n1', NATIVE,
    { to: 'uds:/tmp/r151w.sock', recipient: 'uds:/tmp/r151w.sock', recipient_kind: 'session', summary: 'R151W 主题', message: '原生正文\n第二行' },
    JSON.stringify({ success: true, message: 'Message sent successfully' }))]);
  eq(list.length, 1, '原生会话成功 → 1 条');
  eq(list[0].channel, 'native', '通道 native');
  eq(list[0].title, '已发送跨会话消息', '原生标题固定');
  ok(list[0].status.includes('发给 '), '状态含「发给 」');
  ok(list[0].status.includes('uds:'), '状态含目标地址');
  ok(list[0].status.includes('R151W 主题'), 'summary 进状态行');
  eq(list[0].body, '原生正文\n第二行', '正文取 message');
  eq(list[0].delivery, 'native', 'delivery=native');
  eq(list[0].okCount, 1, 'ok-count 1');
  eq(list[0].failCount, 0, 'fail-count 0');
  // 正文键回退:prompt → content;success 用文本兜底
  eq(one([call('toolu_n2', NATIVE, { to: 'uds:/x', recipient_kind: 'session', prompt: '老版本 prompt' }, '{"success":true}')])[0].body, '老版本 prompt', '正文回退 prompt');
  eq(one([call('toolu_n3', NATIVE, { to: 'uds:/x', recipient_kind: 'session', content: '截断副本' }, '"success": true')])[0].body, '截断副本', '正文回退 content');
  console.log('✓ 原生会话成功:标题/状态(发给+地址+主题)/正文(message→prompt→content)/delivery 正确');

  // ── 原生:发给子代理 / 队友 → 不画 ──
  eq(one([call('toolu_n4', NATIVE, { to: 'agent-abc', recipient: 'agent-abc', recipient_kind: 'agent', message: '给子代理' }, '{"success":true,"message":"Resuming agent agent-abc"}')]).length, 0, 'recipient_kind=agent 不画');
  eq(one([call('toolu_n5', NATIVE, { to: 'teammate', recipient: 'teammate', recipient_kind: 'name', message: '给队友' }, '{"success":true}')]).length, 0, 'recipient_kind=name 不画');
  eq(one([call('toolu_n6', NATIVE, { to: 'agent-abc', message: '没写 kind 也不是 uds' }, '{"success":true}')]).length, 0, '非会话目标不画');
  console.log('✓ 原生发给子代理 / 队友 / 非会话目标:不画(避免每条子代理消息都冒一条「已发送」)');

  // ── 原生:失败 / 非引导拒绝 → 不画 ──
  eq(one([call('toolu_n7', NATIVE, { to: 'uds:/x', recipient_kind: 'session', message: 'x' }, '{"success":false,"message":"nope"}')]).length, 0, 'success:false 不画');
  eq(one([call('toolu_n8', NATIVE, { to: 'uds:/x', recipient_kind: 'session', message: 'x' }, 'Error: 网络错误，连接超时', true)]).length, 0, '其它失败(非引导拒绝)不画');
  eq(one([call('toolu_n9', NATIVE, { to: 'agent-err', recipient_kind: 'agent', message: 'x' }, 'Error: 网络错误', true)]).length, 0, '非会话目标的失败不画');
  console.log('✓ 原生失败(success:false / 其它错误 / 非会话目标):都不画');

  // ── 原生:被引导拒绝 → 一条「被拒」行 ──
  list = one([call('toolu_n10', NATIVE, { to: 'uds:/tmp/r151w-d8.sock', recipient_kind: 'session', message: '被拒正文' }, REFUSAL, true)]);
  eq(list.length, 1, '引导拒绝 → 1 条');
  eq(list[0].rejected, true, 'rejected 标记');
  eq(list[0].channel, 'native', '通道 native');
  eq(list[0].title, '原生发送被拒', '标题「原生发送被拒」');
  ok(!list[0].title.includes('已发送'), '被拒行标题不含「已发送」');
  eq(list[0].status, '请改用跨会话工具', '状态提示改用跨会话工具');
  eq(list[0].okCount, 0, 'ok-count 0');
  eq(list[0].failCount, 0, 'fail-count 0');
  eq(list[0].body, REFUSAL, '正文是完整拒绝原因');
  ok(list[0].body.includes(M.XS_SEND_GUARD_MARKS[0]), '正文含稳定特征串');
  // 另一条特征串(GUI 工具名)单独也认
  eq(one([call('toolu_n11', NATIVE, { to: 'uds:/x', recipient_kind: 'session' }, '请用 mcp__ccgui-sessions__send_message 发', true)])[0].rejected, true, '按 GUI 工具名特征也认');
  console.log('✓ 原生被引导拒绝:一条 data-rejected 行、标题/状态正确、正文是完整原因');

  // ── 去重:blocks 与 toolCalls 各出现一次 → 1 条 ──
  const dup = call('toolu_dup', GUI, { to: [B_SID], message: '去重正文' }, guiResult([{ to: B_SID, ok: true, name: B.title, delivery: 'auto' }]));
  list = xsSendNotices({ blocks: [{ type: 'tool_use', toolCall: dup }], toolCalls: [dup] });
  eq(list.length, 1, '同一个 tool_use_id 只出一条');
  // blocks 里没结果、toolCalls 里有结果 → 用带结果的那份,不漏画
  const bare = { ...dup, result: null };
  list = xsSendNotices({ blocks: [{ type: 'tool_use', toolCall: bare }], toolCalls: [dup] });
  eq(list.length, 1, '两处同 id 时取带结果的那份');
  console.log('✓ 去重:blocks + toolCalls 同一 tool_use_id 只出一条(结果只在一处也能画)');

  // ── 正文缺失 → 占位 ──
  list = one([call('toolu_e1', GUI, { to: [B_SID] }, guiResult([{ to: B_SID, ok: true, name: B.title }]))]);
  eq(list[0].body, M.XS_SEND_BODY_MISSING, '正文缺失用「（正文未记录）」');
  console.log('✓ 正文缺失:占位「（正文未记录）」');

  // ── 重做截断:被点工具及其之后都不画 ──
  const calls = [
    call('toolu_r1', GUI, { to: [B_SID], message: '第一条' }, guiResult([{ to: B_SID, ok: true, name: B.title }])),
    call('toolu_r2', GUI, { to: [B_SID], message: '第二条' }, guiResult([{ to: B_SID, ok: true, name: B.title }])),
    call('toolu_r3', GUI, { to: [B_SID], message: '第三条' }, guiResult([{ to: B_SID, ok: true, name: B.title }])),
  ];
  eq(one(calls, { _retryTrimToolId: 'toolu_r2' }).map((n) => n.toolUseId).join(','), 'toolu_r1', '截断点之前的保留、之后的丢弃');
  eq(one(calls).length, 3, '没有重做标记时三条都在');
  console.log('✓ 重做截断:_retryTrimToolId 之前的保留,被点工具及之后都不画');

  // ── 其它工具 / 空输入 ──
  eq(one([call('toolu_o1', 'Bash', { command: 'ls' }, 'ok')]).length, 0, '无关工具不画');
  eq(xsSendNotices(null).length, 0, 'null 回合 → 0 条');
  eq(xsSendNotices({}).length, 0, '没有工具调用 → 0 条');
  eq(xsToolResultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb', 'tool_result 的数组正文');
  console.log('✓ 无关工具 / 空回合:不画;tool_result 两种正文形态都认');

  // ── 回执补位:记录里没写出 tool_result 时,用已观察到的回执补上(回合换历史副本后不凭空消失) ──
  const noResult = call('toolu_c1', GUI, { to: [B_SID], message: '回执正文' }, undefined);
  const receipt = one([call('toolu_c1', GUI, { to: [B_SID], message: '回执正文' }, guiResult([{ to: B_SID, ok: true, name: B.title, delivery: 'queued' }]))])[0];
  ok(receipt && receipt.title === `已发送给 ${B.title}`, '前提:先有一条成功回执');
  list = xsSendNotices(turnOf([noResult]), { receipts: { toolu_c1: receipt } });
  eq(list.length, 1, '没有 result 但有回执 → 补出一条');
  eq(list[0].title, receipt.title, '补出来的与那次观察一致');
  eq(xsSendNotices(turnOf([noResult])).length, 0, '没有 result 也没有回执 → 不画');
  const failedNoResult = call('toolu_c2', GUI, { to: [B_SID], message: 'x' }, '报错了', true);
  eq(xsSendNotices(turnOf([failedNoResult]), { receipts: { toolu_c2: receipt } }).length, 0, '有失败结果时以失败为准,不拿回执冒充成功');
  // 合成终态(finalizedMessages 给未回执工具补的中断态)不是真回执 → 也走回执补位
  const synth = { id: 'toolu_c3', name: GUI, input: { to: [B_SID], message: '回执正文' }, category: 'call', result: { content: '', isError: false, synthetic: true, interrupted: true } };
  list = xsSendNotices({ toolCalls: [synth], blocks: [{ type: 'tool_use', toolCall: synth }] }, { receipts: { toolu_c3: receipt } });
  eq(list.length, 1, '合成中断态 + 有回执 → 补出那条(不把「已发送」误判成失败)');
  eq(xsSendNotices({ toolCalls: [synth] }).length, 0, '合成中断态 + 没有回执 → 不画');
  console.log('✓ 回执补位:缺 tool_result 时用已观察到的回执;没有回执 / 结果是失败 → 不画');

  // ── 跨回合去重:hidden 里的 tool_use_id 不再画(同一 id 出现在两条回合里,只让最早那轮画) ──
  const dupCall = call('toolu_h1', GUI, { to: [B_SID], message: '去重第二条' }, guiResult([{ to: B_SID, ok: true, name: B.title }]));
  eq(xsSendNotices(turnOf([dupCall]), { hidden: new Set(['toolu_h1']) }).length, 0, 'hidden 命中 → 这一轮不画');
  eq(xsSendNotices(turnOf([dupCall]), { hidden: new Set(['toolu_other']) }).length, 1, 'hidden 没命中 → 照常画');
  eq(xsSendToolIds(turnOf([
    call('toolu_i1', GUI, { to: [B_SID], message: 'a' }, '{}'),
    call('toolu_i2', 'Bash', { command: 'ls' }, 'ok'),
    call('toolu_i3', NATIVE, { to: 'uds:/x', recipient_kind: 'session' }, '{"success":true}'),
  ])).join(','), 'toolu_i1,toolu_i3', 'xsSendToolIds 只列发送类工具、按出现顺序');
  eq(xsSendToolIds(turnOf([dupCall], { _retryTrimToolId: 'toolu_h1' })).length, 0, '截断点及之后的发送工具不算在内');
  console.log('✓ 跨回合去重:hidden 命中不再画;xsSendToolIds 只列发送类工具并按 _retryTrimToolId 截断');
} finally {
  M.cleanup();
}
console.log('PASS check-r151w-xs-send-notice');
process.exit(0);
