#!/usr/bin/env node
// r90:缓存命中率二次修复(依据 .devflow/PLAN-r90-cache-followups.md + RESEARCH-r90-cache-audit2.md)。
//
//  ① MCP_CONNECTION_NONBLOCKING='false' 进第三方 env 包(慢 MCP 让 tools 数组在会话
//     开头变形两次,每次冷启前两个请求各失配整段历史;假上游实测 82% → 99.9%)。
//  ② 兜底标题(/api/chat/title)照抄 CLI 原生 generate_session_title 形态:零工具、
//     无 MCP、不加载技能、自写短 system、小快档模型、<session> 转写、JSON 容错解析,
//     并先等原生落盘的 ai-title 行;所有瘦身 flag 过 `--help` 探测门。
//  ③ 输入预测三态:'auto' 下第三方关、官方开;显式设过就尊重。
//
// 原生标题落点(2.1.257 二进制 + 假上游实测):会话 jsonl 追加一行
//   {"type":"ai-title","aiTitle":"…","sessionId":"…"}
// = GUI session-reader 认的那一行,判据本就一致。fixture 用真实 jsonl 行形态
// (键序两种变体都在真实数据里出现过),内容为合成值。
//
// Run: node tests/unit/check-r90-cache-followups.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_HOME = process.env.HOME;
const home = join(tmpdir(), `cgui-r90-${process.pid}`);
mkdirSync(join(home, '.claude'), { recursive: true });
process.env.HOME = home;   // os.homedir() 在 POSIX 上优先读 $HOME

const {
  SNAPSHOT_ENV_KEY, TOOL_SEARCH_ENV_KEY, MCP_NONBLOCKING_ENV_KEY,
  applyPromptCacheEnv, resolvePromptCacheOn, promptCacheMemoEquals,
  cliSupportsFlag, cliSupportsSnapshotFlag, _resetSnapFlagCache,
} = await import('../../server/utils/prompt-cache-env.js');
const { readSessionTitles } = await import('../../server/services/session-reader.js');
const {
  buildTitleArgs, parseTitleJson, resolveTitleModel, resolvePromptSuggestions, TITLE_SYSTEM_PROMPT,
} = await import('../../server/routes/chat.js');

const chatSrc = readFileSync(join(root, 'server/routes/chat.js'), 'utf8');
const settingsSrc = readFileSync(join(root, 'server/routes/settings.js'), 'utf8');
const panelSrc = readFileSync(join(root, 'client/src/components/SettingsPanel.jsx'), 'utf8');
const storeSrc = readFileSync(join(root, 'client/src/stores/sessionStore.js'), 'utf8');
const appSrc = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');

const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message}`); } };
const acheck = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message}`); } };
const writeSettings = (env) => writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env }));

// ── ① MCP 阻塞连接:env 包含/移除随开关与 provider 类别 ──────────────────────
check('B1-1 开启时三个键一起写', () => {
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789' };
  applyPromptCacheEnv(env, true, null);
  assert.equal(env[SNAPSHOT_ENV_KEY], '1');
  assert.equal(env[TOOL_SEARCH_ENV_KEY], 'false');
  assert.equal(env[MCP_NONBLOCKING_ENV_KEY], 'false', '缺 MCP_CONNECTION_NONBLOCKING=false 则慢 MCP 下冷启仍两次失配');
});
check('B1-2 关闭时把 MCP 键按备忘还原(原本没设过 → 删掉,不留 false)', () => {
  const env = { ANTHROPIC_BASE_URL: 'x' };
  const memo = applyPromptCacheEnv(env, true, null);
  assert.deepEqual(memo, { toolSearch: null, mcpNonblocking: null });
  applyPromptCacheEnv(env, false, memo);
  assert.equal(MCP_NONBLOCKING_ENV_KEY in env, false);
  assert.equal(TOOL_SEARCH_ENV_KEY in env, false);
  assert.equal(SNAPSHOT_ENV_KEY in env, false);
});
check('B1-3 关闭时把 MCP 键还原成用户原值', () => {
  const env = { [MCP_NONBLOCKING_ENV_KEY]: 'true' };
  const memo = applyPromptCacheEnv(env, true, null);
  assert.equal(memo.mcpNonblocking, 'true');
  applyPromptCacheEnv(env, false, memo);
  assert.equal(env[MCP_NONBLOCKING_ENV_KEY], 'true');
});
check('B1-4 用户在第三方下手动改回 true:切回官方不拿备忘覆盖', () => {
  const env = {};
  const memo = applyPromptCacheEnv(env, true, null);
  env[MCP_NONBLOCKING_ENV_KEY] = 'true';           // 用户手改
  applyPromptCacheEnv(env, false, memo);
  assert.equal(env[MCP_NONBLOCKING_ENV_KEY], 'true', '只有当前值仍是我们写的 false 时才还原');
});
check('B1-5 r89 旧备忘(只有 toolSearch)按缺键补记,不推翻已记的那一项', () => {
  const env = { [TOOL_SEARCH_ENV_KEY]: 'false', [MCP_NONBLOCKING_ENV_KEY]: 'true' };
  const memo = applyPromptCacheEnv(env, true, { toolSearch: 'true' });
  assert.equal(memo.toolSearch, 'true', '已记的 toolSearch 不能被我们自己写的 false 顶掉');
  assert.equal(memo.mcpNonblocking, 'true', '缺的那一项要按当前 env 补记');
});
check('B1-6 连续两次开启不把自己写的 false 当用户原值', () => {
  const env = { [MCP_NONBLOCKING_ENV_KEY]: 'true' };
  const m1 = applyPromptCacheEnv(env, true, null);
  const m2 = applyPromptCacheEnv(env, true, m1);
  assert.equal(m2.mcpNonblocking, 'true');
});
check('B1-7 provider 类别决定写不写(auto:第三方写、官方不写)', () => {
  const third = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789' };
  applyPromptCacheEnv(third, resolvePromptCacheOn('auto', true), null);
  assert.equal(third[MCP_NONBLOCKING_ENV_KEY], 'false');
  const official = { [MCP_NONBLOCKING_ENV_KEY]: 'false' };
  applyPromptCacheEnv(official, resolvePromptCacheOn('auto', false), { toolSearch: null, mcpNonblocking: null });
  assert.equal(MCP_NONBLOCKING_ENV_KEY in official, false, '官方渠道不该留下这个键');
});
check('B1-8 备忘比较把两项都算进去(只比 toolSearch 会漏写 prefs)', () => {
  assert.equal(promptCacheMemoEquals({ toolSearch: 'a', mcpNonblocking: null }, { toolSearch: 'a', mcpNonblocking: null }), true);
  assert.equal(promptCacheMemoEquals({ toolSearch: 'a', mcpNonblocking: 'true' }, { toolSearch: 'a', mcpNonblocking: null }), false);
  assert.equal(promptCacheMemoEquals(null, { toolSearch: null, mcpNonblocking: null }), false);
  assert.equal(promptCacheMemoEquals(null, null), true);
});
check('B1-9 端点回 mcpNonblockingEnv,备忘比较走 promptCacheMemoEquals', () => {
  assert.ok(/mcpNonblockingEnv: env\[MCP_NONBLOCKING_ENV_KEY\]/.test(settingsSrc), '/api/prompt-cache 未把 MCP 键回给面板');
  assert.ok(/!promptCacheMemoEquals\(nextMemo, memo\)/.test(settingsSrc), '备忘变化判定未覆盖新键 → 备忘丢失');
});
check('B1-10 面板文案写清 MCP 键与它的代价', () => {
  assert.ok(/MCP_CONNECTION_NONBLOCKING=false/.test(panelSrc), '面板未说明写入了哪个键');
  assert.ok(/首条消息会等最慢的 MCP 连上/.test(panelSrc), '面板未写清代价');
});

// ── ② 标题:spawn 参数(零工具/无 MCP/短 system/探测门)────────────────────
const FULL_HELP = [
  '  --tools <tools...>  Specify the list of available tools',
  '  --mcp-config <configs...>  Load MCP servers from JSON',
  '  --strict-mcp-config  Only use MCP servers from --mcp-config',
  '  --disable-slash-commands  Disable all skills',
  '  --system-prompt <prompt>  System prompt to use for the session',
  '  --system-prompt-snapshot <on|off>  Record the system prompt once',
].join('\n');
const argPair = (args, flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };

check('B2-1 全支持时:零工具 + 空 MCP + 不加载技能 + 自写短 system', () => {
  _resetSnapFlagCache();
  cliSupportsFlag('/probe/full', '--tools', () => FULL_HELP);   // 预热同一份 help 缓存
  const args = buildTitleArgs({ claudePath: '/probe/full', model: 'deepseek-chat' });
  assert.equal(args[0], '-p');
  assert.ok(args.includes('--no-session-persistence'), '标题调用绝不能落盘成会话');
  assert.equal(argPair(args, '--tools'), '', '工具列表必须为空(原生标题就是零工具,26 个工具 ≈ 64k 字符)');
  assert.equal(argPair(args, '--mcp-config'), '{"mcpServers":{}}');
  assert.ok(args.includes('--strict-mcp-config'), '不加 strict 时用户配置的 MCP 仍会被加载');
  assert.ok(args.includes('--disable-slash-commands'));
  assert.equal(argPair(args, '--system-prompt'), TITLE_SYSTEM_PROMPT);
  assert.equal(argPair(args, '--model'), 'deepseek-chat');
  assert.ok(!args.includes('--permission-mode'), '零工具时无权限面,plan 只往 system 多塞一段');
});
check('B2-2 老 CLI 不认的 flag 一个都不加(unknown option 会直接退进程)', () => {
  _resetSnapFlagCache();
  const args = buildTitleArgs({ claudePath: '/probe/old', model: 'x' });
  // 探测走真实 execFileSync 打不到 /probe/old → 抛错 → 一律按不支持
  for (const f of ['--tools', '--mcp-config', '--strict-mcp-config', '--disable-slash-commands', '--system-prompt']) {
    assert.ok(!args.includes(f), `${f} 未过探测门`);
  }
  assert.deepEqual(args, ['-p', '--no-session-persistence', '--model', 'x'], '探测失败时仍要能起标题(退化,不是失效)');
});
check('B2-3 只支持一部分 flag 时逐个门控', () => {
  _resetSnapFlagCache();
  const partial = '  --tools <tools...>  x\n  --disable-slash-commands  y';
  cliSupportsFlag('/probe/partial', '--tools', () => partial);
  const args = buildTitleArgs({ claudePath: '/probe/partial', model: '' });
  assert.equal(argPair(args, '--tools'), '');
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(!args.includes('--mcp-config'));
  assert.ok(!args.includes('--strict-mcp-config'), 'strict 必须跟着 --mcp-config 一起,单独给它无意义');
  assert.ok(!args.includes('--system-prompt'));
  assert.ok(!args.includes('--model'), '空模型不传 --model(回落默认模型)');
});
check('B2-4 非法模型名不进 argv(cmd.exe 元字符注入面)', () => {
  _resetSnapFlagCache();
  cliSupportsFlag('/probe/full2', '--tools', () => FULL_HELP);
  assert.ok(!buildTitleArgs({ claudePath: '/probe/full2', model: 'x&calc' }).includes('--model'));
});
check('B2-5 探测按二进制路径缓存整份 help(多个 flag 只跑一次子进程)', () => {
  _resetSnapFlagCache();
  let calls = 0;
  const probe = () => { calls += 1; return FULL_HELP; };
  cliSupportsFlag('/probe/cache90', '--tools', probe);
  cliSupportsFlag('/probe/cache90', '--mcp-config', probe);
  cliSupportsFlag('/probe/cache90', '--system-prompt', probe);
  assert.equal(calls, 1, `同一二进制探了 ${calls} 次 help,应只 1 次`);
  _resetSnapFlagCache();
});
check('B2-6 后界断言:只有 --system-prompt-snapshot 时不能判成支持 --system-prompt', () => {
  _resetSnapFlagCache();
  assert.equal(cliSupportsFlag('/probe/snaponly', '--system-prompt', () => '  --system-prompt-snapshot <on|off>'), false);
  assert.equal(cliSupportsSnapshotFlag('/probe/snaponly'), true, '同一份 help 缓存要能给出 snapshot=true');
  _resetSnapFlagCache();
});
check('B2-7 短 system 遵守 argv 三条 Windows 约束(单行/纯 ASCII/无双引号)', () => {
  assert.ok(!/[\r\n]/.test(TITLE_SYSTEM_PROMPT), '换行会让 cmd.exe 截断整条命令');
  assert.ok(/^[\x20-\x7e]*$/.test(TITLE_SYSTEM_PROMPT), '非 ASCII 会被 cmd 码页破坏');
  assert.ok(!TITLE_SYSTEM_PROMPT.includes('"'), '双引号会被 cmd 重解析');
  assert.ok(TITLE_SYSTEM_PROMPT.length < 1500, `短提示膨胀到 ${TITLE_SYSTEM_PROMPT.length} 字符,瘦身目标(≤2k token)失守`);
  assert.ok(/title/.test(TITLE_SYSTEM_PROMPT) && /JSON/.test(TITLE_SYSTEM_PROMPT), '必须要求只回 title 字段的 JSON');
});

// ── ② 标题:解析容错 ────────────────────────────────────────────────────
check('B3-1 纯 JSON', () => {
  assert.deepEqual(parseTitleJson('{"title":"Widget cache prefix"}'), { title: 'Widget cache prefix', json: true });
});
check('B3-2 thinking 段 + JSON(DeepSeek 实测形态)', () => {
  const out = '让我想想这段会话在讲什么…\n\n{"title":"前缀缓存命中率"}';
  assert.deepEqual(parseTitleJson(out), { title: '前缀缓存命中率', json: true });
});
check('B3-3 前后杂文 / 代码围栏包裹', () => {
  assert.equal(parseTitleJson('```json\n{"title":"MCP blocking connect"}\n```').title, 'MCP blocking connect');
  assert.equal(parseTitleJson('Here you go: {"title":"Session title"} hope that helps').title, 'Session title');
  assert.equal(parseTitleJson('{"title":"Widget cache prefix"}3\n').title, 'Widget cache prefix', 'stdout 尾巴带杂字符也要能取到');
});
check('B3-4 标题里含转义双引号', () => {
  assert.deepEqual(parseTitleJson('{"title":"MCP \\"slow\\" server"}'), { title: 'MCP "slow" server', json: true });
});
check('B3-5 非 JSON:原样交回并标 json:false(交给既有清洗与元话术兜底)', () => {
  assert.deepEqual(parseTitleJson('缓存命中率排查'), { title: '缓存命中率排查', json: false });
  assert.deepEqual(parseTitleJson('  '), { title: '', json: false });
  assert.deepEqual(parseTitleJson(null), { title: '', json: false });
  assert.deepEqual(parseTitleJson('{"notitle":"x"}'), { title: '{"notitle":"x"}', json: false });
});
check('B3-6 端点:先等原生 ai-title、<session> 转写、JSON 命中即跳过元话术', () => {
  const title = chatSrc.slice(chatSrc.indexOf("router.post('/chat/title'"), chatSrc.indexOf('const childEnv = { ...process.env };'));
  assert.ok(/await waitForAiTitle\(jsonlSid\)/.test(title), '兜底必须先等原生落盘的 ai-title,否则短回合白起一个进程');
  assert.ok(/<session>\\n\$\{sessionText\}\\n<\/session>/.test(title), 'user 消息未照抄原生的 <session> 转写');
  assert.ok(/\.slice\(0, 1000\)/.test(title), '会话正文未按原生上限 1000 字符截断');
  assert.ok(/parsed\.json && parsed\.title/.test(chatSrc), 'JSON 解析成功时必须跳过元话术启发式(会误杀长英文标题)');
  assert.ok(/buildTitleArgs\(\{ claudePath: resolveUserClaude\(\)/.test(chatSrc), 'argv 未走 buildTitleArgs,或探测的不是实际 spawn 的二进制');
});

// ── ② 标题模型:小快档映射优先,读不到回退会话模型 ──────────────────────────
check('B4-1 settings 有小快档映射就用它', () => {
  writeSettings({ ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat' });
  assert.equal(resolveTitleModel('deepseek-reasoner'), 'deepseek-chat');
});
check('B4-2 没配(官方渠道)就回退会话模型', () => {
  writeSettings({});
  assert.equal(resolveTitleModel('claude-sonnet-4-6'), 'claude-sonnet-4-6');
});
check('B4-3 小快档值非法时回退会话模型(不把注入串塞进 argv)', () => {
  writeSettings({ ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x&calc' });
  assert.equal(resolveTitleModel('deepseek-chat'), 'deepseek-chat');
});

// ── ②a 原生标题落点判据:fixture 用真实 jsonl 行形态 ─────────────────────
await acheck('B5-1 认原生写的 ai-title 行(真实形态,两种键序都出现过)', async () => {
  const f = join(home, 'fx-ai.jsonl');
  writeFileSync(f, [
    '{"type":"summary","summary":"x","leafUuid":"u0"}',
    '{"type":"ai-title","aiTitle":"Prompt cache prefix breakage","sessionId":"11111111-2222-3333-4444-555555555555"}',
    '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1"}',
  ].join('\n') + '\n');
  const t = await readSessionTitles(f);
  assert.equal(t.aiTitle, 'Prompt cache prefix breakage');
  assert.equal(t.customTitle, '');
});
await acheck('B5-2 少见键序 {type,sessionId,aiTitle} 同样认', async () => {
  const f = join(home, 'fx-ai2.jsonl');
  writeFileSync(f, '{"type":"ai-title","sessionId":"11111111-2222-3333-4444-555555555555","aiTitle":"Slow MCP tools drift"}\n');
  assert.equal((await readSessionTitles(f)).aiTitle, 'Slow MCP tools drift');
});
await acheck('B5-3 手改标题与自动标题分开取(自动标题不许盖掉手改)', async () => {
  const f = join(home, 'fx-both.jsonl');
  writeFileSync(f, [
    '{"type":"ai-title","aiTitle":"Auto name","sessionId":"s"}',
    '{"type":"custom-title","customTitle":"我改的名字","sessionId":"s"}',
  ].join('\n') + '\n');
  const t = await readSessionTitles(f);
  assert.equal(t.aiTitle, 'Auto name');
  assert.equal(t.customTitle, '我改的名字');
});
await acheck('B5-4 同类多行后写胜出(CLI 对 ai-title 是 last-wins)', async () => {
  const f = join(home, 'fx-lastwins.jsonl');
  writeFileSync(f, [
    '{"type":"ai-title","aiTitle":"First","sessionId":"s"}',
    '{"type":"ai-title","aiTitle":"Second","sessionId":"s"}',
  ].join('\n') + '\n');
  assert.equal((await readSessionTitles(f)).aiTitle, 'Second');
});
await acheck('B5-5 正文里出现 ai-title 字样不误判成标题行', async () => {
  const f = join(home, 'fx-noise.jsonl');
  writeFileSync(f, [
    '{"type":"user","message":{"role":"user","content":"grep 一下 \\"type\\":\\"ai-title\\" 看看有几个"},"uuid":"u1"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ai-title"}]},"uuid":"u2"}',
  ].join('\n') + '\n');
  const t = await readSessionTitles(f);
  assert.equal(t.aiTitle, '', '只有顶层 type 才是标题行,消息正文里的同名字样不算');
});

// ── ③ promptSuggestions:默认值按 provider 类别 ─────────────────────────
check('B6-1 auto:第三方关、官方开', () => {
  writeSettings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789' });
  assert.equal(resolvePromptSuggestions('auto'), false, '第三方按 token 计费,每回合多打一次主模型必须默认关');
  assert.equal(resolvePromptSuggestions(undefined), false);
  writeSettings({});
  assert.equal(resolvePromptSuggestions('auto'), true, '官方渠道默认值不变');
});
check('B6-2 用户显式设过就一直尊重(压过 provider 类别)', () => {
  writeSettings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789' });
  assert.equal(resolvePromptSuggestions(true), true);
  writeSettings({});
  assert.equal(resolvePromptSuggestions(false), false);
});
check('B6-3 settings 读不到时按官方处理(不静默关掉别人的功能)', () => {
  rmSync(join(home, '.claude', 'settings.json'), { force: true });
  assert.equal(resolvePromptSuggestions('auto'), true);
});
check('B6-4 compatKey 存解析后的实际值(存 auto 会复用到不符的常驻进程)', () => {
  assert.ok(/suggest: resolvePromptSuggestions\(promptSuggestions\)/.test(chatSrc), 'compatKey 仍存原值');
  assert.ok(/const suggestOn = resolvePromptSuggestions\(promptSuggestions\)/.test(chatSrc), 'spawn 处仍按 === true 判');
});
check('B6-5 store 三态 + 迁移:1→true / 0→false / 无键→auto,setter auto 删键', () => {
  // 只看 promptSuggestions 这一段:excludeDynamicSystemPrompt 用同一套三态写法,
  // 不划范围的 grep 会被它顶住(变异自证时实测漏网)。
  const block = storeSrc.slice(storeSrc.indexOf('promptSuggestions: (() => {'));
  const decl = block.slice(0, block.indexOf('})(),') + 5);
  assert.ok(/getItem\('cgui-prompt-suggestions'\)/.test(decl) && /v === '1' \? true : v === '0' \? false : 'auto'/.test(decl),
    'store 默认值未做三态迁移(老用户的 1/0 要留成显式值,没存过的走 auto)');
  const setter = storeSrc.slice(storeSrc.indexOf('setPromptSuggestions: ('));
  assert.ok(/localStorage\.removeItem\('cgui-prompt-suggestions'\)/.test(setter.slice(0, 600)),
    '选回「自动」必须删键,否则 auto 无法表达');
});
check('B6-6 客户端原样上送三态(不在客户端把 auto 提前拍成布尔)', () => {
  assert.ok(/promptSuggestions: _suggestPref,/.test(appSrc), '上送的不是三态原值,server 的 provider 判据就废了');
});
check('B6-7 面板三态按钮 + 文案讲清代价', () => {
  // 同样要划到函数末尾:后面的 ExcludeDynamicPromptToggle 也是三态,不划就永远绿。
  const from = panelSrc.indexOf('function PromptSuggestionsToggle');
  const toggle = panelSrc.slice(from, panelSrc.indexOf('\nfunction ', from + 1));
  assert.ok(/\['auto', '自动'\], \[true, '开'\], \[false, '关'\]/.test(toggle), '输入预测仍是两态开关');
  assert.ok(/每个回合多打一次主模型/.test(panelSrc), '面板未写清代价');
  assert.ok(/官方渠道开启、第三方 provider 关闭/.test(panelSrc), '面板未写清「自动」的含义');
});

process.env.HOME = REAL_HOME;
rmSync(home, { recursive: true, force: true });
if (failures.length) {
  console.error('FAIL:\n' + failures.map((f) => '  - ' + f).join('\n\n'));
  process.exit(1);
}
console.log('check-r90-cache-followups: OK');
