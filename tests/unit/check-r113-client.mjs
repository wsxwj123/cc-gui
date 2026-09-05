#!/usr/bin/env node
// r113 前端验收测试:Bug 3(init 下发的显式压缩窗口不做取小钳位,整回合徽章分母被抬高)。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r113.md §6/§7 写,没看实现、
// 没看 PLAN/RESEARCH/审查报告。纯函数真 import 真跑;JSX 进不了 node,接线只能读源码文本。
//
// 真实用户视角:官方 Anthropic 登录(模型真实窗口 200K),设置里把「自动压缩窗口」选成
// 1M,发一条消息 → 整个回合徽章显示 xx/1M,压缩横幅与 ≥80% 红色告警被压住;要等到
// result 带 modelUsage 才跳回 200K(用户停止 / result 报错 / 中转不吐时永远不自愈)。
//
// 设计要点:动态 import + 逐条 try/catch(导出还不存在时每条各自红,而不是整文件炸)。
// 每条标 [修前应红](复现/新契约)或 [修前应绿](回归/不变),文件末尾分类汇总。
//
// Run: node tests/unit/check-r113-client.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let PASS = 0;
let FAILS = 0;
const failed = [];
const tally = { RED: { pass: 0, fail: 0 }, GREEN: { pass: 0, fail: 0 } };
const TAG = { RED: '[修前应红]', GREEN: '[修前应绿]' };
function check(tag, name, fn) {
  const label = `${TAG[tag]} ${name}`;
  try {
    fn();
    PASS++; tally[tag].pass++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    FAILS++; tally[tag].fail++;
    failed.push(label);
    const msg = String((e && e.message) || e).split('\n').slice(0, 5).join('\n      ');
    console.log(`  ✗ ${label}\n      ${msg}`);
  }
}
const red = (name, fn) => check('RED', name, fn);
const green = (name, fn) => check('GREEN', name, fn);

const read = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; } };
// 只剥行首块注释/行注释与"前面不含引号或斜杠"的行尾注释:通吃式的块注释正则会被
// 源码里的正则字面量骗成注释起点,一口吃掉半个文件,锁就成了永远绿的空壳。
const stripComments = (s) => s
  .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*\n?/gm, '')
  .replace(/^[ \t]*\/\/[^\n]*\n?/gm, '')
  .replace(/^([^'"`/\n]*?)[ \t]+\/\/[^\n]*$/gm, '$1');
function fnBody(src, declRe) {
  const m = declRe.exec(src);
  if (!m) return '';
  let i = src.indexOf('(', m.index);
  if (i < 0) return '';
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  const open = src.indexOf('{', i);
  if (open < 0) return '';
  depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return '';
}
const count = (s, sub) => s.split(sub).length - 1;

let MOD = {};
try { MOD = await import(pathToFileURL(join(ROOT, 'client/src/utils/contextWindow.js')).href); }
catch (e) { MOD = { __err: e }; }
function reconcile(...args) {
  if (MOD.__err) throw new Error(`contextWindow.js 导入失败:${MOD.__err.message}`);
  if (typeof MOD.reconcileBadgeWindow !== 'function') {
    throw new Error(`缺少导出 reconcileBadgeWindow(当前 typeof=${typeof MOD.reconcileBadgeWindow})`);
  }
  return MOD.reconcileBadgeWindow(...args);
}
// at 只做调试用,不参与判定 —— 比较 meta 时一律排除它。
const noAt = (m) => { const { at, ...rest } = m || {}; return rest; };
const SONNET = 'claude-sonnet-4-6';   // 官方 200K
const M1 = 1_000_000;
const K200 = 200_000;
const K100 = 100_000;

// ══════════════════════════════════════════════════════════════════════════
// R. reconcileBadgeWindow —— §6.1 数值例子
// ══════════════════════════════════════════════════════════════════════════
console.log('\nR. reconcileBadgeWindow 仲裁(§6.1)');

const EXPLICIT_1M = { linked: M1, linkedSource: 'explicit', linkedOrigin: 'explicit' };

red('R1 官方 200K 模型 + init 下发显式 1M + 尚无 CLI 自报 → 分母钳到 200K', () => {
  const m = reconcile(null, EXPLICIT_1M, SONNET);
  assert.equal(m.window, K200, '整回合徽章不该显示 1M(压缩横幅与 80% 告警会被压住)');
  assert.equal(m.source, 'explicit');
  assert.equal(m.origin, 'explicit');
});

red('R2 R1 之后 result 到达(CLI 自报 200K)→ 仍 200K/explicit,不退回 cli', () => {
  const m = reconcile(reconcile(null, EXPLICIT_1M, SONNET), { cli: K200 }, SONNET);
  assert.equal(m.window, K200);
  assert.equal(m.source, 'explicit');
  assert.equal(m.origin, 'explicit');
});

red('R3 幂等:R2 之后再来一次同样的 init → 逐字段与 R2 相同', () => {
  const r2 = reconcile(reconcile(null, EXPLICIT_1M, SONNET), { cli: K200 }, SONNET);
  const again = reconcile(r2, EXPLICIT_1M, SONNET);
  assert.deepEqual(noAt(again), noAt(r2), '重复送达的 init 改变了结果(不幂等)');
});

red('R4 顺序颠倒:先 result 后 init → 与 R2 结果相同', () => {
  const r2 = reconcile(reconcile(null, EXPLICIT_1M, SONNET), { cli: K200 }, SONNET);
  const flipped = reconcile(reconcile(null, { cli: K200 }, SONNET), EXPLICIT_1M, SONNET);
  assert.deepEqual(noAt(flipped), noAt(r2), '送达顺序会改变分母(SSE 重连后就会踩到)');
});

red('R5 必修-1b:显式值(100K)小于 CLI 自报(200K)→ 取 100K,方向不能反', () => {
  const prev = reconcile(null, { cli: K200 }, SONNET);
  const m = reconcile(prev, { linked: K100, linkedSource: 'explicit', linkedOrigin: 'explicit' }, SONNET);
  assert.equal(m.window, K100, 'CLI 实际在 100K 压缩,分母显示 200K 会漏报');
  assert.equal(m.source, 'explicit');
});

red('R6 显式值等于 CLI 自报 → 该值', () => {
  const prev = reconcile(null, { cli: K200 }, SONNET);
  const m = reconcile(prev, { linked: K200, linkedSource: 'explicit' }, SONNET);
  assert.equal(m.window, K200);
  assert.equal(m.source, 'explicit');
});

red("R7 linkedSource='linked'(GUI 联动第三方)不钳位(r103 既有语义)", () => {
  const prev = reconcile(null, { linked: M1, linkedSource: 'linked', linkedOrigin: 'rules' }, 'k3');
  const m = reconcile(prev, { cli: K200 }, 'k3');
  assert.equal(m.window, M1, '联动值被 CLI 自报的 200K 钳回去 = 把 r103 修好的又弄坏');
  assert.equal(m.source, 'linked');
  assert.equal(m.origin, 'rules');
});

red('R8 provider(手填/实抓)不钳位,origin 取 providerOrigin', () => {
  const prev = reconcile(null, { provider: 500_000, providerOrigin: 'manual' }, 'k3');
  const m = reconcile(prev, { cli: K200 }, 'k3');
  assert.equal(m.window, 500_000);
  assert.equal(m.source, 'provider');
  assert.equal(m.origin, 'manual');
});

red('R9 纯 CLI 来源(官方,GUI 无来源)→ 200K/cli/cli', () => {
  const prev = reconcile(null, { provider: null }, SONNET);
  const m = reconcile(prev, { cli: K200 }, SONNET);
  assert.equal(m.window, K200);
  assert.equal(m.source, 'cli');
  assert.equal(m.origin, 'cli');
});

red('R10 provider:null(后端解析不出)不得清掉已有的 cli 值', () => {
  const r9 = reconcile(reconcile(null, { provider: null }, SONNET), { cli: K200 }, SONNET);
  const m = reconcile(r9, { provider: null }, SONNET);
  assert.equal(m.window, K200);
  assert.equal(m.source, 'cli');
});

red('R11 [1m] 模型压过一切(含 explicit 钳位)', () => {
  const prev = reconcile(null, { linked: 500_000, linkedSource: 'explicit' }, 'k3[1m]');
  const m = reconcile(prev, { cli: K200 }, 'k3[1m]');
  assert.equal(m.window, M1);
  assert.equal(m.source, '1m');
  assert.equal(m.origin, '1m');
});

red('R12 显式 1M + 无 cli + 非 Anthropic 模型 → 按 CLI 自认恒 200K 钳', () => {
  const m = reconcile(null, { linked: M1, linkedSource: 'explicit' }, 'deepseek-chat');
  assert.equal(m.window, K200, '第三方名 CLI 自报恒 200K,首个 result 前分母不能偏大');
  assert.equal(m.source, 'explicit');
});

red('R13 显式 500K + 无 cli + 未知模型名 → min(500K,200K)=200K', () => {
  const m = reconcile(null, { linked: 500_000, linkedSource: 'explicit' }, 'some-unknown-model');
  assert.equal(m.window, K200);
  assert.equal(m.source, 'explicit');
});

red('R13b 显式 100K + 无 cli + 未知模型名 → 100K(小的那个赢)', () => {
  const m = reconcile(null, { linked: K100, linkedSource: 'explicit' }, 'some-unknown-model');
  assert.equal(m.window, K100);
  assert.equal(m.source, 'explicit');
});

red('R13c 显式 500K + 无 cli + Anthropic 原生 1M 模型 → 500K(用 nativeContextWindow 兜底)', () => {
  const m = reconcile(null, { linked: 500_000, linkedSource: 'explicit' }, 'claude-opus-4-8');
  assert.equal(m.window, 500_000, '对 Anthropic 家族必须用该模型原生窗口兜底,不是恒 200K');
  assert.equal(m.source, 'explicit');
});

red('R14 全空 → window/source/origin 三者皆 null', () => {
  const m = reconcile(null, {}, '');
  assert.equal(m.window, null);
  assert.equal(m.source, null);
  assert.equal(m.origin, null);
});

red('R15 脏入参(prevMeta/patch/model 任意组合)永不抛,返回合法 meta 且 window=null', () => {
  for (const prev of [0, 'x', [], true, null, undefined, NaN]) {
    for (const patch of [null, 42, [], undefined, 'str']) {
      for (const model of [null, {}, undefined, 42]) {
        const m = reconcile(prev, patch, model);
        assert.equal(typeof m, 'object', `入参 ${String(prev)}/${String(patch)}/${String(model)} 应返回对象`);
        assert.equal(m.window, null, `入参 ${String(prev)}/${String(patch)}/${String(model)} 不该算出窗口`);
        assert.equal(m.source, null);
      }
    }
  }
});

red('R16 非法槽值一律归 null(字符串数字 / 0 / NaN 不进槽)', () => {
  const m = reconcile(null, { linked: '1000000', provider: 0, cli: NaN }, SONNET);
  assert.equal(m.window, null);
  assert.equal(m.source, null);
  assert.equal(m.linked, null, "字符串 '1000000' 必须归 null,不是保留原值");
  assert.equal(m.provider, null);
  assert.equal(m.cli, null);
});

red('R17 patch 里的 undefined 不清槽(缺键同义)', () => {
  const r2 = reconcile(reconcile(null, EXPLICIT_1M, SONNET), { cli: K200 }, SONNET);
  assert.deepEqual(noAt(reconcile(r2, { cli: undefined }, SONNET)), noAt(r2));
});

red('R18 patch 里的 null 显式清槽:清掉 cli 后回落原生 200K 兜底', () => {
  const r2 = reconcile(reconcile(null, EXPLICIT_1M, SONNET), { cli: K200 }, SONNET);
  const m = reconcile(r2, { cli: null }, SONNET);
  assert.equal(m.cli, null, 'null 必须真的清空该槽');
  assert.equal(m.window, K200);
  assert.equal(m.source, 'explicit');
});

red('R19 返回形态:十个键齐全,at 是数字(其值不参与判定)', () => {
  const m = reconcile(null, EXPLICIT_1M, SONNET);
  assert.deepEqual(Object.keys(m).sort(),
    ['at', 'cli', 'linked', 'linkedOrigin', 'linkedSource', 'origin', 'provider',
      'providerOrigin', 'source', 'window'].sort());
  assert.equal(typeof m.at, 'number');
});

red('R20 原始输入存进 meta 供后续重算(六个槽按 patch 原值落位)', () => {
  const m = reconcile(null, { ...EXPLICIT_1M, provider: 300_000, providerOrigin: 'fetched', cli: K200 }, SONNET);
  assert.equal(m.linked, M1, 'linked 槽必须存未钳位的原值');
  assert.equal(m.linkedSource, 'explicit');
  assert.equal(m.linkedOrigin, 'explicit');
  assert.equal(m.provider, 300_000);
  assert.equal(m.providerOrigin, 'fetched');
  assert.equal(m.cli, K200);
});

red("R21 origin 规则:source='1m'→'1m';'cli'→'cli';provider 缺 providerOrigin → 'provider'", () => {
  assert.equal(reconcile(null, { linked: 500_000, linkedSource: 'explicit' }, 'k3[1m]').origin, '1m');
  assert.equal(reconcile(null, { cli: K200 }, SONNET).origin, 'cli');
  assert.equal(reconcile(null, { provider: 500_000 }, 'k3').origin, 'provider');
});

// ══════════════════════════════════════════════════════════════════════════
// N. §6.3 不变(反向用例):既有纯函数与既有接线一字不改
// ══════════════════════════════════════════════════════════════════════════
console.log('\nN. 既有行为不变(§6.3)');

green('N1 四个既有导出仍在', () => {
  for (const n of ['resolveBadgeWindow', 'nativeContextWindow', 'pickCliContextWindow', 'isBareClaudeAlias']) {
    assert.equal(typeof MOD?.[n], 'function', `既有导出 ${n} 被挪走`);
  }
});

green('N2 resolveBadgeWindow 行为不变:explicit 取小 / linked 不钳 / [1m] 压过一切 / 非对象入参', () => {
  const f = MOD?.resolveBadgeWindow;
  assert.deepEqual(f({ cliWindow: K200, linkedWindow: 500_000, linkedSource: 'explicit', model: SONNET }),
    { window: K200, source: 'explicit' });
  assert.deepEqual(f({ cliWindow: K200, linkedWindow: M1, linkedSource: 'linked', model: 'k3' }),
    { window: M1, source: 'linked' });
  assert.deepEqual(f({ cliWindow: K200, providerWindow: 262_144, model: 'k3[1m]' }),
    { window: M1, source: '1m' });
  assert.deepEqual(f('k3'), { window: null, source: null });
});

green('N3 nativeContextWindow 兜底表未被顺手改动(抽样 4 条)', () => {
  const f = MOD?.nativeContextWindow;
  assert.equal(f(SONNET), K200);
  assert.equal(f('claude-opus-4-8'), M1);
  assert.equal(f('claude-sonnet-4-6[1m]'), M1);
  assert.equal(f('deepseek-chat'), 131_072);
});

green('N4 pickCliContextWindow 非法值纪律未变', () => {
  const f = MOD?.pickCliContextWindow;
  const e = (w) => ({ m: { contextWindow: w } });
  for (const w of [0, -1, NaN, Infinity, '200000']) assert.equal(f(e(w), 'm'), null, `contextWindow=${String(w)}`);
  assert.deepEqual(f(e(K200), 'm'), { window: K200, matchedModel: 'm' });
});

// ══════════════════════════════════════════════════════════════════════════
// C. §6.2 接线 + §7 源码锁 —— JSX 进不了 node,只能读【去注释后】的源码文本。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nC. 接线与源码锁(§6.2 / §7)');

const APP = stripComments(read('client/src/App.jsx'));
const CW = stripComments(read('client/src/utils/contextWindow.js'));
const CHAT = stripComments(read('server/routes/chat.js'));

green('C0 App.jsx / contextWindow.js / chat.js 都读得到(源码锁的前提)', () => {
  assert.ok(APP.length > 0, 'App.jsx 读不到');
  assert.ok(CW.length > 0, 'contextWindow.js 读不到');
  assert.ok(CHAT.length > 0, 'chat.js 读不到');
});

red('C1 §7 必须出现:contextWindow.js 导出 reconcileBadgeWindow', () => {
  assert.match(CW, /export[\s\S]{0,40}\breconcileBadgeWindow\b/);
});

red('C2 §7 必须出现:reconcileBadgeWindow 体内复用 resolveBadgeWindow( 与 nativeContextWindow(', () => {
  const body = fnBody(CW, /(?:export\s+)?(?:function|const)\s+reconcileBadgeWindow\b/);
  assert.ok(body.length > 0, 'contextWindow.js 切不出 reconcileBadgeWindow 函数体');
  assert.match(body, /resolveBadgeWindow\(/, '仲裁必须复用既有纯函数,不许另写一套优先级');
  assert.match(body, /nativeContextWindow\(/, 'CLI 自认窗口兜底必须走 nativeContextWindow');
});

red('C3 §7 必须出现:App.jsx 里 reconcileBadgeWindow( 恰好出现 3 次(三个写入点)', () => {
  assert.equal(count(APP, 'reconcileBadgeWindow('), 3,
    `三个写入点(fetch 回写 / init 消费 / result 消费)必须都走同一仲裁入口,实际 ${count(APP, 'reconcileBadgeWindow(')} 次`);
});

red('C4 §7 必须出现:resolvedWindowMeta.set( 的次数 == reconcileBadgeWindow( 的次数', () => {
  assert.equal(count(APP, 'resolvedWindowMeta.set('), count(APP, 'reconcileBadgeWindow('),
    '有写 meta 却没经仲裁的路径(或反之)');
});

red('C5 §7 不得出现:init 直写 resolvedWindowCache.set(…, event.linkedContextWindow)(本轮 bug 本体)', () => {
  assert.equal(/resolvedWindowCache\.set\([^)]*event\.linkedContextWindow/.test(APP), false,
    'init 消费点仍绕过纯函数直写显式窗口 → 整回合徽章分母被抬高');
});

green('C6 §7 不得出现:resolvedWindowCache.set(wk, cliWin.window)(R8-6 直写 CLI 自报)', () => {
  assert.equal(/resolvedWindowCache\.set\(wk,\s*cliWin\.window\)/.test(APP), false);
});

red('C7 §7 不得出现:App.jsx 直接调用 resolveBadgeWindow((必须经 reconcileBadgeWindow 包装)', () => {
  assert.equal(/resolveBadgeWindow\(/.test(APP), false,
    '仲裁入口必须唯一,否则又会出现"某个写入点自己拼装 meta"的同类 bug');
});

red('C8 §7 三处写入点统一:每个 resolvedWindowCache.set( 写的都是 picked.window', () => {
  const sets = [...APP.matchAll(/resolvedWindowCache\.set\(([^;]{0,60})/g)].map((m) => m[1]);
  assert.ok(sets.length > 0, 'App.jsx 找不到 resolvedWindowCache.set(');
  for (const s of sets) {
    assert.match(s, /picked\.window/, `有写入点没写仲裁结果:resolvedWindowCache.set(${s.slice(0, 50)}…`);
  }
});

red('C9 §6.2 init 写入点入参:linked/linkedSource/linkedOrigin 三键取自 event.linkedContextWindow*', () => {
  assert.match(APP, /linked:\s*event\.linkedContextWindow\b/, 'init patch 缺 linked 槽');
  assert.match(APP, /linkedSource:\s*event\.linkedContextWindowSource/, 'init patch 缺 linkedSource 槽');
  assert.match(APP, /linkedOrigin:\s*event\.linkedContextWindowOrigin/, 'init patch 缺 linkedOrigin 槽');
});

red('C10 §6.2 result 写入点入参:patch 只送 { cli: cliWin.window }', () => {
  assert.match(APP, /\{\s*cli:\s*cliWin\.window\s*\}/, 'result 消费点没把 CLI 自报值作为 cli 槽送进仲裁');
});

red('C11 §6.2 fetch 回写入参:provider 槽 + providerOrigin 槽', () => {
  assert.match(APP, /providerOrigin:/, '/api/model-window 回写没带 providerOrigin');
  assert.match(APP, /provider:\s*Number\.isFinite\(/, '/api/model-window 回写的 provider 槽没做有限数校验');
});

green('C12 §6.2 不变:init 侧 Number.isFinite(event.linkedContextWindow) 前置门保留', () => {
  assert.match(APP, /Number\.isFinite\(event\.linkedContextWindow\)/,
    '0/负数/缺失不触发写入的前置门被删了');
});

green('C13 §6.2 不变:cgui:model-window-cli 广播仍在', () => {
  assert.match(APP, /cgui:model-window-cli/);
});

green('C14 §6.3 不变:两张缓存仍是模块级 Map,provider 切换仍清空', () => {
  assert.match(APP, /const resolvedWindowCache = new Map\(\)/);
  assert.match(APP, /const resolvedWindowMeta = new Map\(\)/);
  assert.match(APP, /cgui:provider-change/);
});

green('C15 §6.3 不变:分母优先级链一字不改', () => {
  assert.match(APP, /resolvedWindow \|\| measuredCtx\?\.windowTokens \|\| nativeContextWindow\(currentModel\)/);
});

green('C16 §6.3 不变:winSourceLabel 的 explicit / linked 两条文案逐字保留', () => {
  assert.match(APP, /winSourceLabel/, '徽章弹层来源文案函数不在了');
  assert.ok(APP.includes('按 CLI 实际窗口取小'), "explicit 分支文案被改动");
  assert.ok(APP.includes('压缩联动同源'), "linked 分支文案被改动");
});

green('C17 §6.3 不变:服务端零改动(三字段名 + 下发时机)', () => {
  assert.match(CHAT, /linkedContextWindow\b/);
  assert.match(CHAT, /linkedContextWindowSource: linkedWin\.source/);
  assert.match(CHAT, /subtype: 'context_window'/);
  assert.match(CHAT, /export function resolveLinkedWindowInfo/);
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r113-client: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
console.log(`   [修前应红] ${tally.RED.pass + tally.RED.fail} 条(现在绿 ${tally.RED.pass} / 红 ${tally.RED.fail})`);
console.log(`   [修前应绿] ${tally.GREEN.pass + tally.GREEN.fail} 条(现在绿 ${tally.GREEN.pass} / 红 ${tally.GREEN.fail})`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
}
process.exit(FAILS ? 1 : 0);
