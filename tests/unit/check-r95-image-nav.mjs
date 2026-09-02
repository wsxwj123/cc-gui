#!/usr/bin/env node
// r95:生图面板两条 UX —— ① 任务列表里所有图可用方向键左右切换;② 开始生图后预览区
// 立刻不再显示上一轮的图。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r95.md 的对外契约写,
// 不看实现。两部分:
//   A. 纯函数契约(flattenBrowsable / shotPos / neighbor):真 import 真跑。
//   B. 源码锁(JSX 进不了 node,只能读文件做结构断言),逐条抄 INTERFACE 第 3 节。
// 断言消息里带 INTERFACE 编号(B*/R*/M*),红了能直接对回契约表。
//
// 设计要点:纯函数部分用【动态 import + 逐条 try/catch】。静态 import 一个还不存在的
// 导出会在 ESM 链接阶段直接抛错、后面一条断言都跑不到;改前必须"每条各自红",
// 才看得出到底缺哪几件。
//
// Run: node tests/unit/check-r95-image-nav.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
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
    const msg = String(e && e.message || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// A. 纯函数契约(INTERFACE 第 1 节)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] 纯函数契约 client/src/utils/imageEntry.js');

let MOD = null;
let MODERR = '';
try {
  MOD = await import('../../client/src/utils/imageEntry.js');
} catch (e) {
  MODERR = String(e && e.message || e);
}
check('A0 imageEntry.js 可被 node 直接 import(零依赖纯函数模块)', () => {
  assert.ok(MOD, `import 失败:${MODERR}`);
});

const flattenBrowsable = MOD?.flattenBrowsable;
const shotPos = MOD?.shotPos;
const neighbor = MOD?.neighbor;
const entryFiles = MOD?.entryFiles;

// INTERFACE 1.1 的基准 fixture(逐字抄)
const four = { id: 'A', status: 'done', prompt: '猫', file: '/i/a.png',
               files: ['/i/a.png', '/i/b.png', '/i/c.png', '/i/d.png'] };
const one = { id: 'B', status: 'done', prompt: '狗', file: '/i/s.png' };
const run = { id: 'C', status: 'running', prompt: '跑' };
const bad = { id: 'D', status: 'error', prompt: '错', error: 'boom' };
const empty = { id: 'E', status: 'done', prompt: '空' };
const EXPECT = [
  { id: 'A', index: 0, file: '/i/a.png', prompt: '猫' },
  { id: 'A', index: 1, file: '/i/b.png', prompt: '猫' },
  { id: 'A', index: 2, file: '/i/c.png', prompt: '猫' },
  { id: 'A', index: 3, file: '/i/d.png', prompt: '猫' },
  { id: 'B', index: 0, file: '/i/s.png', prompt: '狗' },
];
// 每次现算,避免"函数还不存在"时顶层求值直接终止整个文件。
const mk = () => flattenBrowsable([run, four, one, bad, empty]);
// 只比 INTERFACE 写明的四个字段(实现多带字段不算违约)。
const slim = (s) => ({ id: s.id, index: s.index, file: s.file, prompt: s.prompt });

// ── 1.1 flattenBrowsable ──────────────────────────────────────────────
check('R1 flattenBrowsable 已导出且是函数', () => {
  assert.equal(typeof flattenBrowsable, 'function');
});
check('A1 flattenBrowsable(非法入参 [] / null / undefined / \'x\' / {} / 0)一律返回 []', () => {
  for (const v of [[], null, undefined, 'x', {}, 0]) {
    assert.deepEqual(flattenBrowsable(v), [], `入参 ${JSON.stringify(v) ?? String(v)} 应得 []`);
  }
});
check('A2 基准 fixture 展平结果逐项相等(M2 过滤非 done + M3 用 entryFiles + M4 不重排)', () => {
  assert.deepEqual(mk().map(slim), EXPECT);
});
check('M2 running 条目不产出任何项', () => {
  assert.deepEqual(flattenBrowsable([run]), []);
});
check('M2 error / cancelled / interrupted 条目不产出任何项', () => {
  for (const st of ['error', 'cancelled', 'interrupted', 'pending', undefined]) {
    assert.deepEqual(flattenBrowsable([{ id: 'X', status: st, prompt: 'p', file: '/i/x.png' }]), [],
      `status=${String(st)} 不该产出项(只有 status==='done' 可看)`);
  }
});
check('A3 done 但无 file 也无 files 的条目不产出任何项', () => {
  assert.deepEqual(flattenBrowsable([empty]), []);
});
check('A4 单图条目产出 1 项,index=0', () => {
  assert.deepEqual(flattenBrowsable([one]).map(slim), [{ id: 'B', index: 0, file: '/i/s.png', prompt: '狗' }]);
});
check('M3 多图条目产出 4 项,index 0→3,file 顺序与 files 逐字一致', () => {
  const got = flattenBrowsable([four]);
  assert.equal(got.length, 4, '多图条目必须产出 4 项(用 entryFiles(h),不是 h.file)');
  assert.deepEqual(got.map((s) => s.index), [0, 1, 2, 3]);
  assert.deepEqual(got.map((s) => s.file), four.files);
});
check('M3 flattenBrowsable 必须用 entryFiles(条目内顺序与 entryFiles(h) 逐项一致)', () => {
  assert.equal(typeof entryFiles, 'function', 'entryFiles 既有导出必须还在');
  for (const h of [four, one]) {
    assert.deepEqual(flattenBrowsable([h]).map((s) => s.file), entryFiles(h),
      `条目 ${h.id} 内顺序必须 === entryFiles(h) 顺序`);
  }
});
check('A5 条目缺 prompt 时产出项的 prompt === \'\'(不是 undefined/null)', () => {
  const got = flattenBrowsable([{ id: 'F', status: 'done', file: '/i/f.png' }]);
  assert.equal(got.length, 1);
  assert.strictEqual(got[0].prompt, '');
});
check('A6 数组里混有 null / 非对象:跳过且不抛错', () => {
  const got = flattenBrowsable([null, one, undefined, 'x', 7, [], four]);
  assert.deepEqual(got.map(slim), [EXPECT[4], ...EXPECT.slice(0, 4)]);
});
check('M4 顺序契约:条目顺序 = 入参顺序,不重排', () => {
  assert.deepEqual(flattenBrowsable([one, four]).map((s) => s.id), ['B', 'A', 'A', 'A', 'A']);
  assert.deepEqual(flattenBrowsable([four, one]).map((s) => s.id), ['A', 'A', 'A', 'A', 'B']);
});

// ── 1.2 shotPos ───────────────────────────────────────────────────────
check('A7 shotPos 已导出且是函数', () => {
  assert.equal(typeof shotPos, 'function');
});
check('A8 shotPos(shots, {id:\'B\',index:0}) === 4', () => {
  assert.strictEqual(shotPos(mk(), { id: 'B', index: 0 }), 4);
});
check('A9 shotPos(shots, {id:\'A\',index:3}) === 3', () => {
  assert.strictEqual(shotPos(mk(), { id: 'A', index: 3 }), 3);
});
check('A10 shotPos 的 cur 为 null / undefined / \'\' → -1', () => {
  const s = mk();
  for (const cur of [null, undefined, '']) assert.strictEqual(shotPos(s, cur), -1, `cur=${String(cur)}`);
});
check('A11 shotPos 的 shots 为 null / \'x\' / [] → -1', () => {
  for (const v of [null, undefined, 'x', {}, []]) {
    assert.strictEqual(shotPos(v, { id: 'A', index: 0 }), -1, `shots=${String(v)}`);
  }
});
check('A12 shotPos 条目不在序列(id ZZZ)→ -1', () => {
  assert.strictEqual(shotPos(mk(), { id: 'ZZZ', index: 0 }), -1);
});
check('M5 shotPos 下标越界(id A / index 99)→ -1(不能只比 id)', () => {
  assert.strictEqual(shotPos(mk(), { id: 'A', index: 99 }), -1);
});
check('M5 shotPos 字符串下标(index \'0\')→ -1(index 必须 === 严格相等)', () => {
  assert.strictEqual(shotPos(mk(), { id: 'A', index: '0' }), -1);
});
check('A13 不变式:对每一项 s 与其下标 i,shotPos(shots, s) === i', () => {
  const s = mk();
  assert.ok(s.length > 0, 'fixture 展平后不该为空');
  s.forEach((item, i) => assert.strictEqual(shotPos(s, item), i, `第 ${i} 项自查失败`));
});

// ── 1.3 neighbor ──────────────────────────────────────────────────────
check('A14 neighbor 已导出且是函数', () => {
  assert.equal(typeof neighbor, 'function');
});
check('B2 neighbor 同条目内下一张:A#0 --(1)--> A#1', () => {
  assert.deepEqual(slim(neighbor(mk(), { id: 'A', index: 0 }, 1)), EXPECT[1]);
});
check('B2 neighbor 跨条目:A#3 --(1)--> B#0(本条目最后一张跳到下一个条目第一张)', () => {
  assert.deepEqual(slim(neighbor(mk(), { id: 'A', index: 3 }, 1)), EXPECT[4]);
});
check('B3 neighbor 反向跨条目:B#0 --(-1)--> A#3', () => {
  assert.deepEqual(slim(neighbor(mk(), { id: 'B', index: 0 }, -1)), EXPECT[3]);
});
check('M1/B4 序列第一张按 ← 返回 null(到头停住,不循环到末尾)', () => {
  assert.strictEqual(neighbor(mk(), { id: 'A', index: 0 }, -1), null);
});
check('M1/B4 序列最后一张按 → 返回 null(到头停住,不循环到开头)', () => {
  assert.strictEqual(neighbor(mk(), { id: 'B', index: 0 }, 1), null);
});
check('A15 dir 只取符号、幅度忽略:5 等同 1', () => {
  assert.deepEqual(slim(neighbor(mk(), { id: 'A', index: 1 }, 5)), EXPECT[2]);
});
check('A16 dir 只取符号、幅度忽略:-5 等同 -1', () => {
  assert.deepEqual(slim(neighbor(mk(), { id: 'A', index: 2 }, -5)), EXPECT[1]);
});
check('A17 dir 为 0 / \'x\' / null / undefined / NaN → null', () => {
  const s = mk();
  for (const d of [0, 'x', null, undefined, NaN]) {
    assert.strictEqual(neighbor(s, { id: 'A', index: 0 }, d), null, `dir=${String(d)}`);
  }
});
check('A18 neighbor([], cur, 1) → null', () => {
  assert.strictEqual(neighbor([], { id: 'A', index: 0 }, 1), null);
});
check('A19 neighbor(shots, null, 1) 与 neighbor(null, cur, 1) → null', () => {
  assert.strictEqual(neighbor(mk(), null, 1), null);
  assert.strictEqual(neighbor(null, { id: 'A', index: 0 }, 1), null);
  assert.strictEqual(neighbor(undefined, { id: 'A', index: 0 }, 1), null);
});
check('A20 neighbor 未知 id / 越界 index → null', () => {
  assert.strictEqual(neighbor(mk(), { id: 'ZZZ', index: 0 }, 1), null);
  assert.strictEqual(neighbor(mk(), { id: 'A', index: 99 }, 1), null);
  assert.strictEqual(neighbor(mk(), { id: 'A', index: 99 }, -1), null);
});
check('B8 单张序列:两个方向都 null', () => {
  const s = flattenBrowsable([one]);
  assert.equal(s.length, 1);
  assert.strictEqual(neighbor(s, { id: 'B', index: 0 }, 1), null);
  assert.strictEqual(neighbor(s, { id: 'B', index: 0 }, -1), null);
});
check('A21 全序列遍历:从第 0 项连按 → 恰好 shots.length-1 步后返回 null,且经过项逐项相等', () => {
  const s = mk();
  const seen = [s[0]];
  let cur = s[0];
  let steps = 0;
  while (steps < 100) {
    const nx = neighbor(s, cur, 1);
    if (nx === null) break;
    seen.push(nx);
    cur = nx;
    steps++;
  }
  assert.strictEqual(steps, s.length - 1, `应恰好走 ${s.length - 1} 步(到头停住,不循环)`);
  assert.deepEqual(seen.map(slim), s.map(slim), '经过的项必须与 shots 逐项一致');
});
check('A22 反向全序列遍历:从末项连按 ← 恰好 shots.length-1 步后返回 null', () => {
  const s = mk();
  let cur = s[s.length - 1];
  let steps = 0;
  while (steps < 100) {
    const pv = neighbor(s, cur, -1);
    if (pv === null) break;
    cur = pv;
    steps++;
  }
  assert.strictEqual(steps, s.length - 1);
  assert.deepEqual(slim(cur), EXPECT[0]);
});
check('A23 既有导出未被本轮改动挪走(entryFiles/pickedIndex/pickedFile/entryPreviewUrl/pickedPreviewUrl)', () => {
  for (const n of ['entryFiles', 'pickedIndex', 'pickedFile', 'entryPreviewUrl', 'pickedPreviewUrl']) {
    assert.equal(typeof MOD?.[n], 'function', `既有导出 ${n} 必须还在(check-r84-mj-actions t4 依赖)`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// B. 源码锁(INTERFACE 第 3 节)—— JSX 进不了 node,只能读文件做结构断言
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[B] 源码锁 3.1 ImageLightbox.jsx');
let LB = '';
try { LB = read('client/src/components/ImageLightbox.jsx'); } catch (e) { LB = ''; }
check('3.1-0 ImageLightbox.jsx 可读', () => assert.ok(LB.length > 0, '文件读不到或为空'));

check('3.1 组件签名含 onPrev / onNext / counter 三个 prop', () => {
  const m = LB.match(/ImageLightbox[^(]*\(([\s\S]*?)\)\s*(?:=>\s*)?\{/);
  assert.ok(m, '找不到 ImageLightbox 的组件签名');
  for (const p of ['onPrev', 'onNext', 'counter']) {
    assert.ok(m[1].includes(p), `B1/B7: 签名缺 ${p} —— 序列由 ImagePanel 算好后传进来`);
  }
});
check('M6 存在 const nav = !!(onPrev || onNext) 与 if (!nav) return 守卫', () => {
  assert.match(LB, /const nav = !!\(onPrev \|\| onNext\)/, 'B8/B9: 缺 nav 判定');
  assert.match(LB, /if \(!nav\) return/, 'B8/B9: 缺 if (!nav) return —— 没接导航的调用点必须完全不拦方向键');
});
check('B5 Esc 三件套仍在同一分支(stopImmediatePropagation → preventDefault → onClose)', () => {
  assert.match(LB, /'Escape'\)[^\n]*stopImmediatePropagation\(\)[^\n]*preventDefault\(\)[^\n]*onClose\(\)/);
});
check('R2/B2 ImageLightbox 出现 \'ArrowRight\'', () => {
  assert.ok(count(LB, /'ArrowRight'/g) >= 1, "缺 'ArrowRight'");
});
check('B3 ImageLightbox 出现 \'ArrowLeft\'', () => {
  assert.ok(count(LB, /'ArrowLeft'/g) >= 1, "缺 'ArrowLeft'");
});
check('B2/B3 方向键分支消费事件(Arrow* 附近 stopImmediatePropagation)', () => {
  assert.match(LB, /Arrow(Left|Right)[\s\S]{0,240}stopImmediatePropagation/,
    '方向键必须自己吃掉,否则会漏给面板外的全局快捷键');
});
check('M7/B10 滚动锁是独立 effect 且依赖不含 src(以 }, [open]) 收尾)', () => {
  assert.match(LB, /document\.body\.style\.overflow = 'hidden'[\s\S]{0,240}\}, \[open\]\)/,
    '依赖含 src 会让"切图 = 重跑 effect",连切多张再关闭可能残留 body 滚动锁');
});
check('M8/B7 翻页按钮阻断冒泡:stopPropagation() 至少 3 处', () => {
  const n = count(LB, /stopPropagation\(\)/g);
  assert.ok(n >= 3, `实得 ${n} 处,需 ≥3 —— 点翻页按钮不许冒泡到遮罩把放大层关掉`);
});
check('B7 ChevronLeft / ChevronRight 出现且 import 自 \'./Icon.jsx\'', () => {
  const imports = [...LB.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/Icon\.jsx'/g)].map((m) => m[1]).join(',');
  for (const ic of ['ChevronLeft', 'ChevronRight']) {
    assert.ok(LB.includes(ic), `缺 ${ic}`);
    assert.ok(imports.includes(ic), `${ic} 必须 import 自 './Icon.jsx'(图标统一走 Icon 间接层)`);
  }
});
check('3.1 哑组件:不出现 flattenBrowsable / neighbor / entryFiles / ordered / history', () => {
  for (const [re, id] of [[/\bflattenBrowsable\b/, 'flattenBrowsable'], [/\bneighbor\b/, 'neighbor'],
    [/\bentryFiles\b/, 'entryFiles'], [/\bordered\b/, 'ordered'], [/\bhistory\b/, 'history']]) {
    assert.ok(!re.test(LB), `Lightbox 是哑组件,不许在此处算序列(发现 ${id})`);
  }
});
check('3.1 ImageLightbox 无自有状态(不出现 useState)', () => {
  assert.ok(!/\buseState\b/.test(LB), '当前张由上层持有,组件内不许自持状态');
});
check('3.1 不出现 window.confirm / alert(Tauri webview 里这俩是哑的)', () => {
  assert.ok(!LB.includes('window.confirm'), '发现 window.confirm');
  assert.ok(!/\balert\(/.test(LB), '发现 alert(');
});

console.log('\n[B] 源码锁 3.2 ImagePanel.jsx');
let P = '';
try { P = read('client/src/components/ImagePanel.jsx'); } catch (e) { P = ''; }
check('3.2-0 ImagePanel.jsx 可读', () => assert.ok(P.length > 0, '文件读不到或为空'));

check('B1 序列取自任务列表展示顺序:flattenBrowsable(ordered)', () => {
  assert.match(P, /flattenBrowsable\(ordered\)/, '可看范围 = 任务列表里所有图,顺序与列表一致');
});
check('B2/B3 存在 const goShot = (dir) 且调用 neighbor(', () => {
  assert.match(P, /const goShot = \(dir\)/);
  assert.match(P, /neighbor\(/);
});
check('R4/M10 setZoom 全部改用条目坐标:setZoom({ id: 恰好 3 处', () => {
  assert.strictEqual(count(P, /setZoom\(\{ id:/g), 3, '预览区大图 / 网格视图 / 列表视图 三处调用点');
});
check('R4 setZoom( 调用点 ≥ 4 处(3 处开 + 关闭时置空)', () => {
  assert.ok(count(P, /setZoom\(/g) >= 4, `实得 ${count(P, /setZoom\(/g)} 处`);
});
check('M10 不许出现 setZoom({ src:(旧的 {src,name,path} 形态,无法定位序列位置)', () => {
  assert.strictEqual(count(P, /setZoom\(\{ src:/g), 0);
});
check('R3/M9/B11 generate 块内含 setCurrentId(d.jobId)', () => {
  const m = P.match(/const generate = async \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(m, '切不出 generate 块(签名被改了?)');
  assert.match(m[0], /setCurrentId\(d\.jobId\)/, '受理成功必须把预览区指向新任务,否则仍显示上一轮的图');
});
check('B14/E7 submitAction 按 G4 定死的两参签名切块,块内仍含 setCurrentId(d.jobId)', () => {
  // 【E7 / r94,G4 已定死签名】const submitAction = async (h, action) => {(条目 + Action 对象);
  // 块内"受理成功就把预览区指向新任务"这条 r95 结论一个字不变。
  const m = P.match(/const submitAction = async \(h, action\) => \{[\s\S]*?\n  \};/);
  assert.ok(m, 'E7:签名必须是 (h, action) 两参,且能切出整块');
  assert.match(m[0], /setCurrentId\(d\.jobId\)/, '放大/变体受理成功同样要指向新任务');
});
check('B11/B13 非 done 状态块存在(current.status !== \'done\' + elapsedSec + CANCEL_NOTE)', () => {
  assert.match(P, /current\.status !== 'done'/, '预览区必须有"非完成态"分支,不许回退显示旧图');
  assert.match(P, /elapsedSec\(current\)/, 'running 期间显示已耗秒数');
  assert.match(P, /CANCEL_NOTE/, '取消态提示文案');
});
check('M11/B16 loadHistory 回落规则逐字保留', () => {
  assert.match(P, /setCurrentId\(\(cur\) => \(list\.some\(\(h\) => h\.id === cur\) \? cur : \(list\.find\(\(h\) => h\.status === 'done'\)\?\.id \|\| ''\)\)\);/,
    '删除当前条目仍回落到最近一条已完成记录 —— 这一行本轮一个字都不许动');
});
check('B1/B7 <ImageLightbox 传参含 onPrev / onNext / counter', () => {
  const at = P.indexOf('<ImageLightbox');
  assert.ok(at > 0, '找不到 <ImageLightbox 挂载点');
  const tag = P.slice(at, P.indexOf('/>', at) + 2);
  for (const p of ['onPrev', 'onNext', 'counter']) {
    assert.ok(tag.includes(p), `挂载点缺 ${p}`);
  }
});
check('3.2 键盘只在 Lightbox 里:ImagePanel 不出现 window.addEventListener(\'keydown\'', () => {
  assert.strictEqual(count(P, /window\.addEventListener\('keydown'/g), 0,
    '面板级 keydown 会和会话 Esc 等全局快捷键打架');
});
check('3.2 r84 既有锁:path: h.file / reveal(h.file) / src={h.previewUrl} 各 0 次', () => {
  assert.strictEqual(count(P, /path: h\.file/g), 0);
  assert.strictEqual(count(P, /reveal\(h\.file\)/g), 0);
  assert.strictEqual(count(P, /src=\{h\.previewUrl\}/g), 0);
});
check('3.2 回归锁:{imageStrip(h)} 恰 2 次 且含 {imageStrip(current)}', () => {
  assert.strictEqual(count(P, /\{imageStrip\(h\)\}/g), 2);
  assert.ok(P.includes('{imageStrip(current)}'), '预览区缩略条不许丢');
});
check('3.2/E8 回归锁:含 submitAction(h, act)(与 r84 的 E5 同步)', () => {
  // 【E8 / r94,G4 已定死字面】
  assert.ok(P.includes('submitAction(h, act)'), 'E8:调用形态逐字为 submitAction(h, act)');
});
check('3.2 回归锁:含 reveal(shotFile(h))', () => {
  assert.ok(P.includes('reveal(shotFile(h))'));
});

console.log('\n[B] 源码锁 3.3 未接导航的两个调用点');
const CALL = "<ImageLightbox src={zoomImage?.src} name={zoomImage?.name} path={zoomImage?.path} onClose={() => setZoomImage(null)} />";
for (const f of ['client/src/components/MessageBubble.jsx', 'client/src/components/ChatInput.jsx']) {
  const short = f.split('/').pop();
  let S = '';
  try { S = read(f); } catch (e) { S = ''; }
  check(`B9 ${short} 的调用行逐字未变(不接导航)`, () => {
    assert.ok(S.length > 0, '文件读不到');
    assert.ok(S.includes(CALL), `调用行必须逐字仍是:\n      ${CALL}`);
  });
  check(`B9 ${short} 不出现 onPrev / onNext / counter`, () => {
    // 用词边界:ChatInput 里本来就有 onPreview 之类的标识符,裸 includes 会误报。
    for (const p of ['onPrev', 'onNext', 'counter']) {
      assert.ok(!new RegExp(`\\b${p}\\b`).test(S), `发现 ${p} —— 会话消息/输入框附件的放大层不该有方向键导航`);
    }
  });
}

console.log('\n[B] 源码锁 3.4 零 diff 文件');
// 【E9 / r94】本轮 server/routes/image.js 必须改(新增 mj-proxy / upload-ref / buttons 等),
// 零 diff 锁收窄为只查 tests/acceptance —— 收窄后这条立即绿,是 §9 R10 点名的两条天生绿之一。
check('3.4/E9 tests/acceptance/** 本轮零改动(server/routes/image.js 已移出该锁)', () => {
  let base = '';
  try {
    base = execFileSync('git', ['merge-base', 'HEAD', 'master'], { cwd: root, encoding: 'utf8' }).trim();
  } catch (e) {
    console.log('    (跳过:git 不可用 —', String(e.message).split('\n')[0], ')');
    return;
  }
  const changed = execFileSync('git', ['diff', '--name-only', base, '--', 'tests/acceptance'],
    { cwd: root, encoding: 'utf8' }).trim();
  assert.strictEqual(changed, '', `这些文件本轮一行都不该改:\n      ${changed.split('\n').join('\n      ')}`);
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r95-image-nav: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r95-image-nav: 序列展平/定位/相邻三函数契约 + Lightbox 导航与 Esc/滚动锁 + 预览区跟随新任务 全绿');
