#!/usr/bin/env node
// 开发侧单测(r105):变体 id 逐级回退 + DeepSeek 三档补丁 + 生成脚本的并集合并。
// 变异哨兵(逐条实跑验证过红):
//  - variantBaseIds 去掉 maxLevels 限制 → d1 红(出现第 4 级候选);
//  - lookup 去掉家族比对(matchCatalog(cand).family !== fam 那行)→ d3 红
//    (gpt-5-codexx-a 跨家族落到 gpt-5 的表条目);
//  - lookup 把变体回退排到"剥前缀"之后 → d2 红(网关 id 拿到直连口径);
//  - catalogPrefillEntry 不带 viaId / 仍标 source:'catalog' → d5 红;
//  - applyCatalogPrefill 的所有权判据退回 `!== 'catalog'` → d5 红(变体条目被当用户声明,不再刷新);
//  - 生成脚本的合并层删掉 → d7 红(旧表独有 id 丢失 / 上游判死被接受);
//  - lookup 去掉 `hit?.reasoning === false → break` → d8 红(kimi turbo 跟着基名被判死);
//  - 家族比对退回 matchCatalog(key)(不剥命名空间)→ d8 红(codex/qwen 网关 id 跨家族回退);
//  - 提示文案改回带"表内"的写法 → d8 红。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  variantBaseIds, lookupModelCapabilities, catalogPrefillEntry, applyCatalogPrefill, isCatalogSource,
} from '../../server/utils/model-capabilities.js';
import { effortSourceNote } from '../../client/src/utils/effortCaps.js';

// d1 回退候选:逐级去尾、≤3 级、剥到只剩首段即停
{
  assert.deepEqual(variantBaseIds('deepseek-v4-flash-vision-exp'),
    ['deepseek-v4-flash-vision', 'deepseek-v4-flash', 'deepseek-v4'], 'd1: 逐级去尾');
  assert.deepEqual(variantBaseIds('a-b-c-d-e-f'), ['a-b-c-d-e', 'a-b-c-d', 'a-b-c'], 'd1: 最多 3 级');
  assert.deepEqual(variantBaseIds('gpt-4o'), [], 'd1: 剥完只剩首段 → 无候选');
  assert.deepEqual(variantBaseIds('deepseek'), [], 'd1: 单段无候选');
  assert.deepEqual(variantBaseIds(''), [], 'd1: 空串');
  assert.deepEqual(variantBaseIds(null), [], 'd1: 非字符串');
  assert.deepEqual(variantBaseIds('-leading'), [], 'd1: 前导横线不产生空候选');
  for (const c of variantBaseIds('deepseek-v4-flash-vision-exp')) {
    assert.ok(c.startsWith('deepseek'), 'd1: 候选仍以原 id 首段开头');
  }
}

// d2 命名空间:网关 id 只在同命名空间内回退(网关口径 ≠ 直连口径)
{
  assert.deepEqual(variantBaseIds('deepseek/deepseek-v4-flash-vision-exp'),
    ['deepseek/deepseek-v4-flash-vision', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4'],
    'd2: 命名空间前缀原样保留');
  // 用表里没有的网关变体验回退(vision-exp 的网关形态 pi-ai 0.84.4 已收录 = 精确命中)。
  const gw = lookupModelCapabilities('deepseek/deepseek-v4-flash-nightly', 'openai');
  assert.equal(gw.viaId, 'deepseek/deepseek-v4-flash', 'd2: 回退到同命名空间的基名');
  assert.deepEqual(gw.efforts, ['high', 'xhigh'], 'd2: 拿网关口径(OpenRouter 把 max 重命名为 xhigh)');
  const gwA = lookupModelCapabilities('deepseek/deepseek-v4-flash-nightly', 'anthropic');
  assert.deepEqual(gwA.efforts, ['low', 'medium', 'high'], 'd2: 网关 anthropic 口径');
  assert.notDeepEqual(gw.efforts, lookupModelCapabilities('deepseek-v4-flash', 'openai').efforts,
    'd2: 绝不落到直连口径(网关把 max 重命名成 xhigh、且不透传 low)');
}

// d3 不跨家族 + 表外 id 仍走家族正则
{
  const codex = lookupModelCapabilities('gpt-5-codex-x', 'openai');
  assert.equal(codex.viaId, 'gpt-5-codex', 'd3: 命中即停在同家族的 gpt-5-codex');
  assert.notEqual(codex.viaId, 'gpt-5', 'd3: 不回退到跨家族的 gpt-5');
  // 家族比对本身:gpt-5-codexx-a 的候选是 gpt-5-codexx(表里没有)→ gpt-5(表里有),
  // 没有家族比对就会跨家族落到 gpt-5 的表条目上([low,medium,high],且 viaId='gpt-5')。
  const deep = lookupModelCapabilities('gpt-5-codexx-a', 'openai');
  assert.equal(deep?.family, 'gpt-codex', 'd3: 跨家族即停 → 落家族正则而非 gpt-5 的表条目');
  assert.equal(deep.viaId, undefined, 'd3: 跨家族的候选不算命中');
  assert.deepEqual(deep.efforts, ['low', 'medium', 'high', 'xhigh'], 'd3: 走 codex 家族正则档位');
  assert.equal(lookupModelCapabilities('foo-bar-baz', 'openai'), null, 'd3: 表外且无正则 → null(全档)');
  assert.equal(lookupModelCapabilities('openai/gpt-5/deprecated', 'openai'), null, 'd3: 多段 id 边界不变');
  const noProto = lookupModelCapabilities('deepseek-v4-flash-vision-exp');
  assert.equal(noProto.family, 'deepseek-v4', 'd3: 不传协议 = 不查表(向后兼容),只走家族正则');
  assert.equal(noProto.efforts, null, 'd3: 正则不给档位 = 全档');
}

// d4 三个在售 id:两协议都得 low/high/max(byId,不建 byProto)
{
  for (const proto of ['openai', 'anthropic']) {
    for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']) {
      const hit = lookupModelCapabilities(id, proto);
      assert.deepEqual(hit.efforts, ['low', 'high', 'max'], `d4: ${id} @${proto} 三档`);
      assert.equal(hit.source, undefined, `d4: ${id} 是精确命中,不标 table-variant`);
    }
  }
  const table = JSON.parse(await readFile(new URL('../../server/data/thinking-levels.json', import.meta.url), 'utf8'));
  for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']) {
    assert.ok(!(id in table.byProto), `d4: ${id} 不进 byProto(两协议折算表相同)`);
  }
  // 快照命名(表外)靠回退拿到同一组档位,而不是回落五档
  const snap = lookupModelCapabilities('deepseek-v4-flash-nightly', 'anthropic');
  assert.deepEqual(snap.efforts, ['low', 'high', 'max'], 'd4: 表外变体 id 经回退拿到基名档位');
  assert.equal(snap.viaId, 'deepseek-v4-flash', 'd4: viaId = 命中的基名');
}

// d5 预填条目形态与所有权:table-variant 属机器所有,可刷新、可被用户声明压过
{
  const pre = catalogPrefillEntry('deepseek-v4-flash-nightly', 'openai');
  assert.deepEqual(pre, { efforts: ['low', 'high', 'max'], source: 'table-variant', viaId: 'deepseek-v4-flash' },
    'd5: 预填带 source+viaId');
  assert.ok(isCatalogSource('table-variant') && isCatalogSource('catalog') && !isCatalogSource('user'),
    'd5: 所有权判据');
  const models = ['deepseek-v4-flash-nightly'];
  // 机器条目会被目录刷新(过期的旧值不会粘住)
  const refreshed = applyCatalogPrefill(models, { 'deepseek-v4-flash-nightly': { efforts: ['high'], source: 'table-variant' } }, 'openai');
  assert.deepEqual(refreshed[models[0]].efforts, ['low', 'high', 'max'], 'd5: 变体条目可被刷新');
  // 用户声明仍压过
  const user = applyCatalogPrefill(models, { 'deepseek-v4-flash-nightly': { efforts: ['max'], source: 'user' } }, 'openai');
  assert.deepEqual(user[models[0]], { efforts: ['max'], source: 'user' }, 'd5: 用户声明不被覆盖');
  // 存储往返:normalize 必须透传 source+viaId,否则下轮被当成用户声明
  const { normalizeProviderModels, denormalizeProviderModels } = await import('../../server/routes/settings.js');
  const roundTrip = normalizeProviderModels(denormalizeProviderModels(models, refreshed)).meta;
  assert.deepEqual(roundTrip[models[0]], { efforts: ['low', 'high', 'max'], source: 'table-variant', viaId: 'deepseek-v4-flash' },
    'd5: 落盘往返保住 source+viaId');
}

// d6 前端提示:仅变体命中时给出来源说明
{
  const meta = {
    'deepseek-v4-flash-nightly': { efforts: ['low', 'high', 'max'], source: 'table-variant', viaId: 'deepseek-v4-flash' },
    'deepseek-v4-flash': { efforts: ['low', 'high', 'max'], source: 'catalog' },
  };
  assert.match(effortSourceNote(meta, 'deepseek-v4-flash-nightly'), /deepseek-v4-flash/, 'd6: 变体命中给说明');
  assert.match(effortSourceNote(meta, 'deepseek-v4-flash-nightly[1m]'), /deepseek-v4-flash/, 'd6: 剥 [1m] 后仍命中');
  assert.equal(effortSourceNote(meta, 'deepseek-v4-flash'), '', 'd6: 精确命中不显示说明');
  assert.equal(effortSourceNote(null, 'x'), '', 'd6: 无 meta 不显示');
  assert.equal(effortSourceNote({ x: { source: 'table-variant' } }, 'x'), '', 'd6: 缺 viaId 不显示');
}

// d7 生成脚本合并层:并集 + 拒绝判死降级 + 上游删除的 id 保留(真跑脚本,造迷你 dist)
{
  const dir = mkdtempSync(join(tmpdir(), 'r105-gen-'));
  const dist = join(dir, 'node_modules/@earendil-works/pi-ai/dist');
  mkdirSync(join(dist, 'providers/data'), { recursive: true });
  writeFileSync(join(dist, '../package.json'), JSON.stringify({ version: '9.9.9' }));
  // 迷你 models.js:等级直接写在模型条目里(与真 pi-ai 的 getSupportedThinkingLevels 同签名)
  writeFileSync(join(dist, 'models.js'), 'export const getSupportedThinkingLevels = (m) => m.levels || [];\n');
  writeFileSync(join(dist, 'providers/data/t.json'), JSON.stringify({
    'openai-completions': {
      'keep-me-x': { levels: ['high'] },          // 旧表 [low,high] → 并集应为 [low,high]
      'kill-me-x': { levels: [] },                // 上游判死,旧表有档 → 必须拒绝
      'brand-new-x': { levels: ['low', 'max'] },  // 纯新增
    },
  }));
  const prev = join(dir, 'prev.json');
  writeFileSync(prev, JSON.stringify({
    source: 'old',
    byId: {
      'keep-me-x': { efforts: ['low', 'high'] },
      'kill-me-x': { efforts: ['low', 'medium'] },
      'gone-upstream-x': { efforts: ['high', 'max'] }, // 上游已删 → 必须保留
    },
    byProto: {},
  }));
  const out = join(dir, 'out.json');
  // 路径带空格:.pathname 是 %20 转义的,execFile 会找不到文件 → 必须 fileURLToPath。
  const script = fileURLToPath(new URL('../../scripts/gen-thinking-levels.mjs', import.meta.url));
  const log = execFileSync(process.execPath, [script, dist, out, prev], { encoding: 'utf8' });
  const t = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(t.byId['keep-me-x'], { efforts: ['low', 'high'] }, 'd7: 同 id 取档位并集(减档不生效)');
  assert.deepEqual(t.byId['kill-me-x'], { efforts: ['low', 'medium'] }, 'd7: 拒绝 reasoning:false 判死降级');
  assert.deepEqual(t.byId['gone-upstream-x'], { efforts: ['high', 'max'] }, 'd7: 上游删除的 id 保留');
  assert.deepEqual(t.byId['brand-new-x'], { efforts: ['low', 'max'] }, 'd7: 新增 id 照常进表');
  assert.match(t.source, /9\.9\.9/, 'd7: source 带 pi-ai 版本号');
  assert.match(log, /拒绝的判死降级 1 条/, 'd7: 日志报出被拒绝的降级数');
  assert.match(log, /上游删除但保留 1 个/, 'd7: 日志报出保留数');
  // 手工补丁层仍压在最后一层(重跑生成脚本不丢 DeepSeek 三档)
  assert.deepEqual(t.byId['deepseek-v4-flash'], { efforts: ['low', 'high', 'max'] }, 'd7: 手工补丁不被数据覆盖');
  rmSync(dir, { recursive: true, force: true });
}

// d8 r105b 三处收口:判死不传播 + 命名空间 id 按裸尾段比家族 + 提示文案不提"表"
{
  const table = JSON.parse(await readFile(new URL('../../server/data/thinking-levels.json', import.meta.url), 'utf8'));
  // 哨兵前提:这几条表数据在,下面的断言才有意义(表变了就该重挑样本,而不是静默变空跑)
  assert.deepEqual(table.byId['kimi-k2-0905-preview'], { reasoning: false }, 'd8: 前提—基名在表里判死');
  assert.ok(table.byId['openai/gpt-5.4'], 'd8: 前提—跨家族基名在表里(不然拦不拦都一样)');
  assert.ok(table.byId['qwen/qwen3-235b-a22b'], 'd8: 前提—跨家族基名在表里');
  assert.ok(table.byProto['deepseek/deepseek-v4-pro'], 'd8: 前提—同家族基名在表里');

  // ① 判死不经推断传播:候选命中 reasoning:false 即弃,交回家族正则(此处正则也不认 → null=全档)。
  //    传播的话会得到 {reasoning:false, source:'table-variant'} → UI 锁灰 + 发送静默摘档。
  const kimi = lookupModelCapabilities('kimi-k2-0905-preview-turbo', 'openai');
  assert.equal(kimi, null, 'd8: 变体不因基名判死而被判死(维持全档)');
  assert.equal(lookupModelCapabilities('kimi-k2-0905-preview', 'openai').reasoning, false,
    'd8: 精确命中的判死照常生效(只拦推断,不拦查表)');

  // ② 命名空间 id 的"不跨家族":比家族用裸尾段,否则 family 恒 null 使拦截对含 '/' 的 id 全失效。
  const codexNs = lookupModelCapabilities('openai/gpt-5.4-codex-preview', 'openai');
  assert.equal(codexNs.viaId, undefined, 'd8: 带命名空间的 codex 不回退到 openai/gpt-5.4');
  assert.equal(codexNs.family, 'gpt-codex', 'd8: 落到 codex 家族正则');
  // qwen 网关 instruct 变体:裸尾段家族是 qwen-instruct,而 qwen/qwen3-235b-a22b 的裸尾段是
  // qwen 家族 → 跨家族即停,不该拿它的三档条目。
  // ⚠️ 收尾的 matchCatalog(id) 会让最终 family='qwen' 而非 'qwen-instruct':`^qwen` 这条正则
  //   直接命中了命名空间前缀 "qwen" 本身(matchCatalog(id) 非空就不再取 tail)。这是回退功能
  //   之前就有的既有行为,本轮不动;此处只钉"结论与 r105 之前一致(全档)"。
  const qwenNs = lookupModelCapabilities('qwen/qwen3-235b-a22b-instruct-2601', 'openai');
  assert.equal(qwenNs.viaId, undefined, 'd8: 跨家族候选不算命中');
  assert.equal(qwenNs.efforts, null, 'd8: 恢复改前结论(全档,不是 qwen3-235b-a22b 的三档)');
  assert.equal(qwenNs.family, 'qwen', 'd8: 落家族正则(命名空间前缀命中 ^qwen,既有行为)');
  // 同家族的命名空间回退不能被误伤(裸尾段两侧同为 deepseek-v4)
  const dsNs = lookupModelCapabilities('deepseek/deepseek-v4-pro-turbo', 'openai');
  assert.equal(dsNs.viaId, 'deepseek/deepseek-v4-pro', 'd8: 同家族仍回退到同命名空间基名');
  assert.deepEqual(dsNs.efforts, ['high', 'xhigh'], 'd8: 拿网关 openai 口径');
  assert.deepEqual(lookupModelCapabilities('deepseek/deepseek-v4-pro-turbo', 'anthropic').efforts,
    ['low', 'medium', 'high'], 'd8: 网关 anthropic 口径');

  // ③ 提示文案:点名基名,且不出现对用户无指代物的"表"
  const note = effortSourceNote(
    { 'deepseek-v4-flash-nightly': { source: 'table-variant', viaId: 'deepseek-v4-flash' } },
    'deepseek-v4-flash-nightly');
  assert.match(note, /按\s*deepseek-v4-flash(?![\w-])/, 'd8: 仍点名基名');
  assert.doesNotMatch(note, /表/, 'd8: 文案不提"表"(用户没有这个指代物)');
}

console.log('check-r105-dev-variant-fallback: all passed');
