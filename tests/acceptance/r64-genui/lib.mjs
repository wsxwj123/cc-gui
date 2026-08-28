// r64-genui 验收测试公共库(零依赖,node 原生跑)。
// 只依据 .devflow/INTERFACE-r64-genui.md 的黑盒契约写断言,不看实现代码。
//
// ── 测试与实现之间唯一的约定(除此之外不对实现结构作任何假设)────────────────────
// 实现方必须提供一个**不 import React / CSS / 浏览器 API** 的模块,导出下面 4 个纯函数。
// 放在哪个文件由实现方决定:设环境变量 GENUI_TEST_MODULE=<绝对路径> 即可,
// 下面的 CANDIDATES 只是省事用的默认查找位置,不构成目录结构要求。
//
//   matchFenceLang(info: string) -> boolean
//     info = ``` 后面那一整串(如 "cgui-ui title=x")。命中规则见 §1.1。
//
//   parseSpec(fenceBody: string, opts?: { finalized?: boolean }) -> {
//     ok:      boolean   // true=渲染成组件树;false=退回原始代码块(§5 总原则②)
//     root:    null | { title?: string, gap: number, items: Node[] }   // ok=false 时为 null
//     ignored: number    // "N 个不支持的组件已忽略"里的 N;0 表示不显示那行灰字
//     notice:  null | string  // 用户可见的说明条文案(红条/超大说明);无提示时 null
//   }
//     opts.finalized 默认 true(已定稿)。false = 流式期未写完。
//     Node = 归一化后的组件节点,字段名沿用 §2 各表(type / items / rows / series …)。
//
//   buildActionText(evt: { action: string, component: object }) -> string
//     返回替用户发出的那条消息全文(§3.2)。非法动作名时允许抛错或返回空。
//
//   evalPlotExpr(expr: string, params?: Record<string, number>) -> number | null
//     §2.8 的表达式求值。非法表达式返回 null(不得抛、不得走 eval/new Function)。
//
// 功能没实现时这些 import 会失败,整片红是预期(会打印一行人话说明缺什么)。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const CANDIDATES = [
  'client/src/genui/contract.mjs',
  'client/src/genui/contract.js',
  'client/src/genui/index.mjs',
];

let _mod = null;
export async function genui() {
  if (_mod) return _mod;
  const envp = process.env.GENUI_TEST_MODULE;
  const tried = [];
  for (const c of envp ? [envp] : CANDIDATES) {
    const p = path.isAbsolute(c) ? c : path.join(ROOT, c);
    tried.push(p);
    if (!fs.existsSync(p)) continue;
    _mod = await import(pathToFileURL(p).href);
    break;
  }
  if (!_mod) {
    throw new Error(
      '缺少交付物:genui 纯逻辑契约模块(导出 matchFenceLang / parseSpec / buildActionText / evalPlotExpr)\n'
      + '  已查找:\n    ' + tried.join('\n    ') + '\n'
      + '  实现放在别处时用 GENUI_TEST_MODULE=<绝对路径> 指定。\n'
      + '  该模块必须能被裸 node import(不得 import React / CSS / DOM),否则验收测试跑不起来。');
  }
  for (const fn of ['matchFenceLang', 'parseSpec', 'buildActionText', 'evalPlotExpr']) {
    if (typeof _mod[fn] !== 'function') throw new Error(`契约模块缺少导出函数:${fn}`);
  }
  return _mod;
}

// ── 便捷封装:让每条用例只写"输入什么、断言什么"────────────────────────────────
/** 解析一份 spec。传对象自动 JSON.stringify;传字符串原样送(用来测非法 JSON)。 */
export async function parse(specOrText, opts) {
  const { parseSpec } = await genui();
  const body = typeof specOrText === 'string' ? specOrText : JSON.stringify(specOrText);
  const r = parseSpec(body, opts);
  assert.ok(r && typeof r === 'object', 'parseSpec 必须返回对象,实际:' + String(r));
  assert.equal(typeof r.ok, 'boolean', 'parseSpec 结果缺 ok:boolean');
  assert.equal(typeof r.ignored, 'number', 'parseSpec 结果缺 ignored:number');
  if (r.ok) assert.ok(r.root && Array.isArray(r.root.items), 'ok=true 时 root.items 必须是数组');
  return r;
}
/** 把单个组件节点包成 items 解析,返回归一化后的该节点;被丢弃时返回 null。 */
export async function node(n, opts) {
  const r = await parse({ items: [n] }, opts);
  if (!r.ok) return null;
  return r.root.items.length ? r.root.items[0] : null;
}
/** 同上,但连 ignored 计数一起返回,用来断言"丢弃要计数"。 */
export async function nodeR(n, opts) {
  const r = await parse({ items: [n] }, opts);
  return { r, n: r.ok && r.root.items.length ? r.root.items[0] : null };
}
export function typesOf(r) { return r.ok ? r.root.items.map((x) => x && x.type) : []; }
/** 全树节点计数(把任何数组字段里的 {type:...} 都算一个节点)。 */
export function countNodes(v) {
  if (Array.isArray(v)) return v.reduce((s, x) => s + countNodes(x), 0);
  if (!v || typeof v !== 'object') return 0;
  let n = typeof v.type === 'string' ? 1 : 0;
  for (const k of Object.keys(v)) if (k !== 'type') n += countNodes(v[k]);
  return n;
}
/** 深度 d 的 col 嵌套链,最里面放一个可识别的 text。 */
export function nest(d, leaf = { type: 'text', content: 'LEAF' }) {
  let cur = leaf;
  for (let i = 0; i < d - 1; i++) cur = { type: 'col', items: [cur] };
  return cur;
}
/** 整棵树里是否出现过某个字符串(用来断言"被丢弃"是真丢了,不是藏在别的字段)。 */
export function hasText(v, s) { return JSON.stringify(v === undefined ? null : v).includes(s); }

// ── 44 种白名单类型的最小合法样本(字段取自 §2 各表的"必填"列)────────────────
export const SAMPLES = {
  text: { type: 'text', content: 'hi' },
  row: { type: 'row', items: [{ type: 'text', content: 'a' }] },
  col: { type: 'col', items: [{ type: 'text', content: 'a' }] },
  grid: { type: 'grid', items: [{ type: 'text', content: 'a' }], cols: 2 },
  card: { type: 'card', items: [{ type: 'text', content: 'a' }] },
  divider: { type: 'divider' },
  spacer: { type: 'spacer' },
  stat: { type: 'stat', label: 'L', value: '42' },
  badge: { type: 'badge', label: 'B' },
  progress: { type: 'progress', label: 'P', value: 50 },
  avatar: { type: 'avatar', name: 'Ann' },
  list: { type: 'list', items: ['a', 'b'] },
  table: { type: 'table', columns: ['c1'], rows: [['1']] },
  keyvalue: { type: 'keyvalue', pairs: [{ key: 'k', value: 'v' }] },
  timeline: { type: 'timeline', items: [{ title: 't' }] },
  steps: { type: 'steps', steps: [{ title: 's' }] },
  breadcrumb: { type: 'breadcrumb', items: ['a'] },
  'file-tree': { type: 'file-tree', items: [{ name: 'a.txt', type: 'file' }] },
  callout: { type: 'callout', content: 'c' },
  code: { type: 'code', code: 'x=1', lang: 'js' },
  json: { type: 'json', value: { a: 1 } },
  diff: { type: 'diff', diffs: [{ path: 'p.txt', oldText: null, newText: 'n' }] },
  link: { type: 'link', label: 'L', href: 'https://example.com' },
  audio: { type: 'audio', src: '/api/files/a.mp3' },
  video: { type: 'video', src: '/api/files/a.mp4' },
  chart: { type: 'chart', data: [{ label: 'a', value: 1 }] },
  plot: { type: 'plot', series: [{ expr: 'sin(x)' }] },
  echart: { type: 'echart', data: [{ label: 'a', value: 1 }] },
  button: { type: 'button', label: 'B', action: 'go' },
  input: { type: 'input', label: 'L' },
  textarea: { type: 'textarea', label: 'L' },
  select: { type: 'select', options: ['a', 'b'] },
  radio: { type: 'radio', options: ['a', 'b'] },
  checkbox: { type: 'checkbox', label: 'L' },
  switch: { type: 'switch', label: 'L' },
  slider: { type: 'slider', label: 'L' },
  submit: { type: 'submit', label: '交卷' },
  quiz: { type: 'quiz', question: 'q', options: [{ label: 'a', correct: true }] },
  tabs: { type: 'tabs', tabs: [{ label: 't', items: [{ type: 'text', content: 'x' }] }] },
  accordion: { type: 'accordion', items: [{ title: 't', items: [{ type: 'text', content: 'x' }] }] },
  copy: { type: 'copy', text: 'x' },
  mermaid: { type: 'mermaid', code: 'flowchart TD\n  A-->B' },
  diagram: { type: 'diagram', kind: 'architecture', nodes: [{ label: 'A', type: 'focal' }] },
  scene3d: { type: 'scene3d', meshes: [{ shape: 'box' }] },
};
export const ALL_TYPES = Object.keys(SAMPLES);

// 交付物还没实现时把一屏栈变成一行人话
process.on('uncaughtException', (e) => {
  console.log('FAIL - 测试文件无法启动');
  console.log('       ' + String((e && e.message) || e).split('\n').join('\n       '));
  process.exit(1);
});

// ── 极简用例壳(不引框架):每条用例只测一件事,互不依赖,失败不中断后面的用例
let pass = 0, fail = 0, skipped = 0;
export async function t(name, fn) {
  try { await fn(); pass++; console.log('ok   - ' + name); }
  catch (e) {
    fail++;
    console.log('FAIL - ' + name);
    console.log('       ' + String((e && e.message) || e).split('\n').join('\n       '));
  }
}
export function skip(name, why) { skipped++; console.log('skip - ' + name + '  ← ' + why); }
export function done(label) {
  console.log(`\n[${label}] 通过 ${pass} / 失败 ${fail} / 跳过 ${skipped}`);
  process.exit(fail ? 1 : 0);
}
