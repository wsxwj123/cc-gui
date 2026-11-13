import React from 'react';

// r176:接口报错下方的动作区。本地副本(报错分支加的 ❌ 块 / 本回合合成报错的副本)与
// 落盘的历史回合共用这一份界面;三种动作各自做的事由调用方传进来,这里只管画。
//   action: 'provider' | 'repair-official' | 'content-risk' | null
//   hints:  补充提示(1M / 官方未登录 / 签名 / 诊断串说明);r183 起本地 ❌ 块也走这里,
//           不再用引用语法拼在正文里。
export default function ApiErrorActions({
  action,
  hints = null,
  mobileChrome,
  sessionId,
  projectHash,
  repairReport,
  onOpenRepair,
  riskRewound,
  contentRiskAnchor,
  onContentRiskRewind,
  onNewSessionWithLastUser,
}) {
  const hintList = Array.isArray(hints) ? hints.filter(Boolean) : [];
  return (
    <>
      {hintList.length > 0 && (
        <div className="px-4 pb-2 -mt-1">
          {hintList.map((h) => (
            <div key={h} className="text-[12px] text-ink-muted font-body leading-relaxed border-l-2 border-canvas-deep pl-2 mb-1">
              {h}
            </div>
          ))}
        </div>
      )}
      {/* 鉴权类错误的动作链接:打开顶栏 Provider 弹层核对 key/渠道
          (cgui:open-provider → 顶栏 ProviderSwitcher 单实例)。
          手机布局无该弹层(走 MobileMenu Provider 分页),隐藏按钮避免死点。 */}
      {action === 'provider' && !mobileChrome && (
        <div className="px-4 pb-2 -mt-1">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('cgui:open-provider'))}
            className="px-3 py-1.5 rounded-lg border border-canvas-deep bg-canvas-warm text-[12px] text-accent font-body hover:border-accent/40 transition-colors">
            检查 Provider 设置
          </button>
        </div>
      )}
      {/* r10-12→r11-⑤:官方拒收历史空内容块 → 行动卡改为唤出居中体检模态
          (三态反馈全显式,统计数字持久于 localStorage,刷新后仍可唤出)。 */}
      {action === 'repair-official' && sessionId && (
        <div className="px-4 pb-2 -mt-1">
          <div className="text-[12px] text-ink-muted font-body mb-1.5">
            {repairReport
              ? `检测到历史含官方不接受的空内容块(空text ${repairReport.emptyText || 0} 处/空thinking ${repairReport.emptyThinking || 0} 处)`
              : '检测到历史可能含官方不接受的空内容块'}
          </div>
          {/* r151r:清理只删空段落;不空的第三方思考段落不带官方签名,清理后仍可能被拒 → 固定给出路。 */}
          <div className="text-[12px] text-ink-muted font-body mb-1.5 leading-relaxed">
            清理只删除空段落。清理后仍被拒：切回原来的 provider,在此会话执行 /compact 后再切回;或新开会话。
          </div>
          <button
            onClick={() => onOpenRepair({ sessionId, projectHash })}
            className="px-3 py-1.5 rounded-lg border border-canvas-deep bg-canvas-warm text-[12px] text-accent font-body hover:border-accent/40 transition-colors">
            体检与清理(自动备份原文件)…
          </button>
        </div>
      )}
      {/* r99:服务商内容审核拒绝(DeepSeek 400 Content Exists Risk)。被拒内容
          留在上下文里,之后每一轮都会被同样拒绝 → 必须把它从会话里移除。
          不加 mobileChrome 门控:手机同样需要这两个动作,且不依赖顶栏弹层。 */}
      {action === 'content-risk' && (
        <div className="px-4 pb-2 -mt-1">
          <div className="text-[12px] text-ink-muted font-body mb-1.5 leading-relaxed">
            该请求被服务商的内容审核拒绝，不是本机或 CLI 的故障。触发内容通常是最近一条工具输出或消息正文。
            该内容仍在会话上下文中，不移除则之后每一轮请求都会被同样拒绝。
            {riskRewound
              && '本会话已自动回退过一次，再次被拒说明触发内容在更早的位置或在你自己的消息里；继续自动回退会覆盖上一次的备份，因此下面只提供改写消息与新开会话。'}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onContentRiskRewind}
              className="px-3 py-1.5 rounded-lg border border-canvas-deep bg-canvas-warm text-[12px] text-accent font-body hover:border-accent/40 transition-colors">
              {contentRiskAnchor ? '回退到上一条工具输出之前并重发' : '回退到上一条消息之前并重新编辑'}
            </button>
            <button
              onClick={onNewSessionWithLastUser}
              className="px-3 py-1.5 rounded-lg border border-canvas-deep bg-canvas-warm text-[12px] text-ink-muted font-body hover:border-accent/40 transition-colors">
              新开会话(带上最后一条消息)
            </button>
          </div>
        </div>
      )}
    </>
  );
}
