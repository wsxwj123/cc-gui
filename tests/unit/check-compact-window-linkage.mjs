#!/usr/bin/env node
// 自动压缩窗口联动(chat.js resolveCompactWindowSettings)分支自检。
// node tests/unit/check-compact-window-linkage.mjs
//
// 语义依据(CLI 2.1.221 二进制 + headless `claude --model k3 --settings <file> -p "/context"` 实测):
//   ① autoCompactWindow 是【窗口】,有效窗口 = min(CLI 自认的模型窗口, 该值)。
//      实测:--model k3 + autoCompactWindow=1000000 → /context 仍报 200k(被钳);
//            --model k3 + env.CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576 → /context 报 1m。
//   ② 压缩线 = 有效窗口 − min(模型最大输出, 20000) − 13000(固定预留,不是乘百分比)。
//      实测:autoCompactWindow=200000 与 100000 两档,/context 的 Autocompact buffer 恒为 29k。
//   ③ CLI schema:autoCompactWindow 为 int [100000, 1000000];窗口来源只对
//      非 claude- 前缀的模型名读 CLAUDE_CODE_MAX_CONTEXT_TOKENS。
// 故联动必须同时写两个键:MAX_CONTEXT_TOKENS 校正窗口认知,autoCompactWindow 武装主动压缩。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REAL_HOME = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'cgui-acw-test-'));
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(join(home, '.claude-gui'), { recursive: true });
process.env.HOME = home;   // os.homedir() 在 POSIX 上优先读 $HOME

const { resolveCompactWindowSettings } = await import('../../server/routes/chat.js');

const write = (rel, obj) => writeFileSync(join(home, rel), JSON.stringify(obj), 'utf8');
// 默认场景:第三方 provider(有 ANTHROPIC_BASE_URL),无用户显式设置,无 provider 条目。
function setup({ settings, provider } = {}) {
  write('.claude/settings.json', settings ?? { env: { ANTHROPIC_BASE_URL: 'https://relay.example/v1' } });
  if (provider) {
    write('.claude-gui/active-provider.json', { id: 'p1' });
    write('.claude-gui/custom-providers.json', [{ id: 'p1', ...provider }]);
  } else {
    write('.claude-gui/active-provider.json', {});
    write('.claude-gui/custom-providers.json', []);
  }
}
// 便捷断言:期望窗口 win → autoCompactWindow=min(win,1M) 且 env 报真实 win。
function expectWindow(model, win, msg) {
  const got = resolveCompactWindowSettings(model);
  assert.deepEqual(got, {
    autoCompactWindow: Math.min(win, 1_000_000),
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(win) },
  }, msg);
}

try {
  // ── 让位:三种"不该干预"的场景必须返回 null ────────────────────
  setup({ settings: { model: 'claude-sonnet-4-6' } });
  assert.equal(resolveCompactWindowSettings('k3'), null, '官方 OAuth(无 ANTHROPIC_BASE_URL)不干预');

  setup({ settings: { autoCompactWindow: 300_000, env: { ANTHROPIC_BASE_URL: 'https://relay.example/v1' } } });
  assert.equal(resolveCompactWindowSettings('k3'), null, '用户在设置页显式填了 autoCompactWindow → 联动整个让位');

  setup({ settings: { env: { ANTHROPIC_BASE_URL: 'https://relay.example/v1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } } });
  assert.equal(resolveCompactWindowSettings('k3'), null, 'env 显式设置 → 联动整个让位');

  // ── 小窗让位:<100K 低于 CLI schema 下限,表达不了就交回 CLI 默认 ──
  // 不能硬钳到 100K —— 那是对 CLI 谎报窗口,会把压缩线/硬阻断线放到真窗口之外。
  setup({ provider: { contextWindow: 64_000 } });
  assert.equal(resolveCompactWindowSettings('some-tiny-model'), null, '窗口 64K < schema 下限 100K → null');
  setup({ provider: { contextWindow: 100_000 } });
  expectWindow('some-model', 100_000, '窗口恰好 100K → 落在下限上,照常下发');

  // ── 模型未知且无 provider 窗口 → 无从判断,不猜 ──────────────────
  setup();
  assert.equal(resolveCompactWindowSettings('totally-unknown-model'), null, '规则表未命中且 provider 没填窗口 → null');

  // ── k3 变体(R1:旧值 262,144 被实测最大 prompt 319,687 证伪)────────
  setup();
  expectWindow('k3', 1_048_576, '裸 k3 = Kimi Code 套餐别名,官方 1,048,576');
  expectWindow('k3-0905', 1_048_576, 'k3 带日期变体同为 1M(旧 /^k3$/ 精确匹配会漏)');
  expectWindow('k3.5', 1_048_576, 'k3 带小版本变体同为 1M');
  expectWindow('kimi-k3', 1_048_576, 'kimi-k3 全名同为 1M');
  expectWindow('k3-256k', 262_144, 'k3-256k 是官方明列的固定 256K 档,必须先于泛化 k3 规则命中');
  expectWindow('kimi-k2.6', 262_144, 'Kimi K2.6 仍 256K,不被 k3 规则波及');
  expectWindow('minimax-k3', 204_800, 'minimax-k3 不是 k3 变体(k3 不在开头),仍走 minimax 规则的 200K');
  assert.equal(resolveCompactWindowSettings('k30-preview'), null, 'k30 数字续接不误中 k3 规则');

  // ── mimo(R1:服务端此前完全没有 mimo 规则 → 联动与徽章分母全落空)──
  expectWindow('mimo-v2.5-pro', 1_000_000, 'MiMo v2.5 官方 1M');
  assert.equal(resolveCompactWindowSettings('mimo-v2-flash'), null, 'MiMo 旧代已下线无官方规格 → 不猜,交 CLI 默认');

  // ── gpt-5 拆分(R1:5.4 起 1.05M,gpt-5/mini/nano 仍 400K)───────────
  expectWindow('gpt-5.6-sol', 1_050_000, 'GPT-5.6 官方 1.05M;autoCompactWindow 被 CLI schema 上限钳到 1M,env 仍报真实 1.05M');
  expectWindow('gpt-5.5', 1_050_000, 'GPT-5.5 同为 1.05M');
  expectWindow('openai/gpt-5.6-sol', 1_050_000, '带 openai/ 前缀的同一模型给同一答案');
  expectWindow('gpt-5', 400_000, 'GPT-5 仍 400K');
  expectWindow('gpt-5-mini', 400_000, 'GPT-5 mini 仍 400K(拆分不能把它一起调大)');
  expectWindow('gpt-5-nano', 400_000, 'GPT-5 nano 仍 400K');

  // ── deepseek 代际 ───────────────────────────────────────────────
  expectWindow('deepseek-v4-flash', 1_048_576, 'DeepSeek V4 1M(实测最大 680,100 已打穿旧的 200K 口径)');
  expectWindow('deepseek-chat', 131_072, 'DeepSeek 旧系 128K');

  // ── R2 核心:下发的是真实窗口,不再乘百分比 ──────────────────────
  // 128K 家是折上折唯一真正咬到的地方:旧实现 131,072×80% = 104,857 下发,
  // CLI 再扣约 33K 预留 → 压缩线约 72K,只有真窗口的 55%。
  const ds = resolveCompactWindowSettings('deepseek-chat');
  assert.equal(ds.autoCompactWindow, 131_072, '下发真实窗口本身,不是 131072×80%=104857');
  assert.ok(ds.autoCompactWindow > 104_857, '必须严格大于旧的折上折值,否则等于没改');

  // ── [1m] 后缀最高优先级(GUI 的 1M 开关)────────────────────────
  setup({ provider: { contextWindow: 128_000 } });
  expectWindow('deepseek-chat[1m]', 1_048_576, '[1m] 后缀压过规则表与 provider 手填窗口');

  // ── provider 实抓窗口 > 规则表 > provider 手填 ──────────────────
  setup({ provider: { contextWindow: 128_000, modelWindows: { 'k3': 524_288 } } });
  expectWindow('k3', 524_288, 'provider 实抓的 modelWindows 压过内置规则表');
  setup({ provider: { contextWindow: 512_000 } });
  expectWindow('who-knows-model', 512_000, '规则表未命中时回落 provider 手填的 contextWindow');
  expectWindow('k3', 1_048_576, '规则表命中时优先于 provider 手填');

  console.log('check-compact-window-linkage: all assertions passed');
} finally {
  process.env.HOME = REAL_HOME;
  rmSync(home, { recursive: true, force: true });
}
