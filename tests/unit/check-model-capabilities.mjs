#!/usr/bin/env node
// 单测:r11-⑩ 思考档位目录法预填 —— 家族目录匹配矩阵 + 预填条目形态 +
// applyCatalogPrefill 的"用户声明永不覆盖"语义 + normalize source 透传 + 接线守卫。
// 变异哨兵(实际验证过红):lookupModelCapabilities 恒返回 null(目录命中仍 null)→ t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MODEL_CAPABILITY_CATALOG, EFFORT_IDS,
  lookupModelCapabilities, catalogPrefillEntry, applyCatalogPrefill,
} from '../../server/utils/model-capabilities.js';

const { normalizeProviderModels, denormalizeProviderModels, sanitizeModelMeta, EFFORT_LEVEL_IDS } =
  await import('../../server/routes/settings.js');

// t1 匹配矩阵:家族命中/优先级/目录外 null
{
  assert.equal(lookupModelCapabilities('deepseek-chat').reasoning, false, 't1: deepseek-chat 非思考');
  assert.equal(lookupModelCapabilities('deepseek-v4.1-chat').reasoning, false, 't1: v4 chat 端非思考');
  assert.equal(lookupModelCapabilities('deepseek-reasoner').reasoning, true, 't1: reasoner 思考');
  assert.equal(lookupModelCapabilities('deepseek-v4').reasoning, true, 't1: v4 系思考');
  assert.equal(lookupModelCapabilities('kimi-k2-thinking').reasoning, true, 't1: k2-thinking 特例先于 k2');
  assert.equal(lookupModelCapabilities('kimi-k2-0905-preview').reasoning, false, 't1: k2 instruct 非思考');
  assert.equal(lookupModelCapabilities('kimi-k3').reasoning, true, 't1: k3 系思考');
  assert.equal(lookupModelCapabilities('glm-5.2').reasoning, true, 't1: GLM 系思考');
  assert.equal(lookupModelCapabilities('qwen3-235b-a22b-instruct-2507').reasoning, false, 't1: qwen instruct 非思考');
  assert.equal(lookupModelCapabilities('qwen2.5-72b').reasoning, false, 't1: qwen2 代际非思考');
  assert.equal(lookupModelCapabilities('qwen3-max').reasoning, true, 't1: qwen3 系思考');
  assert.equal(lookupModelCapabilities('minimax-m2').reasoning, true, 't1: MiniMax 思考');
  assert.equal(lookupModelCapabilities('mimo-v2.5-pro').reasoning, true, 't1: MiMo 思考');
  assert.deepEqual(lookupModelCapabilities('gpt-5.2').efforts, ['minimal', 'low', 'medium', 'high'], 't1: gpt-5 系离散档');
  assert.deepEqual(lookupModelCapabilities('gpt-5.2-codex').efforts, ['low', 'medium', 'high', 'xhigh'], 't1: codex 系档位(先于 gpt-5 通配)');
  assert.deepEqual(lookupModelCapabilities('o3-mini').efforts, ['low', 'medium', 'high'], 't1: o 系三档');
  assert.equal(lookupModelCapabilities('gpt-4o').reasoning, false, 't1: gpt-4 系非思考');
  assert.equal(lookupModelCapabilities('llama-3.3-70b'), null, 't1: 目录外返回 null');
  assert.equal(lookupModelCapabilities('claude-opus-4-8'), null, 't1: claude 系不进目录(全默认)');
  assert.equal(lookupModelCapabilities(''), null, 't1: 空串 null');
  assert.equal(lookupModelCapabilities(null), null, 't1: 非字符串 null');
}

// t2 预填条目形态:reasoning:false / efforts 子集带 source:'catalog';全默认与目录外 null
{
  assert.deepEqual(catalogPrefillEntry('deepseek-chat'), { reasoning: false, source: 'catalog' }, 't2: 非思考预填');
  assert.deepEqual(catalogPrefillEntry('gpt-5.2'), { efforts: ['minimal', 'low', 'medium', 'high'], source: 'catalog' }, 't2: 档位子集预填');
  assert.equal(catalogPrefillEntry('deepseek-v4'), null, 't2: 思考+全档=全默认不产条目');
  assert.equal(catalogPrefillEntry('llama-3.3-70b'), null, 't2: 目录外不预填');
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
  const models = ['deepseek-chat', 'gpt-5.2', 'kimi-k3', 'llama-3.3-70b'];
  // 空 meta → 目录预填两条(kimi-k3 全默认、llama 目录外均无条目)
  const filled = applyCatalogPrefill(models, null);
  assert.deepEqual(Object.keys(filled).sort(), ['deepseek-chat', 'gpt-5.2'], 't3: 未声明模型自动预填');
  assert.equal(filled['deepseek-chat'].source, 'catalog', 't3: 预填标 source:catalog');
  // 用户声明(显式 source:'user')永不覆盖 —— 即使与目录冲突
  const userMeta = { 'deepseek-chat': { source: 'user' }, 'gpt-5.2': { efforts: ['max'], source: 'user' } };
  const merged = applyCatalogPrefill(models, userMeta);
  assert.deepEqual(merged['deepseek-chat'], { source: 'user' }, 't3: 用户"回到全默认"墓碑压住目录');
  assert.deepEqual(merged['gpt-5.2'], { efforts: ['max'], source: 'user' }, 't3: 用户档位声明不被目录覆盖');
  // 历史无 source 条目(r10-9 存量)视同用户声明
  const legacy = applyCatalogPrefill(['deepseek-chat'], { 'deepseek-chat': { efforts: ['low'] } });
  assert.deepEqual(legacy['deepseek-chat'], { efforts: ['low'] }, 't3: 历史无 source 条目不被覆盖');
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
  assert.equal((settings.match(/applyCatalogPrefill\(/g) || []).length, 2, 't5: POST+PUT 两个保存路径调用点(不多不少)');
  assert.match(settings, /applyCatalogPrefill\(cleanModels, sanitizeModelMeta\(req\.body\?\.modelMeta, cleanModels\)\)/, 't5: POST 创建路径预填');
  assert.match(settings, /applyCatalogPrefill\(nextModels, list\[idx\]\.modelMeta \|\| null\)/, 't5: PUT 编辑路径预填(两分支统一)');
  assert.match(settings, /catalogPrefillEntry\(mid\)/, 't5: fetch-models 附 catalogMeta');
  const editor = readFileSync(new URL('../../client/src/components/ProviderThinkingEditor.jsx', import.meta.url), 'utf8');
  assert.match(editor, /目录预填，可修改/, 't5: 编辑器显示预填来源小字');
  assert.match(editor, /entry\.source === 'catalog'/, 't5: 小字仅 catalog 条目显示');
  assert.equal((editor.match(/source: 'user'/g) || []).length >= 4, true, 't5: 编辑器全部写入点盖 source:user(addRow/setThink×2/toggleEffort)');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /d\.catalogMeta/, 't5: 表单拉取列表合并目录预填');
  assert.match(app, /if \(!next\[mid\]\) next\[mid\] = pre;/, 't5: 前端合并只填未声明模型(已声明不动)');
}

console.log('check-model-capabilities: all passed');
