#!/usr/bin/env node
// r16-1:显示路径的「模型属不属于当前 provider」白名单 —— 补上发送路径早就有的那道关。
//
// 用户实测症状:从 DeepSeek 切到 Claude 官方订阅后,顶栏模型徽章仍显示
// deepseek-v4-flash,但点开下拉列表里没有这一项(列表已是官方模型)。发送不受影响
// (resolveSendModel 一直有白名单,会回落),所以只错在显示。
//
// 根因:两条路径口径不一致 —— 显示 resolveSelectorModel 是 pin→历史→全局的裸取值,
// 对"这个值属于哪个 provider"毫无判断。store 里的陈旧值有多条来源(切 provider 时
// clear 的 PUT 与水合 GET 竞速、fetchModel 的 `if (data.model)` 守卫让服务端空响应
// 保留旧值、跨设备同步、ws 重连/回前台水合),逐条根治要能稳定复现那个时序;而显示
// 层补上白名单后,不管值从哪来都串不出来。
//
// 与既有三层防线(check-model-residue-guard:写入拒绝/读取自愈/选择器标异常)互补:
// 那三层管 ~/.claude/settings.json 里的外来模型名,这一层管前端 store 的残留值。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveSelectorModel, resolveSendModel, makeProviderModelGuard } from '../../client/src/utils/routing.js';

const OFFICIAL = { providerHint: 'anthropic' };
const S = (o = {}) => ({
  availableModels: [{ id: 'claude-sonnet-4-6' }, { id: 'sonnet' }, { id: 'opus' }, { id: 'haiku' }, { id: 'fable' }],
  customModels: [],
  currentProvider: OFFICIAL,
  currentModel: 'claude-sonnet-4-6',
  modelBySession: {},
  paneSessions: [],
  selectedSession: null,
  context1mBySession: {},
  providerEpoch: 0,
  ...o,
});

// ── ① 核心症状:切到官方后,旧 provider 的 pin 不得再显示 ──────────────
{
  assert.equal(resolveSelectorModel(S({ modelBySession: { s1: 'deepseek-v4-flash' } }), 's1'), 'claude-sonnet-4-6',
    '① 残留 pin 不属于当前 provider → 回落全局(而不是显示一个列表里根本没有的值)');
  // 历史值(paneSessions/selectedSession 的 model)同样要过关
  assert.equal(resolveSelectorModel(S({ selectedSession: { sessionId: 's1', model: 'mimo-v2.5-pro' } }), 's1'),
    'claude-sonnet-4-6', '① 历史值同样受白名单约束');
}

// ── ② 不许误杀:官方下的 claude-* 与 CLI 别名 ────────────────────────
// availableModels 只是 settings env + 别名枚举,不是完整目录 —— 误杀会让"选了 opus
// 实际显示 sonnet",正是发送路径注释里记过的老账。
{
  for (const m of ['claude-opus-4-8', 'claude-opus-5', 'claude-haiku-4-5-20251001']) {
    assert.equal(resolveSelectorModel(S({ modelBySession: { s1: m } }), 's1'), m,
      `② 官方下 ${m} 不在 available 里也必须放行`);
  }
  assert.equal(resolveSelectorModel(S({ modelBySession: { s1: 'opus' } }), 's1'), 'opus', '② 别名在 available 里,照常');
}

// ── ③ 不许误杀:列表未加载(启动瞬间)一律放行 ─────────────────────────
{
  assert.equal(resolveSelectorModel(S({ availableModels: [], customModels: [], modelBySession: { s1: 'deepseek-v4-flash' } }), 's1'),
    'deepseek-v4-flash', '③ 两个列表都空 = 尚未加载,不校验(否则启动瞬间徽章会闪)');
}

// ── ④ 不许误杀:用户手填的自定义模型 id ──────────────────────────────
{
  const st = S({ currentProvider: { providerHint: 'deepseek' }, availableModels: [{ id: 'deepseek-v4-pro' }],
    customModels: ['my-private-model'], currentModel: 'deepseek-v4-pro', modelBySession: { s1: 'my-private-model' } });
  assert.equal(resolveSelectorModel(st, 's1'), 'my-private-model', '④ customModels 里的手填 id 必须放行');
}

// ── ⑤ [1m] 逻辑不受影响(比对剥后缀,输出仍带后缀)───────────────────
{
  assert.equal(resolveSelectorModel(S({ modelBySession: { s1: 'claude-opus-4-8' }, context1mBySession: { s1: true } }), 's1'),
    'claude-opus-4-8[1m]', '⑤ 放行的模型照常拼 [1m]');
  // 全局值必须与 pin 的裸 id 不同,否则"误杀→回落全局→补 [1m]"的输出与正确答案一模一样,
  // 断言分辨不了(判官变异实测:比对不剥 [1m] 时这条仍绿)。
  const st = S({ currentProvider: { providerHint: 'deepseek' },
    availableModels: [{ id: 'deepseek-v4-pro' }, { id: 'other-model' }],
    currentModel: 'other-model', modelBySession: { s1: 'deepseek-v4-pro[1m]' }, context1mBySession: { s1: true } });
  assert.equal(resolveSelectorModel(st, 's1'), 'deepseek-v4-pro[1m]',
    '⑤ 带 [1m] 的 pin 按裸 id 比对,不被误杀(全局值刻意取不同值,使误杀可分辨)');
}

// ── ⑥ 第三方 provider 下自家模型照常显示(没把功能修没)──────────────
{
  const st = S({ currentProvider: { providerHint: 'deepseek' }, availableModels: [{ id: 'deepseek-v4-flash' }],
    currentModel: 'deepseek-v4-flash', modelBySession: { s1: 'deepseek-v4-flash' } });
  assert.equal(resolveSelectorModel(st, 's1'), 'deepseek-v4-flash', '⑥ 第三方下自家模型正常');
  // 反向:第三方 provider 下,claude-* 不再享受官方豁免
  assert.equal(resolveSelectorModel(S({ ...st, modelBySession: { s1: 'claude-opus-5' } }), 's1'), 'deepseek-v4-flash',
    '⑥ 非官方 provider 下 claude-* 不豁免(那是官方专属兜底)');
}

// ── ⑦ currentModel 无条件信任:校验失败时兜底不落空 ──────────────────
{
  const st = S({ currentModel: 'some-model-not-in-list', modelBySession: { s1: 'deepseek-v4-flash' } });
  assert.equal(resolveSelectorModel(st, 's1'), 'some-model-not-in-list',
    '⑦ 全局值是服务端按 settings.json 解析的,不参与校验(否则徽章会空)');
}

// ── ⑧ 发送路径回归:抽共用判据后行为逐字不变 ─────────────────────────
{
  const base = { availableModels: [{ id: 'claude-sonnet-4-6' }], customModels: [], officialAnthropic: true };
  assert.equal(resolveSendModel({ pin: 'deepseek-v4-flash', hist: null, globalModel: 'claude-sonnet-4-6', ...base }),
    'claude-sonnet-4-6', '⑧ 陈旧 pin 被跳过,回落全局');
  assert.equal(resolveSendModel({ pin: 'claude-opus-5', hist: null, globalModel: 'claude-sonnet-4-6', ...base }),
    'claude-opus-5', '⑧ 官方 claude-* 豁免');
  assert.equal(resolveSendModel({ pin: 'x', hist: 'y', globalModel: 'z', availableModels: [], customModels: [] }),
    'x', '⑧ 两列表空时的早退分支逐字保留');
  assert.equal(resolveSendModel({ pin: 'a', hist: 'b', globalModel: 'c', ...base }), null,
    '⑧ 全都不在白名单 → null(不传 --model,让 CLI 用默认)');
}

// ── ⑨ 判据本身的边界 ───────────────────────────────────────────────
{
  const g = makeProviderModelGuard({ availableModels: [{ id: 'a' }], customModels: [], officialAnthropic: false });
  assert.equal(g(''), false, '⑨ 空串不算命中');
  assert.equal(g(null), false, '⑨ null 不算命中');
  assert.equal(g(undefined), false, '⑨ undefined 不算命中');
  const g2 = makeProviderModelGuard({ availableModels: null, customModels: undefined, officialAnthropic: false });
  assert.equal(g2('anything'), true, '⑨ 非数组入参按"未加载"处理,放行');
}

// ── ⑩ r16-1 判官必修①:"实时拉取"来的模型必须先登记成自定义模型再选中 ──────
// fetchedRows 的构造条件就是"既不在 available 也不在 custom"(SessionSelectors.jsx
// fetchedRows / App.jsx 手机端同构),所以它天然在白名单外。若点击时只 selectModel
// 不 addCustomModel,这个 pin 显示侧会被 guard 拒(徽章点了不动)、发送侧白名单也会
// 丢掉它(老代码是"显示 X 实发 Y"的静默错发)。两个点击点必须与自定义输入框同写法。
{
  const sel = readFileSync(new URL('../../client/src/components/SessionSelectors.jsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(sel, /fetchedRows\.map\(\(m\) => \(\s*\n\s*<button key=\{`f-\$\{m\.id\}`\} onClick=\{\(\) => \{ useStore\.getState\(\)\.addCustomModel\(m\.id\); selectModel\(m\.id\); \}\}/,
    '⑩ 桌面"实时拉取"行:先 addCustomModel 再 selectModel');
  assert.match(app, /onClick=\{\(\) => \{ useStore\.getState\(\)\.addCustomModel\(m\.id\); pick\(m\.id\); \}\}/,
    '⑩ 手机端"实时拉取"行:同款');
  // 行为侧依据:登记进 customModels 后,该 id 就能过白名单
  const before = resolveSelectorModel(S({ currentProvider: { providerHint: 'deepseek' },
    availableModels: [{ id: 'deepseek-v4-pro' }], currentModel: 'deepseek-v4-pro',
    modelBySession: { s1: 'deepseek-v4-turbo' } }), 's1');
  assert.equal(before, 'deepseek-v4-pro', '⑩ 未登记的实时拉取模型会被拒(这正是必须 addCustomModel 的原因)');
  const after = resolveSelectorModel(S({ currentProvider: { providerHint: 'deepseek' },
    availableModels: [{ id: 'deepseek-v4-pro' }], customModels: ['deepseek-v4-turbo'],
    currentModel: 'deepseek-v4-pro', modelBySession: { s1: 'deepseek-v4-turbo' } }), 's1');
  assert.equal(after, 'deepseek-v4-turbo', '⑩ 登记后正常显示');
}

// ── ⑪ r16-1 判官指出的启动窗口误杀 ────────────────────────────────────
// guard 自带的"未加载"判据是【两个列表都空】,而 customModels 从 localStorage 同步读出、
// 开机即非空 —— 只要用户加过一个自定义模型,开机那段白名单里就只有那一个 id,第三方
// 用户的徽章会闪一下全局默认。显示侧门槛因此放宽成"availableModels 空就整段跳过"。
{
  const st = S({ availableModels: [], customModels: ['my-model'], currentProvider: { providerHint: 'deepseek' },
    currentModel: 'deepseek-v4-pro', modelBySession: { s1: 'deepseek-v4-flash' } });
  assert.equal(resolveSelectorModel(st, 's1'), 'deepseek-v4-flash',
    '⑪ available 未加载但 custom 非空时,显示侧不得校验(否则开机闪值)');
  // 发送侧不放宽:它宁可回落也不能把不存在的模型发上去
  assert.equal(resolveSendModel({ pin: 'deepseek-v4-flash', hist: null, globalModel: 'my-model',
    availableModels: [], customModels: ['my-model'], officialAnthropic: false }), 'my-model',
    '⑪ 发送侧维持严格语义(同样入参下回落到白名单内的值)');
}

// ── ⑫ 判官指出的覆盖缺口:paneSessions 那条历史取值链 ───────────────────
{
  const st = S({ currentProvider: { providerHint: 'anthropic' },
    paneSessions: [{ sessionId: 'p1', model: 'deepseek-v4-flash' }],
    modelBySession: {}, currentModel: 'claude-sonnet-4-6' });
  assert.equal(resolveSelectorModel(st, 'p1'), 'claude-sonnet-4-6',
    '⑫ paneSessions 里的旧 provider 历史模型同样被拒(此前该链路零覆盖)');
  const ok = S({ currentProvider: { providerHint: 'anthropic' },
    paneSessions: [{ sessionId: 'p1', model: 'claude-opus-4-8' }], modelBySession: {} });
  assert.equal(resolveSelectorModel(ok, 'p1'), 'claude-opus-4-8', '⑫ 合法历史模型照常显示');
  // providerEpoch 门控与新校验叠加:epoch 非 0 时历史整段不采信,与校验无交互
  const ep = S({ providerEpoch: 1, paneSessions: [{ sessionId: 'p1', model: 'claude-opus-4-8' }], modelBySession: {} });
  assert.equal(resolveSelectorModel(ep, 'p1'), 'claude-sonnet-4-6', '⑫ epoch 门控优先,历史不采信');
}

console.log('check-selector-model-guard: all passed');
