// r151w 跨会话 UI 折叠化:三处呈现(收件箱待处理、对话流里的接收、对话流里的发送)共用的折叠行。
// 形状照 App.jsx 的 TaskNoticeRow:两侧分隔线 + 居中两行(标题 / 状态小字),正文默认两行预览,
// 点击标题行展开全文。整行只有**一个**展开控件(标题行本身):展开提示是它内部的一个 span,
// 点它等于点整行,读屏不会念两遍;不可折叠时标题行退化成 <div>(不留死按钮)。
// 纯展示:不读 store、不发请求。正文是另一个模型的输出(不可信),一律纯文本 pre-wrap,不解析 markdown。
// DOM 顺序固定「标题行 → 动作行(有则)→ 正文」:动作贴着标题行,正文再长也推不走【处理】/【忽略】。
import React, { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from './Icon.jsx';

const FOLD_LINES = 2;
const CLAMP_STYLE = { display: '-webkit-box', WebkitLineClamp: FOLD_LINES, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
const SEP = 'flex-1 h-px bg-canvas-deep/70 min-w-[10px]';

/**
 * @param {string} testId 根节点的 data-testid(收件箱 xs-card / 接收 peer-message / 发送 xs-send-notice)
 * @param {object} rootProps 根节点额外属性(data-message-id / data-status / data-via / data-channel …),
 *        按传入顺序渲染;注意 data-testid 恒在最前(r151c 单测按「testid 在 message-id 之前」切分)。
 * @param {string} direction 'in'(收到)/ 'out'(发出)
 * @param {string} idSeed 派生正文节点 id 的唯一后缀(消息 id / 回合 uuid + tool_use_id)
 * @param {ReactNode} icon 标题行图标(可为 null)
 * @param {ReactNode} title 标题行内容(标题文字 + 徽标)
 * @param {ReactNode} status 状态行内容(可空:只有展开提示)
 * @param {string} body 正文(调用方已把「正文缺失」换成占位文案)
 * @param {boolean} noFold 不折叠(「放任」档):全文展示、没有展开控件、标题行不是按钮
 * @param {ReactNode} actions 动作行(仅收件箱):原因 + 处理 / 撤回 / 忽略
 * @param {ReactNode} meta 展开后的元信息(仅发送行):每目标一行
 */
export const XsNoticeRow = React.memo(function XsNoticeRow({
  testId,
  rootProps,
  direction = 'in',
  idSeed = '',
  toggleTestId,
  bodyTestId,
  expandTestId,
  metaTestId,
  titleTestId,
  statusTestId,
  icon = null,
  title = null,
  status = null,
  body = '',
  noFold = false,
  actions = null,
  meta = null,
  className = '',
  innerClassName = '',
  bodyClassName = '',
  animate = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const bodyRef = useRef(null);
  const text = typeof body === 'string' ? body : '';
  const lineCount = text ? text.split('\n').length : 0;
  // 可折叠 = 有展开后才看得到的元信息,或正文超过两行,或确实被两行截断(长行自动折行也算)。
  // 展开态不测量:去掉 clamp 后 scrollHeight 恒等于 clientHeight,会把 overflow 误判成 false。
  const foldable = !noFold && (Boolean(meta) || lineCount > FOLD_LINES || overflow);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || noFold || expanded) return;
    const next = el.scrollHeight > el.clientHeight + 1;
    setOverflow((prev) => (prev === next ? prev : next));
  }, [text, noFold, expanded]);
  const clamped = foldable && !expanded;
  const bodyId = `${bodyTestId || 'xs-notice-body'}-${idSeed || testId || 'row'}`;

  const head = (
    <>
      <span className={SEP} aria-hidden="true" />
      <span className="flex flex-col items-center min-w-0 max-w-[70%] px-1">
        <span className="text-[12px] font-medium font-body leading-tight min-w-0 max-w-full text-ink-soft flex items-center gap-1.5">
          {icon}
          <span data-testid={titleTestId} className="min-w-0 flex items-center gap-1.5">{title}</span>
        </span>
        <span className="text-[10.5px] text-ink-faint font-body mt-0.5 flex items-center gap-1.5 min-w-0 max-w-full">
          {foldable && (expanded ? <ChevronDown size={10} className="shrink-0" /> : <ChevronRight size={10} className="shrink-0" />)}
          {status != null && status !== '' && (
            <span data-testid={statusTestId} className="truncate min-w-0">{status}</span>
          )}
          {foldable && (
            <span data-testid={expandTestId} className="shrink-0 text-accent">{expanded ? '收起' : '展开全文'}</span>
          )}
        </span>
      </span>
      <span className={SEP} aria-hidden="true" />
    </>
  );

  return (
    <div data-testid={testId} data-cgui="xs-notice" data-direction={direction} {...rootProps}
      className={`${animate ? 'animate-fade-up ' : ''}${className}`}>
      <div className={innerClassName}>
        {foldable ? (
          <button type="button" data-testid={toggleTestId} aria-expanded={expanded} aria-controls={bodyId}
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center gap-3 py-1.5 text-left cursor-pointer">
            {head}
          </button>
        ) : (
          <div data-testid={toggleTestId} className="w-full flex items-center gap-3 py-1.5 text-left">{head}</div>
        )}
        {/* 动作行在正文之前:展开时按钮不随正文长度移动(收件箱区自身还有 42vh 内滚) */}
        {actions && <div className="flex items-center gap-2 min-w-0 flex-wrap px-1 pb-1">{actions}</div>}
        <div ref={bodyRef} id={bodyId} data-testid={bodyTestId}
          className={`mt-1 text-[12.5px] leading-relaxed text-ink font-body whitespace-pre-wrap break-words ${bodyClassName}`}
          style={clamped ? CLAMP_STYLE : undefined}>
          {text}
        </div>
        {meta && expanded && (
          <div data-testid={metaTestId} className="mt-1 px-1 text-[11px] leading-relaxed text-ink-faint font-body whitespace-pre-wrap break-words">
            {meta}
          </div>
        )}
      </div>
    </div>
  );
});
