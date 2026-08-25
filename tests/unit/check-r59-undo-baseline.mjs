#!/usr/bin/env node
// 单测:r59 撤销基线太晚(⌘Z 后留首字母) + 程序化写入不入栈(model 框 / 提示词回填撤不回)。
//
// 用户实报(0.2.345):「任意输入框输入内容,⌘Z 撤回后仍会留下输入的首字母」+
// 「model id 列表框内撤销无效」。
// 根因 A:惰性建栈发生在 input 回调里,此刻 el.value 已含首字母 → 基线 =「首字母」,
//         keydown 的 idx>0 守卫让撤销永远退不到空。修 = focusin/beforeinput 提前建栈。
// 根因 B:勾选弹窗「确认」/「恢复」按钮经 React setState 改受控值,不产生 DOM input
//         事件 → 撤销栈无记录,首次 ⌘Z 才建栈且基线已是「写入后的值」,无处可退。
//         修 = applyProgrammaticText(旧值先入栈 → 原生 setter 写 → 派发 input)。
//
// 本仓无 jsdom,故双层:
//   ① 逻辑层:给 inputUndo.js 垫 document/HTMLTextAreaElement/Event 的最小 DOM 实现真跑
//      (元素 value 做成原型 accessor —— 和真实 DOM 一样,这正是「原生 setter」技巧的前提)。
//   ② 源码锚:两个监听 + 两处调用点。
// Run: node tests/unit/check-r59-undo-baseline.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ───────────── DOM 垫片 ─────────────
const seen = []; // 派发到 document 的 input 事件流水(验「受控组件收得到」)

const doc = {
  _ls: new Map(), // type -> [{ fn, capture }]
  addEventListener(type, fn, capture) {
    if (!this._ls.has(type)) this._ls.set(type, []);
    this._ls.get(type).push({ fn, capture });
  },
  _fire(type, ev) { (this._ls.get(type) || []).forEach(({ fn }) => fn(ev)); },
};

class EventShim {
  constructor(type, opts) { this.type = type; this.bubbles = !!(opts && opts.bubbles); this.isComposing = false; }
}

// value 必须是原型上的 accessor:真实 <textarea> 就是这样,React 也正因此才要用
// Object.getOwnPropertyDescriptor(proto,'value').set 绕过自己的 value 追踪。
class TextAreaShim {
  constructor(value = '') { this.__v = String(value); this.tagName = 'TEXTAREA'; this.readOnly = false; this.disabled = false; }
  get value() { return this.__v; }
  set value(v) { this.__v = String(v); }
  setSelectionRange() { /* noop */ }
  dispatchEvent(ev) {
    ev.target = this;
    if (ev.type === 'input') seen.push({ el: this, value: this.value, applying: !!this.__undoApplying });
    doc._fire(ev.type, ev);
    return true;
  }
}

globalThis.document = doc;
globalThis.Event = EventShim;
globalThis.HTMLTextAreaElement = TextAreaShim;
globalThis.HTMLInputElement = TextAreaShim; // 本测只用 textarea 形态

const { initInputUndo, seedBaseline, applyProgrammaticText } = await import('../../client/src/utils/inputUndo.js');
initInputUndo();

const DEBOUNCE_WAIT = 420; // > 模块里的 350ms 去抖,让还原点真正落栈
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const focus = (el) => doc._fire('focusin', { type: 'focusin', target: el });
const beforeinput = (el) => doc._fire('beforeinput', { type: 'beforeinput', target: el });
// 用户敲字:先改 DOM 值,再发 input(浏览器就是这个顺序 —— 也正是「基线太晚」的成因)
const type = (el, v) => { el.value = v; el.dispatchEvent(new EventShim('input', { bubbles: true })); };
const undo = (el) => doc._fire('keydown', {
  type: 'keydown', target: el, key: 'z', metaKey: true, ctrlKey: false, shiftKey: false,
  isComposing: false, preventDefault() { this.__prevented = true; },
});
const redo = (el) => doc._fire('keydown', {
  type: 'keydown', target: el, key: 'z', metaKey: true, ctrlKey: false, shiftKey: true,
  isComposing: false, preventDefault() { this.__prevented = true; },
});

// ───────────── ① focusin 建栈:撤到底是空,不留首字母 ─────────────
{
  const el = new TextAreaShim('');
  focus(el);
  type(el, 'a');
  await sleep(DEBOUNCE_WAIT);
  type(el, 'ab');
  await sleep(DEBOUNCE_WAIT);

  undo(el);
  assert.equal(el.value, 'a', 't1: 第一次 ⌘Z 退到上一个还原点');
  undo(el);
  assert.equal(el.value, '', 't1: 第二次 ⌘Z 必须退到空 —— 留「a」就是用户实报的「撤回后还剩首字母」(基线在 input 回调里才建,已含首字母)');
  // 重做还得能回去(基线提前不许破坏 redo)
  redo(el);
  assert.equal(el.value, 'a', 't1: ⇧⌘Z 重做照常');
}

// ───────────── ② beforeinput 兜底:没走 focusin 也有真基线 ─────────────
{
  const el = new TextAreaShim('');
  beforeinput(el); // 值还没变,此刻取到的才是原值
  type(el, 'x');
  await sleep(DEBOUNCE_WAIT);

  undo(el);
  assert.equal(el.value, '', 't2: 无 focusin 路径(脚本先聚焦/挂载时已聚焦)靠 beforeinput 建基线,⌘Z 同样退到空');
}

// ── ②b beforeinput 只在无记录时建栈,不许把打字中的历史冲掉 ──
{
  const el = new TextAreaShim('');
  focus(el);
  type(el, 'hello');
  await sleep(DEBOUNCE_WAIT);
  beforeinput(el); // 已有记录 → 零动作
  undo(el);
  assert.equal(el.value, '', 't2b: beforeinput 遇已有记录必须零动作(重建基线会把「hello」钉成原值,撤销就退不回去了)');
}

// ───────────── ③ 程序化写入:旧值可撤 + 受控组件收得到 input ─────────────
{
  const el = new TextAreaShim('gpt-4o\nclaude-3'); // 用户手打的原有模型行,从未聚焦 → 栈是空的
  seen.length = 0;
  applyProgrammaticText(el, 'gpt-4o\nclaude-3\nnew-model-a\nnew-model-b');

  assert.equal(el.value, 'gpt-4o\nclaude-3\nnew-model-a\nnew-model-b', 't3: 值写进去了');
  const ev = seen.find((s) => s.el === el);
  assert.ok(ev, 't3: 必须派发 input 事件 —— React 受控 value 只认 onChange,不发事件则下次重渲染把旧值刷回来');
  assert.equal(ev.value, 'gpt-4o\nclaude-3\nnew-model-a\nnew-model-b', 't3: 派发时 DOM 值已是新值(onChange 读 e.target.value 才拿得到)');
  assert.equal(ev.applying, false, 't3: 不带 __undoApplying —— 这一笔要被 input 监听正常记下,否则撤了不能重做');

  await sleep(DEBOUNCE_WAIT);
  undo(el);
  assert.equal(el.value, 'gpt-4o\nclaude-3', 't3: ⌘Z 必须回到写入前的旧值(用户实报「model id 列表框内撤销无效」:setState 写入不产生 input 事件,栈里没这一步)');
  redo(el);
  assert.equal(el.value, 'gpt-4o\nclaude-3\nnew-model-a\nnew-model-b', 't3: 重做能回到合并结果');
}

// ── ③b seedBaseline 幂等:已有记录不覆盖 ──
{
  const el = new TextAreaShim('原值');
  seedBaseline(el);
  type(el, '原值改');
  await sleep(DEBOUNCE_WAIT);
  seedBaseline(el); // 已有记录 → 零动作
  undo(el);
  assert.equal(el.value, '原值', 't3b: seedBaseline 对已有记录的框零动作');
}

// ───────────── ④ 源码锚 ─────────────
const REPO = new URL('../../', import.meta.url);
const undoSrc = readFileSync(new URL('client/src/utils/inputUndo.js', REPO), 'utf8');

assert.match(undoSrc, /export function seedBaseline\(el\)/, 't4: seedBaseline 必须导出(程序化通道与外部调用点都要用)');
assert.match(undoSrc, /export function applyProgrammaticText\(el, value\)/, 't4: applyProgrammaticText 必须导出');
assert.match(
  undoSrc,
  /document\.addEventListener\('focusin',[\s\S]{0,80}?seedBaseline\(e\.target\)[\s\S]{0,20}?,\s*true\)/,
  't4: focusin 捕获阶段建基线(删了 = 首字母残留复发)',
);
assert.match(
  undoSrc,
  /document\.addEventListener\('beforeinput',[\s\S]{0,80}?seedBaseline\(e\.target\)[\s\S]{0,20}?,\s*true\)/,
  't4: beforeinput 捕获阶段兜底建基线',
);
// 顺序红线:先钉旧值再写新值,反了就等于没钉
const apt = undoSrc.slice(undoSrc.indexOf('export function applyProgrammaticText'));
const iSeed = apt.indexOf('seedBaseline(el)');
const iSet = apt.indexOf('setNativeValue(el, value)');
assert.ok(iSeed > 0 && iSet > iSeed, 't4: applyProgrammaticText 必须先 seedBaseline 再 setNativeValue(顺序反了则栈里钉的是新值,⌘Z 无处可退)');
// 既有语义红线没被顺手改坏
assert.match(undoSrc, /const MAX = 200;/, 't4: 200 步上限不动');
assert.match(undoSrc, /const DEBOUNCE = 350;/, 't4: 350ms 合并不动');
assert.match(undoSrc, /el\.__undoApplying = true;/, 't4: apply() 的防环标志不动');

// App.jsx:勾选弹窗确认走撤销通道(不再裸 setModelsText 单飞)
{
  const app = readFileSync(new URL('client/src/App.jsx', REPO), 'utf8');
  assert.match(app, /import \{ applyProgrammaticText \} from '\.\/utils\/inputUndo\.js';/, 't5: App.jsx 引入 applyProgrammaticText');
  assert.match(app, /<textarea ref=\{modelsRef\}[^>]*value=\{modelsText\}/, 't5: 模型框挂 modelsRef(没 ref 就拿不到 DOM,写入只能走 setState)');
  const onConfirm = app.match(/onConfirm=\{\(ids\) => \{[\s\S]*?\n\s*\}\}/);
  assert.ok(onConfirm, 't5: 找得到勾选弹窗 onConfirm');
  assert.match(onConfirm[0], /mergeModelLines\(parseModels\(\), ids\)\.join\('\\n'\)/, 't5: 合并语义不变(原有行一律保留)');
  assert.match(onConfirm[0], /applyProgrammaticText\(modelsRef\.current, merged\)/, 't5: 确认必须经撤销通道写入,否则合并进来的模型行 ⌘Z 撤不回(用户实报)');
  assert.match(onConfirm[0], /setPickCandidates\(null\)/, 't5: 确认后关弹窗');
}

// ImagePanel.jsx:「恢复」走撤销通道 + 仍切回生图页(r51 t7 锚在此等强迁移)
{
  const ip = readFileSync(new URL('client/src/components/ImagePanel.jsx', REPO), 'utf8');
  assert.match(ip, /import \{ applyProgrammaticText \} from '\.\.\/utils\/inputUndo\.js';/, 't6: ImagePanel 引入 applyProgrammaticText');
  assert.match(
    ip,
    /onClick=\{\(\) => \{ restorePrompt\(h\.prompt \|\| ''\); setTab\('gen'\); \}\}/,
    "t6:「恢复」把该条提示词填回输入框(经 restorePrompt)并自动切回生图选项卡(r51 t7:不许停留在任务列表)",
  );
  const restore = ip.match(/const restorePrompt = useCallback\(\(v\) => \{[\s\S]*?\}, \[setPromptDraft\]\);/);
  assert.ok(restore, 't6: 找得到 restorePrompt 定义');
  assert.match(restore[0], /applyProgrammaticText\(el, v\)/, 't6: 回填必须经撤销通道,否则被覆盖掉的原提示词 ⌘Z 撤不回');
  assert.match(restore[0], /setPromptDraft\(v\)/, 't6: 框未挂载时退回 setState,不许丢回填');
  // 草稿链路仍在(派发的 input → onChange → setPromptDraft → localStorage)
  assert.match(ip, /onChange=\{\(e\) => setPromptDraft\(e\.target\.value\)\}/, 't6: 输入框 onChange 仍走 setPromptDraft(草稿写盘靠它)');
}

console.log('✓ check-r59-undo-baseline: 基线提前(focusin/beforeinput)+ 程序化写入通道(model 框 / 提示词恢复)');
