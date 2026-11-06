import { LoadingMark, ElapsedTime } from './LoadingBits.jsx';

// r154:生成中的底部状态行(主会话流式行、连接 / 压缩占位、子代理视图三处共用)。
// 版式固定为 指示器 · 用时 · 分隔点 · 状态词;label = liveStatusLabel 的返回 { phase, verb, object }。
// 颜色全取主题变量;流光只挂在状态词上,且只有生成中这一行挂(回合结束整行卸载)。
export function LiveStatusLine({ label, startedAt, className = '' }) {
  const phase = label?.phase || 'thinking';
  const verb = label?.verb || '';
  const object = label?.object || '';
  return (
    <div
      data-live-line=""
      data-live-phase={phase}
      {...(phase === 'stopping' ? { role: 'status' } : {})}
      className={`flex items-center gap-2 min-w-0 text-[13px] font-body ${className}`}
    >
      <span className="shrink-0 inline-flex items-center text-accent">
        <LoadingMark size={14} markProps={{ 'data-live-indicator': '' }} />
      </span>
      <span data-live-elapsed="" className="shrink-0 inline-flex">
        <ElapsedTime startedAt={startedAt} />
      </span>
      <span data-live-sep="" aria-hidden="true" className="shrink-0 text-ink-faint">·</span>
      {/* textContent 必须恰为 verb 或 verb + ' ' + object:中间只有一个空格,不带省略号 */}
      <span data-live-text="" className="live-shine min-w-0 truncate text-ink-soft">
        <span data-live-verb="">{verb}</span>
        {object ? <>{' '}<span data-live-object="" className="text-ink">{object}</span></> : null}
      </span>
    </div>
  );
}
