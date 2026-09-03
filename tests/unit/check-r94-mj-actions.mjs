#!/usr/bin/env node
// r94-C:Midjourney 动作语汇 server/utils/mj-actions.js(INTERFACE §2)。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r94.md 的 §2 写,不看实现。
// 断言名带 INTERFACE 编号(§2.x / R* / M*)。
//
// 核心牙(改坏就红):
//  ① `upsample::` 与 `upsample_` 严格互斥 —— 前者是 U 按钮(只切图不放大),后者才是真放大。
//    用 startsWith('MJ::JOB::upsample') 一把抓会让「取出单图」被当成「真放大」(M12)。
//  ② 回落路径(上游没给 buttons)只许产出 pick 与 variation,【不含 reroll】——
//    proxy 原版有 reroll 模板,但本轮不放行,两种协议的回落必须完全相同(M13)。
//  ③ 真放大/zoom/pan/inpaint 只可能来自 buttons:自拼 customId 的 hash 段是假的,上游必 400(M14)。
//  ④ 签名里没有 version:按版本猜真放大命令 = 又一张会过时的表(M15)。
//
// 零网络、零真实配置:纯函数直接 import。模块现在还不存在 → 用动态 import + 逐条 check(),
// 让每条各自红,而不是链接失败一条都跑不到。
// Run: node tests/unit/check-r94-mj-actions.mjs
import assert from 'node:assert/strict';

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

console.log('\n[A] §2 server/utils/mj-actions.js');

let MA = null;
let MAERR = '';
try {
  MA = await import('../../server/utils/mj-actions.js');
} catch (e) {
  MAERR = String((e && e.message) || e);
}
check('A0 mj-actions.js 可被 node 直接 import(零依赖纯函数模块)', () => {
  assert.ok(MA, `import 失败:${MAERR}`);
});

const classifyCustomId = MA?.classifyCustomId;
const mjActionsFor = MA?.mjActionsFor;
const changeActionFor = MA?.changeActionFor;

// ══════════════════════════════════════════════════════════════════════════
// §2.1 classifyCustomId
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §2.1 classifyCustomId');

check('R2 classifyCustomId 已导出且是函数', () => {
  assert.equal(typeof classifyCustomId, 'function');
});
check('§2.1 upsample:: → pick(U 按钮:取出单图,像素不变)', () => {
  assert.strictEqual(classifyCustomId('MJ::JOB::upsample::2::abc'), 'pick');
});
check('M12/§2.1 upsample_ 系六个命令 → upscale(真放大)', () => {
  const ids = [
    'MJ::JOB::upsample_v6_2x_subtle::1::abc::SOLO',
    'MJ::JOB::upsample_v6_2x_creative::1::abc::SOLO',
    'MJ::JOB::upsample_v7_2x_subtle::1::abc::SOLO',
    'MJ::JOB::upsample_v7_2x_creative::1::abc::SOLO',
    'MJ::JOB::upsample_v5_2x::1::abc::SOLO',
    'MJ::JOB::upsample_v5_4x::1::abc::SOLO',
  ];
  for (const id of ids) assert.strictEqual(classifyCustomId(id), 'upscale', id);
});
check('M12/§2.1 严格互斥:upsample:: 只判 pick,upsample_ 只判 upscale', () => {
  assert.strictEqual(classifyCustomId('MJ::JOB::upsample::1::abc'), 'pick');
  assert.strictEqual(classifyCustomId('MJ::JOB::upsample_v5_2x::1::abc'), 'upscale');
  assert.notStrictEqual(classifyCustomId('MJ::JOB::upsample::1::abc'), 'upscale',
    'startsWith(MJ::JOB::upsample) 一把抓会让「取出单图」被当成「真放大」');
});
check('§2.1 variation / high_variation / low_variation 三种变体各自的 kind', () => {
  assert.strictEqual(classifyCustomId('MJ::JOB::variation::3::abc'), 'variation');
  assert.strictEqual(classifyCustomId('MJ::JOB::high_variation::1::abc::SOLO'), 'vary_strong');
  assert.strictEqual(classifyCustomId('MJ::JOB::low_variation::1::abc::SOLO'), 'vary_subtle');
});
check('§2.1 reroll → reroll', () => {
  assert.strictEqual(classifyCustomId('MJ::JOB::reroll::0::abc::SOLO'), 'reroll');
});
check('§2.1 Outpaint 与 CustomZoom → zoom', () => {
  assert.strictEqual(classifyCustomId('MJ::Outpaint::50::1::abc::SOLO'), 'zoom');
  assert.strictEqual(classifyCustomId('MJ::CustomZoom::abc'), 'zoom');
});
check('R12/M48b/§2.1 两段式 MJ::Outpaint::1::h::SOLO → zoom(真机实测 label Zoom Out 1.5×)', () => {
  assert.strictEqual(classifyCustomId('MJ::Outpaint::1::h::SOLO'), 'zoom');
});
check('R12/M48b/§2.1 两段式 MJ::Inpaint::1::h::SOLO → inpaint(真机实测 label Vary (Region))', () => {
  assert.strictEqual(classifyCustomId('MJ::Inpaint::1::h::SOLO'), 'inpaint');
});
check('M48b/§2.1 不变式:同一份 buttons 里三段式与两段式并存,两者都要分对', () => {
  // 真机实测:apimart 父任务的 15 个按钮里,MJ::JOB::<cmd>::<idx>::<hash> 与 MJ::<Cmd>::<idx>::<hash>
  // 同时存在。按 split('::')[2] 取命令段会把两段式读成 '1' → 落进 unknown。
  const mixed = [
    ['MJ::JOB::upsample::1::h', 'pick'], ['MJ::JOB::variation::1::h', 'variation'],
    ['MJ::JOB::reroll::0::h::SOLO', 'reroll'], ['MJ::JOB::pan_left::0::h::SOLO', 'pan'],
    ['MJ::Outpaint::1::h::SOLO', 'zoom'], ['MJ::Inpaint::1::h::SOLO', 'inpaint'],
  ];
  for (const [id, kind] of mixed) assert.strictEqual(classifyCustomId(id), kind, id);
});
check('§2.1 pan_left / pan_up → pan', () => {
  assert.strictEqual(classifyCustomId('MJ::JOB::pan_left::1::abc::SOLO'), 'pan');
  assert.strictEqual(classifyCustomId('MJ::JOB::pan_up::1::abc::SOLO'), 'pan');
});
check('§2.1 Inpaint → inpaint', () => {
  assert.strictEqual(classifyCustomId('MJ::Inpaint::1::abc::SOLO'), 'inpaint');
});
check('§2.1 非法/未知输入一律 unknown 且不抛错', () => {
  for (const bad of ['', null, undefined, 42, {}, 'MJ::JOB::wat::1::abc', 'upsample']) {
    assert.strictEqual(classifyCustomId(bad), 'unknown', `输入 ${JSON.stringify(bad) ?? String(bad)}`);
  }
});
check('§2.1 返回值恒在 10 个 kind 的取值域内', () => {
  const OK = new Set(['pick', 'variation', 'vary_strong', 'vary_subtle', 'upscale', 'reroll', 'zoom', 'pan', 'inpaint', 'unknown']);
  const probes = ['MJ::JOB::upsample::2::abc', 'MJ::JOB::upsample_v7_2x_subtle::1::abc::SOLO',
    'MJ::JOB::variation::3::abc', 'MJ::JOB::high_variation::1::abc::SOLO', 'MJ::JOB::low_variation::1::abc::SOLO',
    'MJ::JOB::reroll::0::abc::SOLO', 'MJ::Outpaint::50::1::abc::SOLO', 'MJ::CustomZoom::abc',
    'MJ::JOB::pan_left::1::abc::SOLO', 'MJ::Inpaint::1::abc::SOLO', 'x', '', null];
  for (const p of probes) assert.ok(OK.has(classifyCustomId(p)), `${String(p)} 返回了域外 kind ${classifyCustomId(p)}`);
});

// ══════════════════════════════════════════════════════════════════════════
// §2.2 mjActionsFor
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §2.2 mjActionsFor');

const BTN = (customId, label) => ({ customId, label });
const btnSet = [
  BTN('MJ::JOB::upsample::1::h1', 'U1'),
  BTN('MJ::JOB::variation::1::h1', 'V1'),
  BTN('MJ::JOB::upsample_v7_2x_subtle::1::h1', 'Upscale (Subtle)'),
];

check('§2.2 mjActionsFor 已导出且是函数', () => {
  assert.equal(typeof mjActionsFor, 'function');
});
check('§2.2 buttons 非空:逐个产出 customId 模式,customId 逐字相同(不重拼)', () => {
  const acts = mjActionsFor({ buttons: btnSet, protocol: 'mj', imageCount: 1 });
  assert.equal(acts.length, 3, `应产出 3 项(实得 ${acts.length})`);
  assert.deepEqual(acts.map((a) => a.customId), btnSet.map((b) => b.customId), 'customId 必须逐字来自 buttons');
  assert.deepEqual(acts.map((a) => a.label), acts.map((a) => MA?.MJ_ACTION_LABELS?.[a.kind]), 'label 取自本地标签表');
  for (const a of acts) assert.strictEqual(a.mode, 'customId', `${a.id} 的 mode 应为 customId`);
  assert.deepEqual(acts.map((a) => a.kind), ['pick', 'variation', 'upscale']);
});
check('M48c/§2.2 label 一律取 MJ_ACTION_LABELS[kind],【不透传上游 label】', () => {
  // 真机实测:上游 pan / reroll 的 label 是纯 emoji(⬅ ➡ ⬆ ⬇ 🔄),透传出来就是一排裸箭头。
  const acts = mjActionsFor({ buttons: [BTN('MJ::JOB::upsample::1::h', 'U1'), BTN('MJ::JOB::variation::1::h', '')], protocol: 'mj', imageCount: 4 });
  assert.strictEqual(acts[0].label, MA?.MJ_ACTION_LABELS?.pick, `pick 的 label 应是中文默认名(实得 ${acts[0].label})`);
  assert.strictEqual(acts[1].label, MA?.MJ_ACTION_LABELS?.variation, 'variation 同理');
  assert.notStrictEqual(acts[0].label, 'U1', '不许把上游 label 透传出去');
});
check('M48c/§2.2 上游 label 是纯 emoji 时也不外泄(真机实测形态)', () => {
  const acts = mjActionsFor({ buttons: [
    BTN('MJ::JOB::reroll::0::h::SOLO', '🔄'), BTN('MJ::JOB::pan_left::0::h::SOLO', '⬅'),
  ], protocol: 'mj', imageCount: 4 });
  for (const a of acts) {
    assert.ok(!/[🔄⬅➡⬆⬇]/.test(a.label), `label 里出现了上游的裸 emoji:${a.label}`);
    assert.strictEqual(a.label, MA?.MJ_ACTION_LABELS?.[a.kind], `${a.kind} 的 label 应取 MJ_ACTION_LABELS`);
  }
});
check('§2.2 上游元素只有 {customId,label,style,type}(无 emoji 键)也照常工作', () => {
  const acts = mjActionsFor({ buttons: [{ customId: 'MJ::JOB::upsample::1::h', label: 'U1', style: 2, type: 2 }],
    protocol: 'mj', imageCount: 4 });
  assert.equal(acts.length, 1);
  assert.strictEqual(acts[0].customId, 'MJ::JOB::upsample::1::h');
});
check('§2.2 buttons 里 unknown 项不产出', () => {
  const acts = mjActionsFor({ buttons: [BTN('MJ::JOB::wat::1::h', '?'), BTN('MJ::JOB::upsample::1::h', 'U1')], protocol: 'mj', imageCount: 4 });
  assert.equal(acts.length, 1, `未知按钮不该产出动作(实得 ${JSON.stringify(acts.map((a) => a.kind))})`);
  assert.strictEqual(acts[0].kind, 'pick');
});
check('§2.2 重复 customId 去重,保留首个', () => {
  const dup = [BTN('MJ::JOB::upsample::1::h', 'U1'), BTN('MJ::JOB::upsample::1::h', '第二次')];
  const acts = mjActionsFor({ buttons: dup, protocol: 'mj', imageCount: 4 });
  assert.equal(acts.length, 1, '重复 customId 只保留一项');
  // label 一律取本地表(M48c),所以"保留首个"只能靠"只剩一项"来判,
  // 不能拿上游 label 当判据 —— 那与 M48c 的"不透传上游 label"直接打架。
  assert.strictEqual(acts[0].label, MA?.MJ_ACTION_LABELS?.pick, '保留首个,且 label 取自本地标签表');
});
check('§2.2 buttons 超 32 只取前 32', () => {
  const many = Array.from({ length: 40 }, (_, i) => BTN(`MJ::JOB::upsample::1::h${i}`, `U${i}`));
  const acts = mjActionsFor({ buttons: many, protocol: 'mj', imageCount: 4 });
  assert.equal(acts.length, 32, `应截断为 32(实得 ${acts.length})`);
  assert.strictEqual(acts[0].customId, 'MJ::JOB::upsample::1::h0');
  assert.strictEqual(acts[31].customId, 'MJ::JOB::upsample::1::h31');
});
check('M13/§2.2 回落路径(buttons 空 + mj + imageCount 4)恰 8 项:pick×4 + variation×4,mode 均 index', () => {
  const acts = mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 4 });
  assert.equal(acts.length, 8, `回落必须恰 8 项(实得 ${acts.length}:${JSON.stringify(acts.map((a) => a.kind))})`);
  assert.deepEqual(acts.filter((a) => a.kind === 'pick').map((a) => a.index), [1, 2, 3, 4]);
  assert.deepEqual(acts.filter((a) => a.kind === 'variation').map((a) => a.index), [1, 2, 3, 4]);
  for (const a of acts) assert.strictEqual(a.mode, 'index', `${a.id} 的 mode 应为 index`);
});
check('M13/§2.2 回落路径不含 reroll(proxy 原版有该模板,本轮不放行)', () => {
  for (const protocol of ['mj', 'mj-proxy']) {
    const kinds = mjActionsFor({ buttons: [], protocol, imageCount: 4 }).map((a) => a.kind);
    assert.ok(!kinds.includes('reroll'), `protocol=${protocol} 的回落不许有 reroll(实得 ${JSON.stringify(kinds)})`);
  }
});
check('M13/§2.2 proxy 原版与 apimart 的回落【完全相同】(同 8 项)', () => {
  const a = mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 4 });
  const b = mjActionsFor({ buttons: [], protocol: 'mj-proxy', imageCount: 4 });
  assert.deepEqual(b.map((x) => ({ kind: x.kind, index: x.index, mode: x.mode })),
    a.map((x) => ({ kind: x.kind, index: x.index, mode: x.mode })));
});
check('§2.2 buttons 空 + imageCount 1:pick 与 variation 各 1 项(index 1)', () => {
  const acts = mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 1 });
  assert.equal(acts.length, 2, `实得 ${JSON.stringify(acts.map((a) => `${a.kind}#${a.index}`))}`);
  assert.deepEqual(acts.map((a) => a.kind).sort(), ['pick', 'variation']);
  for (const a of acts) assert.strictEqual(a.index, 1);
});
check('§2.2 buttons 空 + imageCount 0 或缺省 → 空数组', () => {
  assert.deepEqual(mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 0 }), []);
  assert.deepEqual(mjActionsFor({ buttons: [], protocol: 'mj' }), []);
});
check('§2.2 入参 null / undefined / 字符串 → 空数组,不抛错', () => {
  for (const bad of [null, undefined, 'x']) {
    assert.deepEqual(mjActionsFor(bad), [], `入参 ${String(bad)}`);
  }
});
check('G11/§2.2 id 恰为 `${kind}:${customId}`(customId 模式)/ `${kind}:${index}`(index 模式)', () => {
  for (const a of mjActionsFor({ buttons: btnSet, protocol: 'mj', imageCount: 4 })) {
    assert.strictEqual(a.id, `${a.kind}:${a.customId}`, 'customId 模式的 id 构成');
  }
  for (const a of mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 4 })) {
    assert.strictEqual(a.id, `${a.kind}:${a.index}`, 'index 模式的 id 构成');
  }
});
check('G11/§2.2 id 同一输入跨调用稳定(纯函数,不含随机数/时间戳/自增)', () => {
  const once = mjActionsFor({ buttons: btnSet, protocol: 'mj', imageCount: 4 }).map((a) => a.id);
  const twice = mjActionsFor({ buttons: btnSet, protocol: 'mj', imageCount: 4 }).map((a) => a.id);
  assert.deepEqual(twice, once, '两次调用的 id 必须逐字相同');
});
check('§2.2 不变式:id 唯一', () => {
  const acts = [...mjActionsFor({ buttons: btnSet, protocol: 'mj', imageCount: 4 }),
    ...mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 4 })];
  for (const a of acts) assert.ok(a.id, `动作缺 id:${JSON.stringify(a)}`);
  const ids = mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 4 }).map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, `回落路径的 id 必须互不相同(实得 ${JSON.stringify(ids)})`);
  const ids2 = mjActionsFor({ buttons: btnSet, protocol: 'mj', imageCount: 4 }).map((a) => a.id);
  assert.equal(new Set(ids2).size, ids2.length, 'buttons 路径的 id 必须互不相同');
});
check('§2.2 不变式:customId 模式必有非空 customId 且无 index', () => {
  for (const a of mjActionsFor({ buttons: btnSet, protocol: 'mj', imageCount: 4 })) {
    assert.strictEqual(a.mode, 'customId');
    assert.ok(typeof a.customId === 'string' && a.customId.length > 0, `${a.id} 缺 customId`);
    assert.ok(a.index === undefined || a.index === null, `${a.id} 不该同时带 index(实得 ${a.index})`);
  }
});
check('§2.2 不变式:index 模式必有 1–4 整数 index 且无 customId', () => {
  for (const a of mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 4 })) {
    assert.strictEqual(a.mode, 'index');
    assert.ok(Number.isInteger(a.index) && a.index >= 1 && a.index <= 4, `${a.id} 的 index 非法:${a.index}`);
    assert.ok(a.customId === undefined || a.customId === null || a.customId === '', `${a.id} 不该带 customId`);
  }
});
check('M14/§2.2 不变式:upscale/reroll/zoom/pan/inpaint 只可能来自 buttons(回落路径一个都没有)', () => {
  for (const protocol of ['mj', 'mj-proxy']) {
    for (const n of [1, 2, 4]) {
      const kinds = mjActionsFor({ buttons: [], protocol, imageCount: n }).map((a) => a.kind);
      for (const forbidden of ['upscale', 'reroll', 'zoom', 'pan', 'inpaint']) {
        assert.ok(!kinds.includes(forbidden), `protocol=${protocol} imageCount=${n} 的回落出现了 ${forbidden}`);
      }
    }
  }
});
check('M14/§2.2 不自拼 customId:回落项一律不带 MJ::JOB:: 串', () => {
  for (const a of mjActionsFor({ buttons: [], protocol: 'mj-proxy', imageCount: 4 })) {
    assert.ok(!String(a.customId || '').includes('MJ::JOB::'), `${a.id} 自拼了 customId:${a.customId}`);
  }
});
check('M15/§2.2 签名无 version 入参:传 version 不改变结果', () => {
  const base = mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 4 });
  for (const v of ['5.1', '7', '8.2', 'niji7']) {
    const withV = mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 4, version: v });
    assert.deepEqual(withV.map((a) => `${a.kind}#${a.index}`), base.map((a) => `${a.kind}#${a.index}`),
      `version=${v} 不该影响动作集(签名里根本没有这个入参)`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// §2.3 changeActionFor
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §2.3 changeActionFor');

check('§2.3 changeActionFor 已导出且是函数', () => {
  assert.equal(typeof changeActionFor, 'function');
});
check('§2.3 pick → UPSCALE', () => {
  assert.strictEqual(changeActionFor('pick'), 'UPSCALE');
});
check('§2.3 variation / vary_strong / vary_subtle → VARIATION', () => {
  for (const k of ['variation', 'vary_strong', 'vary_subtle']) {
    assert.strictEqual(changeActionFor(k), 'VARIATION', `kind=${k}`);
  }
});
check('§2.3 reroll → REROLL', () => {
  assert.strictEqual(changeActionFor('reroll'), 'REROLL');
});
check('M25/§2.3 原版不支持的 kind 与非法入参一律 null', () => {
  for (const k of ['upscale', 'zoom', 'pan', 'inpaint', 'unknown', '', null, 42]) {
    assert.strictEqual(changeActionFor(k), null, `kind=${JSON.stringify(k) ?? String(k)}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// §2.4 常量
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §2.4 常量');

check('§2.4 MJ_ACTION_LABELS 九个 kind 的中文名逐字正确', () => {
  const want = {
    pick: '取出单图', variation: '变体', vary_strong: '强变体', vary_subtle: '弱变体',
    upscale: '真放大', reroll: '重新生成', zoom: '扩展画布', pan: '平移扩展', inpaint: '局部重绘',
  };
  const got = MA?.MJ_ACTION_LABELS;
  assert.ok(got && typeof got === 'object', `MJ_ACTION_LABELS 必须是对象(实得 ${String(got)})`);
  for (const [k, v] of Object.entries(want)) assert.strictEqual(got[k], v, `MJ_ACTION_LABELS.${k}`);
});
check('M47/§2.4 不得存在值恰为「放大」二字的键(旧文案会让人以为 U 按钮能提升像素)', () => {
  const got = MA?.MJ_ACTION_LABELS;
  assert.ok(got && typeof got === 'object', 'MJ_ACTION_LABELS 必须存在,这条才有判定对象');
  for (const [k, v] of Object.entries(got)) {
    assert.notStrictEqual(v, '放大', `键 ${k} 的值仍是旧文案「放大」`);
  }
});
check('G12/§2.4 MJ_NO_UPSCALE_NOTE 同时含四个子串,且不得含「稍后重试」/「请重试」', () => {
  const n = MA?.MJ_NO_UPSCALE_NOTE;
  assert.equal(typeof n, 'string', `实得 ${String(n)}`);
  assert.ok(n.length > 0, '不许是空串');
  for (const sub of ['该中转站不提供真放大', '像素不变', '高清', '不额外计费']) {
    assert.ok(n.includes(sub), `措辞缺子串「${sub}」(实得 ${JSON.stringify(n)})`);
  }
  for (const bad of ['稍后重试', '请重试']) {
    assert.ok(!n.includes(bad), `这不是临时故障,不许写「${bad}」`);
  }
});
check('M16/§2.4 MJ_RENDERED_KINDS 恰为 [pick, variation, upscale](本轮只渲染这三种)', () => {
  assert.deepEqual(MA?.MJ_RENDERED_KINDS, ['pick', 'variation', 'upscale']);
});

check('R12/§2.2 真机 apimart 父任务的 15 项按钮:产不出任何 upscale(该站不提供真放大)', () => {
  const real = [
    ...[1, 2, 3, 4].map((i) => BTN(`MJ::JOB::upsample::${i}::h`, `U${i}`)),
    BTN('MJ::JOB::reroll::0::h::SOLO', '🔄'),
    ...[1, 2, 3, 4].map((i) => BTN(`MJ::JOB::variation::${i}::h`, `V${i}`)),
    BTN('MJ::JOB::pan_left::0::h::SOLO', '⬅'), BTN('MJ::JOB::pan_right::0::h::SOLO', '➡'),
    BTN('MJ::JOB::pan_up::0::h::SOLO', '⬆'), BTN('MJ::JOB::pan_down::0::h::SOLO', '⬇'),
    BTN('MJ::Outpaint::1::h::SOLO', 'Zoom Out 1.5×'), BTN('MJ::Inpaint::1::h::SOLO', 'Vary (Region)'),
  ];
  const kinds = mjActionsFor({ buttons: real, protocol: 'mj', imageCount: 4 }).map((a) => a.kind);
  assert.equal(kinds.length, 15, `15 项按钮全部可识别(实得 ${kinds.length}:${JSON.stringify(kinds)})`);
  assert.ok(!kinds.includes('upscale'), '这份 buttons 里没有 upsample_v*,不许凭空造出 upscale');
  assert.ok(kinds.includes('zoom') && kinds.includes('inpaint'), '两段式的 Outpaint/Inpaint 必须被认出来');
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r94-mj-actions: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r94-mj-actions: customId 分类 + 动作集(含 proxy 原版退化)+ change 映射 + 标签常量 全绿');
