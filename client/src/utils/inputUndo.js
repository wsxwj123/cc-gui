// CK-12: 全局输入框撤销/重做(像 Word)。
//
// 为什么需要:React 受控 <textarea>/<input> 的 value 由状态驱动,每次重渲染都把
// DOM value 重设回去,浏览器原生的 Cmd/Ctrl+Z undo 缓冲被清空 → 用户按 Z 没反应。
// 这里在 document 级挂一个捕获阶段监听,给每个文本输入框维护一份自己的撤销栈,
// 按 Cmd/Ctrl+Z 回退、Cmd/Ctrl+Shift+Z(或 Ctrl+Y)重做。一处接线覆盖所有输入框,
// 不必逐个组件改。
//
// 写回受控输入用「原生 setter + 派发 input 事件」的标准技巧,让 React 的 onChange
// 照常触发、状态与 DOM 同步。

const hist = new WeakMap(); // el -> { stack: string[], idx: number, timer: number|null }
const MAX = 200;            // 每个输入框最多存 200 步,够用且不吃内存
const DEBOUNCE = 350;       // 连续打字合并成一个撤销单元(停顿 350ms 落一个还原点)

function isEditable(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
  if (el.tagName === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    // 只接管文本型输入;number/checkbox/range/date 等有各自的原生语义,不碰。
    return ['text', 'search', 'url', 'email', 'tel', 'password'].includes(t) && !el.readOnly && !el.disabled;
  }
  return false;
}

function getState(el) {
  let s = hist.get(el);
  if (!s) { s = { stack: [el.value], idx: 0, timer: null }; hist.set(el, s); }
  return s;
}

// r59:基线必须赶在用户敲第一个字符之前建立。以前只在 input 回调里惰性建栈,此刻
// el.value 已含首字母 → 基线 = 「首字母」,idx>0 守卫让撤销永远退不到空(用户实报
// 「⌘Z 后还留一个字母」)。已有记录时零动作,不会覆盖打字中的历史。
export function seedBaseline(el) {
  if (!isEditable(el) || hist.has(el)) return;
  getState(el); // 此刻的值 = 真基线
}

function commit(el) {
  const s = getState(el);
  const val = el.value;
  if (s.stack[s.idx] === val) return;       // 无变化不记
  s.stack = s.stack.slice(0, s.idx + 1);    // 截断 redo 分支(在历史中间打字时)
  s.stack.push(val);
  if (s.stack.length > MAX) s.stack.shift();
  s.idx = s.stack.length - 1;
}

function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  // 让 React 受控状态跟着更新(否则下次重渲染又把旧值刷回来)。
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function apply(el, value) {
  el.__undoApplying = true;
  setNativeValue(el, value);
  try { el.setSelectionRange(value.length, value.length); } catch { /* password 等不支持 */ }
  el.__undoApplying = false;
}

// r59:程序化写入通道(勾选弹窗「确认」合并模型、点「恢复」回填提示词……)。React
// setState 直接改受控值不产生 DOM input 事件 → 撤销栈里没这一步,用户 ⌘Z 无处可退。
// 走这里:先把「写入前的旧值」钉进栈,再原生 setter 写 + 派发 input(刻意不设
// __undoApplying —— 这一笔要被 input 监听正常记下,才能撤了再重做)。
export function applyProgrammaticText(el, value) {
  if (!el) return;
  seedBaseline(el);
  setNativeValue(el, value);
  try { el.setSelectionRange(value.length, value.length); } catch { /* password 等不支持 */ }
}

export function initInputUndo() {
  // 聚焦那一刻的值才是「原值」:先建栈,再让用户打字(见 seedBaseline)。
  document.addEventListener('focusin', (e) => seedBaseline(e.target), true);
  // 兜底:脚本先聚焦 / 无 focusin 路径(本模块挂载时框已聚焦)。beforeinput 早于值改变,
  // 此刻取到的仍是旧值;已有记录则零动作。
  document.addEventListener('beforeinput', (e) => seedBaseline(e.target), true);

  // 打字时去抖落还原点。捕获阶段确保先于组件自身逻辑拿到。
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!isEditable(el) || el.__undoApplying || e.isComposing) return;
    const s = getState(el);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = null; commit(el); }, DEBOUNCE);
  }, true);

  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!isEditable(el) || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const z = e.key === 'z' || e.key === 'Z';
    const y = e.key === 'y' || e.key === 'Y';
    const redo = (z && e.shiftKey) || (y && !e.shiftKey);
    const undo = z && !e.shiftKey;
    if (!undo && !redo) return;
    e.preventDefault();
    const s = getState(el);
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    commit(el); // 把「按下快捷键前的最新输入」先落进栈,保证最近一笔可被撤
    if (undo && s.idx > 0) { s.idx -= 1; apply(el, s.stack[s.idx]); }
    else if (redo && s.idx < s.stack.length - 1) { s.idx += 1; apply(el, s.stack[s.idx]); }
  }, true);
}
