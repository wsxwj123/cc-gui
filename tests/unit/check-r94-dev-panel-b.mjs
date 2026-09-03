#!/usr/bin/env node
// r94 B2 线【开发自检】—— 验收测试(check-r94-panel.mjs)锁的是 INTERFACE 的字面,这一份
// 补的是"面板自己的判断有没有写错":控件清单与服务端白名单是否一一对应、动作请求体两形态、
// 参考图 payload 形态、以及 generate 之前那三道"会花钱/必被拒"的闸。
//
// JSX 进不了 node,所以行为面只能测两种东西:①能被 import 的纯函数(经 client/src/utils/
// mjParams.js 再导出的那一份);②从面板源码里【解析出来的常量】与服务端清单比对。
// 零网络、零真实配置。Run: node tests/unit/check-r94-dev-panel-b.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const P = read('client/src/components/ImagePanel.jsx');
const M = await import(new URL('../../client/src/utils/mjParams.js', import.meta.url));
const { buildImageRequest } = await import(new URL('../../server/utils/image-protocols.js', import.meta.url));

let PASS = 0;
const failed = [];
function check(name, fn) {
  try { fn(); PASS++; console.log(`  ✓ ${name}`); } catch (e) {
    failed.push(name);
    console.log(`  ✗ ${name}\n      ${String(e && e.message).split('\n').slice(0, 3).join('\n      ')}`);
  }
}
// 从面板源码里取一个数组常量的字符串元素(面板是 JSX,只能这样读它的清单)。
const arrayConst = (name) => {
  const m = P.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(m, `源码里找不到 const ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};
const block = (re, what) => { const m = P.match(re); assert.ok(m, `切不出${what}`); return m[0]; };

console.log('\n[1] 再导出层');
check('mjParams.js 把面板要用的 11 个名字都导出了', () => {
  for (const fn of ['compileMjFlags', 'mjCapsFor', 'mjEffectiveSpeed', 'mjRefModeFor',
    'classifyCustomId', 'mjActionsFor', 'changeActionFor']) {
    assert.equal(typeof M[fn], 'function', `缺函数 ${fn}`);
  }
  assert.deepEqual(M.MJ_REF_MODES, ['upload', 'inline', 'url']);
  assert.deepEqual(M.MJ_RENDERED_KINDS, ['pick', 'variation', 'upscale']);
  assert.equal(M.MJ_ACTION_LABELS.pick, '取出单图');
  assert.ok(M.MJ_NO_UPSCALE_NOTE.includes('像素不变'));
});
check('面板只经 utils/mjParams.js 取这层能力,不直接 import 服务端目录', () => {
  assert.ok(P.includes("from '../utils/mjParams.js'"), '缺再导出入口');
  assert.equal((P.match(/from '\.\.\/\.\.\/\.\.\/server\//g) || []).length, 0,
    '面板不许直接 import server/ 下的模块(会把 fs/os 拉进浏览器包)');
});

console.log('\n[2] 控件清单与服务端白名单一一对应');
check('常用 + 高级两组恰好覆盖 MJ_PARAM_FIELDS,不重不漏', () => {
  const common = arrayConst('MJ_COMMON_FIELDS');
  const advanced = arrayConst('MJ_ADVANCED_FIELDS');
  assert.equal(new Set([...common, ...advanced]).size, common.length + advanced.length, '两组之间有重复字段');
  assert.deepEqual([...common, ...advanced].sort(), [...M.MJ_PARAM_FIELDS].sort(),
    '控件清单与服务端白名单对不上:多出来的填了不发,少掉的界面上没法填');
});
check('每个字段都有界面文案(标签 / 形态 / 说明)', () => {
  const meta = P.match(/const MJ_FIELD_META = \{[\s\S]*?\n\};/);
  assert.ok(meta, '找不到 MJ_FIELD_META');
  for (const f of M.MJ_PARAM_FIELDS) {
    assert.match(meta[0], new RegExp(`\\n  ${f}: \\[`), `字段 ${f} 没有界面文案`);
  }
});
check('垫图传法三项的说明各写一句(费用 / base64 / 只收链接)', () => {
  const meta = block(/const MJ_REF_MODE_META = \{[\s\S]*?\n\};/, 'MJ_REF_MODE_META');
  for (const m of M.MJ_REF_MODES) assert.match(meta, new RegExp(`\\n  ${m}: \\[`), `缺 ${m} 的说明`);
  assert.ok(meta.includes('0.05') && meta.includes('72 小时'), 'upload 档要写清费用与有效期');
  assert.ok(meta.includes('base64'), 'inline 档要说明形态');
});

console.log('\n[3] 动作:两种请求体形态 + 端点映射');
check('submitAction 两形态并存,customId 形态不发 index', () => {
  const b = block(/const submitAction = async \(h, action\) => \{[\s\S]*?\n  \};/, 'submitAction');
  assert.match(b, /action\.customId \? \{ customId: action\.customId \}/, 'customId 形态必须原样带回上游按钮');
  assert.match(b, /action: legacyMjAction\(action\.kind\), index: action\.index/, 'index 形态仍是 r84 老请求体');
  assert.ok(!/customId: action\.customId, index/.test(b), '带 customId 时不许再塞 index');
});
check('legacyMjAction:取出单图与真放大都打 upscale,变体打 variation', () => {
  const line = block(/const legacyMjAction = \(kind\) => [^\n]*/, 'legacyMjAction');
  assert.match(line, /kind === 'variation' \? 'variation' : 'upscale'/);
});
check('单图动作条只认上游按钮,拿不到按钮时给说明而不是假按钮', () => {
  const b = block(/const mjSoloBar = \(h\) => \{[\s\S]*?\n  \};/, 'mjSoloBar');
  assert.match(b, /a\.mode === 'customId'/, '回落出来的 U/V 打在单图任务上是白花钱');
  assert.match(b, /MJ_RENDERED_KINDS\.includes\(a\.kind\)/, '本轮只渲染三种 kind');
  assert.match(b, /MJ_NO_UPSCALE_NOTE/, '没有真放大按钮时要如实说明');
});
check('缩略条按 index 形态取动作:第 i 格对应 Action 的 index 是 i + 1', () => {
  const b = block(/const imageStrip = \(h\) => \{[\s\S]*?\n  \};/, 'imageStrip');
  assert.match(b, /mjActionsFor\(\{ buttons: \[\]/, '缩略条恒用 index 形态(序号藏在 customId 的 hash 段里)');
  assert.match(b, /filter\(\(a\) => a\.index === i \+ 1\)/);
  // 该形态真的产得出 4 组 U/V,否则缩略条上一个按钮都不会有。
  const acts = M.mjActionsFor({ buttons: [], protocol: 'mj', imageCount: 4 });
  assert.equal(acts.filter((a) => a.index === 2).length, 2, 'index 形态每格应有取出单图 + 变体两项');
});

console.log('\n[4] 参考图 payload 与三道前置闸');
check('refs payload 带 role/weight,history 形态字面不变', () => {
  const b = block(/const generate = async \(\) => \{[\s\S]*?\n  \};/, 'generate');
  assert.ok(b.includes("kind: 'history', file: r.file"), 'r54 锁住的字面不许改');
  assert.match(b, /role: refRole\(r\)/, '三种来源都要带 role');
  assert.match(b, /kind: 'url', url: r\.url/, 'URL 型参考图要发出去');
  assert.match(b, /weight: Number\(r\.weight\)/, '权重按数字发送');
});
check('generate 里没有任何上传调用(永不隐式产生上传费用)', () => {
  const b = block(/const generate = async \(\) => \{[\s\S]*?\n  \};/, 'generate');
  assert.ok(!b.includes('upload-ref'), 'upload-ref 只能由用户显式点');
  for (const guard of ['needRefUpload', 'refModeUrlOnly', 'localNonImageRef']) {
    assert.ok(b.indexOf(guard) > 0 && b.indexOf(guard) < b.indexOf('/api/image/generate'),
      `${guard} 必须在发请求之前拦下`);
  }
});
check('upload-ref 只在显式的 uploadRef 里调,且换回来的链接记了有效期', () => {
  assert.equal((P.match(/'\/api\/image\/upload-ref'/g) || []).length, 1, '上传入口只能有一处');
  const b = block(/const uploadRef = async \(i\) => \{[\s\S]*?\n  \};/, 'uploadRef');
  assert.match(b, /expiresAt: d\.expiresAt/, '有效期来自服务端,不在面板里自算');
  assert.match(b, /revokeRefPreview\(r\)/, '换成链接后旧的 objectURL 要撤');
});

console.log('\n[5] 「将要发送」与真正发上游的提示词同源');
check('预览用的是 compileMjFlags 本体,版本 flag 的补法与 mj-proxy 方言层一致', () => {
  assert.ok(P.includes('compileMjFlags('), '预览必须用同一个编译函数');
  assert.match(P, /`--niji \$\{mjCapsSel\.base\}`/, 'niji 档补 --niji <base>');
  assert.match(P, /`--v \$\{mjCapsSel\.base\}`/, '主线档补 --v <base>');
  // 方言层的实际产物:niji7 → --niji 7、7 → --v 7(面板补的形态必须与它对得上)。
  const cfg = { protocol: 'mj-proxy', baseURL: 'https://mj.example.com/mj', apiKey: 'k', model: 'midjourney', size: '16:9' };
  assert.match(buildImageRequest({ ...cfg, mjVersion: 'niji7' }, '猫', []).body.prompt, /--niji 7$/);
  assert.match(buildImageRequest({ ...cfg, mjVersion: '7' }, '猫', []).body.prompt, /--v 7$/);
});
check('8.x + turbo:预览按 fast 显示并带说明,表单里仍是用户存的原值', () => {
  const eff = M.mjEffectiveSpeed('8.2', 'turbo');
  assert.equal(eff.speed, 'fast');
  assert.ok(eff.note.includes('fast'));
  const save = block(/mjSpeed: mjProto \? \(form\.mjSpeed \|\| ''\) : '',/, '保存时的速度字段');
  assert.ok(!save.includes('mjEffectiveSpeed'), '落盘值不许被降级改写');
  assert.match(P, /mjSpeed: p\.mjSpeed \|\| ''/, '回填的是存的原值');
});

console.log(`\n—— check-r94-dev-panel-b: ${PASS} 绿 / ${failed.length} 红 ——`);
if (failed.length) { for (const n of failed) console.log(`  ✗ ${n}`); process.exit(1); }
console.log('✓ check-r94-dev-panel-b: 控件清单/动作两形态/参考图闸/预览同源 全绿');
