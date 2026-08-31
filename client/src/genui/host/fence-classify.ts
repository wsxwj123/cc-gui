/**
 * 围栏判定的纯逻辑:语言标记 → 字节门 → 解析/修复 → 四种形态 + 说明条文案。
 *
 * 为什么单独成 `.ts`(PLAN §2.0.2 的结构性约束):**裸 node 加载不了 `.tsx` / `.jsx`**
 * (类型擦除不处理 JSX)。这段逻辑原先分散在 `components/GenuiFence.jsx`(语言标记、
 * 字节门、classifyFence)与 `upstream/fence-render.tsx`(resolveGenuiSpec)两个带 JSX
 * 的文件里,验收契约模块 `genui/contract.mjs` 一个都 import 不了。搬到这里之后:
 *   - `GenuiFence.jsx` 只剩 JSX,判定逻辑原样从这里 import(不复制一份);
 *   - 说明条文案也在这里,渲染层与契约模块读**同一个字符串** —— 文案是可断言项
 *     (INTERFACE §5.1 / §5.7),两处各写一遍迟早对不上。
 *
 * 处理顺序本身是契约,不能重排(INTERFACE §5.1 / §5.7):
 *   空体守卫 → 字节上限门 → resolveGenuiSpec → 空卡守卫 → spec
 * 三条门都在解析**之前**:空体不该产生状态条目,超大围栏不该进解析层(每 chunk 两次
 * JSON.stringify,超大子树直接卡死主线程)。
 */
import { repairGenuiSpec, GENUI_LIMITS } from '../upstream/guard.ts'
import { parsePartialGenuiSpec } from '../upstream/parse-partial.ts'
import { completeFenceJson, describeJsonFailure, repairFenceJson } from '../upstream/fence-repair.ts'
import type { GenuiSpec } from '../upstream/spec.ts'

/**
 * 上下文:本条消息是否已定稿。二级补全只在定稿后开(PLAN §1.4)——
 * 流式期的半截 JSON 补全出来就是猜,猜错会让界面在打字过程中乱跳。
 */
export interface GenuiFenceContext {
  /** 本窗格的队列键(交互态键的会话分量)。判定逻辑不用它,只随上下文一起传给渲染层。 */
  readonly queueKey?: string
  /** True once the message finished streaming. */
  readonly settled?: boolean
}

// 语言标记判定(PLAN §1.8:照抄 ArtifactPreview 的 normLang —— 取第一个空白分隔词 + 小写)。
// 一行同时认两个标记(决策 3);大小写不敏感;```cgui-ui title=x 只取第一个词。
const GENUI_LANGS = new Set(['cgui-ui', 'dsh-ui'])

export function normGenuiLang(lang: unknown): string {
  return String(lang || '').trim().split(/\s+/)[0].toLowerCase()
}

export function isGenuiLang(lang: unknown): boolean {
  return GENUI_LANGS.has(normGenuiLang(lang))
}

/**
 * 围栏原文的 UTF-8 字节数。上限是**字节**不是字符(INTERFACE §1.3),中文围栏按字符算
 * 会放进来三倍大的东西。
 */
export function fenceByteLength(raw: string): number {
  return new TextEncoder().encode(raw).length
}

/**
 * Resolve a raw fence body to a guarded spec.
 *
 * - Tier-1 repair (quote escape + trailing commas): safe at any time —
 *   adopted only when the whole body parses, so a still-growing streaming
 *   half keeps falling back to the code block, never flashing a banner.
 * - Tier-2 completion (missing quotes/brackets): settled renders only —
 *   `context.settled` is true exclusively once the message finished, so
 *   streaming halves are never completed early.
 *
 * CGUI-PATCH: 原文在 `upstream/fence-render.tsx`,整段搬到本 `.ts`(见文件头)。
 * 那边只留两个 React 入口,函数本身从这里 import,零行为变化。
 */
export function resolveGenuiSpec(raw: string, context?: GenuiFenceContext): GenuiSpec | null {
  const parsed = parsePartialGenuiSpec(raw)
  let spec = parsed === null ? null : repairGenuiSpec(parsed)
  if (spec === null) {
    const repaired = repairFenceJson(raw)
    if (repaired !== null) {
      const reparsed = parsePartialGenuiSpec(repaired.text)
      spec = reparsed === null ? null : repairGenuiSpec(reparsed)
    }
    // CGUI-PATCH: 二级补全的门 `context.source !== undefined` → `context.settled === true`(§1.4)
    if (spec === null && context?.settled === true) {
      const completed = completeFenceJson(raw)
      if (completed !== null) {
        const reparsed = parsePartialGenuiSpec(completed.text)
        spec = reparsed === null ? null : repairGenuiSpec(reparsed)
      }
    }
  }
  return spec
}

/** 说明条:两档语气。解析失败是错(红),规格过大只是"换个显示方式"(中性灰)。 */
export type FenceNoticeTone = 'error' | 'info'

export interface FenceClass {
  /** 四种形态之一,决定渲染分支(INTERFACE §9.1)。 */
  kind: 'empty' | 'oversize' | 'unparsed' | 'no-node' | 'spec'
  /** 用户可见的说明条文案;无话可说时 null。 */
  notice: string | null
  tone: FenceNoticeTone
  /** kind='oversize' 时的原文体积(KB,四舍五入)。 */
  kb?: number
  /** kind='spec' 时的守卫产物。 */
  spec?: GenuiSpec
}

/**
 * 把围栏归到五种形态之一,并给出该形态的说明条文案。纯函数、不碰 React,单测直接调。
 * 形态决定渲染分支,分支决定可测锚(INTERFACE §9.1),所以判定和渲染分开写。
 */
export function classifyFence(raw: string, settled: boolean): FenceClass {
  // ① 空体(§1.4.1-2):流式期每个围栏开头必经的 1-2 帧。不解析、不算指纹、不读写状态存储。
  //    (字面量 "undefined" 那半由 MarkdownRenderer 的 children 守卫治,这里只管"空体不产生状态")
  if (raw.trim() === '') return { kind: 'empty', notice: null, tone: 'error' }
  // ② 字节上限门(§5.3 补丁1 / INTERFACE §5.7)。原文只增不减,所以越过阈值后恒为超限,
  //    天然满足"不得反复抖动"。
  const bytes = fenceByteLength(raw)
  if (bytes > GENUI_LIMITS.maxFenceBytes) {
    const kb = Math.round(bytes / 1024)
    return { kind: 'oversize', kb, tone: 'info', notice: `界面规格过大（${kb} KB），已按代码块显示` }
  }
  const spec = resolveGenuiSpec(raw, { settled })
  if (spec === null) {
    // 流式期的半截 JSON **不是错误**(用户还在看模型打字),只给代码块;
    // 定稿后仍解析不出来才配一条红条(§5.1)。
    if (!settled) return { kind: 'unparsed', notice: null, tone: 'error' }
    // describeJsonFailure 只描述 JSON 语法错;合法 JSON 但不是界面规格(数组/字符串/
    // 没有 items)时它返回 null,那一路同样走红条(§5.1 末两行),补一句人话。
    const detail = describeJsonFailure(raw) ?? '（围栏体不是合法的界面规格：根对象需要 items 数组）'
    return {
      kind: 'unparsed',
      tone: 'error',
      notice: `⚠️ cgui-ui 围栏 JSON 解析失败${detail} —— 围栏保持为代码块；请让模型检查并修复 JSON 后重发。`,
    }
  }
  // ③ 空卡守卫(§5.2 末段)。JSON 解析出来了、结构也对,但一个节点都没活下来(类型全不在
  //    白名单 / 必填字段全非法)。此时渲染出来是一张**空卡**,比留着原文更糟:用户既看不到
  //    模型写了什么,也不知道出了什么事。口径取 guard 回传的 kept(全树存活数),与灰字的
  //    dropped 同源,不另算一遍。**不出任何说明条**:JSON 是好的,说"解析失败"是撒谎;
  //    灰字「N 个已忽略」也没有承载它的块(§9.1)。
  if (spec.kept === 0) return { kind: 'no-node', notice: null, tone: 'error' }
  return { kind: 'spec', spec, notice: null, tone: 'error' }
}
