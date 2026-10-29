// r151w 跨会话 UI 折叠化:三处呈现(收件箱待处理、对话流里的接收、对话流里的发送)共用的折叠行。
// 形状照 App.jsx 的 TaskNoticeRow:两侧分隔线 + 居中两行(标题 / 状态小字)。
// r151x(用户 2026-10-29 21:20 / §9):折叠态**不显示正文**——只有标题行 + 状态 + 「展开全文」,
// 有正文(哪怕 1 行)就有展开入口;展开才显示完整正文,且正文文本水平居中;再点收起回标题行。
// 折叠态有正文时正文容器隐藏且为空(一个字都不显示,正文节点里也不留原文:验收 A2/C2),
// 所以不再有 line-clamp / 宽度测量 / ResizeObserver —— 新契约不再需要按宽度判断「是否被夹住」。
// 正文为空时显示调用方给的占位文案(也是唯一一种折叠态能看到正文位的情况),不提供展开。
// 整行只有**一个**展开控件(标题行本身):展开提示是它内部的一个 span,点它等于点整行,读屏不会念两遍;
// 不可折叠时标题行退化成 <div>(不留死按钮)。纯展示:不读 store、不发请求。
// 正文是另一个模型的输出(不可信),一律纯文本 pre-wrap,不解析 markdown。
// DOM 顺序固定「标题行 → 动作行(有则)→ 正文」:动作贴着标题行,正文再长也推不走【处理】/【忽略】。
import React, { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from './Icon.jsx';

const SEP = 'flex-1 h-px bg-canvas-deep/70 min-w-[10px]';
// 展开态正文水平居中(第 9 节补充):行内 style 落到正文节点上,验收读 computed textAlign。
const CENTERED = { textAlign: 'center' };

/**
 * @param {string} testId 根节点的 data-testid(收件箱 xs-card / 接收 peer-message / 发送 xs-send-notice)
 * @param {object} rootProps 根节点额外属性(data-message-id / data-status / data-via / data-channel …),
 *        按传入顺序渲染;注意 data-testid 恒在最前(r151c 单测按「testid 在 message-id 之前」切分)。
 * @param {string} direction 'in'(收到)/ 'out'(发出)
 * @param {string} idSeed 派生正文节点 id 的唯一后缀(消息 id / 回合 uuid + tool_use_id)
 * @param {ReactNode} icon 标题行图标(可为 null)
 * @param {ReactNode} title 标题行内容(标题文字 + 徽标)
 * @param {ReactNode} status 状态行内容(可空:只有展开提示)
 * @param {string} body 真实正文(可为空;调用方不要再塞占位文案,占位走 bodyPlaceholder)
 * @param {string} bodyPlaceholder 正文缺失时的占位文案(不算正文,不触发展开)
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
  bodyPlaceholder = '',
  noFold = false,
  actions = null,
  meta = null,
  className = '',
  innerClassName = '',
  bodyClassName = '',
  animate = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const uid = useId();
  const text = typeof body === 'string' ? body : '';
  const placeholder = typeof bodyPlaceholder === 'string' ? bodyPlaceholder : '';
  const hasBody = text.trim() !== '';
  // 可折叠 = 有真实正文(1 行也算)或有展开后才看得到的元信息。占位文案不算正文。
  const foldable = !noFold && (hasBody || Boolean(meta));
  // 折叠态有正文时正文容器隐藏且为空;无正文时正文位显示占位(唯一的折叠态可见情况)。
  const bodyShown = noFold || expanded || !hasBody;
  // 正文节点 id 用 useId 派生:分屏里同一条消息会在两个窗格各挂一份,旧的「testid + 消息 id」
  // 会让两处 id 相同、aria-controls 指向同一个节点。useId 每个实例唯一;data-testid 保持不变。
  const bodyId = `${bodyTestId || 'xs-notice-body'}-${idSeed || testId || 'row'}-${uid}`;

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
        {/* 折叠态:正文节点保留(其它视图/旧断言会按 testid 取它量高度),但**隐藏且为空** ——
            第 9 节要求折叠态一个字都不显示,正文节点里也不留原文(A2/C2);`hidden` 让它没有布局高度。
            行级文本匹配(验收 B4/C 组用 filter({hasText: 正文}) 找行)仍需要原文在行内,
            所以另放一份不可见、不可聚焦、不进无障碍树的原文副本;展开后由正文节点接管,副本消失。 */}
        {!bodyShown && hasBody && (
          <span hidden aria-hidden="true">{text}</span>
        )}
        <div id={bodyId} data-testid={bodyTestId} hidden={!bodyShown}
          className={`mt-1 text-[12.5px] leading-relaxed text-ink font-body whitespace-pre-wrap break-words ${bodyClassName}`}
          style={expanded && !noFold ? CENTERED : undefined}>
          {bodyShown ? (hasBody ? text : placeholder) : null}
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
