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
import { useGenuiAction } from '../genui/upstream/action-context.ts';
import { genuiStateKey } from '../genui/upstream/interaction-store.ts';
// 判定逻辑(语言标记 / 字节门 / 四种形态 / 说明条文案)全在 host/fence-classify.ts。
// 这个文件只剩 JSX —— 裸 node 加载不了 `.jsx`(PLAN §2.0.2),而验收契约模块必须
// import 得到那段逻辑,所以它不能留在这里。再导出是为了不动既有调用方
// (MarkdownRenderer 读 isGenuiLang,浏览器用例读 classifyFence)。
import {
  classifyFence, fenceByteLength, isGenuiLang, normGenuiLang,
} from '../genui/host/fence-classify.ts';

export { classifyFence, fenceByteLength, isGenuiLang, normGenuiLang };

const NOTICE_BASE = {
  margin: '0 0 6px',
  padding: '6px 10px',
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
};
// 两档说明条:解析失败是错(红),规格过大只是"换个显示方式"(中性灰),别把后者也刷成红的。
// CGUI-PATCH:字面色换成宿主主题变量(原注释说的"M9 那一轮接 token")。原来的 #f87171 是
// 给深色底调的浅红,浅色主题下对比度不够;--color-error 本身就是明暗两套(index.css 里
// 浅色 #DC2626 / 深色 #EF4444),跟着主题走。底色与描边用 color-mix 从同一个 token 兑出来,
// 不再各写一个 rgba —— 换主题时只有一处要改。
const NOTICE_TONE = {
  error: {
    background: 'color-mix(in srgb, var(--color-error) 14%, transparent)',
    border: '1px solid color-mix(in srgb, var(--color-error) 40%, transparent)',
    color: 'var(--color-error)',
  },
  info: {
    background: 'color-mix(in srgb, var(--color-ink-faint) 12%, transparent)',
    border: '1px solid color-mix(in srgb, var(--color-ink-faint) 35%, transparent)',
    color: 'var(--color-ink-muted)',
  },
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

// 来源标识(INTERFACE §6 末行 / §9.1)。genui 接入宿主皮肤后,模型画的界面与原生 UI
// 在视觉上不可区分 —— 这一条标识是唯一的区分点,所以它**没有开关、没有关闭键、不随
// 任何设置消失**:JSX 里无条件渲染,不读 store,内部不放 button(否则就有了关闭的口子)。
// 用 span 而不是 div:即使将来有人把它挪进某行文字里也不破坏排版。
const BADGE_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  margin: '0 0 6px',
  padding: '2px 7px',
  borderRadius: 999,
  fontSize: 10.5,
  lineHeight: 1.5,
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
  color: 'var(--color-ink-muted)',
  background: 'color-mix(in srgb, var(--color-ink-faint) 12%, transparent)',
  border: '1px solid color-mix(in srgb, var(--color-ink-faint) 30%, transparent)',
};
const BADGE_DOT_STYLE = {
  width: 5,
  height: 5,
  borderRadius: '50%',
  background: 'var(--color-accent)',
  flexShrink: 0,
};
/** 块内恒在的来源标识。无 props、无状态、无分支 —— 它不该有任何"不出现"的路径。 */
function GenuiBadge() {
  return (
    /* 刻意**不给** data-cgui:那是皮肤的样式契约,登记进去等于给皮肤作者一个
       `display:none` 的口子,与"不可关闭"直接冲突。测试用 data-testid 就够。 */
    <span data-testid="genui-badge" style={BADGE_STYLE}>
      <span style={BADGE_DOT_STYLE} aria-hidden />
      模型生成界面
    </span>
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
        <div data-cgui="genui-block" data-testid="genui-block" style={settled ? SETTLED_STYLE : undefined}>
          {/* 来源标识挂在块根内、正文之前:一个围栏一处,与 genui-block 一一对应(§9.1)。 */}
          <GenuiBadge />
          {/* 交互态的持久键(§1.2.2 A1)。只在 spec 分支算:空体/超大/解析失败三条降级路
              一个状态条目都不该产生。指纹取**围栏原文**,与解析结果无关。 */}
          <GenuiBlock spec={fence.spec} stateKey={genuiStateKey(queueKey, raw)} settled={settled} />
        </div>
      </ErrorBoundary>
    );
  }
  // 其余四种形态一律降级成代码块,说明条给不给、给哪一档语气,由 classifyFence 一处
  // 定夺(空体/空卡不出条、超大出灰条、定稿后修不好出红条 —— §5.1 / §5.2 / §5.7)。
  // 空体渲染的是**空**代码块:原文只有空白,照着贴等于贴一片空行。
  return (
    <DegradedFence
      raw={fence.kind === 'empty' ? '' : raw}
      lang={normLang}
      tone={fence.tone}
      notice={fence.notice}
    />
  );
}
