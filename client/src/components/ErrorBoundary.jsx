import React from 'react';

// 渲染崩溃降级边界:全仓此前零 ErrorBoundary,任何一处渲染 throw = 整页白屏
// (历次"一行崩全页"的制度性根因)。包住的子树崩了 → 局部报错块 + 重试,
// 其余区域照常可用。重试=清错误重渲子树(多数崩溃由瞬时数据形态触发,
// 状态刷新后可恢复;真持续崩用户也能看到具体错误信息而非白屏)。
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[ErrorBoundary]', error, info?.componentStack); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="m-3 p-4 rounded-lg border border-amber-300 bg-amber-50 text-[12px] font-body text-ink space-y-2">
        <div className="font-medium">{(this.props.label || '此区域')}渲染出错,其余功能不受影响。</div>
        <div className="text-ink-muted break-all">{String(error?.message || error)}</div>
        <button
          onClick={() => this.setState({ error: null })}
          className="px-2.5 py-1 rounded-md border border-canvas-deep bg-canvas hover:bg-canvas-deep text-[11px]"
        >重试</button>
      </div>
    );
  }
}
