// genui 围栏组件(PLAN r64 §2.2)。MarkdownRenderer 认出 ```cgui-ui / ```dsh-ui 就挂它。
//
// 处理顺序本身是契约,不能重排(INTERFACE §5.1 / §5.7):
//   空体守卫 → 字节上限门 → resolveGenuiSpec → GenuiBlock / 降级代码块
// 三条门都在 resolveGenuiSpec **之前**:空体不该产生状态条目,超大围栏不该进解析层
// (每 chunk 两次 JSON.stringify,超大子树直接卡死主线程)。
//
// 降级安全网(INTERFACE §5 总原则②,一天都不能缺):走不通的每一条路,**原始代码块必须
// 仍然可见** —— 用户永远不对着空白发呆。
import React, { useMemo } from 'react';
import { CodeBlock } from './CodeBlock.jsx';
import { ErrorBoundary } from '../genui/upstream/ErrorBoundary.tsx';
import { GenuiBlock } from '../genui/upstream/GenuiBlock.tsx';
import { resolveGenuiSpec } from '../genui/upstream/fence-render.tsx';
import { describeJsonFailure } from '../genui/upstream/fence-repair.ts';
import { GENUI_LIMITS } from '../genui/upstream/guard.ts';
import { useGenuiAction } from '../genui/upstream/action-context.ts';
import { genuiStateKey } from '../genui/upstream/interaction-store.ts';

// 语言标记判定(PLAN §1.8:照抄 ArtifactPreview 的 normLang —— 取第一个空白分隔词 + 小写)。
// 一行同时认两个标记(决策 3);大小写不敏感;```cgui-ui title=x 只取第一个词。
const GENUI_LANGS = new Set(['cgui-ui', 'dsh-ui']);
export function normGenuiLang(lang) {
  return String(lang || '').trim().split(/\s+/)[0].toLowerCase();
}
export function isGenuiLang(lang) {
  return GENUI_LANGS.has(normGenuiLang(lang));
}

/**
 * 围栏原文的 UTF-8 字节数。上限是**字节**不是字符(INTERFACE §1.3),中文围栏按字符算
 * 会放进来三倍大的东西。
 */
export function fenceByteLength(raw) {
  return new TextEncoder().encode(raw).length;
}

/**
 * 把围栏归到四种形态之一。纯函数、不碰 React,单测直接调。
 * 形态决定渲染分支,分支决定可测锚(INTERFACE §9.1),所以判定和渲染分开写。
 */
export function classifyFence(raw, settled) {
  // ① 空体(§1.4.1-2):流式期每个围栏开头必经的 1-2 帧。不解析、不算指纹、不读写状态存储。
  //    (字面量 "undefined" 那半由 MarkdownRenderer 的 children 守卫治,这里只管"空体不产生状态")
  if (raw.trim() === '') return { kind: 'empty' };
  // ② 字节上限门(§5.3 补丁1 / INTERFACE §5.7)。原文只增不减,所以越过阈值后恒为超限,
  //    天然满足"不得反复抖动"。
  const bytes = fenceByteLength(raw);
  if (bytes > GENUI_LIMITS.maxFenceBytes) return { kind: 'oversize', kb: Math.round(bytes / 1024) };
  const spec = resolveGenuiSpec(raw, { settled });
  return spec === null ? { kind: 'unparsed' } : { kind: 'spec', spec };
}

const NOTICE_BASE = {
  margin: '0 0 6px',
  padding: '6px 10px',
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
};
// 两档说明条:解析失败是错(红),规格过大只是"换个显示方式"(中性灰),别把后者也刷成红的。
// 配色暂用字面值,主题映射统一在 M9 那一轮接 token。
const NOTICE_TONE = {
  error: { background: 'rgba(239, 68, 68, 0.14)', border: '1px solid rgba(239, 68, 68, 0.4)', color: '#f87171' },
  info: { background: 'rgba(127, 127, 127, 0.12)', border: '1px solid rgba(127, 127, 127, 0.35)', color: 'inherit' },
};

/** 降级形态:说明条(可选)+ 原始代码块。genui-source 恒在,genui-notice 只在有话说时在。 */
function DegradedFence({ raw, lang, notice = null, tone = 'error' }) {
  return (
    <div>
      {notice !== null && (
        <div
          data-testid="genui-notice"
          role={tone === 'error' ? 'alert' : undefined}
          style={{ ...NOTICE_BASE, ...NOTICE_TONE[tone] }}
        >
          {notice}
        </div>
      )}
      <div data-testid="genui-source">
        <CodeBlock lang={lang} code={raw} />
      </div>
    </div>
  );
}

// 定稿后关掉入场动画。回合末围栏子树会连续重挂两次(dockKeyPrefix 换两轮),每次重挂
// 都重播一遍逐条渐显 = 用户看到"回复完成后整块界面又抖一次"。GenuiBlock.module.css 的
// .reveal 把 animation 走 var(--genui-reveal, …),这里给个 none 就按下了;自定义属性
// 会继承,挂在外层容器上即可,不必碰 upstream 的 .tsx。
const SETTLED_STYLE = { '--genui-reveal': 'none' };

/**
 * @param {string}  raw      围栏原文(已去掉尾换行)
 * @param {string}  lang     围栏语言标记(原文形态,内部归一)
 * @param {boolean} settled  本条消息是否已定稿。**props 透传,不查 DOM**(PLAN §1.4):
 *                           DOM 探测在 React 19 并发渲染下时序不可靠,props 是渲染输入。
 *
 * 交互态键的会话分量 `queueKey` 从 action Provider 取(PLAN §1.2.2 A1 / §1.3.2):
 * 挂在窗格根,所以它天然是**本窗格**的会话键,分屏两个窗格里逐字节相同的围栏就此分家。
 * 只读面(`value={null}`)与窗格外拿到 '' —— 键仍稳定(重挂不丢状态),只是不按会话分。
 */
export function GenuiFence({ raw, lang = 'cgui-ui', settled = false }) {
  const queueKey = useGenuiAction()?.queueKey ?? '';
  const normLang = normGenuiLang(lang);
  // 解析结果按 [原文, 是否定稿] 记忆:流式每 chunk 都会重渲,不 memo 就是每帧重跑一遍
  // 修复+白名单遍历。settled 进 deps 是因为二级补全只在定稿后开(§1.4)。
  const fence = useMemo(() => classifyFence(raw, settled), [raw, settled]);

  if (fence.kind === 'spec') {
    return (
      // ErrorBoundary 在外、genui-block 在内:某个组件渲染抛异常时整块换成灰卡
      // (§5.8),此时"渲染成功的块"并不存在,genui-block 也就不该留在 DOM 里(§9.1)。
      <ErrorBoundary label="该界面">
        <div data-testid="genui-block" style={settled ? SETTLED_STYLE : undefined}>
          {/* 交互态的持久键(§1.2.2 A1)。只在 spec 分支算:空体/超大/解析失败三条降级路
              一个状态条目都不该产生。指纹取**围栏原文**,与解析结果无关。 */}
          <GenuiBlock spec={fence.spec} stateKey={genuiStateKey(queueKey, raw)} settled={settled} />
        </div>
      </ErrorBoundary>
    );
  }
  if (fence.kind === 'oversize') {
    return (
      <DegradedFence
        raw={raw}
        lang={normLang}
        tone="info"
        notice={`界面规格过大（${fence.kb} KB），已按代码块显示`}
      />
    );
  }
  // 空体:空代码块,不报错、不出红条(§5.1)。
  if (fence.kind === 'empty') return <DegradedFence raw="" lang={normLang} />;
  // 剩下 unparsed。流式期的半截 JSON **不是错误**(用户还在看模型打字),只给代码块;
  // 定稿后仍解析不出来才配一条红条(§5.1)。
  if (!settled) return <DegradedFence raw={raw} lang={normLang} />;
  // describeJsonFailure 只描述 JSON 语法错;合法 JSON 但不是界面规格(数组/字符串/
  // 没有 items)时它返回 null,那一路同样走红条(§5.1 末两行),补一句人话。
  const detail = describeJsonFailure(raw) ?? '（围栏体不是合法的界面规格：根对象需要 items 数组）';
  return (
    <DegradedFence
      raw={raw}
      lang={normLang}
      notice={`⚠️ cgui-ui 围栏 JSON 解析失败${detail} —— 围栏保持为代码块；请让模型检查并修复 JSON 后重发。`}
    />
  );
}
