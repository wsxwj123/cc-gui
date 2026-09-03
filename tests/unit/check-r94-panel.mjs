#!/usr/bin/env node
// r94-B:源码锁(INTERFACE §7 全节)+ §6 里能靠源码断言的组件层行为。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r94.md 写。JSX 进不了 node,
// 组件层只能读文件做结构断言 —— 这些锁是"字面模式"锁,逐条抄 §7,不推断实现。
// 断言名带 INTERFACE 编号(§7.x / B* / R* / M*)。
//
// 零网络、零真实配置:只读仓库文件 + 一次 git 只读查询(零 diff 锁,git 不可用时跳过)。
// Run: node tests/unit/check-r94-panel.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return ''; } };
const count = (s, re) => (s.match(re) || []).length;

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

const MP = read('server/utils/mj-params.js');
const MA = read('server/utils/mj-actions.js');
const C = read('server/utils/image-caps.js');
const PR = read('server/utils/image-protocols.js');
const R = read('server/routes/image.js');
const P = read('client/src/components/ImagePanel.jsx');
const LB = read('client/src/components/ImageLightbox.jsx');

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §7.1 server/utils/mj-params.js');
// ══════════════════════════════════════════════════════════════════════════
check('§7.1 文件存在且非空', () => assert.ok(MP.length > 0, '读不到 server/utils/mj-params.js'));
check('§7.1 必须导出 compileMjFlags / mjCapsFor / mjEffectiveSpeed', () => {
  for (const fn of ['compileMjFlags', 'mjCapsFor', 'mjEffectiveSpeed']) {
    assert.ok(new RegExp(`export function ${fn}\\b`).test(MP), `缺 export function ${fn}`);
  }
});
check('§7.1 必须有 export const MJ_PARAM_FIELDS 与标识符 viaBody', () => {
  assert.match(MP, /export const MJ_PARAM_FIELDS/);
  assert.ok(MP.includes('viaBody'), '缺 viaBody 标识符');
});
check('§7.1 垫图传法三件:MJ_REF_MODES / MJ_REF_MODE_DEFAULT / mjRefModeFor', () => {
  assert.match(MP, /export const MJ_REF_MODES/);
  assert.match(MP, /export const MJ_REF_MODE_DEFAULT/);
  assert.match(MP, /export function mjRefModeFor\b/);
});
check('§7.1 不许 import 任何 node 内置模块(纯函数模块,给前端也能用)', () => {
  assert.equal(count(MP, /from 'node:/g), 0, '出现了 node: 内置模块 import');
  assert.equal(count(MP, /require\(['"]node:/g), 0);
});
check('§1.1/§7.1 不许出现 --turbo / --fast / --relax 字面', () => {
  for (const lit of ['--turbo', '--fast', '--relax']) {
    assert.ok(!MP.includes(lit), `出现了 ${lit}(速度不走 flag)`);
  }
});
check('§7.1 不许出现 MJ_UPSCALE_COMMANDS(真放大命令表只能来自 buttons)', () => {
  assert.ok(!MP.includes('MJ_UPSCALE_COMMANDS'));
});
check('M34/§7.1 不许出现 MJ_IMAGE_REF_MODE(模块级单值开关已被 provider 字段取代)', () => {
  assert.ok(!MP.includes('MJ_IMAGE_REF_MODE'));
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §7.2 server/utils/mj-actions.js');
// ══════════════════════════════════════════════════════════════════════════
check('§7.2 文件存在且非空', () => assert.ok(MA.length > 0, '读不到 server/utils/mj-actions.js'));
check('§7.2 必须导出 classifyCustomId / mjActionsFor / changeActionFor', () => {
  for (const fn of ['classifyCustomId', 'mjActionsFor', 'changeActionFor']) {
    assert.ok(new RegExp(`export function ${fn}\\b`).test(MA), `缺 export function ${fn}`);
  }
});
check('§7.2 必须导出 MJ_ACTION_LABELS / MJ_NO_UPSCALE_NOTE / MJ_RENDERED_KINDS', () => {
  for (const k of ['MJ_ACTION_LABELS', 'MJ_NO_UPSCALE_NOTE', 'MJ_RENDERED_KINDS']) {
    assert.ok(new RegExp(`export const ${k}\\b`).test(MA), `缺 export const ${k}`);
  }
});
check('R7/§7.2 必须含字面串 取出单图', () => assert.ok(MA.includes('取出单图')));
check('§7.2 不许 import 任何 node 内置模块', () => {
  assert.equal(count(MA, /from 'node:/g), 0);
});
check('M15/§7.2 不许出现标识符 version(动作集不按版本猜)', () => {
  assert.equal(count(MA, /\bversion\b/g), 0, '出现了 version 标识符');
});
check('M14/§7.2 不许自拼 customId(无 MJ::JOB:: 的字符串拼接与模板串)', () => {
  assert.ok(!MA.includes("'MJ::JOB::' +"), "出现了 'MJ::JOB::' + 拼接");
  assert.ok(!MA.includes('MJ::JOB::${'), '出现了 MJ::JOB::${ 模板串');
});
check('M48b/§2.1 不许按 split(\'::\')[2] 取命令段(两段式 customId 会被读成 1)', () => {
  assert.ok(!/split\(\s*'::'\s*\)\s*\[\s*2\s*\]/.test(MA), "出现了 split('::')[2]");
  assert.ok(!/split\(\s*"::"\s*\)\s*\[\s*2\s*\]/.test(MA), '出现了 split("::")[2]');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §7.3 server/utils/image-caps.js');
// ══════════════════════════════════════════════════════════════════════════
check('M43/§7.3 re: /^ 出现 0 次(八条家族正则都不再锚定串首)', () => {
  assert.equal(count(C, /re: \/\^/g), 0, `实得 ${count(C, /re: \/\^/g)} 处仍锚定 ^`);
});
check('M44/§7.3 [^a-z0-9] 出现 ≥8 次(分隔符容忍形态)', () => {
  const n = count(C, /\[\^a-z0-9\]/g);
  assert.ok(n >= 8, `实得 ${n} 次,需 ≥8`);
});
check('R5/§7.3 必须出现 OPENAI_UNKNOWN 与 unknown: true', () => {
  assert.ok(C.includes('OPENAI_UNKNOWN'), '缺 OPENAI_UNKNOWN');
  assert.ok(C.includes('unknown: true'), '缺 unknown: true');
});
check('§7.3 回归:APIMART_UNKNOWN 的 fields 仍逐字 [size, n, nsfwCheck]', () => {
  assert.ok(C.includes('APIMART_UNKNOWN'), '缺 APIMART_UNKNOWN');
  assert.match(C, /APIMART_UNKNOWN[\s\S]{0,400}fields: \['size', 'n', 'nsfwCheck'\]/);
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §7.4 server/utils/image-protocols.js');
// ══════════════════════════════════════════════════════════════════════════
check('§7.4 必须出现 mj-proxy', () => assert.ok(PR.includes('mj-proxy')));
check('M18/§7.4 buildMjActionRequest 形参表逐字为 (config, action, index, taskId, customId)', () => {
  assert.ok(PR.includes('function buildMjActionRequest(config, action, index, taskId, customId)'),
    '前四个位置与名称必须不变,customId 只能追加在末尾');
});
check('§7.4 四条既有错误文案字面不许改', () => {
  for (const lit of ['未知的 Midjourney 操作', '缺少上游任务号', 'baseURL 未配置']) {
    assert.ok(PR.includes(lit), `缺文案字面:${lit}`);
  }
  assert.ok(PR.includes('只能对第 1–${MJ_ACTION_INDEX_MAX} 张'), '缺 index 越界文案字面');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §7.5 server/routes/image.js');
// ══════════════════════════════════════════════════════════════════════════
check('§7.5 必现字面:mj-proxy / mjButtons / mjPromptSent / upload-ref / mjCustomId / assertPublicRefUrl / mjEffectiveSpeed / speedNote', () => {
  for (const lit of ['mj-proxy', 'mjButtons', 'mjPromptSent', 'upload-ref', 'mjCustomId',
    'assertPublicRefUrl', 'mjEffectiveSpeed', 'speedNote']) {
    assert.ok(R.includes(lit), `缺字面:${lit}`);
  }
});
check('§7.5 必现字面(垫图传法):mjRefMode 与 mjRefModeFor(', () => {
  assert.ok(R.includes('mjRefMode'), '缺 mjRefMode');
  assert.ok(R.includes('mjRefModeFor('), '缺 mjRefModeFor( 调用');
});
check('M34/§7.5 不许出现 MJ_IMAGE_REF_MODE', () => {
  assert.ok(!R.includes('MJ_IMAGE_REF_MODE'));
});
check('K3/§7.5 function pollTask 仍恰好 1 次(只改签名不复制状态机)', () => {
  assert.equal(count(R, /function pollTask/g), 1, `实得 ${count(R, /function pollTask/g)} 处`);
});
const RUNNER = (() => {
  const a = R.indexOf('async function runImageJob');
  const b = R.indexOf("router.post('/image/generate'");
  return a >= 0 && b > a ? R.slice(a, b) : '';
})();
check('§7.5 能切出 runImageJob 文本区间(runner 在 generate 路由之前)', () => {
  assert.ok(RUNNER.length > 0, '切不出 RUNNER 区间(位置锁无从判定)');
});
check('K16/M51/§7.5 位置锁:RUNNER 内 undiciFetch( 恰 2 次(两处新外联必须落在区间之外)', () => {
  assert.equal(count(RUNNER, /undiciFetch\(/g), 2, `实得 ${count(RUNNER, /undiciFetch\(/g)} 次`);
});
check('K16/§7.5 位置锁:RUNNER 内 await assertPublicBaseURL( 恰 1 次', () => {
  assert.equal(count(RUNNER, /await assertPublicBaseURL\(/g), 1, `实得 ${count(RUNNER, /await assertPublicBaseURL\(/g)} 次`);
});
check('K16/§7.5 位置锁:RUNNER 内 redirect: \'manual\' 恰 2 次', () => {
  assert.equal(count(RUNNER, /redirect: 'manual'/g), 2, `实得 ${count(RUNNER, /redirect: 'manual'/g)} 次`);
});
check('K16/§7.5 位置锁:RUNNER 内 readCapped( 恰 2 次', () => {
  assert.equal(count(RUNNER, /readCapped\(/g), 2, `实得 ${count(RUNNER, /readCapped\(/g)} 次`);
});
check('§7.5 零 diff 整段:下载分支的 assertPublicBaseURL(picked.url, { allowLoopback: sameOrigin })', () => {
  assert.ok(R.includes('assertPublicBaseURL(picked.url, { allowLoopback: sameOrigin })'), '这一段本轮零 diff');
});
check('§7.5 零 diff 整段:resolvePreviewPath / realPathInsideSaveDirs / redactKey 调用点仍在', () => {
  for (const lit of ['resolvePreviewPath(', 'realPathInsideSaveDirs(', 'redactKey(']) {
    assert.ok(R.includes(lit), `缺调用点:${lit}`);
  }
});
check('§7.5 零 diff 整段:MAX_CONCURRENT_JOBS / withHistory / mutateImageProviders 仍在', () => {
  for (const lit of ['MAX_CONCURRENT_JOBS', 'withHistory', 'mutateImageProviders']) {
    assert.ok(R.includes(lit), `缺:${lit}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §7.6 client/src/components/ImagePanel.jsx');
// ══════════════════════════════════════════════════════════════════════════
check('§7.6 必现字面:compileMjFlags( / mjCapsFor( / mjEffectiveSpeed( / mj-proxy', () => {
  for (const lit of ['compileMjFlags(', 'mjCapsFor(', 'mjEffectiveSpeed(', 'mj-proxy']) {
    assert.ok(P.includes(lit), `缺:${lit}`);
  }
});
check('R7/M47/§7.6 必现字面:取出单图 与 真放大', () => {
  assert.ok(P.includes('取出单图'), '缺「取出单图」');
  assert.ok(P.includes('真放大'), '缺「真放大」');
});
check('R12/B3b/§7.6 必现字面:高清 与 不额外计费(HD 控件标签与说明,真机 V5 结论)', () => {
  assert.ok(P.includes('高清'), '缺「高清」');
  assert.ok(P.includes('不额外计费'), '缺「不额外计费」');
});
check('B15/§7.6 必现字面:naturalWidth 与 naturalHeight(像素尺寸从图片本身读)', () => {
  assert.ok(P.includes('naturalWidth'), '缺 naturalWidth');
  assert.ok(P.includes('naturalHeight'), '缺 naturalHeight');
});
check('B16/B17/§7.6 <ImageLightbox 传参含 meta / actualSize / onToggleActualSize,且仍含 onPrev / onNext / counter', () => {
  const at = P.indexOf('<ImageLightbox');
  assert.ok(at > 0, '找不到 <ImageLightbox 挂载点');
  const tag = P.slice(at, P.indexOf('/>', at) + 2);
  for (const p of ['meta', 'actualSize', 'onToggleActualSize', 'onPrev', 'onNext', 'counter']) {
    assert.ok(tag.includes(p), `挂载点缺 ${p}`);
  }
});
check('M54/B25/§7.6 模型输入框那行 class 含 min-w-0', () => {
  const line = P.split('\n').find((l) => l.includes('cgui-image-model-options') || (l.includes('form.model') && l.includes('className')));
  assert.ok(line, '找不到模型输入框那一行');
  assert.ok(line.includes('min-w-0'), `该行缺 min-w-0(实得 ${line.trim().slice(0, 160)})`);
});
check('K6/§7.6 history 形态 ref 仍逐字含 kind: \'history\', file: r.file(role 追加其后)', () => {
  assert.ok(P.includes("kind: 'history', file: r.file"), '这段字面本轮不许改');
});
check('E1/M47/§7.6 不许出现 MJ_ACTION_LABEL = { 与值恰为 \'放大\' 的动作标签', () => {
  assert.ok(!P.includes('MJ_ACTION_LABEL = {'), '旧的两项标签表必须被 MJ_ACTION_LABELS 取代');
  assert.equal(count(P, /: '放大'/g), 0, `出现了值恰为「放大」的标签(实得 ${count(P, /: '放大'/g)} 处)`);
});
check('§7.6 不许出现 window.addEventListener(\'keydown\' 与 setZoom({ src:', () => {
  assert.equal(count(P, /window\.addEventListener\('keydown'/g), 0);
  assert.equal(count(P, /setZoom\(\{ src:/g), 0);
});
check('M49/K11/§7.6 不许出现 versions: [(版本门表只许落 mj-params.js)', () => {
  assert.equal(count(P, /versions: \[/g), 0, `实得 ${count(P, /versions: \[/g)} 处`);
});
check('§7.6 回归(字面):r95 与 r84 的既有锚点一个不少', () => {
  for (const lit of ['flattenBrowsable(ordered)', 'const goShot = (dir)', '{imageStrip(current)}',
    'reveal(shotFile(h))', "const MJ_GRID_POSITIONS = ['左上', '右上', '左下', '右下']",
    '来自上一任务第 ${h.mjIndex} 张', 'refs.length + picked.length > MAX_REFS',
    "form.protocol === 'mj' &&", '(sizeOptionsFor(dialect, form.model) ?? SIZE_OPTIONS).map',
    'const sizeCap = sizeCapFor(dialect, form.model)']) {
    assert.ok(P.includes(lit), `缺回归锚点:${lit}`);
  }
});
check('§7.6 回归(精确计数):setZoom({ id: 恰 3 次', () => {
  assert.equal(count(P, /setZoom\(\{ id:/g), 3, `实得 ${count(P, /setZoom\(\{ id:/g)} 次`);
});
check('§7.6 回归(精确计数):{imageStrip(h)} 恰 2 次', () => {
  assert.equal(count(P, /\{imageStrip\(h\)\}/g), 2, `实得 ${count(P, /\{imageStrip\(h\)\}/g)} 次`);
});
check('§7.6 回归(精确计数):CANCEL_NOTE 恰 3 次(mj-proxy 不得另起一套条目渲染)', () => {
  assert.equal(count(P, /CANCEL_NOTE/g), 3, `实得 ${count(P, /CANCEL_NOTE/g)} 次`);
});
check('§7.6 回归(精确计数):进度渲染 h.progress == null 那段恰 2 次', () => {
  const n = count(P, /h\.progress == null \? '' : ` · \$\{h\.progress\}%`/g);
  assert.equal(n, 2, `实得 ${n} 次`);
});
check('§7.6 回归(精确计数):h.files?.length > 1 ? 恰 2 次', () => {
  assert.equal(count(P, /h\.files\?\.length > 1 \?/g), 2, `实得 ${count(P, /h\.files\?\.length > 1 \?/g)} 次`);
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §6 组件层可观测行为(源码可判定的那部分)');
// ══════════════════════════════════════════════════════════════════════════
check('B1 协议下拉出现 midjourney-proxy 选项,且说明写明末尾 /mj 会被去掉', () => {
  assert.ok(/midjourney-proxy|mj-proxy/.test(P), '缺 mj-proxy 协议项');
  assert.ok(P.includes('/mj'), '地址说明要提到末尾 /mj');
  assert.ok(/去掉|自动去|剥/.test(P), '要说明末尾 /mj 会被去掉');
});
check('B2/B28 turbo 说明按【本 GUI 的实际行为】写:出现「按 fast 下发」口径,且不得写「按 turbo 计费」', () => {
  assert.ok(/按 fast 下发/.test(P), '缺「提交时按 fast 下发」这句实际行为陈述');
  assert.ok(!/按 turbo 计费/.test(P), '不得写成「按 turbo 计费」(与实际不符)');
});
check('R12/B12 MJ_NO_UPSCALE_NOTE 在面板里被消费(该站不提供真放大时显示)', () => {
  assert.ok(P.includes('MJ_NO_UPSCALE_NOTE'), '面板必须渲染这条说明');
});
check('B12b 「取出单图」的说明如实写像素不变、不放大', () => {
  assert.ok(/像素不变/.test(P), '缺「像素不变」');
  assert.ok(/不放大/.test(P), '缺「不放大」');
});
check('B21 上传换链接后显示有效期提示(72 小时)', () => {
  assert.ok(/72\s*小时|72h|72 h/i.test(P), '缺 72 小时有效期提示');
});
check('B29 「垫图传法」三个选项的说明各写一句(每张约 $0.05 / base64 直接随请求 / 只接受公网图片链接)', () => {
  assert.ok(/0\.05/.test(P), '缺 upload 档的每张约 $0.05 提示');
  assert.ok(/base64/.test(P), '缺 inline 档的 base64 直传说明');
  assert.ok(/公网图片链接|公网链接/.test(P), '缺 url 档的公网链接说明');
});
check('B30 mj-proxy 说明另起一块,且说明该协议固定以 base64 随请求提交', () => {
  assert.ok(P.includes("form.protocol === 'mj' &&"), 'mj 说明块条件字面不许改');
  assert.ok(/mj-proxy/.test(P), 'mj-proxy 说明块要存在');
});
check('B24 是否显示"候选已按 X 过滤"小字按 cap.unknown 判,不按 family 文案判', () => {
  assert.ok(/unknown/.test(P), '面板要读 cap.unknown');
  assert.ok(!/family === '未登记模型'/.test(P), '不许按 family 文案判');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §7.7 / §7.8 ImageLightbox 与两个未接导航的调用点');
// ══════════════════════════════════════════════════════════════════════════
check('R8/§7.7 ImageLightbox 签名含 meta / actualSize / onToggleActualSize', () => {
  const m = LB.match(/ImageLightbox[^(]*\(([\s\S]*?)\)\s*(?:=>\s*)?\{/);
  assert.ok(m, '找不到 ImageLightbox 组件签名');
  for (const p of ['meta', 'actualSize', 'onToggleActualSize']) {
    assert.ok(m[1].includes(p), `签名缺 ${p}`);
  }
});
check('§7.7 r95 既有锁仍满足:onPrev / onNext / counter 在签名里', () => {
  const m = LB.match(/ImageLightbox[^(]*\(([\s\S]*?)\)\s*(?:=>\s*)?\{/);
  assert.ok(m, '找不到签名');
  for (const p of ['onPrev', 'onNext', 'counter']) assert.ok(m[1].includes(p), `签名缺 ${p}`);
});
check('M53/K10/§7.7 ImageLightbox 仍无自有状态(不出现 useState)', () => {
  assert.ok(!/\buseState\b/.test(LB), '新增 props 不许引入 state');
});
check('§7.7 r95 既有锁:不出现 flattenBrowsable / neighbor / entryFiles / ordered / history', () => {
  for (const id of ['flattenBrowsable', 'neighbor', 'entryFiles', 'ordered', 'history']) {
    assert.ok(!new RegExp(`\\b${id}\\b`).test(LB), `Lightbox 是哑组件,发现 ${id}`);
  }
});
check('§7.7 r95 既有锁:Esc 三件套与 nav 守卫、滚动锁 }, [open]) 都还在', () => {
  assert.match(LB, /'Escape'\)[^\n]*stopImmediatePropagation\(\)[^\n]*preventDefault\(\)[^\n]*onClose\(\)/);
  assert.match(LB, /const nav = !!\(onPrev \|\| onNext\)/);
  assert.match(LB, /if \(!nav\) return/);
  assert.match(LB, /document\.body\.style\.overflow = 'hidden'[\s\S]{0,240}\}, \[open\]\)/);
});
check('§7.7 新增:stopPropagation() 至少 4 次(1:1 按钮同样不许冒泡关掉放大层)', () => {
  const n = count(LB, /stopPropagation\(\)/g);
  assert.ok(n >= 4, `实得 ${n} 处,需 ≥4`);
});
check('§7.7 图标仍来自 ./Icon.jsx', () => {
  assert.match(LB, /from '\.\/Icon\.jsx'/);
});
const R95_CALL = "<ImageLightbox src={zoomImage?.src} name={zoomImage?.name} path={zoomImage?.path} onClose={() => setZoomImage(null)} />";
for (const f of ['client/src/components/MessageBubble.jsx', 'client/src/components/ChatInput.jsx']) {
  const short = f.split('/').pop();
  const S = read(f);
  check(`B18/§7.8 ${short} 的调用行仍逐字是 r95 形态`, () => {
    assert.ok(S.length > 0, '文件读不到');
    assert.ok(S.includes(R95_CALL), `调用行必须逐字仍是:\n      ${R95_CALL}`);
  });
  check(`B18/§7.8 ${short} 不出现 actualSize / onToggleActualSize,放大层挂载点也不传 meta`, () => {
    // actualSize / onToggleActualSize 是本轮新造的标识符,全文件级断言不会误伤;
    // meta 是通用词(ChatInput 里本来就有 MODE_META 派生的局部变量 meta),只能锁在挂载点上。
    for (const p of ['actualSize', 'onToggleActualSize']) {
      assert.ok(!new RegExp(`\\b${p}\\b`).test(S), `发现 ${p} —— 这两处放大层不接新能力`);
    }
    const at = S.indexOf('<ImageLightbox');
    assert.ok(at > 0, '找不到 <ImageLightbox 挂载点');
    const tag = S.slice(at, S.indexOf('/>', at) + 2);
    assert.ok(!/\bmeta\b/.test(tag), `挂载点不许传 meta(实得 ${tag})`);
  });
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §7.9 零 diff 文件');
// ══════════════════════════════════════════════════════════════════════════
check('§7.9 tests/acceptance/** 、PROJECT.md、client/src/utils/imageEntry.js 本轮零改动', () => {
  let base = '';
  try {
    base = execFileSync('git', ['merge-base', 'HEAD', 'master'], { cwd: root, encoding: 'utf8' }).trim();
  } catch (e) {
    console.log('    (跳过:git 不可用 —', String(e.message).split('\n')[0], ')');
    return;
  }
  const changed = execFileSync('git', ['diff', '--name-only', base, '--',
    'tests/acceptance', 'PROJECT.md', 'client/src/utils/imageEntry.js'], { cwd: root, encoding: 'utf8' }).trim();
  assert.strictEqual(changed, '', `这些文件本轮一行都不该改:\n      ${changed.split('\n').join('\n      ')}`);
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r94-panel: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r94-panel: 五个模块的源码锁 + 面板 HD/真放大文案 + Lightbox 新增 props + 零 diff 全绿');
