/**
 * genui 纯逻辑契约模块 —— 验收测试的唯一入口(tests/acceptance/r64-genui/lib.mjs 的
 * CANDIDATES 第一项)。
 *
 * 这里**不实现任何逻辑**,只把散在渲染管线里的四条纯逻辑接出来给裸 node 调:
 *   matchFenceLang  ← host/fence-classify.ts   (§1.1 语言标记)
 *   parseSpec       ← host/fence-classify.ts   (§1.2/§1.3/§5.1/§5.2/§5.7 围栏判定)
 *   buildActionText ← host/action-send.js      (§3.2 外发消息)
 *   evalPlotExpr    ← upstream/safe-math.ts    (§2.8 表达式求值)
 * 一旦这里出现第二份实现,测试就在测一个界面上跑不到的东西。适配只许做形状转换。
 *
 * 硬约束(PLAN §2.0.2):本文件与它 import 到的每一个文件都**不得**碰 React / CSS /
 * DOM,且只能触达 `.ts` / `.js` —— 裸 node 的类型擦除不处理 JSX,import 一个 `.tsx`
 * 会让整个契约模块加载失败。往这里加函数前先确认它不在 `.tsx` / `.jsx` 里。
 */
import { classifyFence, isGenuiLang } from './host/fence-classify.ts';
import { buildActionMessage, pickComponent } from './host/action-send.js';
import { assertSendable } from './host/action-guard.js';
import { compileMathExpr } from './upstream/safe-math.ts';

/** §1.1:``` 后面那一整串是不是 genui 围栏标记。非字符串一律 false,不抛。 */
export const matchFenceLang = isGenuiLang;

/**
 * 根级 `gap` 的缺省值。与渲染层 upstream/GenuiBlock.tsx:63 的 `spec.gap ?? 16`
 * 同一个数 —— 守卫不填缺省(它只管"合法就留下"),缺省是渲染语义。
 */
const DEFAULT_ROOT_GAP = 16;

/**
 * §5 的围栏判定结果,转成契约要的四元组。
 *
 * @param {string} fenceBody 围栏原文
 * @param {{ finalized?: boolean }} [opts] finalized 缺省 true(已定稿)
 * @returns {{ ok: boolean, root: null | { title?: string, gap: number, items: object[] }, ignored: number, notice: string | null }}
 */
export function parseSpec(fenceBody, opts) {
  const settled = opts?.finalized !== false;
  const fence = classifyFence(String(fenceBody ?? ''), settled);
  if (fence.kind !== 'spec') {
    // 空体 / 超大 / 解析不出 / 一个节点都没活下来:统统退回原始代码块。
    // ignored 恒 0 —— 块本身没渲染,「N 个已忽略」的灰字没有承载它的地方(§5.2 末段)。
    return { ok: false, root: null, ignored: 0, notice: fence.notice };
  }
  const spec = fence.spec;
  return {
    ok: true,
    root: { ...spec, gap: spec.gap ?? DEFAULT_ROOT_GAP },
    ignored: spec.dropped,
    notice: null,
  };
}

/**
 * §3.2:替用户发出的那条消息全文。
 *
 * 顺序与真实送达路径**一样**:先过 L4 送达前断言(host/action-guard.js),再构造消息。
 * useGenuiActionCapability.send 就是这么走的 —— 断言不过一条都不发。契约函数照抄这个
 * 顺序,而不是直接调构造器:直接调等于测一条线上不存在的路径,而"非法动作名不得产出
 * 可用消息"(§5.10 不变量 1)正是靠这道断言兜住的。
 *
 * @param {{ action: string, component: object }} evt
 * @returns {string} 断言未过时返回空串(契约允许"抛错或返回空")
 */
export function buildActionText(evt) {
  const component = pickComponent(evt?.component || {});
  if (assertSendable(evt?.action, component) !== null) return '';
  return buildActionMessage(evt?.action, evt?.component).text;
}

/**
 * §2.8:表达式求值。`x` 取自 params.x(缺省 0),其余单个小写字母是参数(未声明取 1)。
 * 非法表达式返回 null,不抛、不走 eval / new Function。
 *
 * @param {string} expr
 * @param {Record<string, number>} [params]
 * @returns {number | null}
 */
export function evalPlotExpr(expr, params) {
  if (typeof expr !== 'string') return null;
  const vars = params && typeof params === 'object' ? params : {};
  const fn = compileMathExpr(expr, { vars });
  if (fn === null) return null;
  let value;
  try {
    // 求值本身也可能炸:一万项加法编译出的闭包链求值时是一万层递归,栈会爆。
    // 编译期的 try 管不到这一段,漏了它 = 超长表达式把调用方掀了。
    value = fn(typeof vars.x === 'number' ? vars.x : 0);
  } catch {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
