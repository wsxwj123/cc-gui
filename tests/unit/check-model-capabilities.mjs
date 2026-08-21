#!/usr/bin/env node
// 单测:r11-⑩ 思考档位目录法预填 —— 家族目录匹配矩阵 + 预填条目形态 +
// applyCatalogPrefill 的"用户声明永不覆盖"语义 + normalize source 透传 + 接线守卫。
// r15 追加:命名空间前缀(OpenRouter 形态)剥离复查 + activeProviderModelMeta 读侧兜底。
// r15-2 追加:目录纠错(撤 kimi-k2 / deepseek-chat 两条错行)、
//   GET /api/providers 下发 modelMeta(修编辑器保存清空用户声明)、
//   ChatInput 能力表变化时的回落放宽、以及判官点名的 5 个测试缺口(t9-t12)。
// r15-3 追加:撤 gpt-5-chat 正则行(t1)、畸形数据表不抛(t11)、生成脚本补丁层(t14)、
//   ChatInput 三条漏判路径(t13)、编辑器 catalog 行折叠+墓碑删除(t15)、
//   GET→save()→PUT 真往返(t16,驱动真 express router,隔离 HOME)。
// 变异哨兵(实际验证过红):
//  - lookupModelCapabilities 恒返回 null(目录命中仍 null)→ t1 红;
//  - 删掉 id.split('/') 复查分支 → t6 红(openai/gpt-5.6-luna family undefined ≠ gpt-5);
//  - activeProviderModelMeta 退回 `p?.modelMeta || null` → t5 红(调用点 2≠4),
//    且 t8 行为侧实测返回 null(存量 provider 拿不到任何预填);
//  - GET /api/providers 的 modelMeta 退回 `p.modelMeta || null` → t5 红 + t16 红(往返丢声明);
//  - 恢复 kimi-k2 / deepseek-chat / gpt-5-chat 错行 → t1 红;
//  - THINKING_TABLE 守卫退回 `typeof t.byId === 'object'` → t11 红(byId:null 时抛);
//  - ChatInput deps 去掉 effort / 早退退回 `prev.permKey !== permKey` return → t13 红;
//  - 编辑器 rows 退回 Object.keys(value) 或 removeRow 退回纯 delete → t15 红;
//  - 生成脚本删掉 MANUAL_OVERRIDES 应用行 → t14 红(产物断言当轮仍绿,故必须查脚本)。
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MODEL_CAPABILITY_CATALOG, EFFORT_IDS,
  lookupModelCapabilities, catalogPrefillEntry, applyCatalogPrefill,
} from '../../server/utils/model-capabilities.js';

const { normalizeProviderModels, denormalizeProviderModels, sanitizeModelMeta, EFFORT_LEVEL_IDS } =
  await import('../../server/routes/settings.js');

// t1 匹配矩阵:家族命中/优先级/目录外 null
{
  // r15-2 纠错:deepseek-chat 行已撤(deepseek-chat-v3.1 实为混合思考,被原行判死)。
  // 判错成 reasoning:false = UI 锁灰 + 发送静默摘档(可见功能损失);判错成 null = 全档
  // (维持现状,无害)。两个方向代价不对称,故拿不准一律退回 null。
  assert.equal(lookupModelCapabilities('deepseek-chat'), null, 't1: deepseek-chat 已退出目录(全档)');
  assert.equal(lookupModelCapabilities('deepseek-chat-v3.1'), null, 't1: chat-v3.1 不再被误判非思考');
  assert.equal(lookupModelCapabilities('deepseek-v4.1-chat').reasoning, true, 't1: v4 系 chat 端归 deepseek-v4 家族(思考)');
  assert.equal(lookupModelCapabilities('deepseek-reasoner').reasoning, true, 't1: reasoner 思考');
  assert.equal(lookupModelCapabilities('deepseek-v4').reasoning, true, 't1: v4 系思考');
  assert.equal(lookupModelCapabilities('kimi-k2-thinking').reasoning, true, 't1: k2-thinking 特例仍命中');
  // r15-2 纠错:kimi-k2 行已撤(k2.5/k2.6/k2.7-code 全支持思考,正则区分不了代际)。
  assert.equal(lookupModelCapabilities('kimi-k2-0905-preview'), null, 't1: k2 老代际退回全档(正则判不了代际)');
  assert.equal(lookupModelCapabilities('kimi-k2.6'), null, 't1: k2.6 不再被误判非思考');
  assert.equal(lookupModelCapabilities('kimi-k3').reasoning, true, 't1: k3 系思考');
  assert.equal(lookupModelCapabilities('glm-5.2').reasoning, true, 't1: GLM 系思考');
  assert.equal(lookupModelCapabilities('qwen3-235b-a22b-instruct-2507').reasoning, false, 't1: qwen instruct 非思考');
  assert.equal(lookupModelCapabilities('qwen2.5-72b').reasoning, false, 't1: qwen2 代际非思考');
  assert.equal(lookupModelCapabilities('qwen3-max').reasoning, true, 't1: qwen3 系思考');
  assert.equal(lookupModelCapabilities('minimax-m2').reasoning, true, 't1: MiniMax 思考');
  assert.equal(lookupModelCapabilities('mimo-v2.5-pro').reasoning, true, 't1: MiMo 思考');
  assert.deepEqual(lookupModelCapabilities('gpt-5.2').efforts, ['low', 'medium', 'high'], 't1: gpt-5 系离散档(r15-2 去 minimal)');
  assert.deepEqual(lookupModelCapabilities('gpt-5.2-codex').efforts, ['low', 'medium', 'high', 'xhigh'], 't1: codex 系档位(先于 gpt-5 通配)');
  assert.deepEqual(lookupModelCapabilities('o3-mini').efforts, ['low', 'medium', 'high'], 't1: o 系三档');
  assert.equal(lookupModelCapabilities('gpt-4o').reasoning, false, 't1: gpt-4 系非思考');
  // r15-3 撤销 `gpt-5-chat` 行(r15-2 加的):与实测表对撞时,唯一"正则判死而表说能思考"
  // 的冲突就是它(gpt-5.2-chat-latest 实测四档)。正则只对【表外模型】生效 —— 那正是最容易
  // 判错的场景,方向还是本轮明令避免的"判死"。撤行后表外 chat 变体退回 gpt-5 家族(全档
  // 方向,无害),表内的照旧由表判死。
  const chat5 = lookupModelCapabilities('gpt-5-chat-latest');
  assert.equal(chat5?.family, 'gpt-5', 't1(r15-3): chat 专行已撤,正则退回 gpt-5 家族');
  assert.equal(chat5.reasoning, true, 't1(r15-3): 正则不再把 chat 变体判死(判死方向危险)');
  assert.equal(lookupModelCapabilities('gpt-5-chat-latest', 'openai').reasoning, false,
    't1(r15-3): 表内的 chat 变体照旧判非思考(带协议查表)');
  assert.deepEqual(lookupModelCapabilities('gpt-5.2-chat-latest', 'openai').efforts, ['low', 'medium', 'high', 'xhigh'],
    't1(r15-3): 撤行后 gpt-5.2-chat-latest 拿回实测四档(原正则会判它不能思考)');
  assert.equal(lookupModelCapabilities('gpt-5.2-codex').family, 'gpt-codex', 't1: codex 家族优先级不变');
  assert.equal(lookupModelCapabilities('llama-3.3-70b'), null, 't1: 目录外返回 null');
  assert.equal(lookupModelCapabilities('claude-opus-4-8'), null, 't1: claude 系不进目录(全默认)');
  assert.equal(lookupModelCapabilities(''), null, 't1: 空串 null');
  assert.equal(lookupModelCapabilities(null), null, 't1: 非字符串 null');
}

// t2 预填条目形态:reasoning:false / efforts 子集带 source:'catalog';全默认与目录外 null
{
  assert.deepEqual(catalogPrefillEntry('gpt-4o'), { reasoning: false, source: 'catalog' }, 't2: 非思考预填');
  assert.deepEqual(catalogPrefillEntry('gpt-5.2'), { efforts: ['low', 'medium', 'high'], source: 'catalog' }, 't2: 档位子集预填');
  assert.equal(catalogPrefillEntry('deepseek-v4'), null, 't2: 思考+全档=全默认不产条目');
  assert.equal(catalogPrefillEntry('llama-3.3-70b'), null, 't2: 目录外不预填');
  assert.equal(catalogPrefillEntry('deepseek-chat'), null, 't2(r15-2): 撤行后 deepseek-chat 不再产非思考条目');
  assert.equal(catalogPrefillEntry('moonshotai/kimi-k2.6'), null, 't2(r15-2): 撤行后 k2.6 不再产非思考条目');
  // 目录卫生:efforts 全部 ∈ EFFORT_IDS,且与 settings.js 的档位全集一致
  assert.deepEqual(EFFORT_IDS, EFFORT_LEVEL_IDS, 't2: 档位全集与 settings.js 同一口径');
  for (const row of MODEL_CAPABILITY_CATALOG) {
    for (const e of row.caps.efforts || []) {
      assert.ok(EFFORT_IDS.includes(e), `t2: 目录档位 ${e}(${row.family})∈ 全集`);
    }
  }
}

// t3 applyCatalogPrefill:用户声明(source:'user'/历史无 source)永不覆盖;
//    catalog 条目跟随最新目录;悬空 catalog 条目剔除
{
  const models = ['gpt-4o', 'gpt-5.2', 'kimi-k3', 'llama-3.3-70b'];
  // 空 meta → 目录预填两条(kimi-k3 全默认、llama 目录外均无条目)
  const filled = applyCatalogPrefill(models, null);
  assert.deepEqual(Object.keys(filled).sort(), ['gpt-4o', 'gpt-5.2'], 't3: 未声明模型自动预填');
  assert.equal(filled['gpt-4o'].source, 'catalog', 't3: 预填标 source:catalog');
  // 用户声明(显式 source:'user')永不覆盖 —— 即使与目录冲突
  const userMeta = { 'gpt-4o': { source: 'user' }, 'gpt-5.2': { efforts: ['max'], source: 'user' } };
  const merged = applyCatalogPrefill(models, userMeta);
  assert.deepEqual(merged['gpt-4o'], { source: 'user' }, 't3: 用户"回到全默认"墓碑压住目录');
  assert.deepEqual(merged['gpt-5.2'], { efforts: ['max'], source: 'user' }, 't3: 用户档位声明不被目录覆盖');
  // 历史无 source 条目(r10-9 存量)视同用户声明
  const legacy = applyCatalogPrefill(['gpt-4o'], { 'gpt-4o': { efforts: ['low'] } });
  assert.deepEqual(legacy['gpt-4o'], { efforts: ['low'] }, 't3: 历史无 source 条目不被覆盖');
  // catalog 旧条目归机器所有:目录不再命中(如模型改名后)→ 撤掉
  const stale = applyCatalogPrefill(['llama-3.3-70b'], { 'llama-3.3-70b': { reasoning: false, source: 'catalog' } });
  assert.equal(stale, null, 't3: 目录外的旧 catalog 条目撤销(一条不剩返回 null)');
  // 不在 models 内的 catalog 条目剔除;用户条目留给调用方既有防悬空逻辑
  const dangling = applyCatalogPrefill(['gpt-5.2'], { 'gone-model': { reasoning: false, source: 'catalog' } });
  assert.deepEqual(Object.keys(dangling), ['gpt-5.2'], 't3: 悬空 catalog 条目剔除');
}

// t4 normalize/denormalize:source 透传 + 用户墓碑条目({source:'user'})保留
{
  const { meta } = normalizeProviderModels([
    { id: 'a', reasoning: false, source: 'catalog' },
    { id: 'b', efforts: ['low'], source: 'user' },
    { id: 'c', source: 'user' },            // 用户"全默认"墓碑:仅 source 也保留
    { id: 'd', source: 'bogus' },           // 非法 source 丢弃 → 条目空 → 不留
  ]);
  assert.deepEqual(meta, {
    a: { reasoning: false, source: 'catalog' },
    b: { efforts: ['low'], source: 'user' },
    c: { source: 'user' },
  }, 't4: source 透传+墓碑保留+非法 source 丢弃');
  const wire = denormalizeProviderModels(['a', 'b', 'c'], meta);
  assert.deepEqual(wire[0], { id: 'a', reasoning: false, source: 'catalog' }, 't4: 落盘形态带 source');
  // sanitize(客户端 body)同样透传 source
  const mm = sanitizeModelMeta({ x: { efforts: ['low'], source: 'user' } }, ['x']);
  assert.deepEqual(mm, { x: { efforts: ['low'], source: 'user' } }, 't4: sanitize 透传 source');
}

// t5 接线守卫:保存路径(POST/PUT)与 fetch-models 均过目录;编辑器标注与 user 打标
{
  const settings = readFileSync(new URL('../../server/routes/settings.js', import.meta.url), 'utf8');
  assert.equal((settings.match(/applyCatalogPrefill\(/g) || []).length, 4,
    't5: POST+PUT 两个保存路径 + activeProviderModelMeta 读侧兜底 + GET /api/providers 下发,共四个调用点(不多不少)');
  assert.match(settings, /applyCatalogPrefill\(cleanModels, sanitizeModelMeta\(req\.body\?\.modelMeta, cleanModels\), type\)/, 't5: POST 创建路径预填(带协议)');
  assert.match(settings, /applyCatalogPrefill\(nextModels, list\[idx\]\.modelMeta \|\| null, type\)/, 't5: PUT 编辑路径预填(两分支统一,带协议)');
  assert.match(settings, /applyCatalogPrefill\(p\.models, p\.modelMeta \|\| null, p\.type\)/, 't5: activeProviderModelMeta 读侧兜底(存量 provider 没被 POST/PUT 预填过)');
  assert.match(settings, /catalogPrefillEntry\(mid, type\)/, 't5: fetch-models 附 catalogMeta(带协议)');
  // r15-2【数据丢失必修】GET /api/providers 必须下发 modelMeta:编辑器读的正是这个接口,
  // 不下发 → 表单恒开成空 → 保存时恒发 {} → PUT 把用户手配的思考声明整片删掉。
  assert.equal((settings.match(/modelMeta: applyCatalogPrefill\(p\.models, p\.modelMeta \|\| null, p\.type\),/g) || []).length, 1,
    't5: GET /api/providers 的 customProviders 映射下发预填版 modelMeta');
  // 两个 GET(/providers 与 /custom-providers)都得有 modelMeta,否则换个入口又丢一次
  assert.equal((settings.match(/^\s*modelMeta:/gm) || []).length, 2, 't5: 两个 provider 列表接口都下发 modelMeta');
  const editor = readFileSync(new URL('../../client/src/components/ProviderThinkingEditor.jsx', import.meta.url), 'utf8');
  // r15-3:catalog 条目不再逐行渲染(会把表单淹掉),改成一行摘要 —— 详见 t15。
  assert.match(editor, /已按模型目录自动判定 \{catalogCount\} 个模型的思考能力/, 't5: 编辑器显示目录判定摘要(用户仍知道目录判了哪些)');
  assert.equal((editor.match(/source: 'user'/g) || []).length >= 4, true, 't5: 编辑器全部写入点盖 source:user(addRow/setThink×2/toggleEffort)');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /d\.catalogMeta/, 't5: 表单拉取列表合并目录预填');
  assert.match(app, /if \(!next\[mid\]\) next\[mid\] = pre;/, 't5: 前端合并只填未声明模型(已声明不动)');
}

// t6 r15:命名空间前缀(OpenRouter 形态)剥离复查 —— 目录正则 ^ 锚定,不剥前缀命中 0
{
  const luna = lookupModelCapabilities('openai/gpt-5.6-luna');
  assert.equal(luna?.family, 'gpt-5', 't6: openai/ 前缀剥离后进 gpt-5 家族');
  assert.deepEqual(luna.efforts, ['low', 'medium', 'high'], 't6: 前缀模型拿到 gpt-5 家族档位');
  assert.deepEqual(
    lookupModelCapabilities('openai/gpt-5.5:batch')?.efforts, ['low', 'medium', 'high'],
    't6: :batch/:free 后缀不影响匹配',
  );
  assert.equal(lookupModelCapabilities('openai/gpt-5.2-codex')?.family, 'gpt-codex', 't6: 前缀不打乱家族优先级(codex 先于 gpt-5)');
  const k2t = lookupModelCapabilities('moonshotai/kimi-k2-thinking');
  assert.equal(k2t?.reasoning, true, 't6: kimi-k2-thinking 思考');
  assert.equal(k2t.efforts, null, 't6: kimi-k2-thinking 无离散档=全档');
  assert.equal(lookupModelCapabilities('moonshotai/kimi-k2.6'), null, 't6(r15-2): k2.6 撤行后正则不再命中');
  assert.equal(lookupModelCapabilities('deepseek/deepseek-chat-v3.1'), null, 't6(r15-2): chat-v3.1 撤行后正则不再命中');
  assert.equal(lookupModelCapabilities('anthropic/claude-opus-4.8'), null, 't6: claude 不在目录 → null(官方模型全档)');
  assert.equal(lookupModelCapabilities('~openai/gpt-latest'), null, 't6: gpt-latest 不得误命中 gpt-5/gpt-4');
  assert.equal(lookupModelCapabilities('meta/llama-3.3-70b'), null, 't6: 剥前缀后仍目录外 → null');
  assert.equal(lookupModelCapabilities('openai/'), null, 't6: 空尾段不炸且返回 null');
  assert.equal(lookupModelCapabilities('openai/gpt-5-chat-latest')?.family, 'gpt-5', 't6(r15-3): 前缀 chat 变体剥前缀后落 gpt-5 家族(chat 专行已撤)');
  // 复查产物与直查同构(含 family)
  assert.deepEqual(lookupModelCapabilities('openai/gpt-5.6-luna'), lookupModelCapabilities('gpt-5.6-luna'), 't6: 复查结果与直查同构');
  // 裸 id 既有行为逐条不变(t1 矩阵重放,防"剥前缀"顺手改坏无前缀分支)
  for (const [id, family] of [
    ['deepseek-reasoner', 'deepseek-reasoner'], ['deepseek-v4', 'deepseek-v4'],
    ['kimi-k2-thinking', 'kimi-thinking'], ['kimi-k3', 'kimi-k3'],
    ['glm-5.2', 'glm'], ['qwen3-235b-a22b-instruct-2507', 'qwen-instruct'], ['qwen2.5-72b', 'qwen2'],
    ['qwen3-max', 'qwen'], ['minimax-m2', 'minimax'], ['mimo-v2.5-pro', 'mimo'],
    ['gpt-5.2-codex', 'gpt-codex'], ['gpt-5.2', 'gpt-5'], ['o3-mini', 'o-series'], ['gpt-4o', 'gpt-4'],
    ['gpt-5-chat-latest', 'gpt-5'],
  ]) {
    assert.equal(lookupModelCapabilities(id)?.family, family, `t6: 裸 id ${id} 家族不变`);
  }
}

// t7 r15:存量零 meta 场景 —— 老 provider 的 modelMeta 全空,读侧兜底应就地产出 catalog 条目
{
  const filled = applyCatalogPrefill(
    ['openai/gpt-5.6-luna', 'openai/gpt-4o', 'anthropic/claude-opus-4.8'], null,
  );
  assert.deepEqual(
    Object.keys(filled).sort(), ['openai/gpt-4o', 'openai/gpt-5.6-luna'],
    't7: 零 meta 存量 provider 恰好预填 2 条(claude 目录外不产条目)',
  );
  assert.deepEqual(filled['openai/gpt-5.6-luna'], { efforts: ['low', 'medium', 'high'], source: 'catalog' }, 't7: 档位子集条目');
  assert.deepEqual(filled['openai/gpt-4o'], { reasoning: false, source: 'catalog' }, 't7: 非思考条目');
}

// t8 r15:activeProviderModelMeta 读侧兜底端到端(隔离 HOME 子进程,零真机数据、不写盘)
//   r15-2 扩充:数据表 + 协议维度 + 用户声明压得住目录 + 与 /api/model 同 key 空间守卫。
const SETTINGS_URL = new URL('../../server/routes/settings.js', import.meta.url).href;
const RESOLVER_URL = new URL('../../server/services/model-resolver.js', import.meta.url).href;
// 子进程里同时取 activeProviderModelMeta() 与 getAvailableModels(),两者正是
// GET /api/model 同一响应里的 modelMeta 与 available —— 一次跑完才能对账 key 空间。
const CHILD = `Promise.all([import(${JSON.stringify(SETTINGS_URL)}), import(${JSON.stringify(RESOLVER_URL)})])`
  + '.then(async ([s, r]) => { const meta = await s.activeProviderModelMeta();'
  + ' const av = await r.getAvailableModels();'
  + ' process.stdout.write(JSON.stringify({ meta, available: av.models.map((m) => m.id) })); });';
const runIsolated = (home) => JSON.parse(execFileSync(process.execPath, ['-e', CHILD], {
  env: {
    ...process.env, HOME: home, USERPROFILE: home,
    // 显式钉死:宿主 shell 可能带着自己的 ANTHROPIC_BASE_URL(server 只在 boot 时 strip),
    // 不钉死则 provider 判定随开发机环境漂,available 的内容不可复现。
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788',
  },
  encoding: 'utf8',
}));

{
  const home = mkdtempSync(join(tmpdir(), 'cgui-r15-'));
  const guiDir = join(home, '.claude-gui');
  mkdirSync(guiDir, { recursive: true });
  writeFileSync(join(guiDir, 'active-provider.json'), JSON.stringify({ id: 'p1' }));
  // 存量落盘形态:models 基本是裸字符串(从没被预填过),外加一条**用户手动声明**。
  // type:'openai' = 该 provider 的协议,查表按它取 byProto 分支。
  const models = [
    'deepseek/deepseek-v4-pro',   // byProto:openai=[high,xhigh]、anthropic=[low,medium,high]
    'deepseek-v4-flash',          // byId 共用:两协议都得 [high,max]
    'openai/gpt-4o',              // 剥前缀后 byId 命中 reasoning:false
    'anthropic/claude-opus-5',    // 表内外都无 → 不产条目(维持全档)
    // 用户手动声明:目录/数据表说什么都不许覆盖(这是 r15 敢做读侧兜底的唯一安全依据)
    { id: 'openai/gpt-5.6-luna', efforts: ['max'], source: 'user' },
  ];
  const wire = [{ id: 'p1', name: 'OpenRouter', type: 'openai', models }];
  writeFileSync(join(guiDir, 'custom-providers.json'), JSON.stringify(wire));
  // /api/model 的 available 来源:openai 协议 provider 的 active marker(见 model-resolver)
  writeFileSync(join(guiDir, 'openai-active.json'), JSON.stringify({
    providerId: 'p1', name: 'OpenRouter', models: models.map((m) => (typeof m === 'string' ? m : m.id)),
  }));
  const { meta, available } = runIsolated(home);
  // 变异 B 下这里曾以 TypeError 崩掉而非干净断言失败 —— 先把形态钉住
  assert.ok(meta && typeof meta === 'object' && !Array.isArray(meta), 't8: 读侧返回对象形态');
  assert.deepEqual(
    Object.keys(meta).sort(),
    ['deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'openai/gpt-4o', 'openai/gpt-5.6-luna'],
    't8: 存量零 meta provider 经 GET 读路径拿到预填(含带前缀模型),全档模型不产条目',
  );
  assert.deepEqual(meta['deepseek/deepseek-v4-pro'], { efforts: ['high', 'xhigh'], source: 'catalog' },
    't8: byProto 按 provider.type=openai 取档');
  assert.deepEqual(meta['deepseek-v4-flash'], { efforts: ['high', 'max'], source: 'catalog' },
    't8: byId 共用条目(anthropic 协议中转能生效的关键)');
  assert.deepEqual(meta['openai/gpt-4o'], { reasoning: false, source: 'catalog' }, 't8: 剥前缀后查表命中非思考');
  assert.equal(meta['anthropic/claude-opus-5'], undefined, 't8: 表内外都无 → 不产条目(维持全档)');
  // ★ 用户声明压得住目录(端到端,不只是纯函数):逐字保留 efforts 与 source
  assert.deepEqual(meta['openai/gpt-5.6-luna'], { efforts: ['max'], source: 'user' },
    't8: 用户手动声明经读侧兜底后逐字不变(数据表/正则都不许覆盖)');
  // ★ key 空间守卫:modelMeta 的 key 必须落在 /api/model 的 available[].id 里,否则前端
  //   effortCapsFor(modelMeta, 当前模型) 永远查不到条目 —— 整套自适应静默失效而单测全绿。
  const availSet = new Set(available);
  for (const k of Object.keys(meta)) {
    assert.ok(availSet.has(k), `t8: modelMeta key「${k}」不在 /api/model 的 available 里(两侧 key 空间漂了)`);
  }
  // 只读:读路径不得回写用户数据
  assert.deepEqual(JSON.parse(readFileSync(join(guiDir, 'custom-providers.json'), 'utf8')), wire, 't8: 读路径零写盘(存量文件逐字不变)');
  rmSync(home, { recursive: true, force: true });
}

// t9 r15-2:activeProviderModelMeta 的 `!p` 分支 —— active id 指向已删/官方 provider
{
  const home = mkdtempSync(join(tmpdir(), 'cgui-r15b-'));
  const guiDir = join(home, '.claude-gui');
  mkdirSync(guiDir, { recursive: true });
  // 激活的是官方 / 已删除的 provider:custom-providers.json 里根本没有这个 id
  writeFileSync(join(guiDir, 'active-provider.json'), JSON.stringify({ id: 'ghost' }));
  writeFileSync(join(guiDir, 'custom-providers.json'), JSON.stringify([{ id: 'p1', name: 'X', type: 'openai', models: ['gpt-4o'] }]));
  const { meta } = runIsolated(home);
  assert.equal(meta, null, 't9: active id 不在 custom providers 里 → null(= 全档,官方模型不被目录染指)');
  rmSync(home, { recursive: true, force: true });
}

// t10 r15-2:数据表匹配矩阵(协议区分 / 共用兜底 / 剥前缀后查表 / 多段 id 边界)
{
  // ① 协议区分:同一 id 两种协议档位不同(byProto)
  assert.deepEqual(lookupModelCapabilities('deepseek/deepseek-v4-pro', 'openai').efforts, ['high', 'xhigh'], 't10: byProto openai 口径');
  assert.deepEqual(lookupModelCapabilities('deepseek/deepseek-v4-pro', 'anthropic').efforts, ['low', 'medium', 'high'], 't10: byProto anthropic 口径');
  // r15-4:全档改为显式写五档条目(原先靠"缺键/null"表达,导致"表说全档"与"表里没有"
  // 不可区分 → openai-proxy 里 claude-opus-5 等 58 个全档模型的 max 被降成 xhigh)。
  // 两条语义要同时成立:①lookup 能读出五档全集(可表达);②catalogPrefillEntry 仍返回
  // null(全选=等于不声明),即存储侧 modelMeta 零变化。
  const lunaOa = lookupModelCapabilities('openai/gpt-5.6-luna', 'openai');
  assert.deepEqual(lunaOa.efforts, ['low', 'medium', 'high', 'xhigh', 'max'], 't10: 全档在表里可表达为五档全集');
  assert.equal(catalogPrefillEntry('openai/gpt-5.6-luna', 'openai'), null, 't10: 全档仍不产 modelMeta 条目(存储侧零变化)');
  assert.deepEqual(lookupModelCapabilities('claude-opus-5', 'anthropic').efforts, ['low', 'medium', 'high', 'xhigh', 'max'],
    't10: 主力全档模型(claude-opus-5)进表 —— 此前被生成脚本丢弃,openai-proxy 里 max 被降成 xhigh');
  assert.equal(catalogPrefillEntry('claude-opus-5', 'anthropic'), null, 't10: 同上,存储侧仍不产条目');
  assert.deepEqual(lookupModelCapabilities('openai/gpt-5.6-luna', 'anthropic').efforts, ['low', 'medium', 'high', 'xhigh'], 't10: 同 id 的 anthropic 键仍生效');
  // ② 共用兜底:未进 byProto 的模型两协议同结论(用户的 anthropic 协议中转靠这条生效)
  for (const proto of ['openai', 'anthropic']) {
    assert.deepEqual(lookupModelCapabilities('deepseek-v4-flash', proto).efforts, ['high', 'max'], `t10: byId 共用(${proto})`);
  }
  // ③ 剥前缀后再查表
  assert.equal(lookupModelCapabilities('openai/gpt-4o', 'openai').reasoning, false, 't10: 剥前缀后 byId 命中 reasoning:false');
  // ④ 多段 id 边界:只取最后一段。a/b/gpt-5 命中;openai/gpt-5/deprecated 的最后一段是
  //    deprecated → 不命中(不做逐段扫描,否则任意中间段都能污染判定)。
  assert.deepEqual(lookupModelCapabilities('a/b/gpt-5', 'openai').efforts, ['low', 'medium', 'high'], 't10: 多段 id 取最后一段命中');
  assert.equal(lookupModelCapabilities('openai/gpt-5/deprecated', 'openai'), null, 't10: 最后一段不是模型名 → 不命中');
  // ⑤ 不传 protocol = 跳过数据表、只走家族正则(向后兼容,现有调用点与纯正则单测不受影响)
  assert.equal(lookupModelCapabilities('gpt-5.2').family, 'gpt-5', 't10: 不传协议走正则');
  assert.equal(lookupModelCapabilities('gpt-5.2', 'openai').family, 'table', 't10: 传协议优先查表');
  assert.deepEqual(lookupModelCapabilities('gpt-5.2', 'openai').efforts, ['low', 'medium', 'high', 'xhigh'], 't10: 表值压过正则值');
  // ⑥ 表命中同样标 source:'catalog'(机器所有,用户声明永远压过它)
  assert.equal(catalogPrefillEntry('deepseek-v4-flash', 'openai').source, 'catalog', 't10: 表条目标 catalog');
  const userWins = applyCatalogPrefill(['deepseek-v4-flash'], { 'deepseek-v4-flash': { efforts: ['max'], source: 'user' } }, 'openai');
  assert.deepEqual(userWins['deepseek-v4-flash'], { efforts: ['max'], source: 'user' }, 't10: 用户声明压过数据表');
}

// t11 r15-2:数据表缺失/损坏 fail-safe —— 必须静默落回家族正则,绝不能抛(否则 /api/model 500)
{
  // 把模块单文件拷到临时目录:它的 ../data/thinking-levels.json 随之指向不存在的路径。
  const dir = mkdtempSync(join(tmpdir(), 'cgui-r15c-'));
  mkdirSync(join(dir, 'utils'), { recursive: true });
  const src = new URL('../../server/utils/model-capabilities.js', import.meta.url);
  writeFileSync(join(dir, 'utils', 'model-capabilities.js'), readFileSync(src, 'utf8'));
  const modUrl = new URL(`file://${join(dir, 'utils', 'model-capabilities.js')}`).href;
  const out = execFileSync(process.execPath, ['-e',
    `import(${JSON.stringify(modUrl)}).then((m) => process.stdout.write(JSON.stringify({`
    + " regex: m.lookupModelCapabilities('gpt-4o', 'openai'),"
    + " tableOnly: m.lookupModelCapabilities('kimi-k2.6', 'openai'),"
    + " prefill: m.catalogPrefillEntry('gpt-5.2', 'openai') })));",
  ], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.regex?.family, 'gpt-4', 't11: 表缺失时仍走家族正则(不抛)');
  assert.equal(r.tableOnly, null, 't11: 只在表里、正则没有的模型(kimi-k2.6)退回 null = 全档,而不是崩');
  assert.deepEqual(r.prefill, { efforts: ['low', 'medium', 'high'], source: 'catalog' }, 't11: 预填照常产出正则口径');
  // r15-3:畸形表(而非缺失)—— typeof null === 'object',守卫若只看 typeof 就会放行,
  // 随后查表抛(GET /api/providers 无兜底 → 500 = provider 列表整个打不开)。
  // 两种畸形各跑一遍:byId/byProto 为 null;byProto 的值不是对象(`in` 操作符会抛)。
  for (const [label, table] of [
    ['byId/byProto 为 null', { byId: null, byProto: null }],
    ['byProto 值非对象', { byId: {}, byProto: { 'gpt-5.2': 'junk' } }],
  ]) {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'thinking-levels.json'), JSON.stringify(table));
    const o = execFileSync(process.execPath, ['-e',
      `import(${JSON.stringify(modUrl)}).then((m) => process.stdout.write(JSON.stringify({`
      + " byProto: m.lookupModelCapabilities('gpt-5.2', 'openai'),"
      + " byId: m.lookupModelCapabilities('gpt-4o', 'openai') })));",
    ], { encoding: 'utf8' });
    const v = JSON.parse(o);
    assert.equal(v.byProto?.family, 'gpt-5', `t11: 畸形表(${label})不抛,落回家族正则`);
    assert.equal(v.byId?.reasoning, false, `t11: 畸形表(${label})另一条查询同样不抛`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// t12 r15-2:五档对齐 —— EFFORT_ORDER / EFFORT_LEVEL_IDS / VALID_EFFORTS / EFFORT_LEVELS
// 四处必须同一集合。依据:本机 CLI 2.1.235 `claude --help` 的 --effort 只接受
// low/medium/high/xhigh/max(无 minimal、无 none)。漂了就会出现"算得出、传不过去"。
{
  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
  const { EFFORT_ORDER } = await import('../../client/src/utils/effortCaps.js');
  assert.deepEqual(EFFORT_ORDER, FIVE, 't12: client EFFORT_ORDER 五档');
  assert.deepEqual(EFFORT_LEVEL_IDS, FIVE, 't12: server EFFORT_LEVEL_IDS 五档');
  assert.deepEqual(EFFORT_IDS, FIVE, 't12: model-capabilities EFFORT_IDS 五档');
  const chat = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  const vm = chat.match(/const VALID_EFFORTS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(vm, 't12: chat.js VALID_EFFORTS 可解析');
  assert.deepEqual(vm[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean), FIVE, 't12: chat.js VALID_EFFORTS 五档');
  const ci = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
  const lm = ci.match(/export const EFFORT_LEVELS = \[([\s\S]*?)\];/);
  assert.ok(lm, 't12: ChatInput EFFORT_LEVELS 可解析');
  const ids = [...lm[1].matchAll(/id:\s*'([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  assert.deepEqual(ids, FIVE, "t12: ChatInput EFFORT_LEVELS 五档(不含 '' 默认档)");
}

// t13 r15-2:ChatInput 回落早退放宽的接线守卫 —— 能力表变化那一刻必须能触发。
// 原早退是"模型没变就 return",于是存量会话升级后:effort 存着 xhigh、模型没动、
// 新能力表判定只到 high → 按钮仍显示「极高」而 App.jsx 发送前已把它静默摘空。
// r26-F3 换锚:解算本体抽成 effortCaps.js 的 useEffortFallback(手机端共用),
// 钉子同步移到钩子源码 + ChatInput 的挂载接线。
{
  const ci = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
  const ec = readFileSync(new URL('../../client/src/utils/effortCaps.js', import.meta.url), 'utf8');
  assert.match(ci, /useEffortFallback\(\{/, 't13: EffortSelector 挂载共用回落钩子(r26-F3 抽取)');
  assert.match(ci, /memoryKey: effortMemKey/, 't13: per-model 记忆键注入钩子(F6 键形)');
  assert.match(ec, /if \(!modelChanged && effortAllowed\(caps, effort \|\| ''\)\) return;/,
    't13: 早退放宽 —— 模型没变但当前档已不合法时仍跑回落');
  // r15-3:上一版只堵住三条触发路径里的一条。permKey 变化(切窗格 / draft→真 sid 迁移)
  // 原本直接 return,跨设备同步(applyRemoteSessionSync 改写 effortBySession)则三个旧
  // deps 全不动、effect 根本不跑 —— 这两类下按钮照样显示「极高」而发送前被静默摘空。
  assert.match(ec, /\}, \[permKey, bareModelId, meta, effort, memoryKey\]\);/,
    't13: deps 含 effort —— 覆盖"档位被外部改成非法值"(跨设备同步);meta=能力表,memoryKey=记忆键');
  assert.match(ec, /const paneChanged = prev\.permKey !== permKey;/,
    't13: permKey 变化拆成 paneChanged(只挡记忆,不再挡回落)');
  assert.match(ec, /const modelChanged = !paneChanged && !!prev\.model && prev\.model !== bareModelId;/,
    't13: 换窗格/会话时两次 model 不可比,不算换模型(记忆不参与)');
  assert.doesNotMatch(ec.slice(ec.indexOf('const lastModelRef'), ec.indexOf('}, [permKey, bareModelId, meta, effort, memoryKey]')),
    /prev\.permKey !== permKey\) return;/, 't13: 切窗格不再整段早退(否则新窗格的非法档没人拉回)');
  assert.match(ec, /if \(modelChanged && memoryKey\) \{ try \{ remembered = localStorage\.getItem/,
    't13: per-model 记忆只在真换模型时参与(能力表/同步路径只做"拉回合法档")');
  assert.match(ci, /setEffort: \(id\) => useStore\.getState\(\)\.setEffortFor\(permKey, id\)/,
    't13: 写入只针对当前 permKey(不动别的会话)');
  // 行为侧:升级瞬间的解算结果(xhigh 不在 gpt-5 家族档位里 → 回落最高可用档 high)
  const { effortCapsFor, effortAllowed, resolveEffortOnModelChange } = await import('../../client/src/utils/effortCaps.js');
  const caps = effortCapsFor({ 'gpt-5.2': catalogPrefillEntry('gpt-5.2') }, 'gpt-5.2');
  assert.equal(effortAllowed(caps, 'xhigh'), false, 't13: 升级后 xhigh 对该模型已非法(早退条件成立)');
  assert.deepEqual(resolveEffortOnModelChange(caps, 'xhigh', null), { effort: 'high', changed: true, reason: 'fallback' },
    't13: 回落到最高可用档并给 toast(reason=fallback)');
  // effort 进 deps 的收敛依据:回落后的新档必合法 → 下一轮 effect 在早退那行 return(不循环)。
  const fallen = resolveEffortOnModelChange(caps, 'xhigh', null).effort;
  assert.equal(effortAllowed(caps, fallen), true, 't13: 回落结果合法 → effect 第二次即早退(effort 进 deps 不会自激)');
}

// t14 r15-2:手工补丁层 —— pi-ai 快照之后发布的模型(依据各家官方 API 文档,见生成脚本
// 头部的来源注释)。缺条目本身无害(落正则=全档),但有官方依据的必须准;这里同时钉住
// "补丁层不被 pi-ai 数据覆盖"这条生成语义(重跑生成脚本后仍应成立)。
{
  assert.deepEqual(catalogPrefillEntry('glm-5.3', 'openai'), { efforts: ['low', 'high', 'max'], source: 'catalog' },
    't14: glm-5.3 三档(Z.AI 文档:only supports max, high, low)');
  assert.deepEqual(catalogPrefillEntry('z-ai/glm-5.3', 'openai'), { efforts: ['low', 'high', 'max'], source: 'catalog' },
    't14: glm-5.3 的 OpenRouter 形态同判定');
  assert.deepEqual(catalogPrefillEntry('qwen3.8-max', 'openai'), { efforts: ['low', 'medium', 'xhigh'], source: 'catalog' },
    't14: qwen3.8-max 三档(QwenCloud 文档:low/medium/xhigh,默认 xhigh)');
  // 补丁层不该误伤 pi-ai 已有的相邻型号
  assert.deepEqual(catalogPrefillEntry('glm-5.2', 'openai'), { efforts: ['low', 'medium', 'high', 'max'], source: 'catalog' },
    't14: glm-5.2 仍取 pi-ai 口径,未被 5.3 补丁波及');
  // r15-3:上面全是【产物】断言 —— 谁删掉生成脚本里的补丁层而不重跑,这些照样绿,
  // 直到下次刷新 pi-ai 快照时补丁静默消失。故同时钉住脚本本身。
  const gen = readFileSync(new URL('../../scripts/gen-thinking-levels.mjs', import.meta.url), 'utf8');
  assert.match(gen, /const MANUAL_OVERRIDES = \{/, 't14: 生成脚本保留手工补丁层');
  for (const id of ['glm-5.3', 'z-ai/glm-5.3', 'qwen3.8-max', 'qwen3.8-max-preview', 'qwen/qwen3.8-max']) {
    assert.ok(gen.includes(`'${id}':`), `t14: 补丁层含 ${id}`);
  }
  // 应用顺序:必须在 byId/byProto 组装完之后覆盖,且清掉同 id 的 byProto(否则协议分支截胡)
  assert.match(gen, /for \(const \[id, e\] of Object\.entries\(MANUAL_OVERRIDES\)\) \{ byId\[id\] = e; delete byProto\[id\]; \}/,
    't14: 补丁层在组装后覆盖 byId 并清同 id 的 byProto(重跑生成脚本仍生效)');
  assert.ok(gen.indexOf('Object.entries(MANUAL_OVERRIDES)') < gen.indexOf('fs.writeFileSync(OUT'),
    't14: 补丁应用早于写盘');
}

// t15 r15-3:编辑器 —— GET 开始下发预填后引入的两处用户可见回归
//   ① 「移除声明」对 catalog 行静默失效(纯 delete 被服务端预填立刻补回,点了等于没点);
//   ② 表单被目录行淹没(用户的 OpenRouter provider 364 个模型 → 几百行 × 5 复选框)。
{
  const editor = readFileSync(new URL('../../client/src/components/ProviderThinkingEditor.jsx', import.meta.url), 'utf8');
  // ② 只渲染用户声明的行;catalog 折叠成一行只读摘要
  assert.match(editor, /Object\.entries\(value \|\| \{\}\)\.filter\(\(\[, e\]\) => e\?\.source !== 'catalog'\)/,
    't15: rows 只取用户声明条目(catalog 不逐行渲染)');
  assert.doesNotMatch(editor, /const rows = Object\.keys\(value/, 't15: 不再 rows = Object.keys(value)(会把几百条 catalog 全渲染)');
  assert.match(editor, /const catalogCount = /, 't15: 统计 catalog 条目数');
  assert.match(editor, /\{catalogCount > 0 && \(/, 't15: catalog 折叠成摘要行(用户仍能知道目录判了多少个)');
  // ① 移除按钮:catalog 条目写 source:'user' 墓碑,用户自己的行仍直接删
  assert.match(editor, /if \(value\?\.\[id\]\?\.source === 'catalog'\) \{/, 't15: removeRow 区分 catalog 条目');
  assert.match(editor, /onChange\(\{ \.\.\.value, \[id\]: \{ source: 'user' \} \}\);\n\s+return;/, 't15: catalog 行写墓碑而非 delete');
  assert.match(editor, /const next = \{ \.\.\.value \};\n\s+delete next\[id\];/, 't15: 用户声明的行仍走 delete');
  // 目录已判定的模型仍在"添加声明"候选里,且添加时以目录判定为初值(不重置成全档)
  assert.match(editor, /onChange\(\{ \.\.\.value, \[id\]: \{ \.\.\.\(value\?\.\[id\] \|\| \{\}\), source: 'user' \} \}\);/,
    't15: addRow 以目录判定为初值转成用户声明');
  // 非阻断④:五档对齐后 EFFORT_LABELS 的 minimal 是死键
  assert.doesNotMatch(editor, /minimal:/, 't15: EFFORT_LABELS 无 minimal 死键');
  // 行为侧(①的真正依据):纯 delete 压不住服务端预填,墓碑压得住 —— 走保存路径的真函数
  const models = ['gpt-4o'];
  const afterDelete = applyCatalogPrefill(models, sanitizeModelMeta({}, models), 'openai');
  assert.deepEqual(afterDelete['gpt-4o'], { reasoning: false, source: 'catalog' },
    't15: 纯 delete 后保存 → 目录预填立刻补回(所以删除按钮必须写墓碑)');
  const afterTombstone = applyCatalogPrefill(models, sanitizeModelMeta({ 'gpt-4o': { source: 'user' } }, models), 'openai');
  assert.deepEqual(afterTombstone['gpt-4o'], { source: 'user' }, 't15: 墓碑压住目录 = 真的回到全默认');
}

// t16 r15-3:P0-b(GET /api/providers 下发 modelMeta)的真往返 —— 此前只有 t5 的源码文本
// 断言,谁把 GET 换成裸 p.modelMeta,行为已变而测试仍绿。这里驱动**真 express router**
// (不起 http server:router 本身就是 (req,res,next) 函数),隔离 HOME、真读写盘:
//   GET /providers → 照客户端 save() 组 body → PUT /custom-providers/:id → 读盘核对。
{
  const home = mkdtempSync(join(tmpdir(), 'cgui-r15d-'));
  try {
    const guiDir = join(home, '.claude-gui');
    mkdirSync(guiDir, { recursive: true });
    // 存量落盘形态:两条用户手配声明(一条限档、一条"全默认"墓碑)+ 若干裸模型 id。
    const wire = [{
      id: 'p1', name: 'OR', type: 'openai', baseURL: 'http://localhost:31999/v1', apiKey: 'k',
      models: [
        { id: 'openai/gpt-5.6-luna', efforts: ['max'], source: 'user' },
        { id: 'openai/gpt-4o', source: 'user' },   // 用户墓碑:压住目录的 reasoning:false
        'deepseek-v4-flash',                        // 目录/表判定 → catalog 条目
        'anthropic/claude-opus-5',                  // 表内外都无 → 无条目
      ],
    }];
    writeFileSync(join(guiDir, 'custom-providers.json'), JSON.stringify(wire));
    const SETTINGS_HREF = new URL('../../server/routes/settings.js', import.meta.url).href;
    const CHILD16 = `import(${JSON.stringify(SETTINGS_HREF)}).then(async (s) => {
      const router = s.default;
      const call = (method, url, body) => new Promise((resolve, reject) => {
        const req = { method, url, body, headers: {}, query: {} };
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); } };
        router(req, res, (err) => reject(err || new Error('unhandled ' + method + ' ' + url)));
      });
      const got = await call('GET', '/providers');
      const p = got.body.customProviders[0];
      // 客户端 save() 的组包方式(App.jsx):modelMeta 就是表单状态,而表单状态直接来自
      // 本接口下发的 modelMeta(setModelCaps(editing.modelMeta ? {...} : {}))。
      const put = await call('PUT', '/custom-providers/p1', {
        name: p.name, type: p.type, baseURL: p.baseURL, models: p.models,
        defaultModel: null, tierModels: {}, contextWindow: null, modelPrices: null,
        modelMeta: p.modelMeta || {},
      });
      process.stdout.write(JSON.stringify({ get: p.modelMeta, putStatus: put.status, putBody: put.body }));
    });`;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', CHILD16], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' },
      encoding: 'utf8',
    }));
    assert.equal(out.putStatus, 200, `t16: PUT 成功(${JSON.stringify(out.putBody)})`);
    // GET 侧:用户声明逐字下发(编辑器据此渲染),catalog 判定一并可见
    assert.deepEqual(out.get['openai/gpt-5.6-luna'], { efforts: ['max'], source: 'user' }, 't16: GET 下发用户限档声明');
    assert.deepEqual(out.get['openai/gpt-4o'], { source: 'user' }, 't16: GET 下发用户墓碑(未被目录预填顶掉)');
    assert.deepEqual(out.get['deepseek-v4-flash'], { efforts: ['high', 'max'], source: 'catalog' }, 't16: GET 下发目录判定');
    // 落盘侧:一次"什么都没改的保存"之后,用户声明必须逐字不变(P0-b 修的就是这里)
    const disk = JSON.parse(readFileSync(join(guiDir, 'custom-providers.json'), 'utf8'))[0];
    const byId = Object.fromEntries(disk.models.map((m) => (typeof m === 'string' ? [m, {}] : [m.id, m])));
    assert.deepEqual(byId['openai/gpt-5.6-luna'], { id: 'openai/gpt-5.6-luna', efforts: ['max'], source: 'user' },
      't16: 往返后用户限档声明逐字不变');
    assert.deepEqual(byId['openai/gpt-4o'], { id: 'openai/gpt-4o', source: 'user' }, 't16: 往返后用户墓碑仍在(否则目录判定会复活)');
    assert.deepEqual(byId['deepseek-v4-flash'], { id: 'deepseek-v4-flash', efforts: ['high', 'max'], source: 'catalog' },
      't16: catalog 条目正常落盘(机器所有,下轮可被目录刷新)');
    assert.deepEqual(byId['anthropic/claude-opus-5'], {}, 't16: 无判定的模型仍是裸字符串');
  } finally {
    rmSync(home, { recursive: true, force: true });  // r15-3b:断言失败也要清,否则 $TMPDIR 积残留
  }
}

// t17 r15-3b:判官复审的收尾三条 —— ①摘要计数算式(算错会静默上线,原先无断言);
// ②手机端档位页必须与桌面同一份 caps 判据(此前六档全列不过滤,而跑回落 effect 的
// 桌面 EffortSelector 在手机上根本不渲染 → 手机上选了不支持的档,发送时被静默摘空,
// 正是本轮要根治的"界面说的≠实际发的");③移除按钮文案不得再说"回到全默认"
// (真实行为是回到目录自动判定,对目录判死的模型点完会锁灰,不是全档)。
{
  const ed = readFileSync(new URL('../../client/src/components/ProviderThinkingEditor.jsx', import.meta.url), 'utf8');
  assert.match(ed, /const catalogCount = Object\.keys\(value \|\| \{\}\)\.length - rows\.length;/,
    't17: 摘要计数 = 全部条目 - 用户声明行(算错则摘要数字撒谎)');
  assert.match(ed, /移除声明\(回到目录自动判定\)/, 't17: 移除按钮文案与真实行为一致');
  assert.doesNotMatch(ed, /移除声明\(回到全默认\)/, 't17: 旧的误导文案已撤');

  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const mob = app.slice(app.indexOf('function MobileEffortPage'), app.indexOf('function MobileEffortPage') + 2400);
  assert.match(mob, /const caps = effortCapsFor\(modelEffortMeta, selModel\);/, 't17: 手机端取当前模型 caps');
  assert.match(mob, /const levels = EFFORT_LEVELS\.filter\(\(e\) => e\.id === '' \|\| effortAllowed\(caps, e\.id\)\);/,
    't17: 手机端按 caps 过滤档位(与桌面 visibleLevels 同口径)');
  assert.match(mob, /\{levels\.map\(\(e\) => \{/, 't17: 手机端渲染过滤后的 levels 而非 EFFORT_LEVELS 全集');
  assert.match(mob, /const locked = caps\.reasoning === false;/, 't17: 手机端有锁死态');
  assert.match(mob, /当前模型不支持思考/, 't17: 锁死时给出与桌面一致的说明');
}

console.log('check-model-capabilities: all passed');
