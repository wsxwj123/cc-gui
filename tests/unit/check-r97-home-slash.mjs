#!/usr/bin/env node
// r97:首页(新建会话)输入框接入斜杠命令菜单 + `@` 引用面板。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r97.md 的对外契约写,
// 不看实现(未读 PLAN、未读 ChatInput.jsx / App.jsx 正文)。四部分:
//   A. 斜杠纯函数契约(slashCommands.js):真 import 真跑。
//   B. `@` 纯函数契约(atRef.js):真 import 真跑,取数函数注入假 fetchImpl。
//   C. 源码锁(.jsx / hook 进不了 node,只能读文件做结构断言),逐条抄 INTERFACE §5。
//   D. §6 既有测试零改动金丝雀(两条 grep 口径的命中行数)。
//
// 设计要点:纯函数部分用【动态 import + 逐条 try/catch】。静态 import 一个还不存在的
// 导出会在 ESM 链接阶段直接抛错、后面一条断言都跑不到;改前必须"每条各自红",
// 才看得出到底缺哪几件。
//
// 断言名带 INTERFACE 编号(B*/R*/M*/§*),红了能直接对回契约表。
// 名字带 [缺口 G*] 的条目是"契约自相矛盾/不可满足"处,口径见 .devflow/TEST-PLAN-r97.md。
//
// Run: node tests/unit/check-r97-home-slash.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const root = join(dirname(SELF), '..', '..');
const read = (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return ''; } };
const count = (s, re) => (s.match(re) || []).length;
const countS = (s, lit) => s.split(lit).length - 1;

let PASS = 0;
let FAILS = 0;
const failed = [];
async function check(name, fn) {
  try {
    await fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

// 全局 fetch 哨兵:任何"该用注入 fetchImpl 却走了全局 fetch"的实现都会炸在这里。
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('哨兵:调用了全局 fetch —— 契约要求用注入的 fetchImpl(单测不得依赖全局 fetch)');
};
const resp = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

// ══════════════════════════════════════════════════════════════════════════
// A. 斜杠纯函数契约(INTERFACE §1)—— client/src/utils/slashCommands.js
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] 斜杠纯函数 client/src/utils/slashCommands.js');

let SUM = null;
let SUERR = '';
try {
  SUM = await import('../../client/src/utils/slashCommands.js');
} catch (e) {
  SUERR = String((e && e.message) || e);
}
const slashBlocked = SUM?.slashBlocked;
const filterSlashCommands = SUM?.filterSlashCommands;
const fetchSlashCommands = SUM?.fetchSlashCommands;

await check('R1 slashCommands.js 可被 node 直接 import(零依赖纯函数模块)', () => {
  assert.ok(SUM, `import 失败:${SUERR}`);
});
await check('R1 filterSlashCommands / slashBlocked / fetchSlashCommands 三个具名导出都是函数', () => {
  assert.equal(typeof filterSlashCommands, 'function', '缺 filterSlashCommands');
  assert.equal(typeof slashBlocked, 'function', '缺 slashBlocked');
  assert.equal(typeof fetchSlashCommands, 'function', '缺 fetchSlashCommands');
});

// ── §1.1 slashBlocked ─────────────────────────────────────────────────
await check("§1.1/M5 slashBlocked:requiresAnthropic='full' 且非官方端点 → true", () => {
  assert.strictEqual(slashBlocked({ requiresAnthropic: 'full' }, false), true);
});
await check("§1.1 slashBlocked:isAnthropic 为 undefined 也算第三方(判据是 !isAnthropic)→ true", () => {
  assert.strictEqual(slashBlocked({ requiresAnthropic: 'full' }, undefined), true);
});
await check("§1.1 slashBlocked:官方端点下 full 不阻止 → false", () => {
  assert.strictEqual(slashBlocked({ requiresAnthropic: 'full' }, true), false);
});
await check("§1.1/M5/B3 slashBlocked:'partial' 永不阻止 → false", () => {
  assert.strictEqual(slashBlocked({ requiresAnthropic: 'partial' }, false), false);
  assert.strictEqual(slashBlocked({ requiresAnthropic: 'partial' }, true), false);
});
await check('§1.1 slashBlocked:requiresAnthropic 为 false / 缺字段 / null / undefined → false 且不抛错', () => {
  assert.strictEqual(slashBlocked({ requiresAnthropic: false }, false), false);
  assert.strictEqual(slashBlocked({}, false), false);
  assert.strictEqual(slashBlocked(null, false), false);
  assert.strictEqual(slashBlocked(undefined, false), false);
});

// ── §1.2 filterSlashCommands ──────────────────────────────────────────
// fixture 逐字抄 INTERFACE §1.2
const CMDS = [
  { name: '/context', desc: 'ctx', type: 'builtin', requiresAnthropic: false },
  { name: '/cost', desc: 'cost', type: 'builtin', requiresAnthropic: 'full' },
  { name: '/compact', desc: 'cmp', type: 'builtin', requiresAnthropic: 'partial' },
  { name: '/agents', desc: 'ag', type: 'builtin', requiresAnthropic: false },
  { name: '/Deploy', desc: 'proj', type: 'project', requiresAnthropic: false },
];
const names = (arr) => (arr || []).map((c) => c && c.name);

await check('§1.2/M1 不以 / 开头一律空:空串 / hi / 前导空格的 " /co" 都得 []', () => {
  assert.deepEqual(filterSlashCommands(CMDS, '', true), []);
  assert.deepEqual(filterSlashCommands(CMDS, 'hi', true), []);
  assert.deepEqual(filterSlashCommands(CMDS, ' /co', true), []);
});
await check('§1.2 commands 非数组(null / 字符串 / undefined)→ [] 且不抛错', () => {
  assert.deepEqual(filterSlashCommands(null, '/c', true), []);
  assert.deepEqual(filterSlashCommands('x', '/c', true), []);
  assert.deepEqual(filterSlashCommands(undefined, '/c', true), []);
});
await check('§1.2/B1 只打一个 "/" → 5 条全出,顺序 = 入参顺序', () => {
  assert.deepEqual(names(filterSlashCommands(CMDS, '/', true)), ['/context', '/cost', '/compact', '/agents', '/Deploy']);
});
await check('§1.2/B2/M3 官方端点 "/co" → [/context, /cost, /compact](收窄且不重排)', () => {
  assert.deepEqual(names(filterSlashCommands(CMDS, '/co', true)), ['/context', '/cost', '/compact']);
});
await check('§1.2/M2/B3 第三方端点 "/co" → [/context, /compact, /cost](full 沉底,其余相对顺序不变)', () => {
  assert.deepEqual(names(filterSlashCommands(CMDS, '/co', false)), ['/context', '/compact', '/cost']);
});
await check('§1.2/M2 第三方端点 "/" → 只有 /cost 沉到末位,其余四条保持入参顺序', () => {
  assert.deepEqual(names(filterSlashCommands(CMDS, '/', false)), ['/context', '/compact', '/agents', '/Deploy', '/cost']);
});
await check('§1.2/M4 大小写不敏感:"/CO" 结果与 "/co" 完全一致', () => {
  assert.deepEqual(names(filterSlashCommands(CMDS, '/CO', true)), names(filterSlashCommands(CMDS, '/co', true)));
  assert.deepEqual(names(filterSlashCommands(CMDS, '/CO', true)), ['/context', '/cost', '/compact']);
});
await check('§1.2/M4 大小写不敏感:"/dep" 命中大写开头的 /Deploy', () => {
  assert.deepEqual(names(filterSlashCommands(CMDS, '/dep', true)), ['/Deploy']);
});
await check('§1.2 整串前缀匹配:"/context x"(带参数)→ [](命令名不含空格)', () => {
  assert.deepEqual(filterSlashCommands(CMDS, '/context x', true), []);
});
await check('§1.2/B2 无命中:"/zzz" → []', () => {
  assert.deepEqual(filterSlashCommands(CMDS, '/zzz', true), []);
});
await check('§1.2 脏数据:数组含 null / 缺 name / name 非字符串 → 跳过且不抛错', () => {
  const dirty = [null, { desc: '无名' }, { name: 42 }, CMDS[0], undefined, { name: '/ctx-ok' }];
  assert.deepEqual(names(filterSlashCommands(dirty, '/c', true)), ['/context', '/ctx-ok']);
});
await check('§1.2/B18 命中 > 50 条不截断(50 条截断是菜单渲染行为,不是过滤行为)', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `/cmd${i}`, type: 'builtin', requiresAnthropic: false }));
  assert.equal(filterSlashCommands(many, '/cmd', true).length, 80);
});
await check('§1.2 不变式:返回项是入参里的同一对象引用(不克隆)', () => {
  const got = filterSlashCommands(CMDS, '/co', true);
  assert.strictEqual(got[0], CMDS[0]);
  assert.strictEqual(got[1], CMDS[1]);
  assert.strictEqual(got[2], CMDS[2]);
});
await check('§1.2 不变式:入参数组不被就地重排(第三方排序也不许改调用方的列表)', () => {
  const src = CMDS.slice();
  filterSlashCommands(src, '/co', false);
  filterSlashCommands(src, '/', false);
  assert.deepEqual(names(src), ['/context', '/cost', '/compact', '/agents', '/Deploy']);
});

// ── §1.3 fetchSlashCommands ───────────────────────────────────────────
const grabUrl = async (cwd) => {
  let url = null;
  await fetchSlashCommands(cwd, { fetchImpl: async (u) => { url = u; return resp({}); } });
  return url;
};

await check('§1.3 URL 编码:cwd="/a b/c" → /api/slash-commands?cwd=%2Fa%20b%2Fc', async () => {
  assert.strictEqual(await grabUrl('/a b/c'), '/api/slash-commands?cwd=%2Fa%20b%2Fc');
});
await check('§1.3/M6/B13 空 cwd("" / undefined / null)→ /api/slash-commands,不带 ?', async () => {
  for (const v of ['', undefined, null]) {
    assert.strictEqual(await grabUrl(v), '/api/slash-commands', `cwd=${String(v)} 不该拼 ?cwd=`);
  }
});
await check('§1.3 空响应 {} → {commands:[], provider:"Anthropic", isAnthropic:true}', async () => {
  const got = await fetchSlashCommands('/p', { fetchImpl: async () => resp({}) });
  assert.deepEqual(got.commands, []);
  assert.strictEqual(got.provider, 'Anthropic');
  assert.strictEqual(got.isAnthropic, true);
});
await check('§1.3/B3 响应 isAnthropic:false → false', async () => {
  const got = await fetchSlashCommands('/p', { fetchImpl: async () => resp({ isAnthropic: false }) });
  assert.strictEqual(got.isAnthropic, false);
});
await check('§1.3/M7 响应 isAnthropic 缺失 → true(判据 !== false,不是 !!d.isAnthropic)', async () => {
  const got = await fetchSlashCommands('/p', { fetchImpl: async () => resp({ isAnthropic: undefined }) });
  assert.strictEqual(got.isAnthropic, true);
});
await check('§1.3/B1 commands / provider 原样透传', async () => {
  const payload = { commands: CMDS, provider: 'DeepSeek', isAnthropic: false };
  const got = await fetchSlashCommands('/p', { fetchImpl: async () => resp(payload) });
  assert.deepEqual(names(got.commands), names(CMDS));
  assert.strictEqual(got.provider, 'DeepSeek');
});
await check('§1.3/M39 HTTP 非 2xx 不检查 r.ok:500 + {error} 照读 body 按字段兜底(不新增错误分支)', async () => {
  const got = await fetchSlashCommands('/p', { fetchImpl: async () => resp({ error: 'boom' }, false) });
  assert.deepEqual(got.commands, [], '服务端 500 时列表应为空,而不是永远不弹');
  assert.strictEqual(got.provider, 'Anthropic');
  assert.strictEqual(got.isAnthropic, true);
});
await check('§1.3 fetchImpl reject → Promise reject(调用方 .catch 保持旧列表)', async () => {
  await assert.rejects(
    fetchSlashCommands('/p', { fetchImpl: async () => { throw new Error('网络炸了'); } }),
    /网络炸了/,
  );
});
await check('§1.3 json() 抛错 → Promise reject', async () => {
  await assert.rejects(
    fetchSlashCommands('/p', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('坏 JSON'); } }) }),
    /坏 JSON/,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// B. `@` 纯函数契约(INTERFACE §2)—— client/src/utils/atRef.js
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[B] @ 纯函数 client/src/utils/atRef.js');

let AUM = null;
let AUERR = '';
try {
  AUM = await import('../../client/src/utils/atRef.js');
} catch (e) {
  AUERR = String((e && e.message) || e);
}
const detectAtQuery = AUM?.detectAtQuery;
const applyAtInsert = AUM?.applyAtInsert;
const parentDir = AUM?.parentDir;
const mapDirEntries = AUM?.mapDirEntries;
const mapSearchFiles = AUM?.mapSearchFiles;
const filterAtSessions = AUM?.filterAtSessions;
const fetchDirEntries = AUM?.fetchDirEntries;
const searchProjectFiles = AUM?.searchProjectFiles;
const createSessionRef = AUM?.createSessionRef;

await check('R2 atRef.js 可被 node 直接 import(零依赖纯函数模块)', () => {
  assert.ok(AUM, `import 失败:${AUERR}`);
});
await check('R2/§5.3 atRef.js 9 个具名导出都是函数', () => {
  for (const n of ['detectAtQuery', 'applyAtInsert', 'parentDir', 'mapDirEntries', 'mapSearchFiles',
    'filterAtSessions', 'fetchDirEntries', 'searchProjectFiles', 'createSessionRef']) {
    assert.equal(typeof AUM?.[n], 'function', `缺具名导出 ${n}`);
  }
});

// ── §2.1 detectAtQuery ────────────────────────────────────────────────
await check('§2.1 无 @ 的文本 → null(空串 / "hello")', () => {
  assert.strictEqual(detectAtQuery('', 0), null);
  assert.strictEqual(detectAtQuery('hello', 5), null);
});
await check('§2.1/M8/B29/B32 斜杠命令优先:整串以 / 开头时不认 @ → null', () => {
  assert.strictEqual(detectAtQuery('/foo @b', 8), null);
  assert.strictEqual(detectAtQuery('/context @s', 11), null);
});
await check('§2.1/B19 光标前只有一个 "@" → {query:"", start:0}', () => {
  assert.deepEqual(detectAtQuery('@', 1), { query: '', start: 0 });
});
await check('§2.1/B22 行中 "hi @sr" → {query:"sr", start:3}', () => {
  assert.deepEqual(detectAtQuery('hi @sr', 6), { query: 'sr', start: 3 });
});
await check('§2.1 换行后也算:"x\\n@f" → {query:"f", start:2}', () => {
  assert.deepEqual(detectAtQuery('x\n@f', 4), { query: 'f', start: 2 });
});
await check('§2.1/M9 @ 前必须是行首或空白:"a@b" → null(邮箱 / 变量名不误触发)', () => {
  assert.strictEqual(detectAtQuery('a@b', 3), null);
  assert.strictEqual(detectAtQuery('me@x.com', 8), null);
});
await check('§2.1 query 内不能有空白:"hi @a b" → null', () => {
  assert.strictEqual(detectAtQuery('hi @a b', 7), null);
});
await check('§2.1 query 内不能再有 @:"hi @a@b" → null', () => {
  assert.strictEqual(detectAtQuery('hi @a@b', 7), null);
});
await check('§2.1 只看光标前:"@ab cd" caret=3 → {query:"ab", start:0}', () => {
  assert.deepEqual(detectAtQuery('@ab cd', 3), { query: 'ab', start: 0 });
});
await check('§2.1 caret 省略 / 非整数(null / NaN / "x" / 2.5)→ 一律按 value.length 处理', () => {
  const want = { query: 'sr', start: 3 };
  assert.deepEqual(detectAtQuery('hi @sr'), want, 'caret 省略');
  for (const c of [null, undefined, NaN, 'x', 2.5]) {
    assert.deepEqual(detectAtQuery('hi @sr', c), want, `caret=${String(c)}`);
  }
});
await check('§2.1 value 为 null / undefined → null 且不抛错', () => {
  assert.strictEqual(detectAtQuery(null, 3), null);
  assert.strictEqual(detectAtQuery(undefined, 3), null);
});
await check('§2.1/M10 不变式:返回非 null 时 value[start] === "@" 且 value.slice(start+1,caret) === query', () => {
  const cases = [['@', 1], ['hi @sr', 6], ['x\n@f', 4], ['@ab cd', 3], ['a b @c/d.js', 11]];
  for (const [v, c] of cases) {
    const r = detectAtQuery(v, c);
    assert.ok(r, `${JSON.stringify(v)} @${c} 应有候选`);
    assert.strictEqual(v[r.start], '@', `${JSON.stringify(v)}: start 必须正好指向 @`);
    assert.strictEqual(v.slice(r.start + 1, c), r.query, `${JSON.stringify(v)}: query 必须是 @ 到光标之间的原文`);
  }
});

// ── §2.2 applyAtInsert ────────────────────────────────────────────────
await check('§2.2/M11/B23 行尾插入:("hi @sr",{sr,3},"src/a.js") → "hi @src/a.js "(自带尾随空格)', () => {
  assert.strictEqual(applyAtInsert('hi @sr', { query: 'sr', start: 3 }, 'src/a.js'), 'hi @src/a.js ');
});
await check('§2.2/M12 行中插入保留后缀:("@q rest",{q,0},"x") → "@x  rest"(两个空格,现状逐字保留)', () => {
  assert.strictEqual(applyAtInsert('@q rest', { query: 'q', start: 0 }, 'x'), '@x  rest');
});
await check('§2.2/M11 空 query:("@",{"",0},"a.md") → "@a.md "', () => {
  assert.strictEqual(applyAtInsert('@', { query: '', start: 0 }, 'a.md'), '@a.md ');
});
await check('§2.2 at 为 null / 缺 start → 原样返回 text(不破坏输入框内容)', () => {
  assert.strictEqual(applyAtInsert('hi @sr', null, 'x'), 'hi @sr');
  assert.strictEqual(applyAtInsert('hi @sr', { query: 'sr' }, 'x'), 'hi @sr');
  assert.strictEqual(applyAtInsert('hi @sr', undefined, 'x'), 'hi @sr');
});
await check('§2.2 text 为 null → ""', () => {
  assert.strictEqual(applyAtInsert(null, { query: '', start: 0 }, 'a'), '');
});

// ── §2.3 parentDir ────────────────────────────────────────────────────
await check('§2.3/B21 parentDir:"a/b/c"→"a/b";"a"→"";空 / null / undefined→""', () => {
  assert.strictEqual(parentDir('a/b/c'), 'a/b');
  assert.strictEqual(parentDir('a'), '');
  assert.strictEqual(parentDir(''), '');
  assert.strictEqual(parentDir(null), '');
  assert.strictEqual(parentDir(undefined), '');
});

// ── §2.4 mapDirEntries ────────────────────────────────────────────────
await check('§2.4/B19/M13 根目录:目录与文件各自 kind,rel 无前缀,且不加「返回上级」', () => {
  assert.deepEqual(
    mapDirEntries([{ name: 'src', isDir: true }, { name: 'a.md', isDir: false }], ''),
    [{ kind: 'dir', name: 'src', rel: 'src' }, { kind: 'file', name: 'a.md', rel: 'a.md' }],
  );
});
await check('§2.4/B20/M14 子目录:首项是 up,其余 rel 带 "src/" 前缀', () => {
  assert.deepEqual(
    mapDirEntries([{ name: 'src', isDir: true }, { name: 'a.md', isDir: false }], 'src'),
    [
      { kind: 'up', name: '..', rel: '' },
      { kind: 'dir', name: 'src', rel: 'src/src' },
      { kind: 'file', name: 'a.md', rel: 'src/a.md' },
    ],
  );
});
await check('§2.4 entries 为 null / undefined 且在根目录 → []', () => {
  assert.deepEqual(mapDirEntries(null, ''), []);
  assert.deepEqual(mapDirEntries(undefined, ''), []);
});
await check('§2.4/B21 entries 为 null 但在子目录 → 仍恒可返回上级(只剩 up 一项)', () => {
  assert.deepEqual(mapDirEntries(null, 'src'), [{ kind: 'up', name: '..', rel: '' }]);
});
await check('§2.4 顺序与入参一致(不重排;目录在前由服务端保证)', () => {
  const got = mapDirEntries([{ name: 'z.md', isDir: false }, { name: 'a', isDir: true }], '');
  assert.deepEqual(got.map((e) => e.name), ['z.md', 'a']);
});

// ── §2.5 mapSearchFiles ───────────────────────────────────────────────
await check('§2.5/B22 搜索结果:name 与 rel 都是相对路径(不是只剩文件名)', () => {
  assert.deepEqual(mapSearchFiles(['a/b.js', 'c.md']), [
    { kind: 'file', name: 'a/b.js', rel: 'a/b.js' },
    { kind: 'file', name: 'c.md', rel: 'c.md' },
  ]);
});
await check('§2.5 files 非数组(null / undefined / "x")→ []', () => {
  assert.deepEqual(mapSearchFiles(null), []);
  assert.deepEqual(mapSearchFiles(undefined), []);
  assert.deepEqual(mapSearchFiles('x'), []);
});

// ── §2.6 filterAtSessions ─────────────────────────────────────────────
const SESS = [
  { sessionId: 's1', firstPrompt: '修 Bug' },
  { sessionId: 's2', firstPrompt: '写文档' },
  { sessionId: 's3', firstPrompt: '旧的', archived: true },
];
const sids = (arr) => (arr || []).map((s) => s && s.sessionId);

await check('§2.6/M15/B25 空 query:已归档会话恒排除 → [s1, s2]', () => {
  assert.deepEqual(sids(filterAtSessions(SESS, '', null)), ['s1', 's2']);
});
await check('§2.6/B31 excludeSessionId 排除当前会话 → [s2]', () => {
  assert.deepEqual(sids(filterAtSessions(SESS, '', 's1')), ['s2']);
});
await check('§2.6 按 firstPrompt 子串匹配:"文档" → [s2]', () => {
  assert.deepEqual(sids(filterAtSessions(SESS, '文档', null)), ['s2']);
});
await check('§2.6 sessionId 前缀匹配:"s2" → [s2]', () => {
  assert.deepEqual(sids(filterAtSessions(SESS, 's2', null)), ['s2']);
});
await check('§2.6 大写 "S2" → [s2](query 整体小写化后再比,sessionId 不做变换)', () => {
  assert.deepEqual(sids(filterAtSessions(SESS, 'S2', null)), ['s2']);
});
await check('§2.6 firstPrompt 小写化后匹配:"BUG" → [s1](firstPrompt "修 Bug")', () => {
  assert.deepEqual(sids(filterAtSessions(SESS, 'BUG', null)), ['s1']);
});
await check('§2.6 不变式:任意 query 的 toUpperCase() 与 toLowerCase() 结果深相等', () => {
  for (const q of ['', 's2', 's', '文档', 'bug', 'zz']) {
    assert.deepEqual(filterAtSessions(SESS, q.toUpperCase(), null), filterAtSessions(SESS, q.toLowerCase(), null),
      `query=${JSON.stringify(q)} 的大小写两种写法结果必须一致`);
  }
});
await check('§2.6 sessions 非数组(null / "x")→ []', () => {
  assert.deepEqual(filterAtSessions(null, '', null), []);
  assert.deepEqual(filterAtSessions('x', '', null), []);
});
await check('§2.6 缺 firstPrompt 的条目 + 非空 query → 不命中且不抛错', () => {
  const list = [{ sessionId: 'zz9' }];
  assert.deepEqual(filterAtSessions(list, '文档', null), []);
});
await check('§2.6/M16 长列表最多 20 条', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ sessionId: `k${i}`, firstPrompt: `第 ${i} 个` }));
  assert.equal(filterAtSessions(many, '', null).length, 20);
});

// ── §2.7 三个取数函数(fetchImpl 注入,全局 fetch 已被哨兵占住)────────
await check('§2.7/M18 fetchDirEntries 根目录 URL:/api/files/list?path=<enc(cwd)>', async () => {
  let url = null;
  await fetchDirEntries('/p q', '', { fetchImpl: async (u) => { url = u; return resp({ entries: [] }); } });
  assert.strictEqual(url, '/api/files/list?path=%2Fp%20q');
});
await check('§2.7/B20 fetchDirEntries 子目录 URL:path = enc(cwd + "/" + dir)', async () => {
  let url = null;
  await fetchDirEntries('/p q', 'src/x', { fetchImpl: async (u) => { url = u; return resp({ entries: [] }); } });
  assert.strictEqual(url, `/api/files/list?path=${encodeURIComponent('/p q/src/x')}`);
});
await check('§2.7 fetchDirEntries 返回值 === mapDirEntries(d.entries, dir)', async () => {
  const entries = [{ name: 'a', isDir: true }, { name: 'b.md', isDir: false }];
  const got = await fetchDirEntries('/p', 'src', { fetchImpl: async () => resp({ entries }) });
  assert.deepEqual(got, mapDirEntries(entries, 'src'));
});
await check('§2.7 fetchDirEntries 响应缺 entries → 空数组(根目录)', async () => {
  const got = await fetchDirEntries('/p', '', { fetchImpl: async () => resp({}) });
  assert.deepEqual(got, []);
});
await check('§2.7 fetchDirEntries 网络失败 → reject(调用方各自 catch 成空列表)', async () => {
  await assert.rejects(fetchDirEntries('/p', '', { fetchImpl: async () => { throw new Error('断网'); } }), /断网/);
});
await check('§2.7/B22 searchProjectFiles URL:/api/files/search?cwd=<enc>&q=<enc>', async () => {
  let url = null;
  await searchProjectFiles('/p q', 'a b', { fetchImpl: async (u) => { url = u; return resp({ files: [] }); } });
  assert.strictEqual(url, `/api/files/search?cwd=${encodeURIComponent('/p q')}&q=${encodeURIComponent('a b')}`);
});
await check('§2.7 searchProjectFiles 返回值 === mapSearchFiles(d.files);缺 files → []', async () => {
  const files = ['a/b.js', 'c.md'];
  assert.deepEqual(await searchProjectFiles('/p', 'a', { fetchImpl: async () => resp({ files }) }), mapSearchFiles(files));
  assert.deepEqual(await searchProjectFiles('/p', 'a', { fetchImpl: async () => resp({}) }), []);
});
await check('§2.7 searchProjectFiles 网络失败 → reject', async () => {
  await assert.rejects(searchProjectFiles('/p', 'a', { fetchImpl: async () => { throw new Error('断网'); } }), /断网/);
});
await check('§2.7/M39 两个 GET 不检查 r.ok:500 响应照读 body 兜底成 [](只有 createSessionRef 检查 ok)', async () => {
  assert.deepEqual(await fetchDirEntries('/p', '', { fetchImpl: async () => resp({ error: 'boom' }, false) }), []);
  assert.deepEqual(await searchProjectFiles('/p', 'a', { fetchImpl: async () => resp({ error: 'boom' }, false) }), []);
});
await check('§2.7/B26 createSessionRef:POST /api/session-ref + JSON 头 + body {sessionId, projectHash}', async () => {
  let seen = null;
  const got = await createSessionRef('sid-1', 'hash-1', {
    fetchImpl: async (u, init) => { seen = { u, init }; return resp({ path: '/abs/ref.md' }); },
  });
  assert.strictEqual(seen.u, '/api/session-ref');
  assert.strictEqual(seen.init.method, 'POST');
  assert.strictEqual(seen.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.init.body), { sessionId: 'sid-1', projectHash: 'hash-1' });
  assert.strictEqual(got, '/abs/ref.md', 'r.ok 时返回 d.path');
});
await check('§2.7/M17/B26 createSessionRef:!r.ok 必须抛错,带服务端 d.error 文案', async () => {
  await assert.rejects(
    createSessionRef('sid', 'h', { fetchImpl: async () => resp({ error: '会话不存在' }, false) }),
    /会话不存在/,
  );
});
await check('§2.7/M17 createSessionRef:!r.ok 且响应无 error 字段 → 抛「生成会话引用失败」', async () => {
  await assert.rejects(
    createSessionRef('sid', 'h', { fetchImpl: async () => resp({}, false) }),
    /生成会话引用失败/,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// C. 源码锁(INTERFACE §5)—— JSX / hook 进不了 node,只能读文件做结构断言
// ══════════════════════════════════════════════════════════════════════════
const SU = read('client/src/utils/slashCommands.js');
const SM = read('client/src/components/SlashCommandMenu.jsx');
const AU = read('client/src/utils/atRef.js');
const AH = read('client/src/hooks/useAtRef.js');
const AP = read('client/src/components/AtRefPanel.jsx');
const C = read('client/src/components/ChatInput.jsx');
const A = read('client/src/App.jsx');
const ICON = read('client/src/components/Icon.jsx');

// 取"赋给 className 的字符串字面量"里含指定标记的那一条(默认类名 prop 或 JSX 属性)。
const classDefault = (src, marker) => [...src.matchAll(/className\s*=\s*['"`]([^'"`]*)['"`]/g)]
  .map((m) => m[1]).find((v) => v.includes(marker));
// Icon.jsx 的具名导出集合(用于"图标标识符必须真的存在"校验)
const iconExports = new Set([...ICON.matchAll(/export\s+(?:const|function)\s+([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]));
// 某文件从 './Icon.jsx' / '../components/Icon.jsx' import 进来的名字
const iconImports = (src) => new Set(
  [...src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'[^']*Icon\.jsx'/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim())).filter(Boolean),
);
// 源码里被当作 JSX 标签用的大写标识符
const jsxTags = (src) => new Set([...src.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]));

console.log('\n[C1] 源码锁 §5.1 utils/slashCommands.js');
await check('§5.1 文件存在且非空', () => assert.ok(SU.length > 0, 'client/src/utils/slashCommands.js 读不到'));
await check('§5.1 三个导出签名逐字在场', () => {
  assert.match(SU, /export function slashBlocked\(/);
  assert.match(SU, /export function filterSlashCommands\(/);
  assert.match(SU, /export async function fetchSlashCommands\(/);
});
await check('§5.1 端点与编码逐字:/api/slash-commands + encodeURIComponent(cwd)', () => {
  assert.match(SU, /\/api\/slash-commands/);
  assert.match(SU, /encodeURIComponent\(cwd\)/);
});
await check('§5.1/M7 isAnthropic 判据逐字 d.isAnthropic !== false', () => {
  assert.match(SU, /d\.isAnthropic !== false/);
});
await check('§5.1 支持 fetchImpl 注入(出现 fetchImpl 标识符)', () => {
  assert.ok(SU.includes('fetchImpl'));
});
await check('§5.1 纯函数模块:无 React / 组件 import、无 useState / useEffect / useStore / localStorage', () => {
  assert.ok(!/from\s*'react'/.test(SU), '不许 import react');
  assert.ok(!/import\s+React/.test(SU), '不许 import React');
  assert.ok(!/from\s*'[^']*\.jsx'/.test(SU), '不许 import 任何 .jsx 组件');
  for (const bad of ['useState', 'useEffect', 'useStore', 'localStorage']) {
    assert.ok(!SU.includes(bad), `不许出现 ${bad}`);
  }
  assert.strictEqual(countS(SU, 'r.ok'), 0, 'M39:GET 不做 ok 检查(加了 500 时列表会从"空"变成"永远不弹")');
});

console.log('\n[C2] 源码锁 §5.2 components/SlashCommandMenu.jsx');
await check('§5.2 文件存在且非空', () => assert.ok(SM.length > 0, 'client/src/components/SlashCommandMenu.jsx 读不到'));
await check('§5.2 导出签名 export function SlashCommandMenu(', () => {
  assert.match(SM, /export function SlashCommandMenu\(/);
});
await check('§5.2/B15/B17 className 是带默认值的 prop,默认类名逐字含七个标记', () => {
  const def = classDefault(SM, 'absolute bottom-full');
  assert.ok(def !== undefined, '找不到含 "absolute bottom-full" 的默认类名(会话内向上弹靠它)');
  for (const t of ['glass-popover', 'absolute bottom-full', 'mb-3', 'max-h-80', 'overflow-y-auto', 'z-30', 'animate-glass-rise']) {
    assert.ok(def.includes(t), `默认类名缺 ${t}(实得:${def})`);
  }
  assert.match(SM, /className\s*=\s*['"`][^'"`]*absolute bottom-full/, 'className 必须有默认值');
});
await check('§5.2/B3 第三方阻止判据走 slashBlocked(从 ../utils/slashCommands.js import)', () => {
  assert.match(SM, /import \{[^}]*slashBlocked[^}]*\} from '\.\.\/utils\/slashCommands\.js'/);
});
await check('§5.2/B1/B3/B18 文案逐字在场', () => {
  for (const t of ['Slash 命令', '仅订阅', 'partial', 'TUI', '(cc switch)', '还有 ', '个命令...']) {
    assert.ok(SM.includes(t), `缺文案 ${t}`);
  }
});
await check('§5.2 TYPE_ICONS 与 TYPE_LABELS 各定义 1 处', () => {
  assert.strictEqual(count(SM, /(?:const|let|var)\s+TYPE_ICONS\s*=/g), 1);
  assert.strictEqual(count(SM, /(?:const|let|var)\s+TYPE_LABELS\s*=/g), 1);
});
await check('§5.2/B18 渲染截断 .slice(0, 50) 逐字在场', () => {
  assert.match(SM, /\.slice\(0, 50\)/);
});
await check('§5.2/B3/B34/M40 disabled 取值只由阻止判据决定:disabled={blocked}(partial / TUI 不得进 disabled)', () => {
  assert.ok(SM.includes('disabled='), '阻止项必须真的 disabled');
  assert.match(SM, /disabled=\{blocked\}/, 'B34:partial 与 interactiveOnly 只是徽章,必须可正常选中');
});
await check('§5.2 四个类型图标 import 自 ./Icon.jsx 且 Icon.jsx 真有这些导出', () => {
  const imp = iconImports(SM);
  for (const ic of ['Terminal', 'Wrench', 'Puzzle', 'Folder']) {
    assert.ok(imp.has(ic), `${ic} 必须 import 自 './Icon.jsx'`);
    assert.ok(iconExports.has(ic), `Icon.jsx 没有导出 ${ic}`);
  }
});
await check('§5.2 哑组件:无 useState / useEffect / fetch( / /api/ / window.confirm / alert(', () => {
  for (const bad of ['useState', 'useEffect', 'fetch(', '/api/', 'window.confirm']) {
    assert.ok(!SM.includes(bad), `不许出现 ${bad}`);
  }
  assert.ok(!/\balert\(/.test(SM), '不许出现 alert(');
});
await check("§5.2 阻止判据不许内联:不出现 requiresAnthropic === 'full'", () => {
  assert.ok(!SM.includes("requiresAnthropic === 'full'"), '必须走 slashBlocked,不许复制判据');
});

console.log('\n[C3] 源码锁 §5.3 utils/atRef.js');
await check('§5.3 文件存在且非空', () => assert.ok(AU.length > 0, 'client/src/utils/atRef.js 读不到'));
await check('§5.3 三条端点字面量各恰好 1 处', () => {
  assert.strictEqual(countS(AU, '/api/files/list'), 1);
  assert.strictEqual(countS(AU, '/api/files/search'), 1);
  assert.strictEqual(countS(AU, '/api/session-ref'), 1);
});
await check('§5.3/M9 检测正则骨架逐字含 (^|[\\s\\n])@', () => {
  assert.match(AU, /\(\^\|\[\\s\\n\]\)@/);
});
await check('§5.3 支持 fetchImpl 注入', () => {
  assert.ok(AU.includes('fetchImpl'));
});
await check('§5.3 mapDirEntries( 在 fetchDirEntries 内 ≥1、mapSearchFiles( 在 searchProjectFiles 内 ≥1', () => {
  const body = (fn) => {
    const m = AU.match(new RegExp(`export (?:async )?function ${fn}\\(`));
    assert.ok(m, `AU 里找不到 export function ${fn}(`);
    const at = AU.indexOf(m[0]);
    const nxt = AU.indexOf('\nexport ', at + 1);
    return nxt > at ? AU.slice(at, nxt) : AU.slice(at, at + 1200);
  };
  assert.ok(body('fetchDirEntries').includes('mapDirEntries('), 'fetchDirEntries 必须内部调用 mapDirEntries(');
  assert.ok(body('searchProjectFiles').includes('mapSearchFiles('), 'searchProjectFiles 必须内部调用 mapSearchFiles(');
});
await check('§5.3/M39 r.ok 恰 1 处(只在 createSessionRef;两个 GET 不检查)', () => {
  assert.strictEqual(countS(AU, 'r.ok'), 1);
});
await check('§5.3 纯函数模块:无 React / .jsx import、无 useState / useEffect / useStore / setTimeout', () => {
  assert.ok(!/import\s+React/.test(AU), '不许 import React');
  assert.ok(!/from\s*'[^']*\.jsx'/.test(AU), '不许 import 任何 .jsx');
  for (const bad of ['useState', 'useEffect', 'useStore', 'setTimeout']) {
    assert.ok(!AU.includes(bad), `不许出现 ${bad}(防抖属于 hook)`);
  }
});

console.log('\n[C4] 源码锁 §5.4 hooks/useAtRef.js');
await check('R8/§5.4 文件存在且非空', () => assert.ok(AH.length > 0, 'client/src/hooks/useAtRef.js 读不到'));
await check('§5.4 导出签名 export function useAtRef( 且入参解构含七个字段', () => {
  assert.match(AH, /export function useAtRef\(/);
  const sig = AH.slice(AH.indexOf('export function useAtRef('), AH.indexOf('export function useAtRef(') + 600);
  for (const p of ['cwd', 'projectHash', 'sessions', 'excludeSessionId', 'text', 'setText', 'inputRef']) {
    assert.ok(new RegExp(`\\b${p}\\b`).test(sig), `useAtRef 入参缺 ${p}`);
  }
});
await check('§5.4 六个状态 setter + 快照 ref atCtxRef 各 ≥1 次', () => {
  for (const s of ['setAtState', 'setAtTab', 'setAtFiles', 'setAtDir', 'setAtIndex', 'setAtBusy', 'atCtxRef']) {
    assert.ok(AH.includes(s), `缺 ${s}`);
  }
});
await check('R8/§5.4/M28 文件 effect 依赖数组逐字 [atState?.query, atTab, !!atState, atDir]', () => {
  assert.match(AH, /\}, \[atState\?\.query, atTab, !!atState, atDir\]\)/);
});
await check('§5.4/M29/B22 搜索防抖 180ms 且 cleanup 里 clearTimeout', () => {
  assert.match(AH, /setTimeout\([\s\S]{0,200}, 180\)/, '缺 180ms 防抖');
  assert.ok(AH.includes('clearTimeout'), 'cleanup 必须 clearTimeout');
});
await check('§5.4 七个纯函数调用点各 ≥1 次(逻辑不许在 hook 里重写一遍)', () => {
  for (const f of ['detectAtQuery(', 'applyAtInsert(', 'parentDir(', 'filterAtSessions(',
    'fetchDirEntries(', 'searchProjectFiles(', 'createSessionRef(']) {
    assert.ok(AH.includes(f), `缺对 ${f} 的调用`);
  }
});
await check('§5.4 mapDirEntries( / mapSearchFiles( 在 hook 内 0 次(映射归取数函数,hook 只拿结果)', () => {
  for (const f of ['mapDirEntries(', 'mapSearchFiles(']) {
    assert.strictEqual(countS(AH, f), 0, `${f} 不该在 useAtRef 里调用 —— 它属于 atRef.js 的 fetch* 内部`);
  }
});
await check('§5.4/B24/B27/B28 键盘:导出 keyDown 且五个键名各 ≥1', () => {
  assert.match(AH, /keyDown/);
  for (const k of ["'ArrowDown'", "'ArrowUp'", "'Tab'", "'Enter'", "'Escape'"]) {
    assert.ok(AH.includes(k), `缺键名 ${k}`);
  }
});
await check('§5.4/B28/B31 Esc 分支含 stopImmediatePropagation(不穿透到「停止生成」)', () => {
  assert.match(AH, /Escape[\s\S]{0,400}stopImmediatePropagation/);
});
await check('§5.4/B26 失败提示走动态 import 的 confirmDialog(不是原生 alert)', () => {
  assert.match(AH, /await import\('\.\.\/utils\/confirmDialog\.jsx'\)/);
});
await check('§5.4/M27 hook 内不许:/api/、useStore、window.confirm、alert(、localStorage', () => {
  for (const bad of ['/api/', 'useStore', 'window.confirm', 'localStorage']) {
    assert.ok(!AH.includes(bad), `不许出现 ${bad}(端点只在 atRef.js;会话列表由入参给)`);
  }
  assert.ok(!/\balert\(/.test(AH), '不许出现 alert(');
});

console.log('\n[C5] 源码锁 §5.5 components/AtRefPanel.jsx');
await check('§5.5 文件存在且非空', () => assert.ok(AP.length > 0, 'client/src/components/AtRefPanel.jsx 读不到'));
await check('§5.5 导出签名 export function AtRefPanel(', () => {
  assert.match(AP, /export function AtRefPanel\(/);
});
await check('§5.5/B31 className 是带默认值的 prop,默认类名含 absolute bottom-full 与 mb-3', () => {
  const def = classDefault(AP, 'absolute bottom-full');
  assert.ok(def !== undefined, '找不到含 "absolute bottom-full" 的默认类名(会话内向上弹靠它)');
  assert.ok(def.includes('mb-3'), `默认类名缺 mb-3(实得:${def})`);
});
await check('§5.5/B19-B30 八条文案逐字在场', () => {
  for (const t of ['文件', '会话', 'Tab 切换 · Enter 选择/进入', '返回上级', '正在生成会话引用...',
    '没有匹配的文件', '当前会话无项目目录', '本项目没有其它可引用的会话']) {
    assert.ok(AP.includes(t), `缺文案 ${t}`);
  }
});
await check('§5.5 六个图标 import 自 ./Icon.jsx 且 Icon.jsx 真有这些导出', () => {
  const imp = iconImports(AP);
  for (const ic of ['AtSign', 'CornerLeftUp', 'Folder', 'FileText', 'MessagesSquare', 'Loader2']) {
    assert.ok(imp.has(ic), `${ic} 必须 import 自 './Icon.jsx'`);
    assert.ok(iconExports.has(ic), `Icon.jsx 没有导出 ${ic}`);
  }
});
await check('§5.5 哑组件:无 useState / useEffect / fetch( / /api/ / useStore', () => {
  for (const bad of ['useState', 'useEffect', 'fetch(', '/api/', 'useStore']) {
    assert.ok(!AP.includes(bad), `不许出现 ${bad}`);
  }
});
await check('§5.2/§5.5 通用不变式:两个新组件用到的 JSX 图标标签都已 import(不留未定义标识符)', () => {
  for (const [nm, src] of [['SlashCommandMenu', SM], ['AtRefPanel', AP]]) {
    if (!src) throw new Error(`${nm} 文件读不到`);
    const imp = iconImports(src);
    for (const tag of jsxTags(src)) {
      if (!iconExports.has(tag)) continue;
      assert.ok(imp.has(tag), `${nm} 用了 <${tag} 却没从 Icon.jsx import`);
    }
  }
});

console.log('\n[C6] 源码锁 §5.6 components/ChatInput.jsx(会话内:斜杠几乎逐字不变,@ 行为不变)');
// 标签切片:从 <Tag 到其后第一个 />;取不到就退化成 800 字窗口。
const tagOf = (src, tag) => {
  const at = src.indexOf(tag);
  if (at < 0) return '';
  const end = src.indexOf('/>', at);
  return end > at && end - at < 800 ? src.slice(at, end + 2) : src.slice(at, at + 800);
};
// 函数体切片:从 startLit 起到最近的 "\n  };";取不到退化成 4000 字窗口。
const fnSlice = (src, startLit) => {
  const at = src.indexOf(startLit);
  if (at < 0) return '';
  const end = src.indexOf('\n  };', at);
  return end > at ? src.slice(at, end) : src.slice(at, at + 4000);
};

await check('§5.6 ChatInput.jsx 可读', () => assert.ok(C.length > 0, '文件读不到'));
await check('§5.6 四条 import 逐字在场(两个新组件 + hook + 三个斜杠纯函数)', () => {
  assert.match(C, /\{[^}]*SlashCommandMenu[^}]*\} from '\.\/SlashCommandMenu\.jsx'/);
  assert.match(C, /\{[^}]*AtRefPanel[^}]*\} from '\.\/AtRefPanel\.jsx'/);
  assert.match(C, /\{[^}]*useAtRef[^}]*\} from '\.\.\/hooks\/useAtRef\.js'/);
  const si = C.match(/import \{([^}]*)\} from '\.\.\/utils\/slashCommands\.js'/);
  assert.ok(si, "缺 import … from '../utils/slashCommands.js'");
  for (const n of ['filterSlashCommands', 'slashBlocked', 'fetchSlashCommands']) {
    assert.ok(si[1].includes(n), `slashCommands.js 的 import 缺 ${n}`);
  }
});
await check('§5.6 过滤改为调用共享函数:const filteredCommands = filterSlashCommands(commands, text, isAnthropic)', () => {
  assert.match(C, /const filteredCommands = filterSlashCommands\(commands, text, isAnthropic\)/);
});
await check('§5.6 拉取改为 fetchSlashCommands(cwd),effect 依赖仍是 }, [sessionId])', () => {
  assert.match(C, /fetchSlashCommands\(cwd\)/);
  assert.match(C, /\}, \[sessionId\]\)/, '拉取 effect 的依赖不许改');
});
await check('§5.6/M31 selectCommand 仍在,块内含 slashBlocked(cmd, isAnthropic) 与 setHistoryCursor(-1)', () => {
  // 切片口径同 check-input-history-nav:const selectCommand = → // ── @ 引用选择器
  const from = C.indexOf('const selectCommand =');
  assert.ok(from > 0, '缺 const selectCommand =');
  let to = C.indexOf('// ── @ 引用选择器');
  if (to < from) to = C.indexOf('const handleKeyDown ='); // 注释锚点若被删,退化到 handleKeyDown(见 §5.6 括注)
  assert.ok(to > from, '切不出 selectCommand 块');
  const sc = C.slice(from, to);
  assert.match(sc, /slashBlocked\(cmd, isAnthropic\)/, 'B3:第三方阻止判据必须走共享函数');
  assert.match(sc, /setText\(cmd\.name \+ ' '\)/, 'B10/M34:回填形态 = 命令名 + 一个空格');
  assert.match(sc, /setHistoryCursor\(-1\)/, 'selectCommand 必须退出历史浏览态');
});
await check('§6.2/M32 注释锚点 "// ── @ 引用选择器" 必须留在 ChatInput(否则 check-input-history-nav 切片塌成全文件)', () => {
  assert.ok(C.includes('// ── @ 引用选择器'), '锚点被删 → 既有测试的切片失效');
});
await check('§5.6/B15 斜杠菜单挂载点:{showCommands && <SlashCommandMenu,传参五件齐全', () => {
  assert.match(C, /\{showCommands && \(?\s*<SlashCommandMenu/);
  const tag = tagOf(C, '<SlashCommandMenu');
  for (const p of ['commands=', 'selectedIndex=', 'provider=', 'isAnthropic=', 'onPick={selectCommand}']) {
    assert.ok(tag.includes(p), `<SlashCommandMenu 传参缺 ${p}`);
  }
});
await check('§5.6/B31 @ 面板挂载点 <AtRefPanel + useAtRef({ …,入参含 sessions / excludeSessionId: sessionId / text / setText', () => {
  assert.match(C, /<AtRefPanel/);
  assert.match(C, /useAtRef\(\{/);
  const call = C.slice(C.indexOf('useAtRef({'), C.indexOf('useAtRef({') + 600);
  for (const p of ['sessions', 'excludeSessionId: sessionId', 'text', 'setText']) {
    assert.ok(call.includes(p), `useAtRef 入参缺 ${p}`);
  }
});
await check('§5.6/M24/③ 会话内两个面板都不传 className(向上弹 = 用组件默认类名)', () => {
  for (const t of ['<SlashCommandMenu', '<AtRefPanel']) {
    const tag = tagOf(C, t);
    assert.ok(tag.length > 0, `找不到 ${t} 挂载点`);
    assert.strictEqual(count(tag, /className/g), 0, `${t} 传了 className —— 会话内必须保持 bottom-full 默认`);
  }
});
await check('§5.6/M27 ChatInput 仍含 useStore((s) => s.sessions)(check-r29-newsession-list t4)', () => {
  assert.ok(C.includes('useStore((s) => s.sessions)'), 'sessions 必须由 ChatInput 读后作为入参传给 hook');
});
await check('§5.6 历史浏览门控保留:historyCursor < 0 出现 ≥3 次', () => {
  assert.ok(count(C, /historyCursor < 0/g) >= 3, `实得 ${count(C, /historyCursor < 0/g)} 处,需 ≥3`);
});
await check('§5.6/B5/B6 Tab / Enter 选中判据逐字不变', () => {
  assert.ok(C.includes("'Tab' || (e.key === 'Enter' && !e.shiftKey && filteredCommands.length > 0)"));
});
await check('§5.6/B9 会话内 Esc 分支仍自己吃掉事件(handleKeyDown 里 \'Escape\' 后 400 字内有 stopImmediatePropagation)', () => {
  const kd = fnSlice(C, 'const handleKeyDown =');
  assert.ok(kd.length > 0, '切不出 handleKeyDown 块');
  assert.match(kd, /'Escape'[\s\S]{0,400}stopImmediatePropagation/, 'Esc 不消费事件会穿透到「停止生成」');
});
await check('§5.6/M19 键盘顺序:showCommands 块 < at.keyDown( < handleSend( 发送分支', () => {
  const kd = fnSlice(C, 'const handleKeyDown =');
  assert.ok(kd.length > 0, '切不出 handleKeyDown 块');
  const iMenu = kd.indexOf('showCommands');
  const iAt = kd.indexOf('at.keyDown(');
  const iSend = kd.indexOf('handleSend(');
  assert.ok(iMenu >= 0, 'handleKeyDown 里找不到 showCommands 分支');
  assert.ok(iAt >= 0, 'handleKeyDown 里找不到 at.keyDown( 分支');
  assert.ok(iSend >= 0, 'handleKeyDown 里找不到 handleSend( 发送分支');
  assert.ok(iMenu < iAt, '斜杠菜单分支必须在 @ 面板之前');
  assert.ok(iAt < iSend, '两个面板分支都必须在发送分支之前,否则 Enter 会误发送');
});
await check('R6/§5.6 迁走的斜杠符号在 ChatInput 内计数为 0(requiresAnthropic / TYPE_ICONS / TYPE_LABELS / 三条文案 / 端点)', () => {
  for (const bad of ['requiresAnthropic', 'TYPE_ICONS', 'TYPE_LABELS', 'Slash 命令', '仅订阅', 'TUI', '/api/slash-commands']) {
    assert.strictEqual(countS(C, bad), 0, `ChatInput 里还剩 ${countS(C, bad)} 处 ${bad}(应全部迁到 SlashCommandMenu/slashCommands.js)`);
  }
});
await check('R7/§5.6/M30 迁走的 @ 符号在 ChatInput 内计数为 0(三条端点 / setAtState / atCtxRef / pickAtItem / atFiles)', () => {
  for (const bad of ['/api/files/list', '/api/files/search', '/api/session-ref', 'setAtState', 'atCtxRef', 'pickAtItem', 'atFiles']) {
    assert.strictEqual(countS(C, bad), 0, `ChatInput 里还剩 ${countS(C, bad)} 处 ${bad}(应全部迁到 atRef.js/useAtRef.js)`);
  }
});
await check('§5.6 图标计数表:Terminal/Puzzle/Wrench/AtSign/CornerLeftUp/FileText/Folder 各 0 次(含 import 行)', () => {
  for (const ic of ['Terminal', 'Puzzle', 'Wrench', 'AtSign', 'CornerLeftUp', 'FileText', 'Folder']) {
    assert.strictEqual(count(C, new RegExp(`\\b${ic}\\b`, 'g')), 0, `ChatInput 里还剩 ${ic}(应随 TYPE_ICONS / @ 面板迁走)`);
  }
});
await check('§5.6/M35 MessagesSquare 恰 2 次(import 1 + 旁问按钮 1);@ 面板那行 <MessagesSquare size={12} 为 0 次', () => {
  assert.strictEqual(count(C, /\bMessagesSquare\b/g), 2,
    '旁问按钮(C:1300)与 @ 无关必须留;删了 import 会让旁问按钮白屏');
  assert.strictEqual(count(C, /<MessagesSquare size=\{12\}/g), 0, '@ 面板的会话图标用法必须随面板迁走');
});
await check('§5.6 通用不变式:ChatInput 里每个大写 JSX 标签都能在 import 列表里找到(esbuild 不报错、生产白屏)', () => {
  const imp = iconImports(C);
  for (const tag of jsxTags(C)) {
    if (!iconExports.has(tag)) continue;
    assert.ok(imp.has(tag), `ChatInput 用了 <${tag} 却没从 Icon.jsx import(迁移时误删 import)`);
  }
});

console.log('\n[C7] 源码锁 §5.7 App.jsx 的 HomeState 切片(首页)');
const hFrom = A.indexOf('function HomeState(');
const hTo = A.indexOf('// ─── CLI-style spinner');
const H = hFrom > 0 && hTo > hFrom ? A.slice(hFrom, hTo) : '';

await check('§5.7 HomeState 切片可定位(function HomeState( → // ─── CLI-style spinner)', () => {
  assert.ok(H.length > 0, `切不出 HomeState(from=${hFrom} to=${hTo})`);
});
await check('R3/§5.7/B1 首页斜杠接线:fetchSlashCommands(project?.path || \'\') / filterSlashCommands( / slashBlocked( / <SlashCommandMenu', () => {
  assert.match(H, /fetchSlashCommands\(project\?\.path \|\| ''\)/, 'B12/B13:cwd 取当前选中项目,未选项目时传空串');
  assert.match(H, /filterSlashCommands\(/);
  assert.match(H, /slashBlocked\(/, 'B3:第三方阻止规则与会话内同一套');
  assert.match(H, /<SlashCommandMenu/);
});
await check('R4/§5.7/B19 首页 @ 接线:useAtRef({ … 四个入参 + <AtRefPanel + at.keyDown(e) + at.onTextChange(', () => {
  assert.match(H, /useAtRef\(\{/);
  const call = H.slice(H.indexOf('useAtRef({'), H.indexOf('useAtRef({') + 600);
  for (const p of ['cwd: project?.path', 'projectHash: project?.hash', 'excludeSessionId: null', 'inputRef: homeInputRef']) {
    assert.ok(call.includes(p), `首页 useAtRef 入参缺 ${p}`);
  }
  assert.match(H, /<AtRefPanel/);
  assert.match(H, /at\.keyDown\(e\)/);
  assert.match(H, /at\.onTextChange\(/);
});
await check('§5.7/M33/B2 同步 effect 逐字:setShowCmds(filteredCmds.length > 0 && text.startsWith(\'/\')),依赖含 filteredCmds.length', () => {
  const lit = "setShowCmds(filteredCmds.length > 0 && text.startsWith('/'))";
  assert.ok(H.includes(lit), 'B2「命中 0 条自动消失」+「命令异步到达后才弹」的唯一机器判据');
  const dep = H.slice(H.indexOf(lit), H.indexOf(lit) + 400).match(/\}, \[([^\]]*)\]\)/);
  assert.ok(dep, '找不到该 effect 的依赖数组');
  assert.ok(dep[1].includes('filteredCmds.length'), `依赖数组缺 filteredCmds.length(实得 [${dep[1]}])`);
});
await check('§5.7/M34/B10 首页选中回填逐字:setText(cmd.name + \' \'),同函数内含 setShowCmds(false) 与 .focus()', () => {
  const lit = "setText(cmd.name + ' ')";
  assert.ok(H.includes(lit), '文本必须是「命令名 + 一个空格」,与 ChatInput 的 selectCommand 同形态');
  const at = H.indexOf(lit);
  const seg = H.slice(Math.max(0, at - 600), at + 600);
  assert.ok(seg.includes('setShowCmds(false)'), '选中后必须关列表');
  assert.match(seg, /(?:inputRef|homeInputRef)[\s\S]{0,120}\.focus\(\)/, '焦点必须回输入框');
});
await check('§5.7/M25/M26/B25 会话列表来源:sessionsByProject[project.hash] + fetchSessionsForPanel(project.hash) + || EMPTY_ARRAY', () => {
  assert.match(H, /s\.sessionsByProject\[project\.hash\]/, '必须按当前选中项目取会话,不是全局单值槽');
  assert.match(H, /fetchSessionsForPanel\(project\.hash\)/, '换项目要拉该项目的会话');
  assert.match(H, /\|\| EMPTY_ARRAY/, '选择器默认值必须用稳定引用(|| [] 会触发 zustand #185 白屏)');
});
await check('R5/§5.7/M23/B17/B19 首页两个面板一律向下弹:absolute top-full × 2、absolute bottom-full × 0', () => {
  assert.strictEqual(countS(H, 'absolute top-full'), 2, 'HomeState 内 absolute top-full 应恰好 2 处(斜杠 + @)');
  assert.strictEqual(countS(H, 'absolute bottom-full'), 0, '首页不许向上弹');
});
await check('§5.7 窗口重新聚焦刷新:window.addEventListener(\'focus\' 与配对 removeEventListener(\'focus\'', () => {
  assert.ok(H.includes("window.addEventListener('focus'"), '缺 focus 监听');
  assert.ok(H.includes("removeEventListener('focus'"), 'effect cleanup 必须摘监听');
});
await check('§5.7/M22 首页输入框外壳类名逐字(relative 插在 rounded-lg 之前,check-focus-neutral 的锚点不变)', () => {
  assert.match(H, /className="w-full relative rounded-lg border border-canvas-deep\/70 bg-canvas-warm\/60"/);
  assert.match(H, /border border-canvas-deep\/70 bg-canvas-warm\/60"/, 'check-focus-neutral t2 的锚点必须原样保留');
});
await check('§5.7 textarea 四件套同在(ref / onChange / onKeyDown / data-cgui 在同一个标签里)', () => {
  const parts = ['ref={homeInputRef}', 'onChange={onHomeTextChange}', 'onKeyDown={onHomeKeyDown}', 'data-cgui="home-input"'];
  const idx = parts.map((p) => [p, H.indexOf(p)]);
  for (const [p, i] of idx) assert.ok(i >= 0, `HomeState 缺 ${p}`);
  const nums = idx.map(([, i]) => i);
  assert.ok(Math.max(...nums) - Math.min(...nums) < 900, '四者必须在同一个 textarea 标签上(实测跨度过大)');
});
await check('§5.7/B14 首页键盘:切片可定位且含 isComposing / 四个键名', () => {
  const kd = fnSlice(H, 'const onHomeKeyDown');
  assert.ok(kd.length > 0, '切不出 onHomeKeyDown(必须是 const onHomeKeyDown = …)');
  assert.ok(kd.includes('isComposing'), '缺输入法守卫');
  for (const k of ["'ArrowDown'", "'ArrowUp'", "'Tab'", "'Escape'"]) {
    assert.ok(kd.includes(k), `缺键名 ${k}`);
  }
});
await check('§5.7/M20/B6 首页 Enter 选中判据逐字:\'Enter\' && !e.shiftKey && filteredCmds.length > 0', () => {
  const kd = fnSlice(H, 'const onHomeKeyDown');
  assert.match(kd, /'Enter' && !e\.shiftKey && filteredCmds\.length > 0/, '列表空时 Enter 必须照常发送(B7)');
});
await check('§5.7/B9 首页斜杠 Esc 分支含 stopImmediatePropagation', () => {
  const kd = fnSlice(H, 'const onHomeKeyDown');
  assert.match(kd, /Escape[\s\S]{0,600}stopImmediatePropagation/);
});
await check('§5.7/M19/B6/B27 首页键盘顺序:showCmds < at.keyDown(e) < submit()', () => {
  const kd = fnSlice(H, 'const onHomeKeyDown');
  const iMenu = kd.indexOf('showCmds');
  const iAt = kd.indexOf('at.keyDown(e)');
  const iSend = kd.indexOf('submit()');
  assert.ok(iMenu >= 0, '缺 showCmds 分支');
  assert.ok(iAt >= 0, '缺 at.keyDown(e) 分支');
  assert.ok(iSend >= 0, '缺 submit() 发送分支');
  assert.ok(iMenu < iAt && iAt < iSend, `顺序错(showCmds=${iMenu} at=${iAt} submit=${iSend}):面板分支必须先于发送,否则 Enter 会误建会话`);
});
await check('§5.7/M37/B14 输入法守卫必须是 onHomeKeyDown 的首条语句独立早退(排在所有按键分支之前)', () => {
  const kd = fnSlice(H, 'const onHomeKeyDown');
  const m = kd.match(/if \([^\n]*isComposing[\s\S]{0,80}return;/);
  assert.ok(m, 'B14:缺 isComposing 早退守卫(只在 Enter 分支内联挡不住方向键)');
  const iGuard = kd.indexOf(m[0]);
  const iKey = Math.min(...["'Enter'", "'ArrowDown'", "'ArrowUp'", "'Tab'", "'Escape'"]
    .map((k) => { const i = kd.indexOf(k); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }));
  assert.ok(iGuard < iKey, `守卫下标 ${iGuard} 必须小于第一个按键分支下标 ${iKey}`);
});
await check('§5.7/B16 submit() 与 draft 派生链四条逐字不变(check-home-state / check-rollback-requeue 的锚点)', () => {
  for (const lit of ['seedNewSessionDefaults(project.hash, _did)', 'buildHomeDraft(project, _did)',
    'enqueueHomeDraft(homeDraftArgs)', 'enqueueRestoredHomeDraft({']) {
    assert.ok(H.includes(lit), `submit() 链路被改动:缺 ${lit}`);
  }
});
await check('§5.7 首页不许把菜单实现复制一份:requiresAnthropic / 端点 / TYPE_LABELS / 三条文案 各 0 次', () => {
  for (const bad of ['requiresAnthropic', '/api/slash-commands', '/api/files/', '/api/session-ref',
    'TYPE_LABELS', 'Slash 命令', '仅订阅', '返回上级', 'setAtState']) {
    assert.strictEqual(countS(H, bad), 0, `HomeState 里出现了 ${bad}(应只经组件/hook 复用)`);
  }
});
await check('§5.7/M25/B25 首页不许读全局单值槽:useStore((s) => s.sessions) 0 次', () => {
  assert.strictEqual(countS(H, 'useStore((s) => s.sessions)'), 0, '会话列表必须按项目取(B25)');
});
await check('§5.7 首页不许 setText(\'\')(清空文本不是本轮行为)', () => {
  assert.strictEqual(countS(H, "setText('')"), 0);
});
await check('§5.7/M26/M36 || [] 计数表:总数恰 2 且都是 files || [];含 useStore( 的行 0 次;|| EMPTY_ARRAY ≥1', () => {
  assert.strictEqual(countS(H, '|| []'), 2,
    '改前就有的两处附件兜底(A:2007/2035 Array.from(...files || []))不许动,也不许新增第三处');
  assert.strictEqual(count(H, /files \|\| \[\]/g), 2, '剩下的两处必须就是附件处理器那两处(M36)');
  const bad = H.split('\n').filter((l) => l.includes('useStore(') && l.includes('|| []'));
  assert.strictEqual(bad.length, 0, `zustand 选择器返回新引用会整页白屏(#185):\n      ${bad.join('\n      ')}`);
  assert.ok(count(H, /\|\| EMPTY_ARRAY/g) >= 1, '正锁:新增的会话列表选择器必须用模块级常量兜底');
});
await check('§5.7/check-popover-clamp 首页 <AnchoredPopover 仍恰好 1 处(两个面板都不用它)', () => {
  assert.strictEqual(countS(H, '<AnchoredPopover'), 1);
});
await check('§5.7/M38/D2 App.jsx 四条新 import 全在(缺一个 = 首页引用未定义标识符 → 生产白屏)', () => {
  assert.match(A, /\{[^}]*SlashCommandMenu[^}]*\} from '\.\/components\/SlashCommandMenu\.jsx'/);
  assert.match(A, /\{[^}]*AtRefPanel[^}]*\} from '\.\/components\/AtRefPanel\.jsx'/);
  assert.match(A, /\{[^}]*useAtRef[^}]*\} from '\.\/hooks\/useAtRef\.js'/);
  assert.match(A, /\} from '\.\/utils\/slashCommands\.js'/);
});

console.log('\n[C8] 位置锁 §5.8 + 零 diff §5.9');
await check('§5.8/M21 附件窗口:data-cgui="home-input" 起 1600 字内六个片段全在(check-r33-home-attachments 同款口径)', () => {
  const i = A.indexOf('data-cgui="home-input"');
  assert.ok(i > 0, '找不到 data-cgui="home-input"');
  const seg = A.slice(i, i + 1600);
  for (const [re, id] of [[/onPaste=\{/, 'onPaste'], [/kind === 'file'/, "kind === 'file'"],
    [/uploadHomeAttachment\(f\)/, 'uploadHomeAttachment(f)'], [/handledFile\) e\.preventDefault\(\)/, 'handledFile) preventDefault'],
    [/onDrop=\{/, 'onDrop'], [/dataTransfer/, 'dataTransfer']]) {
    assert.ok(re.test(seg), `窗口内缺 ${id} —— 面板 JSX / 检测逻辑不许插到 textarea 之前`);
  }
});
await check('§5.8 两个面板 JSX 都在工具行之后(下标 > data-testid="home-send")', () => {
  const iSend = H.indexOf('data-testid="home-send"');
  const iMenu = H.indexOf('<SlashCommandMenu');
  const iPanel = H.indexOf('<AtRefPanel');
  assert.ok(iSend > 0, 'HomeState 找不到 home-send');
  assert.ok(iMenu > iSend, `<SlashCommandMenu 必须在工具行之后(send=${iSend} menu=${iMenu})`);
  assert.ok(iPanel > iSend, `<AtRefPanel 必须在工具行之后(send=${iSend} panel=${iPanel})`);
});
await check('§5.7/D3 两处 absolute top-full 的下标都 > data-testid="home-send"(计数对但挂错元素照样是 bug)', () => {
  const iSend = H.indexOf('data-testid="home-send"');
  const hits = [...H.matchAll(/absolute top-full/g)].map((m) => m.index);
  assert.strictEqual(hits.length, 2, `absolute top-full 应 2 处,实得 ${hits.length}`);
  for (const at of hits) assert.ok(at > iSend, 'top-full 出现在工具行之前 —— 不是本轮两个面板');
});
// r100:原 §5.9「server/** 等自 merge-base 零 diff」是分支范围的 git 锁,任何后续分支改 server/ 都会误红;
// 零改动承诺由判官在验收时用 git diff 核对,这里不再用 git 断言。

// ══════════════════════════════════════════════════════════════════════════
// D. §6 既有测试零改动金丝雀 —— 两条 grep 口径的命中行数(排除本文件)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[D] §6 既有测试零改动金丝雀');
const GREP1 = /ChatInput\.jsx|App\.jsx|filteredCommands|showCommands|selectCommand|slash-commands|HomeState/;
const GREP2 = /atState|setAtState|pickAtItem|atSessions|atFiles|atTab|atDir|atIndex|files\/list|files\/search|session-ref|AtRefPanel|useAtRef|atCtxRef|SlashCommandMenu|slashCommands/;
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
// 排除本轮新增的整组 r97 测试(本文件 + 开发线自测 check-r97-dev-*.mjs):
// 判据是"既有测试文件未被改动",新增文件不该计入基线。
// r97b:同样排除 r97 之后各轮新增的测试(check-r98+ / check-r1xx+),否则合并到 master 后
// 别的轮次的测试文件一进 tests/ 就会改变全目录 grep 计数,把"既有测试未改动"误判成红。
const isR97 = (f) => /(^|\/)check-r(9[7-9]|[1-9]\d{2,})-[^/]*\.mjs$/.test(f);
const hitLines = (re) => {
  let n = 0;
  for (const f of walk(join(root, 'tests'))) {
    if (isR97(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) if (re.test(line)) n++;
  }
  return n;
};
// r97b:原 §6 两条"全 tests/ 目录 grep 命中行数恒为 219 / 4"的金丝雀已删除。它把基线钉在
// r97 分支点那一刻的整个 tests/ 目录,之后任何轮次合法地改动/新增别的测试文件都会让它红
// (合并到 master 后立刻误判)。"既有测试未被本轮改动"这条承诺改由判官在验收时用
// git diff 核对,不再用环境耦合的计数锁表达。
// ══════════════════════════════════════════════════════════════════════════
globalThis.fetch = REAL_FETCH;
console.log(`\n—— check-r97-home-slash: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r97-home-slash: 斜杠/@ 纯函数契约 + 五个新文件源码锁 + ChatInput 逐字不变 + 首页向下弹接线 全绿');
