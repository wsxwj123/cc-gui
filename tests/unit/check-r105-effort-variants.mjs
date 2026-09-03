#!/usr/bin/env node
// r105:思考强度档位 —— ①查表变体回退(id 精确 miss 时去尾段逐级回退)②DeepSeek 直连
// 三个 id 的官方档位进表 ③重生成只增不删 ④前端回退提示文案。
//
// 本文件是【黑盒验收测试】:只依据
//   .devflow/BRIEF-r105-effort-variants.md
//   .devflow/RESEARCH-r105-deepseek-effort.md(主仓)
// 的对外契约写,不看 lookupModelCapabilities 的实现。三类断言:
//   A/B/C 行为契约:真 import 真跑纯函数;
//   D/E   源码与数据锁:JSX 进不了 node、生成脚本无导出,只能读文件/读 JSON 做结构断言;
//   F     既有契约不回归:子进程跑 check-model-capabilities.mjs 看退出码。
//
// 设计要点:纯函数部分用【动态 import + 逐条 try/catch】。静态 import 一个还不存在的
// 导出会在 ESM 链接阶段直接抛错、后面一条断言都跑不到;改前必须"每条各自红",才看得出
// 到底缺哪几件。
//
// 契约要点(逐条对应断言前缀):
//   A 回退规则:精确 miss → 去尾段 ≤3 级回退;不跨命名空间(deepseek/xxx 只落 deepseek/
//     开头的行)、不跨子家族(gpt-5-codex-x 不许落到 gpt-5);命中标 source:'table-variant'
//     + viaId;仍 miss 走家族正则(行为不变)。
//   B 数据:deepseek-v4-flash / -pro / -flash-vision-exp 两协议均 ['low','high','max'],
//     只进 byId 不建 byProto;OpenRouter 网关行(deepseek/…)口径不许被直连补丁覆盖。
//   C 存储语义:用户声明永远压过表/回退;机器条目跟随表刷新;全档变体仍不产条目;
//     预填条目必须能原样穿过存储清洗层(否则 viaId 到不了前端)。
//   D 前端:回退命中时给客观陈述的提示(含"按"+基名);机器来源判定必须认 table-variant。
//   E 生成脚本:补丁写在脚本里(重生成不丢);既有条目不被删/缩档/判死。
//
// Run: node tests/unit/check-r105-effort-variants.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

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

// —— 动态 import:模块炸了/缺导出也要逐条红,而不是整文件起不来 ——
const imp = async (rel) => {
  try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __err: e }; }
};
const CAPS = await imp('../../server/utils/model-capabilities.js');
const EC = await imp('../../client/src/utils/effortCaps.js');
const SETTINGS = await imp('../../server/routes/settings.js');
const pick = (mod, name, file) => {
  if (mod.__err) throw new Error(`${file} 导入失败:${String(mod.__err.message).split('\n')[0]}`);
  if (typeof mod[name] !== 'function') throw new Error(`${file} 缺少导出 ${name}()`);
  return mod[name];
};
const L = (...a) => pick(CAPS, 'lookupModelCapabilities', 'model-capabilities.js')(...a);
const prefill = (...a) => pick(CAPS, 'catalogPrefillEntry', 'model-capabilities.js')(...a);
const applyPrefill = (...a) => pick(CAPS, 'applyCatalogPrefill', 'model-capabilities.js')(...a);

let TABLE = null;
let TABLE_ERR = null;
try { TABLE = JSON.parse(read('server/data/thinking-levels.json')); } catch (e) { TABLE_ERR = e; }
const table = () => {
  if (!TABLE || typeof TABLE !== 'object') throw new Error(`thinking-levels.json 读不出来:${TABLE_ERR?.message || '内容不是对象'}`);
  return TABLE;
};

// DeepSeek 直连三 id 与官方三档(RESEARCH §1/§2:两协议共用同一张折算表)
const THREE = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
const LHM = ['low', 'high', 'max'];

console.log('\n—— A 回退规则(去尾段 ≤3 级 / 不跨命名空间 / 不跨子家族)——');

check('A1 去尾一级:deepseek-v4-flash-vision 按 deepseek-v4-flash 判定,并标 table-variant', () => {
  const r = L('deepseek-v4-flash-vision', 'openai');
  assert.ok(r, '变体 id 应回退命中查表,而不是落回家族正则/null');
  assert.equal(r.source, 'table-variant', "回退命中必须标 source:'table-variant'(前端据此提示)");
  assert.equal(r.viaId, 'deepseek-v4-flash', 'viaId 必须是实际命中的基名');
});

check('A2 去尾两级:deepseek-v4-flash-turbo-preview 一路退到 deepseek-v4-flash', () => {
  const r = L('deepseek-v4-flash-turbo-preview', 'openai');
  assert.equal(r?.viaId, 'deepseek-v4-flash', '中间段 -turbo 不在表里,应继续去尾');
  assert.equal(r?.source, 'table-variant');
});

check('A3 三级边界(允许):deepseek-v4-flash-a-b-c 仍能退到 deepseek-v4-flash', () => {
  const r = L('deepseek-v4-flash-a-b-c', 'openai');
  assert.equal(r?.viaId, 'deepseek-v4-flash', '契约是"最多 3 级",第 3 级必须还算命中');
});

check('A4 四级封顶(拒绝):deepseek-v4-flash-a-b-c-d 不回退,退回家族正则', () => {
  const r = L('deepseek-v4-flash-a-b-c-d', 'openai');
  assert.notEqual(r?.source, 'table-variant', '超过 3 级不许再认表');
  assert.equal(r?.viaId, undefined, '未回退就不该有 viaId');
  assert.notDeepEqual(r?.efforts, LHM, '不许拿到基名的档位');
  assert.equal(r?.reasoning, true, '应落 deepseek-v4 家族正则(思考=true、不限档)');
});

check('A5 不跨子家族:gpt-5-codex-x 落 gpt-5-codex,不许落 gpt-5', () => {
  const r = L('gpt-5-codex-x', 'openai');
  assert.equal(r?.viaId, 'gpt-5-codex', 'codex 变体必须停在最近的 codex 条目上(BRIEF 验收点)');
});

// A5 用 BRIEF 的原例,但它对"家族拦截"其实不敏感(gpt-5-codex 本身在表里,一级就停)。
// A5b 才真的踩到拦截:gpt-5.4-codex 不在表里,再去尾就是 gpt-5.4(另一个家族的行)。
check('A5b 家族拦截真实生效:gpt-5.4-codex-preview 不许借用 gpt-5.4 的表行', () => {
  const r = L('gpt-5.4-codex-preview', 'openai');
  assert.equal(r?.viaId, undefined, 'codex 变体不该回退到非 codex 的 gpt-5.4 条目');
  assert.equal(r?.family, 'gpt-codex', '拦下后应落 codex 家族正则');
});

check('A6 不跨命名空间:deepseek/deepseek-v4-pro-turbo 只落 OpenRouter 行(两协议各自口径)', () => {
  const oa = L('deepseek/deepseek-v4-pro-turbo', 'openai');
  assert.equal(oa?.viaId, 'deepseek/deepseek-v4-pro', '网关 id 不许回退到直连 deepseek-v4-pro');
  assert.deepEqual(oa?.efforts, ['high', 'xhigh'], '网关口径:max 被 OpenRouter 改名成 xhigh');
  const an = L('deepseek/deepseek-v4-pro-turbo', 'anthropic');
  assert.deepEqual(an?.efforts, ['low', 'medium', 'high'], '网关 anthropic 口径与 openai 不同(byProto)');
});

check('A7 网关 vision-exp 不被直连补丁污染(RESEARCH §138 红线)', () => {
  const r = L('deepseek/deepseek-v4-flash-vision-exp', 'openai');
  assert.deepEqual(r?.efforts, ['high', 'xhigh'],
    '带 deepseek/ 前缀的是网关命名,应按 deepseek/deepseek-v4-flash 判定;'
    + '若拿到 [low,high,max] 说明剥前缀后落到了直连条目');
});

check('A8 目录外 id 仍走正则:foo-bar-baz / Unicode id 一律 null', () => {
  assert.equal(L('foo-bar-baz', 'openai'), null, '去尾到 foo 也查不到 → 不许凭空命中');
  assert.equal(L('foo-bar-baz'), null, '不传协议同样是 null');
  assert.equal(L('模型-v4-flash', 'openai'), null, 'Unicode id 不炸也不误命中');
});

check('A9 不传协议 = 不查表(向后兼容:回退只在带协议时生效)', () => {
  const r = L('deepseek-v4-flash-vision');
  assert.notEqual(r?.source, 'table-variant', '不传协议不该走查表回退');
  assert.equal(r?.viaId, undefined);
  assert.equal(r?.family, 'deepseek-v4', '应落家族正则');
});

check('A10 精确命中不标变体:deepseek-v4-flash 无 source/viaId', () => {
  const r = L('deepseek-v4-flash', 'openai');
  assert.ok(r, '基名本身必须在表里');
  assert.notEqual(r.source, 'table-variant', '精确命中不是回退,不能标 table-variant');
  assert.equal(r.viaId, undefined, '精确命中不该带 viaId(否则前端会误报"按 X 判定")');
});

check('A11 畸形/超长入参不抛异常(查表回退不得让 /api/model 500)', () => {
  const weird = [
    ['', 'openai'], [null, 'openai'], [undefined, 'openai'], ['-', 'openai'], ['--', 'openai'],
    ['deepseek/', 'openai'], ['a/b/c/d-e-f-g', 'openai'], [123, 'openai'], [{}, 'openai'],
    ['deepseek-v4-flash-', 'openai'], [Array(300).fill('seg').join('-'), 'openai'],
    ['deepseek-v4-flash', 'bogus-protocol'],
  ];
  for (const [id, proto] of weird) {
    let out;
    assert.doesNotThrow(() => { out = L(id, proto); }, `入参 ${JSON.stringify(id)} 不该抛`);
    assert.ok(out === null || (out && typeof out === 'object'), `入参 ${JSON.stringify(id)} 应返回 null 或对象`);
  }
});

check('A12 幂等 + 无串味:变体查询不得把 viaId 留在基名结果上', () => {
  const v1 = L('deepseek-v4-flash-vision', 'openai');
  const base = L('deepseek-v4-flash', 'openai');
  const v2 = L('deepseek-v4-flash-vision', 'openai');
  assert.deepEqual(v1, v2, '同一查询连查两次结果必须一致');
  assert.equal(base?.viaId, undefined, '先查变体再查基名,基名不该带上 viaId(缓存写串)');
  const base2 = L('deepseek-v4-pro', 'openai');
  const var2 = L('deepseek-v4-pro-turbo', 'openai');
  assert.equal(base2?.viaId, undefined, '先查基名再查变体,基名结果同样干净');
  assert.equal(var2?.viaId, 'deepseek-v4-pro', '顺序反过来变体照样命中');
});

console.log('\n—— B DeepSeek 三个直连 id 的档位(两协议同口径)——');

check('B1 三 id × 两协议:lookup 都拿到 low/high/max(用户报的"仍是五档"就修在这)', () => {
  for (const id of THREE) {
    for (const proto of ['openai', 'anthropic']) {
      const r = L(id, proto);
      assert.deepEqual(r?.efforts, LHM, `${id} @ ${proto} 档位应为 low/high/max`);
      assert.equal(r?.reasoning, true, `${id} @ ${proto} 应判为支持思考`);
    }
  }
});

check('B2 表文件 byId 里三个 id 存在且值正确(直接读 JSON)', () => {
  const t = table();
  for (const id of THREE) {
    assert.ok(t.byId && t.byId[id], `byId 缺 ${id}`);
    assert.deepEqual(t.byId[id].efforts, LHM, `byId['${id}'] 档位应为 low/high/max`);
    assert.notEqual(t.byId[id].reasoning, false, `${id} 不许被判成不支持思考`);
  }
});

check('B3 三个 id 不建 byProto(两协议共用同一张折算表)', () => {
  const t = table();
  for (const id of THREE) {
    assert.equal(t.byProto?.[id], undefined, `${id} 不该进 byProto —— 两个口的合法值相同,建 byProto 等于凭空造协议差异`);
  }
});

check('B4 OpenRouter 网关行口径不被直连补丁覆盖', () => {
  const t = table();
  for (const id of ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro']) {
    assert.deepEqual(t.byProto?.[id]?.openai?.efforts, ['high', 'xhigh'], `${id} openai 口径(网关把 max 叫 xhigh)`);
    assert.deepEqual(t.byProto?.[id]?.anthropic?.efforts, ['low', 'medium', 'high'], `${id} anthropic 口径`);
  }
});

check('B5 前端下拉:三个 id 只剩低/高/极限,中/极高不可选', () => {
  const capsFor = pick(EC, 'effortCapsFor', 'effortCaps.js');
  const allowed = pick(EC, 'effortAllowed', 'effortCaps.js');
  for (const id of THREE) {
    const caps = capsFor({ [id]: prefill(id, 'openai') }, id);
    assert.equal(allowed(caps, 'low'), true, `${id}:低可选`);
    assert.equal(allowed(caps, 'high'), true, `${id}:高可选`);
    assert.equal(allowed(caps, 'max'), true, `${id}:极限可选`);
    assert.equal(allowed(caps, 'medium'), false, `${id}:中不该可选(官方折算成 high)`);
    assert.equal(allowed(caps, 'xhigh'), false, `${id}:极高不该可选(官方折算成 high)`);
  }
});

check('B6 三个 id 的预填条目:档位正确且归机器所有(不是用户声明)', () => {
  for (const id of THREE) {
    const e = prefill(id, 'openai');
    assert.ok(e, `${id} 应产出预填条目(三档 ≠ 全档)`);
    assert.deepEqual(e.efforts, LHM, `${id} 预填档位`);
    assert.notEqual(e.source, 'user', `${id} 预填不许冒充用户声明`);
  }
});

console.log('\n—— C 存储语义(用户声明优先 / 机器条目可刷新 / 全档不产条目)——');

check('C1 用户声明压过回退命中(逐字保留)', () => {
  const id = 'deepseek-v4-flash-vision';
  const out = applyPrefill([id], { [id]: { efforts: ['max'], source: 'user' } }, 'openai');
  assert.deepEqual(out?.[id], { efforts: ['max'], source: 'user' }, '回退命中不许覆盖用户手配的档位');
});

check('C2 机器条目跟随表刷新(回退来源仍归机器所有,不会被当成用户声明冻住)', () => {
  const id = 'deepseek-v4-flash-vision';
  const fresh = prefill(id, 'openai');
  const out = applyPrefill([id], { [id]: { efforts: ['low'], source: 'catalog' } }, 'openai');
  assert.deepEqual(out?.[id], fresh, '陈旧机器条目应被刷新成当前表的判定');
  const out2 = applyPrefill([id], { [id]: { efforts: ['low'], source: 'table-variant', viaId: 'x' } }, 'openai');
  assert.deepEqual(out2?.[id], fresh, "source:'table-variant' 同样归机器所有(否则用户永远改不回)");
});

check('C3 回退到"全档"条目仍不产 modelMeta 条目(存储侧零变化)', () => {
  assert.equal(prefill('claude-opus-5-preview', 'anthropic'), null,
    '基名是五档全集 = 不限制,变体也不该凭空写出一条声明');
});

check('C4 预填条目能原样穿过存储清洗层(否则 viaId 到不了前端)', () => {
  const sanitize = pick(SETTINGS, 'sanitizeModelMeta', 'settings.js');
  const e = prefill('deepseek-v4-flash-vision', 'openai');
  assert.ok(e, '变体应产出预填条目');
  assert.deepEqual(sanitize({ x: e }, ['x']), { x: e }, '清洗层不许吃掉预填条目里的字段');
});

console.log('\n—— D 前端提示文案与来源判定 ——');

const walk = (rel, out = []) => {
  for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = `${rel}/${ent.name}`;
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(ent.name)) out.push(p);
  }
  return out;
};
const CLIENT = walk('client/src').map((p) => [p, read(p)]);
const VIA = '(viaId|via_id|viaModel|variantOf|baseId|base_id|fallbackId)';

check('D1 回退命中有用户可见提示:含"按"+基名变量(客观陈述)', () => {
  const near = new RegExp(`按[\\s\\S]{0,80}?${VIA}|${VIA}[\\s\\S]{0,80}?按`);
  const hits = CLIENT.filter(([, s]) => near.test(s)).map(([p]) => p);
  assert.ok(hits.length >= 1,
    `client/src 里找不到"按 <基名> …"的提示文案。文案锁认这些字段名之一:${VIA};`
    + '换了名字请通知测试代理改锁');
});

check('D2 前端把 table-variant 当机器预填(不得再有裸 === \'catalog\' 比较)', () => {
  // 共享判据自身(isCatalogSource = s => s === 'catalog' || …)那一行除外,它就是正解。
  const strip = (s) => s.split('\n').filter((l) => !/isCatalogSource\s*=/.test(l)).join('\n');
  const bad = CLIENT.filter(([, s]) => /[!=]==\s*['"]catalog['"]/.test(strip(s))).map(([p]) => p);
  assert.deepEqual(bad, [],
    "这些文件仍在裸比 source === 'catalog',回退命中的 'table-variant' 会被误判成用户声明"
    + '(机器条目从此不再刷新):');
});

check('D3 提示文案行为:回退命中点名基名;精确命中/无声明不出提示', () => {
  const note = pick(EC, 'effortSourceNote', 'effortCaps.js');
  const id = 'deepseek-v4-flash-vision';
  const s = String(note({ [id]: prefill(id, 'openai') }, id) || '');
  assert.match(s, /按\s*deepseek-v4-flash(?![\w-])/,
    `文案要点名实际取值的基名(不是变体 id 自己),当前:${JSON.stringify(s)}`);
  const exactId = 'deepseek-v4-flash';
  assert.equal(note({ [exactId]: prefill(exactId, 'openai') }, exactId), '', '精确命中不该出"按 X"提示');
  assert.equal(note({}, 'gpt-5.2'), '', '无声明不出提示');
  assert.equal(note(null, 'gpt-5.2'), '', 'meta 为 null 不炸也不出提示');
});

check('D4 提示文案接线:至少一个组件真的调用它(写了没人显示 = 白写)', () => {
  const users = CLIENT.filter(([p, s]) => !/effortCaps\.js$/.test(p) && /effortSourceNote\s*\(/.test(s)).map(([p]) => p);
  assert.ok(users.length >= 1, '没有任何组件调用 effortSourceNote,用户看不到这条提示');
});

console.log('\n—— E 生成脚本与"只增不删" ——');

check('E1 三个 id 的补丁写在生成脚本里(重跑脚本不会退回上游滞后值)', () => {
  const gen = read('scripts/gen-thinking-levels.mjs');
  const mo = gen.indexOf('MANUAL_OVERRIDES');
  assert.ok(mo > 0, '生成脚本应有 MANUAL_OVERRIDES 手工补丁层');
  for (const id of THREE) {
    const at = gen.indexOf(`'${id}'`);
    assert.ok(at > mo, `${id} 应写进 MANUAL_OVERRIDES(只改 JSON 会被下次重生成抹掉)`);
    assert.match(gen.slice(at, at + 160), /low[\s\S]{0,40}high[\s\S]{0,40}max/,
      `${id} 的补丁值应为 low/high/max`);
  }
});

// 只增不删的具名抽样(不做全表计数金丝雀):这些 id 在 pi-ai 0.84.4 里会消失/降级/判死,
// 见 RESEARCH §5。断言"还在 + 档位只多不少 + 没被判死"。
const SURVIVE = {
  'mimo-v2-pro': ['low', 'medium', 'high'],
  'mimo-v2-flash': ['low', 'medium', 'high'],
  'mimo-v2-omni': ['low', 'medium', 'high'],
  'claude-opus-4': ['low', 'medium', 'high'],
  'claude-opus-4-1': ['low', 'medium', 'high'],
  'gemini-2.5-pro': ['low', 'medium', 'high'],
  'glm-4.5-air': ['low', 'medium', 'high'],
  'glm-5.2': ['low', 'medium', 'high', 'max'],
  'z-ai/glm-5.2': ['low', 'medium', 'high', 'xhigh'],
  'openai/o3-mini-high': ['low', 'medium', 'high'],
  'mistralai/mistral-medium-3-5': ['low', 'medium', 'high'],
  'deepseek/deepseek-v3.2-thinking': ['low', 'medium', 'high'],
  'accounts/fireworks/models/deepseek-v4-pro': ['low', 'medium', 'high'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek-v4-flash-free': ['high', 'max'],
};

check('E2 既有条目只增不删:抽样 id 还在、档位不缩、没被判死', () => {
  const t = table();
  for (const [id, was] of Object.entries(SURVIVE)) {
    const now = t.byId?.[id];
    assert.ok(now, `${id} 被删了(只增不删)`);
    assert.notEqual(now.reasoning, false, `${id} 被判成不支持思考(判死方向,UI 会锁灰)`);
    for (const e of was) {
      assert.ok((now.efforts || []).includes(e), `${id} 少了档位 ${e}(缩档)`);
    }
  }
});

check('E3 换版才需要并集合并:未换版则抽样值逐字不变;换版则脚本必须有合并层', () => {
  const t = table();
  const gen = read('scripts/gen-thinking-levels.mjs');
  const src = String(t.source || '');
  if (/pi-ai@0\.82\.1/.test(src)) {
    for (const [id, was] of Object.entries(SURVIVE)) {
      assert.deepEqual(t.byId?.[id]?.efforts, was, `未升级 pi-ai,${id} 的值不该被顺手改动(source=${src})`);
    }
  } else {
    assert.match(gen, /(并集|union|mergeWithPrevious|PREV_TABLE|旧表)/,
      `表已换版(source=${src}),生成脚本必须有"与旧表并集"的合并层`);
    assert.match(gen, /(reasoning[\s\S]{0,60}false|判死)/,
      '合并层必须显式拒绝"判死降级"(reasoning:false)');
  }
});

console.log('\n—— G r105b 收口(判官 R1/R2/S2,主会话搬自 dev 测试 d8)——');

check('G1 判死不经推断传播:变体不因基名 reasoning:false 被判死(维持全档)', () => {
  assert.deepEqual(table().byId?.['kimi-k2-0905-preview'], { reasoning: false }, '前提:基名在表里判死');
  assert.equal(L('kimi-k2-0905-preview-turbo', 'openai'), null, '推断不许往判死方向走');
  assert.equal(L('kimi-k2-0905-preview', 'openai')?.reasoning, false, '精确命中的判死照常生效');
});

check('G2 命名空间 id 不跨家族:比家族用裸尾段', () => {
  assert.ok(table().byId?.['openai/gpt-5.4'], '前提:跨家族基名在表里');
  assert.equal(L('openai/gpt-5.4-codex-preview', 'openai')?.viaId, undefined,
    '带命名空间的 codex 不许回退到 openai/gpt-5.4');
  const q = L('qwen/qwen3-235b-a22b-instruct-2601', 'openai');
  assert.equal(q?.viaId, undefined, 'instruct 变体不许回退到思考基座 qwen/qwen3-235b-a22b');
  assert.equal(q?.efforts ?? null, null, '维持 r105 之前的结论(全档)');
  assert.equal(L('deepseek/deepseek-v4-pro-turbo', 'openai')?.viaId, 'deepseek/deepseek-v4-pro',
    '同家族同命名空间仍回退');
});

check('G3 回退提示文案不提"表"(用户没有这个指代物)', () => {
  const note = pick(EC, 'effortSourceNote', 'effortCaps.js');
  const id = 'deepseek-v4-flash-vision';
  const s = String(note({ [id]: prefill(id, 'openai') }, id) || '');
  assert.match(s, /按\s*deepseek-v4-flash(?![\w-])/, '仍点名基名');
  assert.doesNotMatch(s, /表/, `文案不提"表",当前:${JSON.stringify(s)}`);
});

console.log('\n—— F 既有契约不回归 ——');

check('F1 既有 check-model-capabilities.mjs 仍全绿(退出码 0)', () => {
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [join(root, 'tests/unit/check-model-capabilities.mjs')],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 1;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  assert.equal(code, 0, `既有单测红了(本轮开工时它是绿的):\n${out.split('\n').slice(-6).join('\n')}`);
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r105-effort-variants: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r105-effort-variants:变体回退矩阵 + DeepSeek 三 id 两协议档位 + 存储语义 + 前端提示 + 只增不删 全绿');
