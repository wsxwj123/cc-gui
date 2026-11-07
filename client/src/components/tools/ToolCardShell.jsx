import React from 'react';

// r158:展开后工具卡的统一骨架(设计稿 v8 ②)。
// 卡头 = [状态图标] [工具名小标签] [标题] [右侧信息];没有展开箭头(2026-11-07 用户要求),
// 整行可点、悬停有底色,开合靠 aria-expanded 表达。正文只在展开时挂载(大输出不常驻 DOM)。
// 受控组件:各卡自己持有 expanded 状态与默认值,这里只负责外形。
// status:run(没有结果)/ ok / err / stopped(被停止的合成结果)。
export function cardStatusOf(result, isError) {
  if (!result) return 'run';
  if (result.interrupted) return 'stopped';
  return (isError ?? result.isError) ? 'err' : 'ok';
}

export function ToolCardShell({
  toolName,
  label,
  status = 'ok',
  Icon,
  title,
  titleMono = false,
  titleHint,
  meta = null,
  expanded,
  onToggle,
  headExtra = null,
  className = '',
  children,
}) {
  return (
    <div
      className={`tc-card animate-fade-up ${className}`}
      data-tool-card=""
      data-tool-name={toolName || ''}
      data-status={status}
    >
      <button
        type="button"
        className="tc-head"
        data-tool-card-head=""
        aria-expanded={expanded ? 'true' : 'false'}
        onClick={onToggle}
      >
        <span className="tc-icon" data-tool-card-icon="">
          {status === 'run'
            ? <span className="mini-spin" aria-hidden="true" />
            : (Icon ? <Icon size={12} /> : null)}
        </span>
        <span className="tc-name" data-tool-card-name="">{label ?? toolName}</span>
        <span
          className={`tc-title ${titleMono ? 'tc-mono' : ''}`}
          data-tool-card-title=""
          title={titleHint ?? (typeof title === 'string' ? title : undefined)}
        >
          {title}
        </span>
        {headExtra}
        <span className="tc-meta" data-tool-card-meta="">{meta}</span>
        {/* 出错只靠红边与图标色区分,读屏用户收起态听不出来:补一句视觉隐藏的「出错」。
            不放进带 data-tool-card-* 钩子的元素(它们的文字被别处读取) */}
        {status === 'err' && <span className="sr-only">出错</span>}
      </button>
      {expanded && (
        <div className="tc-body" data-tool-card-body="">
          {children}
        </div>
      )}
    </div>
  );
}
