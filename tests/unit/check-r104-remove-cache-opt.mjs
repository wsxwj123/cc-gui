#!/usr/bin/env node
// r104:移除「缓存优化」(--exclude-dynamic-system-prompt-sections)开关与全部接线;
//       设置面板只保留一个缓存条目,标题「缓存优化」= 原「静态系统提示快照」那套。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/BRIEF-r104-remove-cache-opt.md 的契约
// 与主会话的契约调整写,不看实现代码。三部分:
//   A. chatCompatKey 真函数契约(真 import 真跑):键集合/顺序/老字段静默忽略。
//   B. 源码锁(server):被移除的四个字面在 server/ 各 0 次。
//   C. 源码锁(client):设置项移除 + 条目合并后的标题/搜索索引/说明文案。
//   D. 反向用例(不该被连坐删掉的东西):prefs 键名、/api/prompt-cache、三个 env 键、
//      r89/r100 既有文案与显示逻辑。
//   E. CHANGELOG 记录移除原因与真机数据。
//
// 设计要点:
//   · "0 次"锁是契约直译(某字面必须消失),不是"文件数 = 常数"式的金丝雀。
//   · 键顺序单独断言,与键集合分开 —— 只错顺序 / 只缺字段,红的条目不同,一眼可辨。
//   · 每条断言的失败信息里带编号(A*/B*/C*/D*/E*),能直接对回 TEST-PLAN-r104.md。
//
// Run: node tests/unit/check-r104-remove-cache-opt.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } };
const count = (s, re) => (s.match(re) || []).length;

let PASS = 0;
let FAILS = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

// 递归收集某目录下的源码文件(跳过 node_modules 与生成物)。
function walk(dir, exts, skip = []) {
  const out = [];
  const rec = (d) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      const rel = p.slice(ROOT.length + 1);
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (name !== 'node_modules') rec(p); continue; }
      if (exts.some((e) => name.endsWith(e))) out.push(p);
    }
  };
  rec(join(ROOT, dir));
  return out;
}
// 返回 [{file, line, text}],给"必须 0 次"的锁做人话失败信息。
function hits(files, re) {
  const out = [];
  for (const f of files) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    src.split('\n').forEach((text, i) => {
      re.lastIndex = 0;
      if (re.test(text)) out.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${text.trim().slice(0, 100)}`);
    });
  }
  return out;
}
const zero = (files, re, why) => {
  const h = hits(files, re);
  assert.strictEqual(h.length, 0, `${why}\n      ${h.slice(0, 8).join('\n      ')}`);
};

// ══════════════════════════════════════════════════════════════════════════
// A. chatCompatKey 契约(真 import 真跑)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] chatCompatKey 契约 server/routes/chat.js');

// 契约:xdyn 出局,其余键与顺序不变。这 14 个键名不是从本轮实现抄的 ——
// 逐个都有 r104 之前的既有测试背书:
//   settingsFp/permEpoch/disToolsMtime/projSettingsMtime/mcpStampMtime → check-r96-dev-compat-key
//   acw/budget/effort/cwd → check-compat-key-model;genui → check-genui-section-text;
//   suggest → check-r90-cache-followups;append/gr/dirs → 三处 base fixture 共用。
const EXPECT_KEYS = ['cwd', 'effort', 'append', 'suggest', 'gr', 'dirs', 'settingsFp',
  'permEpoch', 'disToolsMtime', 'projSettingsMtime', 'mcpStampMtime', 'budget', 'acw', 'genui'];

// HOME 隔离:chatCompatKey 会 stat ~/.claude/settings.json(只读,不写)。
const REAL_HOME = process.env.HOME;
const REAL_PROFILE = process.env.USERPROFILE;
const home = mkdtempSync(join(tmpdir(), 'cgui-r104-'));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%
mkdirSync(join(home, '.claude'), { recursive: true });
writeFileSync(join(home, '.claude', 'settings.json'),
  JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example/v1' } }), 'utf8');

let CHAT = null;
let CHATERR = '';
try { CHAT = await import('../../server/routes/chat.js'); } catch (e) { CHATERR = String((e && e.message) || e); }
const chatCompatKey = CHAT?.chatCompatKey;

// 老客户端仍会传这个字段;新实现必须当它不存在。
const base = {
  workingDir: '/tmp/proj-r104', effort: 'high', appendSystemPrompt: '', promptSuggestions: false,
  globalRead: true, dirs: ['/'], maxBudgetUsd: null,
};
const parse = (o) => JSON.parse(chatCompatKey(o));

try {
  check('A0 server/routes/chat.js 可 import 且导出 chatCompatKey', () => {
    assert.ok(CHAT, `import 失败:${CHATERR}`);
    assert.equal(typeof chatCompatKey, 'function');
  });

  check('A1 键集合恰为 14 个既有键,且 xdyn 不在其中', () => {
    const got = Object.keys(parse(base));
    assert.deepEqual([...got].sort(), [...EXPECT_KEYS].sort(),
      `键集合与契约不符(多/少字段都算违约);实得:${JSON.stringify(got)}`);
    assert.ok(!got.includes('xdyn'), 'xdyn 必须已从复用键移除');
  });

  check('A2 键顺序与契约一致(只改顺序也会让所有温进程冷启一次)', () => {
    assert.deepEqual(Object.keys(parse(base)), EXPECT_KEYS,
      '字段没少但顺序变了 —— 契约要求「其余键与顺序不变」');
  });

  check('A3 老客户端传 excludeDynamicSystemPrompt(true/false/auto/undefined)→ 同一 key', () => {
    const keys = [true, false, 'auto', undefined, null, 'garbage']
      .map((v) => chatCompatKey({ ...base, excludeDynamicSystemPrompt: v }));
    const uniq = [...new Set(keys)];
    assert.strictEqual(uniq.length, 1,
      `该字段必须被完全忽略,不得影响复用键;实得 ${uniq.length} 种 key`);
    assert.strictEqual(uniq[0], chatCompatKey(base), '带老字段与不带必须完全相同');
  });

  check('A4 传老字段不抛错(老客户端/旧 prefs 静默忽略,不是报错)', () => {
    assert.doesNotThrow(() => chatCompatKey({ ...base, excludeDynamicSystemPrompt: true }));
    assert.doesNotThrow(() => chatCompatKey({ ...base, excludeDynamicSystemPrompt: {} }));
  });

  check('A5 key 字符串里不出现 xdyn / excludeDynamic 字样(防换个名字接着藏)', () => {
    const k = chatCompatKey({ ...base, excludeDynamicSystemPrompt: true });
    assert.ok(!k.includes('xdyn'), `key 仍含 xdyn:${k}`);
    assert.ok(!/excludeDynamic/i.test(k), `key 仍含 excludeDynamic:${k}`);
  });

  check('A6 反向用例:其余键照旧生效(effort/cwd/budget/genui/suggest 变化仍换 key)', () => {
    const k = chatCompatKey(base);
    for (const [name, over] of [
      ['effort', { effort: 'low' }],
      ['cwd', { workingDir: '/tmp/other-r104' }],
      ['budget', { maxBudgetUsd: 5 }],
      ['genui', { genui: false }],
      ['suggest', { promptSuggestions: true }],
      ['globalRead', { globalRead: false }],
      ['dirs', { dirs: ['/', '/x'] }],
      ['append', { appendSystemPrompt: 'hi' }],
    ]) {
      assert.notEqual(chatCompatKey({ ...base, ...over }), k, `${name} 变化必须仍换 key(不许连坐删)`);
    }
  });

  check('A7 同一入参重复调用恒等(移除字段不得引入不稳定值)', () => {
    assert.strictEqual(chatCompatKey(base), chatCompatKey(base));
  });

  check('A8 chat.js 不再导出 resolveExcludeDyn(既有测试的 import 会因此改写)', () => {
    assert.strictEqual(CHAT?.resolveExcludeDyn, undefined,
      '导出还在 = 死代码仍可被调用,接线没拆干净');
  });

  check('A9 反向用例:同批既有导出不许被连坐删', () => {
    for (const n of ['chatCompatKey', 'resolvePromptSuggestions', 'noteSelfPermissionWrite']) {
      assert.equal(typeof CHAT?.[n], 'function', `既有导出 ${n} 必须还在`);
    }
  });
} finally {
  process.env.HOME = REAL_HOME;
  if (REAL_PROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_PROFILE;
  rmSync(home, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// B. 源码锁:server/ 里四个字面各 0 次
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[B] 源码锁 server/(被移除的字面各 0 次)');
const SERVER = walk('server', ['.js', '.mjs', '.cjs']);

check('B0 server/ 扫到的文件数 > 20(扫不到文件会让下面几条假绿)', () => {
  assert.ok(SERVER.length > 20, `只扫到 ${SERVER.length} 个文件`);
});
check('B1 server/ 无 excludeDynamicSystemPrompt(请求字段已拆)', () => {
  zero(SERVER, /excludeDynamicSystemPrompt/, 'B1: 请求字段仍在被读/传');
});
check('B2 server/ 无 excludeDynamicSections(不再向 SDK 传该选项)', () => {
  zero(SERVER, /excludeDynamicSections/, 'B2: 仍在给 SDK 传 systemPrompt.excludeDynamicSections');
});
check('B3 server/ 无 resolveExcludeDyn(解析函数已删)', () => {
  zero(SERVER, /resolveExcludeDyn/, 'B3: 解析函数仍在');
});
check('B4 server/ 无 xdyn(复用键字段已删)', () => {
  zero(SERVER, /\bxdyn\b/, 'B4: 复用键字段仍在');
});
check('B5 server/ 不再传 CLI 的 --exclude-dynamic-system-prompt-sections', () => {
  zero(SERVER, /--exclude-dynamic-system-prompt-sections/, 'B5: spawn 参数仍会带上该 flag');
});

// ══════════════════════════════════════════════════════════════════════════
// C. 源码锁:client/(设置项移除 + 条目合并)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[C] 源码锁 client/src(设置项移除 + 条目合并)');
// generated/release-notes 是历史更新日志(会提到旧名字),不属于接线,排除。
const CLIENT = walk('client/src', ['.js', '.jsx'], ['client/src/generated']);
const PANEL = read('client/src/components/SettingsPanel.jsx');
const STORE = read('client/src/stores/sessionStore.js');
const APP = read('client/src/App.jsx');

check('C0 client/src 扫到的文件数 > 20 且三个关键文件可读', () => {
  assert.ok(CLIENT.length > 20, `只扫到 ${CLIENT.length} 个文件`);
  assert.ok(PANEL.length > 0, 'SettingsPanel.jsx 读不到');
  assert.ok(STORE.length > 0, 'sessionStore.js 读不到');
  assert.ok(APP.length > 0, 'App.jsx 读不到');
});
check('C1 client/src 无 excludeDynamicSystemPrompt(store 字段 / 请求体接线已拆)', () => {
  zero(CLIENT, /excludeDynamicSystemPrompt/, 'C1: 字段仍在');
});
check('C2 client/src 无 ExcludeDynamicPromptToggle(开关组件已删)', () => {
  zero(CLIENT, /ExcludeDynamicPromptToggle/, 'C2: 组件仍在');
});
check('C3 SettingsPanel 无 set-cache-opt(旧条目 id 已删)', () => {
  assert.strictEqual(count(PANEL, /set-cache-opt/g), 0, 'C3: 旧「缓存优化」条目仍挂在面板上');
});
check('C4 SettingsPanel 里「静态系统提示快照」不再作为标题出现(条目已改名)', () => {
  // 锁的是"用户看得见的字",不是代码注释:留一句 `// r89 静态系统提示快照…` 的沿革
  // 注释无害,不该判红。故先剥掉整行注释与块注释再数。
  const code = PANEL
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.strictEqual(count(code, /静态系统提示快照/g), 0,
    'C4: 旧标题仍出现在非注释代码里 —— 面板上只保留一个条目,标题为「缓存优化」');
  assert.strictEqual(count(PANEL, /title: '静态系统提示快照'/g), 0, 'C4: 搜索索引里旧标题仍在');
});
check('C5 搜索索引里 title 为「缓存优化」的条目恰 1 条', () => {
  assert.strictEqual(count(PANEL, /title: '缓存优化'/g), 1,
    "C5: 期望恰 1 条 title: '缓存优化'(两条 = 旧条目没删;零条 = 没改名)");
});
check('C6 该条目就是原 set-prompt-snapshot 条目', () => {
  assert.match(PANEL, /\{ id: 'set-prompt-snapshot', tab: 'session', title: '缓存优化'/,
    "C6: 保留下来的必须是原快照条目(id 不许换,否则设置搜索/锚点跳转失效)");
});
check('C7 面板标题渲染点恰 1 处「缓存优化」', () => {
  assert.strictEqual(count(PANEL, /缓存优化\s*<EffectBadge/g), 1,
    'C7: 期望恰 1 处标题渲染(2 处 = 旧开关的标题还在;0 处 = 标题没改名或 EffectBadge 被拿掉)');
});
check('C8 渲染挂载点仍是 set-prompt-snapshot + PromptCacheSnapshotToggle', () => {
  assert.match(PANEL, /<div id="set-prompt-snapshot"><PromptCacheSnapshotToggle \/><\/div>/,
    'C8: r89 的挂载行不许动(只改标题,不换组件)');
  assert.strictEqual(count(PANEL, /<div id="set-cache-opt"/g), 0, 'C8: 旧条目的挂载点仍在');
});
check('C9 搜索索引里"缓存"相关条目只剩 1 条,关键词含 缓存/cache/前缀/快照', () => {
  const entries = [...PANEL.matchAll(
    /\{ id: '([^']+)', tab: '([^']+)', title: '([^']+)'(?:, keys: '([^']*)')? \}/g)]
    .map((m) => ({ id: m[1], title: m[3], keys: m[4] || '' }));
  assert.ok(entries.length > 20, `搜索索引只解析到 ${entries.length} 条,解析失败会让本条假绿`);
  // 判据 = 契约点名的那组关键词(缓存 + cache),不是"keys 里出现过缓存二字"——
  // set-persistent-chat(会话常驻进程)本来就带"缓存"一词,与本轮无关,不该被卷进来。
  const cacheOnes = entries.filter((e) => e.keys.includes('缓存') && e.keys.includes('cache'));
  assert.strictEqual(cacheOnes.length, 1,
    `C9: 期望恰 1 条前缀缓存索引项,实得 ${cacheOnes.length} 条:${JSON.stringify(cacheOnes)}`);
  assert.strictEqual(cacheOnes[0].id, 'set-prompt-snapshot', 'C9: 留下的那条必须是原快照条目');
  for (const w of ['缓存', 'cache', '前缀', '快照']) {
    assert.ok(cacheOnes[0].keys.includes(w), `C9: 该条目 keys 缺关键词「${w}」(搜不到就等于没有)`);
  }
});
check('C10 说明文案用人话解释,含「系统提示」「工具列表」「前缀缓存」三词', () => {
  for (const w of ['系统提示', '工具列表', '前缀缓存']) {
    assert.ok(PANEL.includes(w), `C10: 说明文案缺「${w}」—— 用户看不懂这个开关在干什么`);
  }
});
check('C11 说明文案引用真机数字 99.0% / 0.0%(BRIEF 需求 2)', () => {
  assert.ok(PANEL.includes('99.0%'), 'C11: 缺 99.0%(只开快照时的命中率)');
  assert.ok(PANEL.includes('0.0%'), 'C11: 缺 0.0%(只开原「缓存优化」时的命中率)');
});
check('C12 sessionStore 不再持有该三态字段与 setter', () => {
  assert.strictEqual(count(STORE, /setExcludeDynamicSystemPrompt/g), 0, 'C12: setter 仍在');
  assert.strictEqual(count(STORE, /excludeDynamicSystemPrompt:/g), 0, 'C12: 字段仍在');
});
check('C13 App.jsx 不再往 /api/chat 请求体塞该字段', () => {
  assert.strictEqual(count(APP, /excludeDynamicSystemPrompt/g), 0, 'C13: 发送处仍在传');
});

// ══════════════════════════════════════════════════════════════════════════
// D. 反向用例:不该被连坐删掉的东西(r89 / r90 / r100 既有能力)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[D] 反向用例:保留项不许被连坐删');
const SETTINGS_SRC = read('server/routes/settings.js');

let PCE = null;
try { PCE = await import('../../server/utils/prompt-cache-env.js'); } catch { PCE = null; }
check('D1 三个 env 键常量不变(CARVED_SLATE / ENABLE_TOOL_SEARCH / MCP_CONNECTION_NONBLOCKING)', () => {
  assert.ok(PCE, 'prompt-cache-env.js import 失败');
  assert.strictEqual(PCE.SNAPSHOT_ENV_KEY, 'CLAUDE_CODE_CARVED_SLATE');
  assert.strictEqual(PCE.TOOL_SEARCH_ENV_KEY, 'ENABLE_TOOL_SEARCH');
  assert.strictEqual(PCE.MCP_NONBLOCKING_ENV_KEY, 'MCP_CONNECTION_NONBLOCKING');
});
check('D2 prefs 键名不变:prefs.promptCache { mode, memo }', () => {
  assert.match(SETTINGS_SRC, /prefs\.promptCache/, 'D2: prefs 键名被改 → 用户已存的偏好丢失');
  assert.match(SETTINGS_SRC, /promptCache\s*=\s*\{[^}]*mode/, 'D2: mode 字段丢了');
  assert.match(SETTINGS_SRC, /memo/, 'D2: memo(切回官方还原原值的备忘)丢了');
});
check('D3 端点不变:GET / PUT /prompt-cache 都还在', () => {
  assert.match(SETTINGS_SRC, /router\.get\('\/prompt-cache'/, 'D3: GET 端点丢了');
  assert.match(SETTINGS_SRC, /router\.put\('\/prompt-cache'/, 'D3: PUT 端点丢了');
});
check('D4 面板仍走 /api/prompt-cache 读写(GET + PUT 两处)', () => {
  assert.ok(count(PANEL, /fetch\('\/api\/prompt-cache'/g) >= 2,
    `D4: 实得 ${count(PANEL, /fetch\('\/api\/prompt-cache'/g)} 处,需 ≥2(读状态 + 写模式)`);
});
check('D5 r100 实际值显示与 CLI 支持提示保留', () => {
  assert.match(SETTINGS_SRC, /cliSnapshotSupported/, 'D5: 端点不再回 cliSnapshotSupported');
  assert.match(PANEL, /state\.cliSnapshotSupported === false/, 'D5: 面板不再按 CLI 支持与否分支');
  assert.ok(PANEL.includes('当前不启用系统提示快照'), 'D5: 不支持时的说明文案丢了');
  assert.ok(PANEL.includes('SDK 自带的 claude 运行'), 'D5: 「经 SDK 自带 CLI 运行」这一成因说明丢了');
  assert.ok(/(重新选择|重新切换)[^。\n]{0,16}provider/i.test(PANEL), 'D5: 补救指引丢了');
});
check('D6 r89 既有文案保留:ToolSearch 代价 + settings.json 与终端/bot 共用', () => {
  assert.ok(PANEL.includes('ENABLE_TOOL_SEARCH=false'), 'D6: 关 ToolSearch 的代价说明丢了');
  assert.ok(PANEL.includes('前置加载'), 'D6: 「前置加载」代价说明丢了');
  assert.ok(PANEL.includes('settings.json') && /bot/.test(PANEL), 'D6: 未告知与终端/bot 共用');
});
check('D7 三态开关组件定义仍在(auto / on / off)', () => {
  assert.match(PANEL, /function PromptCacheSnapshotToggle\(/, 'D7: 组件定义丢了');
  for (const m of ["'auto'", "'on'", "'off'"]) {
    assert.ok(PANEL.includes(m), `D7: 三态里的 ${m} 丢了`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// E. CHANGELOG(BRIEF 需求 3)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[E] CHANGELOG');
const CHANGELOG = read('CHANGELOG.md');
check('E0 CHANGELOG.md 可读', () => assert.ok(CHANGELOG.length > 0));
check('E1 CHANGELOG 写清移除原因与真机数据(99.0% / 0.0%)', () => {
  assert.ok(CHANGELOG.includes('99.0%'), 'E1: 缺 99.0%');
  assert.ok(CHANGELOG.includes('0.0%'), 'E1: 缺 0.0%');
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r104-remove-cache-opt: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r104-remove-cache-opt: 复用键去 xdyn + 接线全拆 + 条目合并 + 保留项无连坐 全绿');
