#!/usr/bin/env node
// r103:第三方 provider 手填 1M 窗口,一轮后徽章分母被 CLI 自报的 200k 顶掉。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/BRIEF-r103-window-denominator.md 与主会话
// 定下的契约写,不看实现函数体。四段:
//   A. 纯函数 resolveBadgeWindow 全优先级矩阵(真 import 真跑)。
//   B. 服务端联动值 → 纯函数 的接缝(沙箱 HOME 里跑既有 resolveCompactWindowSettings,
//      复现用户报告的原始场景;不起服务、不碰真实 ~/.claude)。
//   C. 源码锁(JSX / Express 路由进不了 node,只能读文件做结构断言)。
//   D. 既有导出未被本轮改动挪走。
//
// 设计要点:纯函数部分用【动态 import + 逐条 try/catch】。静态 import 一个还不存在的
// 导出会在 ESM 链接阶段直接抛错、后面一条断言都跑不到;改前必须"每条各自红",
// 才看得出到底缺哪几件。
//
// Run: node tests/unit/check-r103-window-denominator.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const M1 = 1_000_000;
const K200 = 200_000;

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

// 去注释:源码锁若把注释算数,实现方只要写一行 "// GUI 来源不覆盖" 就能骗过守卫锁。
// 行尾 // 前一个字符是 : 的不剥(避开 'https://...' 这类字符串)。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/([^:'"`\\])\/\/[^\n]*/g, '$1');

// 从 startIdx 起的第一个 { 做花括号配对,返回整块(含首尾花括号)。
function braceBlock(src, startIdx) {
  const open = src.indexOf('{', startIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

// ══════════════════════════════════════════════════════════════════════════
// A. 纯函数契约 client/src/utils/contextWindow.js → resolveBadgeWindow
//    优先级:model 含 [1m] → 1M;否则 linkedWindow > providerWindow > cliWindow > null。
//    非法/非数一律按"缺失"处理(与既有 pickCliContextWindow 同一纪律)。
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] 纯函数 resolveBadgeWindow 优先级矩阵');

let MOD = null;
let MODERR = '';
try {
  MOD = await import('../../client/src/utils/contextWindow.js');
} catch (e) {
  MODERR = String((e && e.message) || e);
}
check('A0 contextWindow.js 可被 node 直接 import(零依赖纯函数模块)', () => {
  assert.ok(MOD, `import 失败:${MODERR}`);
});

const resolveBadgeWindow = MOD?.resolveBadgeWindow;
// 每条断言各自现调,函数不存在时给一句人话红,而不是整文件炸掉。
const rbw = (arg) => {
  if (typeof resolveBadgeWindow !== 'function') {
    throw new Error('resolveBadgeWindow 未从 client/src/utils/contextWindow.js 导出(契约①)');
  }
  return resolveBadgeWindow(arg);
};

// 【G1 已裁定】返回形态 = { window: number|null, source: string|null }。
// W() 只做取值,形态本身由 M23a 逐字段钉住。
const W = (arg) => {
  const r = rbw(arg);
  assert.ok(r && typeof r === 'object' && !Array.isArray(r),
    `返回必须是 { window, source } 对象,实得 ${JSON.stringify(r)}`);
  assert.ok('window' in r, `返回对象缺 window 字段,实得 ${JSON.stringify(r)}`);
  return r.window;
};

check('A1 resolveBadgeWindow 已导出且是函数', () => {
  assert.equal(typeof resolveBadgeWindow, 'function');
});

// ── 用户报告的原始场景(BRIEF 验收第 1 条)─────────────────────────────
check('M1 第三方手填1M + CLI自报200k + 模型无[1m] → 分母 1M(联动值口径)', () => {
  assert.strictEqual(W({ cliWindow: K200, linkedWindow: M1, model: 'gpt-4o-relay' }), M1);
});
check('M2 第三方手填1M只到达 providerWindow(服务端未回传联动值)+ CLI 200k → 1M', () => {
  assert.strictEqual(W({ cliWindow: K200, providerWindow: M1, model: 'gpt-4o-relay' }), M1);
});
check('M3 官方 claude + CLI自报200k + 无任何GUI侧窗口 → 200000(CLI 自报仍生效)', () => {
  assert.strictEqual(W({ cliWindow: K200, model: 'claude-sonnet-4-6' }), K200);
});
check('M4 模型名带[1m] → 1M,压过 linked/provider/cli 三者', () => {
  assert.strictEqual(
    W({ cliWindow: K200, linkedWindow: 250_000, providerWindow: 262_144, model: 'claude-sonnet-4-6[1m]' }),
    M1);
});
check('M5 模型名带[1m] 且其他全缺 → 1M', () => {
  assert.strictEqual(W({ model: 'k3[1m]' }), M1);
});
check('M6 四项全缺 → null(不猜,不返回 0/undefined)', () => {
  assert.strictEqual(W({}), null);
});

// ── 优先级次序(相邻两级两两比对)────────────────────────────────────
check('M7 linkedWindow 压过 providerWindow 与 cliWindow', () => {
  assert.strictEqual(W({ cliWindow: K200, providerWindow: 262_144, linkedWindow: M1 }), M1);
});
check('M8 providerWindow 压过 cliWindow', () => {
  assert.strictEqual(W({ cliWindow: K200, providerWindow: 262_144 }), 262_144);
});
check('M9 linkedWindow 比 cliWindow 小时【仍然】优先(不是取最大值)', () => {
  assert.strictEqual(W({ cliWindow: K200, linkedWindow: 64_000 }), 64_000);
});
check('M10 providerWindow 比 cliWindow 小时【仍然】优先(不是取最大值)', () => {
  assert.strictEqual(W({ cliWindow: K200, providerWindow: 128_000 }), 128_000);
});
check('M11 反向用例:cliWindow 在任何情况下都不得覆盖已有的 GUI 侧来源', () => {
  for (const cli of [K200, 100, 999_999_999]) {
    assert.strictEqual(W({ cliWindow: cli, linkedWindow: 300_000 }), 300_000, `cliWindow=${cli}`);
    assert.strictEqual(W({ cliWindow: cli, providerWindow: 300_000 }), 300_000, `cliWindow=${cli}`);
  }
});

// ── 逐级降级(上一级非法时不该整条链塌掉)──────────────────────────
check('M12 linkedWindow 非法 → 降到 providerWindow', () => {
  assert.strictEqual(W({ linkedWindow: 0, providerWindow: 262_144, cliWindow: K200 }), 262_144);
});
check('M13 linked + provider 都非法 → 降到 cliWindow', () => {
  assert.strictEqual(W({ linkedWindow: NaN, providerWindow: null, cliWindow: K200 }), K200);
});
check('M14 三级全非法 → null', () => {
  assert.strictEqual(W({ linkedWindow: -1, providerWindow: 'x', cliWindow: 0 }), null);
});

// ── 非法值枚举(每种都得被当"缺失"跳过,不能透传出去)────────────────
const BAD = [0, -1, -200_000, NaN, Infinity, -Infinity, null, undefined, '200000', '1e6', true, false, {}, []];
check('M15 linkedWindow 位上 14 种非法值全部被跳过(由 providerWindow 兜住)', () => {
  for (const v of BAD) {
    assert.strictEqual(W({ linkedWindow: v, providerWindow: 262_144 }), 262_144,
      `linkedWindow=${JSON.stringify(v) ?? String(v)} 应被当作缺失`);
  }
});
check('M16 providerWindow 位上 14 种非法值全部被跳过(由 cliWindow 兜住)', () => {
  for (const v of BAD) {
    assert.strictEqual(W({ providerWindow: v, cliWindow: K200 }), K200,
      `providerWindow=${JSON.stringify(v) ?? String(v)} 应被当作缺失`);
  }
});
check('M17 cliWindow 位上 14 种非法值全部被跳过 → null', () => {
  for (const v of BAD) {
    assert.strictEqual(W({ cliWindow: v }), null,
      `cliWindow=${JSON.stringify(v) ?? String(v)} 应被当作缺失`);
  }
});
check('M18 字符串数字 \'1000000\' 不被当合法窗口(必须真 number,与 pickCliContextWindow 同纪律)', () => {
  assert.strictEqual(W({ linkedWindow: '1000000', cliWindow: K200 }), K200);
});

// ── model 入参的健壮性 ────────────────────────────────────────────────
check('M19 model 为 null/undefined/数字/对象/数组:不抛错,按"无 [1m]"处理', () => {
  for (const m of [null, undefined, 0, 123, {}, [], true]) {
    assert.strictEqual(W({ model: m, cliWindow: K200 }), K200, `model=${String(m)}`);
  }
});
check('M20 model 首尾空白不影响 [1m] 命中', () => {
  assert.strictEqual(W({ model: '  gpt-relay[1m]  ', cliWindow: K200 }), M1);
});
check('M21 [1m] 出现在模型名中间也命中', () => {
  assert.strictEqual(W({ model: 'gpt[1m]-turbo', cliWindow: K200 }), M1);
});
// 【G6 已裁定】resolveBadgeWindow 只认 [1m] 一种标注,不复用 nativeContextWindow 的 -Nm 分支。
check('M22 [1m] 近似串一律不命中([1k] / 1m] / [1 m] / -1mm / -1m / [2m] / -2m)', () => {
  for (const m of ['gpt[1k]', 'gpt1m]', 'gpt[1 m]', 'gpt-1mm', 'gpt-1m', 'gpt[2m]', 'gpt-2m']) {
    assert.strictEqual(W({ model: m, cliWindow: K200 }), K200, `model=${m} 不该被当成 [1m]`);
  }
});
// 【G4 已裁定】[1m] 判定大小写不敏感(与既有 /\[1m\]/i 一致,用户手打 [1M] 也认)。
check('M22b [1m] 大小写不敏感:[1M] / [1M] 混写同样命中 1M', () => {
  for (const m of ['x[1M]', 'X[1M]', 'x[1m]']) {
    assert.strictEqual(W({ model: m, cliWindow: K200 }), M1, `model=${m} 应命中 [1m]`);
  }
});

// ── 返回形态与纯度 ────────────────────────────────────────────────────
check('M23a 【G1 已裁定】返回 { window, source } 两字段:命中 window 是 number、source 是非空字符串', () => {
  const hit = rbw({ cliWindow: K200 });
  assert.ok(hit && typeof hit === 'object' && !Array.isArray(hit), `实得 ${JSON.stringify(hit)}`);
  assert.deepEqual(Object.keys(hit).sort(), ['source', 'window'], '只许这两个字段,多带字段会让调用方误用');
  assert.equal(typeof hit.window, 'number');
  assert.equal(typeof hit.source, 'string');
  assert.ok(hit.source.length > 0);
});
check('M23b 形态无关:未命中时取出的窗口严格是 null(不是 undefined/0/false)', () => {
  const miss = W({});
  assert.strictEqual(miss, null);
  assert.notStrictEqual(miss, undefined);
});
check('M23c source 必须区分四级来源(契约④弹层文案的数据源)', () => {
  const linked = rbw({ cliWindow: K200, linkedWindow: M1 }).source;
  const prov = rbw({ cliWindow: K200, providerWindow: 262_144 }).source;
  const cli = rbw({ cliWindow: K200 }).source;
  const m1 = rbw({ model: 'x[1m]' }).source;
  assert.ok(linked && prov && cli && m1, `四级来源都得有标注,实得 ${JSON.stringify({ linked, prov, cli, m1 })}`);
  assert.equal(new Set([linked, prov, cli, m1]).size, 4, '四级来源标注不得撞名,否则弹层写不出区别');
  assert.strictEqual(rbw({}).source, null, '未命中时 source 必须是 null');
});
check('M24 纯函数:同参数连调两次结果一致,且不改写入参对象', () => {
  const arg = { cliWindow: K200, providerWindow: 262_144, linkedWindow: M1, model: 'x' };
  const snapshot = JSON.stringify(arg);
  const a = W(arg);
  const b = W(arg);
  assert.strictEqual(a, b);
  assert.strictEqual(JSON.stringify(arg), snapshot, '入参对象被就地改写了');
});
check('M25 多余字段不影响结果(实现不许对未知字段挑刺)', () => {
  assert.strictEqual(W({ cliWindow: K200, measuredWindow: 999, foo: 'bar' }), K200);
});
// 【G5 已裁定】无参 / null / 非对象入参一律返回 { window:null, source:null },不抛错。
check('M26 无参调用 resolveBadgeWindow() → { window:null, source:null }', () => {
  assert.deepEqual(rbw(undefined), { window: null, source: null });
});
check('M27 null / 非对象入参(0 / \'x\' / [] / true)一律 { window:null, source:null },不抛错', () => {
  for (const bad of [null, 0, 'x', [], true, NaN]) {
    assert.deepEqual(rbw(bad), { window: null, source: null }, `入参 ${JSON.stringify(bad) ?? String(bad)}`);
  }
});

// ── 【契约补充】explicit 来源要钳位 ────────────────────────────────────
// 语义依据:settings.autoCompactWindow 是"用户显式设置",CLI 侧有效窗口 = min(CLI 自认的
// 模型窗口, 该值)(check-compact-window-linkage 实测结论)。所以显式值大于 CLI 自报时,
// CLI 实际按小的那个走,分母必须跟着钳,否则徽章又谎报一次。
// 'linked' 与 [1m] 不钳:联动会同时写 CLAUDE_CODE_MAX_CONTEXT_TOKENS 抬高 CLI 的窗口认知。
//
// 【命名】主会话未指定来源入参名,本文件定为 linkedSource(与 linkedWindow 对称)。
// EX() 同时塞三种可能的别名,保证钳位矩阵不因命名分歧整片红;命名本身由 E0 单独钉住。
const EX = (linkedWindow, cliWindow, model) => W({
  linkedWindow, cliWindow, model,
  linkedSource: 'explicit', linkedWindowSource: 'explicit', linkedContextWindowSource: 'explicit',
});

check("E0 来源入参名定为 linkedSource(只给这一个别名也必须生效)", () => {
  assert.strictEqual(
    W({ linkedWindow: 500_000, linkedSource: 'explicit', cliWindow: K200, model: 'claude-sonnet-4-6' }),
    K200, '若实现用了别的入参名,请主会话裁定统一');
});
check('E1 官方模型 + 显式 500K + CLI 自报 200K → 200,000(取小)', () => {
  assert.strictEqual(EX(500_000, K200, 'claude-sonnet-4-6'), K200);
});
check('E2 第三方 + 联动 1M(source linked)+ CLI 200K → 1,000,000(不钳)', () => {
  assert.strictEqual(
    W({ linkedWindow: M1, linkedSource: 'linked', cliWindow: K200, model: 'gpt-4o-relay' }), M1);
});
check('E3 显式 100K + CLI 200K → 100,000(显式值更小时取显式值)', () => {
  assert.strictEqual(EX(100_000, K200, 'claude-sonnet-4-6'), 100_000);
});
check('E4 显式 500K 但 CLI 自报缺失/非法 → 500,000(没得钳就不钳)', () => {
  for (const cli of [undefined, null, 0, NaN, '200000']) {
    assert.strictEqual(EX(500_000, cli, 'claude-sonnet-4-6'), 500_000, `cliWindow=${String(cli)}`);
  }
});
check('E5 [1m] 压过钳位:显式 500K + CLI 200K + 模型带 [1m] → 1,000,000', () => {
  assert.strictEqual(EX(500_000, K200, 'claude-sonnet-4-6[1m]'), M1);
});
check("E6 来源缺省(没标 explicit)→ 不钳:联动 300K + CLI 200K → 300,000", () => {
  assert.strictEqual(W({ linkedWindow: 300_000, cliWindow: K200 }), 300_000);
});
check('E7 钳位只作用于 explicit:providerWindow 500K + CLI 200K 照旧不钳', () => {
  assert.strictEqual(
    W({ providerWindow: 500_000, linkedSource: 'explicit', cliWindow: K200 }), 500_000);
});
check('E8 钳位后仍是 GUI 侧来源(source 非空,不得退化成 cli/null)', () => {
  const r = rbw({ linkedWindow: 500_000, linkedSource: 'explicit', cliWindow: K200 });
  assert.equal(typeof r.source, 'string');
  assert.ok(r.source.length > 0);
});

console.log(`\n  —— A 段小计:${PASS} 绿 / ${FAILS} 红 ——`);

// ══════════════════════════════════════════════════════════════════════════
// B. 接缝:服务端联动窗口 → 纯函数分母。复现 BRIEF 里用户报告的原始场景。
//    用既有导出 resolveCompactWindowSettings(chat.js)算出 GUI 真正下发给 CLI 的窗口,
//    再喂给 resolveBadgeWindow,断言"CLI 按 1M 压缩、徽章也显示 1M"。
//    HOME 重定向到临时目录:不起服务、不读写真实 ~/.claude。
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[B] 联动窗口 → 徽章分母 接缝(沙箱 HOME,不碰真实 ~/.claude)');

const REAL_HOME = process.env.HOME;
const REAL_PROFILE = process.env.USERPROFILE;
const home = mkdtempSync(join(tmpdir(), 'cgui-r103-'));
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(join(home, '.claude-gui'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const wr = (rel, obj) => writeFileSync(join(home, rel), JSON.stringify(obj), 'utf8');
const RELAY = { env: { ANTHROPIC_BASE_URL: 'https://relay.example/v1' } };
function setup({ settings, provider } = {}) {
  wr('.claude/settings.json', settings ?? RELAY);
  if (provider) {
    wr('.claude-gui/active-provider.json', { id: 'p1' });
    wr('.claude-gui/custom-providers.json', [{ id: 'p1', ...provider }]);
  } else {
    wr('.claude-gui/active-provider.json', {});
    wr('.claude-gui/custom-providers.json', []);
  }
}

let CHAT = null;
let CHATERR = '';
try {
  CHAT = await import('../../server/routes/chat.js');
} catch (e) {
  CHATERR = String((e && e.message) || e);
}
const rcws = CHAT?.resolveCompactWindowSettings;
// 联动值 = 服务端真正下发给 CLI 的窗口(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)。
const linkedOf = (model) => {
  const v = Number(rcws?.(model)?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

try {
  check('B0 server/routes/chat.js 可 import 且仍导出 resolveCompactWindowSettings', () => {
    assert.ok(CHAT, `import 失败:${CHATERR}`);
    assert.equal(typeof rcws, 'function');
  });

  check('B1 用户原始场景:第三方中转 + provider 手填 1M + 未知模型 → 联动值 1000000', () => {
    setup({ provider: { contextWindow: M1 } });
    assert.strictEqual(linkedOf('gpt-4o-relay'), M1,
      '服务端本就按 1M 下发压缩窗口(BRIEF 已核过),这条绿说明 bug 不在联动层');
  });

  check('B2 端到端:该联动值 + CLI 自报 200k → 徽章分母仍是 1M(本轮要修的那一条)', () => {
    setup({ provider: { contextWindow: M1 } });
    assert.strictEqual(
      W({ linkedWindow: linkedOf('gpt-4o-relay'), cliWindow: K200, model: 'gpt-4o-relay' }), M1);
  });

  check('B3 官方 OAuth(无 ANTHROPIC_BASE_URL)→ 无联动值 → 徽章分母采 CLI 自报 200k', () => {
    setup({ settings: { model: 'claude-sonnet-4-6' } });
    assert.strictEqual(rcws('claude-sonnet-4-6'), null, '官方不干预压缩窗口');
    assert.strictEqual(
      W({ linkedWindow: linkedOf('claude-sonnet-4-6'), cliWindow: K200, model: 'claude-sonnet-4-6' }), K200);
  });

  check("B4 用户显式 autoCompactWindow=300000(explicit)+ CLI 自报 200K → 分母 200,000(钳位)", () => {
    setup({ settings: { autoCompactWindow: 300_000, ...RELAY } });
    assert.strictEqual(rcws('k3'), null, '显式设置时联动整个让位(既有行为,不该被本轮改动)');
    // CLI 有效窗口 = min(模型窗口, autoCompactWindow),显式值抬不动 CLI 的窗口认知 → 分母跟着钳。
    assert.strictEqual(
      W({ linkedWindow: 300_000, linkedSource: 'explicit', cliWindow: K200, model: 'k3' }), K200);
  });

  check('B5 provider 未填窗口且规则表未命中 → 无联动值 → 采 CLI 自报(BRIEF 验收第 3 条)', () => {
    setup();
    assert.strictEqual(rcws('totally-unknown-model'), null);
    assert.strictEqual(
      W({ linkedWindow: linkedOf('totally-unknown-model'), cliWindow: K200, model: 'totally-unknown-model' }),
      K200);
  });

  check('B6 小窗保护:provider 手填 64000 + CLI 自报 200k → 分母 64000(不许被放大)', () => {
    setup({ provider: { contextWindow: 64_000 } });
    assert.strictEqual(
      W({ linkedWindow: linkedOf('some-tiny-model'), cliWindow: K200, model: 'some-tiny-model' }), 64_000);
  });
} finally {
  process.env.HOME = REAL_HOME;
  process.env.USERPROFILE = REAL_PROFILE;
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

// ══════════════════════════════════════════════════════════════════════════
// C. 源码锁 —— JSX / Express 路由跑不进 node,只能读文件做结构断言。
//    所有匹配都在【去注释后】的文本上做:否则实现方写一行注释就能骗过守卫锁。
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[C] 源码锁');

let APP = '';
let CHATSRC = '';
try { APP = read('client/src/App.jsx'); } catch { APP = ''; }
try { CHATSRC = read('server/routes/chat.js'); } catch { CHATSRC = ''; }
const APPC = stripComments(APP);
const CHATC = stripComments(CHATSRC);

check('C0 App.jsx / server/routes/chat.js 均可读', () => {
  assert.ok(APP.length > 0, 'App.jsx 读不到或为空');
  assert.ok(CHATSRC.length > 0, 'chat.js 读不到或为空');
});

// ── 契约②:服务端在 init 回传联动窗口与来源 ────────────────────────────
check('C1 chat.js 回传字段 linkedContextWindow(契约②)', () => {
  assert.ok(CHATC.includes('linkedContextWindow'),
    'server 必须把 GUI 下发给 CLI 的真实窗口随 init/首个流事件回传,前端才不用重算');
});
check('C2 chat.js 回传字段 linkedContextWindowSource(契约②)', () => {
  assert.ok(CHATC.includes('linkedContextWindowSource'),
    '契约②定的字段名是 linkedContextWindowSource。若实现用裸 source 键随 init 下发,'
    + '与 init 载荷里其他 source 字段撞名,需主会话裁定改名还是改契约');
});
check("C3 chat.js 出现来源取值 'explicit' 与 'linked'(契约②枚举)", () => {
  assert.match(CHATC, /'explicit'|"explicit"/, "缺 'explicit'(用户显式设置窗口时的来源)");
  assert.match(CHATC, /'linked'|"linked"/, "缺 'linked'(压缩联动推算出的窗口)");
});
check('C4 linkedContextWindow 的回传点挨着 init(不是塞在别处的死代码)', () => {
  const hits = [...CHATC.matchAll(/linkedContextWindow/g)].map((m) => m.index);
  assert.ok(hits.length > 0, '找不到 linkedContextWindow');
  const near = hits.some((i) => /init/.test(CHATC.slice(Math.max(0, i - 1200), i + 1200)));
  assert.ok(near, '所有出现点周围 ±1200 字符都没有 init —— 契约②要求随 init(或首个流事件)回传');
});
check('C5 App.jsx 消费 linkedContextWindow(链路两端都接上,不是只发不收)', () => {
  assert.ok(APPC.includes('linkedContextWindow'), '前端没接住服务端回传的联动窗口');
});

// ── 契约③:R8-6 的 CLI 单行道覆盖必须被条件化 ──────────────────────────
const R86_MARK = "event.type === 'result' && event.modelUsage";
const r86At = APPC.indexOf(R86_MARK);
const r86Blk = r86At > -1 ? braceBlock(APPC, r86At + R86_MARK.length) : '';
// 实现方可能改用别的守卫名,这里给一组等价可接受的写法,不钉死单一命名。
const GUI_SRC = /linked|guiWin|hasGui|resolveBadgeWindow|providerWin|winSrc|\.source/i;

check('C6 R8-6 块仍存在(定位锚点没被改没)', () => {
  assert.ok(r86At > -1, `App.jsx 找不到锚点:${R86_MARK}`);
  assert.ok(r86Blk.length > 0, '花括号配对失败,切不出 R8-6 块');
});
check('C7 R8-6 块引用 GUI 侧窗口来源(去注释后)—— 有联动窗口时必须让位', () => {
  assert.match(r86Blk, GUI_SRC,
    'R8-6 块里没有任何 GUI 侧来源判定:CLI 自报仍会无条件顶掉手填的 1M');
});
check('C8 R8-6 不得把 CLI 自报值原样写进分母缓存(契约③源码锁)', () => {
  const direct = /resolvedWindowCache\.set\([^)]*cliWin\.window/.test(r86Blk);
  if (!direct) {
    // 已改走仲裁(把 cliWin.window 当候选之一喂给优先级函数),语义由 C7 守住。
    console.log('    (提示:块内已无 set(..., cliWin.window) 直写形态 —— 走仲裁,语义由 C7 守)');
    return;
  }
  const setAt = APPC.indexOf('resolvedWindowCache.set(', r86At);
  const pre = APPC.slice(r86At, setAt);
  assert.match(pre, /if\s*\(/, 'CLI 自报值直写分母缓存,前面连个 if 守卫都没有');
  assert.match(pre, GUI_SRC,
    '守卫只判了 cliWin 有没有值,没判 GUI 侧是否已有窗口来源 —— 这正是本轮 bug 本体');
});
check('C9 红线回归:R8-6 块只碰分母,绝不写分子(setLiveContextUsage / *Tokens)', () => {
  assert.ok(!/setLiveContextUsage/.test(r86Blk), 'R8-6 块写了徽章分子(usage 累积口径历史事故)');
  assert.ok(!/inputTokens|cacheReadInputTokens|outputTokens/.test(r86Blk), 'R8-6 块只读 contextWindow');
});

// ── 契约④:徽章弹层分母说明写清来源 ───────────────────────────────────
const WS_MARK = 'const winSource =';
const wsAt = APPC.indexOf(WS_MARK);
let wsBlk = '';
if (wsAt > -1) {
  const nextConst = APPC.indexOf('\n  const ', wsAt + WS_MARK.length);
  const end = nextConst > -1 ? Math.min(nextConst, wsAt + 900) : wsAt + 900;
  wsBlk = APPC.slice(wsAt, end);
}
// 文案可能落在 winSource 链调用的 label 辅助函数里 —— 顺着调用把函数体也纳进来,
// 否则锁只看一行 const 会误报红。
let wsText = wsBlk;
for (const m of wsBlk.matchAll(/\b(\w+Label)\s*\(/g)) {
  const fnAt = APPC.search(new RegExp(`function\\s+${m[1]}\\s*\\(`));
  const constAt = APPC.indexOf(`const ${m[1]} =`);
  const at = fnAt > -1 ? fnAt : constAt;
  if (at > -1) wsText += '\n' + braceBlock(APPC, at);
}

check('C10 winSource 定义仍在(弹层分母说明的数据源)', () => {
  assert.ok(wsAt > -1, `App.jsx 找不到 ${WS_MARK}`);
});
check('C11 弹层可达文本里五种分母来源字样齐全(手填/实抓/规则表/CLI 自报/[1m],BRIEF 需求 2)', () => {
  for (const [re, name] of [[/手填/, '手填'], [/实抓/, '实抓'], [/规则表/, '规则表'],
    [/自报/, 'CLI 自报'], [/\[1m\]/, '[1m] 后缀']]) {
    assert.match(wsText, re, `分母来源说明缺「${name}」—— 用户分不清 1M 这个分母是哪来的`);
  }
});
check('C12 来源文案由数据算出、不是写死一句话(label helper 必须收参)', () => {
  assert.match(wsBlk, /\w+Label\s*\(\s*[\w.?[]/,
    'winSource 必须把来源标注(meta/linkedContextWindowSource)喂给文案函数,否则五种来源只是死字符串');
});
check('C13 弹层仍渲染 winSource(说明位没被删)', () => {
  assert.ok(APPC.includes('info?.winSource'), '徽章弹层的"分母 = ..."一行必须继续渲染 winSource');
});

// ══════════════════════════════════════════════════════════════════════════
// D. 既有导出与既有行为不被本轮改动挪走
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[D] 既有导出回归');
check('D1 contextWindow.js 既有导出仍在(nativeContextWindow / pickCliContextWindow / isBareClaudeAlias)', () => {
  for (const n of ['nativeContextWindow', 'pickCliContextWindow', 'isBareClaudeAlias']) {
    assert.equal(typeof MOD?.[n], 'function', `既有导出 ${n} 被挪走会连带打红 check-context-window / check-badge-cli-window`);
  }
});
check('D2 nativeContextWindow 兜底表口径未被顺手改动(抽样 4 条)', () => {
  assert.strictEqual(MOD?.nativeContextWindow('claude-sonnet-4-6'), K200);
  assert.strictEqual(MOD?.nativeContextWindow('claude-opus-4-8'), M1);
  assert.strictEqual(MOD?.nativeContextWindow('claude-sonnet-4-6[1m]'), M1);
  assert.strictEqual(MOD?.nativeContextWindow('deepseek-chat'), 131_072);
});
check('D3 pickCliContextWindow 非法值纪律未变(0 / 字符串 / NaN 一律 null)', () => {
  const e = (w) => ({ m: { contextWindow: w } });
  for (const w of [0, -1, NaN, Infinity, '200000']) {
    assert.strictEqual(MOD?.pickCliContextWindow(e(w), 'm'), null, `contextWindow=${String(w)}`);
  }
  assert.deepEqual(MOD?.pickCliContextWindow(e(K200), 'm'), { window: K200, matchedModel: 'm' });
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r103-window-denominator: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r103-window-denominator: 分母优先级矩阵 + 联动接缝 + R8-6 让位锁 + 来源说明 全绿');
