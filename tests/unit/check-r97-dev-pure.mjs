#!/usr/bin/env node
// 作者自测(r97):共享单元的纯函数契约 + 抽取后的关键源码锁。
// 与验收测试 check-r97-home-slash.mjs 相互独立,这份只保证"我抽出来的东西自己是对的"。
// 变异哨兵(实跑验证过红):filterSlashCommands 去掉沉底 → t2 红;detectAtQuery 丢
// 斜杠早退 → t4 红;applyAtInsert 少拼空格 → t5 红;createSessionRef 不判状态码 → t9 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterSlashCommands, slashBlocked, fetchSlashCommands } from '../../client/src/utils/slashCommands.js';
import {
  detectAtQuery, applyAtInsert, parentDir, mapDirEntries, mapSearchFiles,
  filterAtSessions, fetchDirEntries, searchProjectFiles, createSessionRef,
} from '../../client/src/utils/atRef.js';

const read = (p) => readFileSync(new URL(`../../client/src/${p}`, import.meta.url), 'utf8');
const names = (list) => list.map((c) => c.name);
const CMDS = [
  { name: '/context', desc: 'ctx', type: 'builtin', requiresAnthropic: false },
  { name: '/cost', desc: 'cost', type: 'builtin', requiresAnthropic: 'full' },
  { name: '/compact', desc: 'cmp', type: 'builtin', requiresAnthropic: 'partial' },
  { name: '/agents', desc: 'ag', type: 'builtin', requiresAnthropic: false },
  { name: '/Deploy', desc: 'proj', type: 'project', requiresAnthropic: false },
];

// t1 slashBlocked:只有 full + 第三方才阻止
{
  assert.equal(slashBlocked({ requiresAnthropic: 'full' }, false), true);
  assert.equal(slashBlocked({ requiresAnthropic: 'full' }, undefined), true, 't1: 判据是 !isAnthropic');
  assert.equal(slashBlocked({ requiresAnthropic: 'full' }, true), false);
  assert.equal(slashBlocked({ requiresAnthropic: 'partial' }, false), false, 't1: partial 永不阻止');
  for (const cmd of [{ requiresAnthropic: false }, {}, null, undefined]) {
    assert.equal(slashBlocked(cmd, false), false, 't1: 缺字段/空值不抛错');
  }
}

// t2 filterSlashCommands:整串前缀 + 大小写不敏感 + 阻止项沉底 + 不就地重排
{
  for (const text of ['', 'hi', ' /co']) assert.deepEqual(filterSlashCommands(CMDS, text, true), [], 't2: 不以 / 开头恒空');
  for (const list of [null, 'x', undefined]) assert.deepEqual(filterSlashCommands(list, '/c', true), [], 't2: 非数组恒空');
  assert.deepEqual(names(filterSlashCommands(CMDS, '/', true)), names(CMDS), 't2: 全命中保持入参顺序');
  assert.deepEqual(names(filterSlashCommands(CMDS, '/co', true)), ['/context', '/cost', '/compact']);
  assert.deepEqual(names(filterSlashCommands(CMDS, '/co', false)), ['/context', '/compact', '/cost'], 't2: full 沉底且其余相对顺序不变');
  assert.deepEqual(names(filterSlashCommands(CMDS, '/CO', true)), ['/context', '/cost', '/compact'], 't2: 大小写不敏感');
  assert.deepEqual(names(filterSlashCommands(CMDS, '/dep', true)), ['/Deploy']);
  assert.deepEqual(filterSlashCommands(CMDS, '/context x', true), [], 't2: 整串前缀匹配,不是分词');
  assert.deepEqual(filterSlashCommands(CMDS, '/zzz', true), []);
  assert.deepEqual(names(filterSlashCommands([null, { name: 1 }, { desc: 'x' }, CMDS[0]], '/c', true)), ['/context'], 't2: 脏条目跳过不抛错');
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `/c${i}` }));
  assert.equal(filterSlashCommands(many, '/c', true).length, 60, 't2: 不截断(50 条截断是菜单渲染行为)');
  const before = names(CMDS);
  assert.equal(filterSlashCommands(CMDS, '/co', false)[0], CMDS[0], 't2: 返回入参里的同一对象引用');
  assert.deepEqual(names(CMDS), before, 't2: 入参数组不被就地重排');
}

// t3 fetchSlashCommands:URL 拼接 + 字段兜底 + 不检查状态码
{
  const calls = [];
  const stub = (body, ok = true) => async (url) => { calls.push(url); return { ok, json: async () => body }; };
  assert.deepEqual(
    await fetchSlashCommands('/a b/c', { fetchImpl: stub({}) }),
    { commands: [], provider: 'Anthropic', isAnthropic: true },
  );
  assert.equal(calls[0], '/api/slash-commands?cwd=%2Fa%20b%2Fc', 't3: cwd 编码');
  for (const cwd of ['', undefined, null]) {
    await fetchSlashCommands(cwd, { fetchImpl: stub({}) });
    assert.equal(calls.at(-1), '/api/slash-commands', 't3: 空 cwd 不带 ?');
  }
  assert.equal((await fetchSlashCommands('', { fetchImpl: stub({ isAnthropic: false }) })).isAnthropic, false);
  assert.equal((await fetchSlashCommands('', { fetchImpl: stub({ isAnthropic: undefined }) })).isAnthropic, true, 't3: 判据 !== false');
  assert.deepEqual(
    await fetchSlashCommands('', { fetchImpl: stub({ error: 'boom' }, false) }),
    { commands: [], provider: 'Anthropic', isAnthropic: true },
    't3: HTTP 500 也照读 body 兜底成空(不新增错误分支)',
  );
  await assert.rejects(fetchSlashCommands('', { fetchImpl: async () => { throw new Error('net'); } }), /net/);
}

// t4 detectAtQuery
{
  assert.equal(detectAtQuery('', 0), null);
  assert.equal(detectAtQuery('hello', 5), null);
  assert.equal(detectAtQuery('/foo @b', 8), null, 't4: 斜杠命令优先,整串以 / 开头不认 @');
  assert.deepEqual(detectAtQuery('@', 1), { query: '', start: 0 });
  assert.deepEqual(detectAtQuery('hi @sr', 6), { query: 'sr', start: 3 });
  assert.deepEqual(detectAtQuery('x\n@f', 4), { query: 'f', start: 2 }, 't4: 换行后也算');
  assert.equal(detectAtQuery('a@b', 3), null, 't4: @ 前必须行首或空白');
  assert.equal(detectAtQuery('hi @a b', 7), null, 't4: query 内不能有空白');
  assert.equal(detectAtQuery('hi @a@b', 7), null, 't4: query 内不能再有 @');
  assert.deepEqual(detectAtQuery('@ab cd', 3), { query: 'ab', start: 0 }, 't4: 只看光标前');
  assert.deepEqual(detectAtQuery('hi @sr'), { query: 'sr', start: 3 }, 't4: caret 省略按长度');
  assert.deepEqual(detectAtQuery('hi @sr', null), { query: 'sr', start: 3 });
  for (const v of [null, undefined]) assert.equal(detectAtQuery(v, 0), null, 't4: 空值不抛错');
  for (const [v, c] of [['@', 1], ['hi @sr', 6], ['x\n@f', 4], ['@ab cd', 3]]) {
    const r = detectAtQuery(v, c);
    assert.equal(v[r.start], '@', 't4 不变式: start 指向 @');
    assert.equal(v.slice(r.start + 1, c), r.query, 't4 不变式: start+1..caret === query');
  }
}

// t5 applyAtInsert / t6 parentDir
{
  assert.equal(applyAtInsert('hi @sr', { query: 'sr', start: 3 }, 'src/a.js'), 'hi @src/a.js ');
  assert.equal(applyAtInsert('@q rest', { query: 'q', start: 0 }, 'x'), '@x  rest', 't5: 双空格是现状行为,逐字保留');
  assert.equal(applyAtInsert('@', { query: '', start: 0 }, 'a.md'), '@a.md ');
  assert.equal(applyAtInsert('hi', null, 'x'), 'hi', 't5: at 为空原样返回');
  assert.equal(applyAtInsert('hi', { query: 'x' }, 'x'), 'hi', 't5: 缺 start 原样返回');
  assert.equal(applyAtInsert(null, null, 'x'), '');

  assert.equal(parentDir('a/b/c'), 'a/b');
  assert.equal(parentDir('a'), '');
  for (const d of ['', null, undefined]) assert.equal(parentDir(d), '');
}

// t7 mapDirEntries / mapSearchFiles
{
  const entries = [{ name: 'src', isDir: true }, { name: 'a.md', isDir: false }];
  assert.deepEqual(mapDirEntries(entries, ''), [
    { kind: 'dir', name: 'src', rel: 'src' },
    { kind: 'file', name: 'a.md', rel: 'a.md' },
  ]);
  assert.deepEqual(mapDirEntries(entries, 'src'), [
    { kind: 'up', name: '..', rel: '' },
    { kind: 'dir', name: 'src', rel: 'src/src' },
    { kind: 'file', name: 'a.md', rel: 'src/a.md' },
  ], 't7: 子目录首行「返回上级」+ rel 带目录前缀');
  assert.deepEqual(mapDirEntries(null, ''), []);
  assert.deepEqual(mapDirEntries(undefined, ''), []);
  assert.deepEqual(mapDirEntries(null, 'src'), [{ kind: 'up', name: '..', rel: '' }], 't7: 目录里恒可返回上级');

  assert.deepEqual(mapSearchFiles(['a/b.js', 'c.md']), [
    { kind: 'file', name: 'a/b.js', rel: 'a/b.js' },
    { kind: 'file', name: 'c.md', rel: 'c.md' },
  ]);
  for (const f of [null, undefined, 'x']) assert.deepEqual(mapSearchFiles(f), []);
}

// t8 filterAtSessions:query 整体小写化后再比,sessionId 不变换
{
  const list = [
    { sessionId: 's1', firstPrompt: '修 Bug' },
    { sessionId: 's2', firstPrompt: '写文档' },
    { sessionId: 's3', firstPrompt: '旧的', archived: true },
  ];
  const ids = (r) => r.map((s) => s.sessionId);
  assert.deepEqual(ids(filterAtSessions(list, '', null)), ['s1', 's2'], 't8: archived 恒排除');
  assert.deepEqual(ids(filterAtSessions(list, '', 's1')), ['s2']);
  assert.deepEqual(ids(filterAtSessions(list, '文档', null)), ['s2']);
  assert.deepEqual(ids(filterAtSessions(list, 's2', null)), ['s2']);
  assert.deepEqual(ids(filterAtSessions(list, 'S2', null)), ['s2'], 't8: q 已小写化 → 与小写 query 等价');
  assert.deepEqual(ids(filterAtSessions(list, 'BUG', null)), ['s1']);
  for (const l of [null, 'x']) assert.deepEqual(filterAtSessions(l, '', null), []);
  assert.deepEqual(filterAtSessions([{ sessionId: 'zz' }], 'q', null), [], 't8: 缺 firstPrompt 且不命中 id 前缀');
  const many = Array.from({ length: 40 }, (_, i) => ({ sessionId: `s${i}`, firstPrompt: 'x' }));
  assert.equal(filterAtSessions(many, '', null).length, 20, 't8: 最多 20 条');
  for (const q of ['s2', '文档', 'bug', '']) {
    assert.deepEqual(filterAtSessions(list, q.toUpperCase(), null), filterAtSessions(list, q.toLowerCase(), null),
      't8 不变式: 大小写等价');
  }
}

// t9 三个取数函数:URL/方法/兜底/错误
{
  let seen = null;
  const stub = (body, ok = true) => async (url, init) => { seen = { url, init }; return { ok, json: async () => body }; };

  assert.deepEqual(
    await fetchDirEntries('/p', 'src', { fetchImpl: stub({ entries: [{ name: 'a.md', isDir: false }] }) }),
    [{ kind: 'up', name: '..', rel: '' }, { kind: 'file', name: 'a.md', rel: 'src/a.md' }],
  );
  assert.equal(seen.url, `/api/files/list?path=${encodeURIComponent('/p/src')}`, 't9: 目录拼绝对路径走 path=');
  await fetchDirEntries('/p', '', { fetchImpl: stub({}) });
  assert.equal(seen.url, `/api/files/list?path=${encodeURIComponent('/p')}`);
  assert.deepEqual(await fetchDirEntries('/p', '', { fetchImpl: stub({ error: 'x' }, false) }), [], 't9: GET 不判状态码,兜底空');

  assert.deepEqual(
    await searchProjectFiles('/p', 'a b', { fetchImpl: stub({ files: ['x/a.js'] }) }),
    [{ kind: 'file', name: 'x/a.js', rel: 'x/a.js' }],
  );
  assert.equal(seen.url, '/api/files/search?cwd=%2Fp&q=a%20b');
  assert.deepEqual(await searchProjectFiles('/p', 'q', { fetchImpl: stub({}, false) }), [], 't9: GET 不判状态码,兜底空');

  assert.equal(await createSessionRef('sid', 'ph', { fetchImpl: stub({ path: '/tmp/ref.md' }) }), '/tmp/ref.md');
  assert.equal(seen.url, '/api/session-ref');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.init.body), { sessionId: 'sid', projectHash: 'ph' });
  await assert.rejects(createSessionRef('s', 'p', { fetchImpl: stub({ error: '没权限' }, false) }), /没权限/,
    't9: 只有 createSessionRef 检查状态码');
  await assert.rejects(createSessionRef('s', 'p', { fetchImpl: stub({}, false) }), /生成会话引用失败/);
}

// t10 源码锁:抽取彻底(实现只剩一份)+ 两处弹出方向 + 首页会话槽
{
  const SU = read('utils/slashCommands.js');
  const AU = read('utils/atRef.js');
  const AH = read('hooks/useAtRef.js');
  const AP = read('components/AtRefPanel.jsx');
  const SM = read('components/SlashCommandMenu.jsx');
  const C = read('components/ChatInput.jsx');
  const A = read('App.jsx');
  const H = A.slice(A.indexOf('function HomeState('), A.indexOf('// ─── CLI-style spinner'));
  const cnt = (s, t) => s.split(t).length - 1;

  // 纯函数层零 React / 零 store
  for (const [n, s] of [['SU', SU], ['AU', AU]]) {
    for (const banned of ['useState', 'useEffect', 'useStore', 'localStorage', 'react']) {
      assert.equal(cnt(s, banned), 0, `t10: ${n} 不得含 ${banned}`);
    }
  }
  assert.equal(cnt(SU, 'r.ok'), 0, 't10: SU 的 GET 不判状态码');
  assert.equal(cnt(AU, 'r.ok'), 1, 't10: AU 只有 createSessionRef 判状态码');
  assert.equal(cnt(AU, 'setTimeout'), 0, 't10: 防抖属于 hook 不属于纯函数');

  // 状态机只有一份:端点全在 AU,hook 不读 store
  for (const banned of ['/api/', 'useStore', 'localStorage']) assert.equal(cnt(AH, banned), 0, `t10: AH 不得含 ${banned}`);
  assert.match(AH, /\}, \[atState\?\.query, atTab, !!atState, atDir\]\)/, 't10: 文件 effect 依赖逐字保留');
  assert.match(AH, /setTimeout\([\s\S]{0,200}, 180\)/, 't10: 180ms 防抖');
  assert.match(AH, /clearTimeout/, 't10: 防抖 cleanup');
  assert.match(AH, /await import\('\.\.\/utils\/confirmDialog\.jsx'\)/, 't10: 失败提示走应用内对话框');

  // 展示层无副作用
  for (const [n, s] of [['SM', SM], ['AP', AP]]) {
    for (const banned of ['useState', 'useEffect', 'fetch(', '/api/', 'useStore', 'window.confirm', 'alert(']) {
      assert.equal(cnt(s, banned), 0, `t10: ${n} 不得含 ${banned}`);
    }
  }
  assert.match(SM, /disabled=\{blocked\}/, 't10: 只有阻止判据能禁用(partial / TUI 必须可选)');
  assert.equal(cnt(SM, "requiresAnthropic === 'full'"), 0, 't10: 阻止判据只有 slashBlocked 一处实现');

  // ChatInput 已彻底交出实现,且会话内两个面板不传 className(仍向上弹)
  for (const banned of ['TYPE_ICONS', 'TYPE_LABELS', 'requiresAnthropic', 'setAtState', 'pickAtItem', 'atCtxRef',
    '/api/slash-commands', '/api/files/list', '/api/files/search', '/api/session-ref']) {
    assert.equal(cnt(C, banned), 0, `t10: C 不得残留 ${banned}`);
  }
  assert.equal(cnt(C, 'MessagesSquare'), 2, 't10: 旁问按钮的 MessagesSquare 必须留(import + 使用点)');
  const menuTag = C.slice(C.indexOf('<SlashCommandMenu'), C.indexOf('/>', C.indexOf('<SlashCommandMenu')));
  const panelTag = C.slice(C.indexOf('<AtRefPanel'), C.indexOf('/>', C.indexOf('<AtRefPanel')));
  assert.equal(cnt(menuTag, 'className'), 0, 't10: 会话内斜杠菜单不传 className(默认向上弹)');
  assert.equal(cnt(panelTag, 'className'), 0, 't10: 会话内 @ 面板不传 className(默认向上弹)');
  assert.ok(C.indexOf('// ── @ 引用选择器') > C.indexOf('const selectCommand ='),
    't10: check-input-history-nav 的切片锚点必须留在 selectCommand 之后');

  // 首页:两个面板向下弹、挂在工具行之后、会话槽按所选项目取
  assert.equal(cnt(H, 'absolute top-full'), 2, 't10: 首页两个面板都向下弹');
  assert.equal(cnt(H, 'absolute bottom-full'), 0);
  const send = H.indexOf('data-testid="home-send"');
  assert.ok(H.indexOf('<SlashCommandMenu') > send && H.indexOf('<AtRefPanel') > send,
    't10: 面板必须挂在工具行之后(挂 textarea 之前会踩附件保护窗口)');
  assert.match(H, /s\.sessionsByProject\[project\.hash\]/, 't10: 首页会话候选按所选项目取');
  assert.equal(cnt(H, 'useStore((s) => s.sessions)'), 0, 't10: 首页不得用全局旧槽');
  assert.equal(H.split('\n').filter((l) => l.includes('useStore(') && l.includes('|| []')).length, 0,
    't10: zustand 选择器不得 || [](新引用 → React #185 白屏)');
  assert.ok(H.includes('|| EMPTY_ARRAY'), 't10: 用模块级常量兜底');
}

console.log('check-r97-dev-pure: all passed');
