import React from 'react';
import { X, ShieldAlert, ExternalLink } from './Icon.jsx';

// L2: 首次启动检测到 macOS 未授予 GUI app 完全磁盘访问 → 弹引导。
// 不强阻断,用户可"以后再说",但 AI 调用工具读 ~/Downloads/Documents 会失败。
// Windows/Linux 不弹(server 端 needsFullDiskAccess 已直返 false)。
export function FullDiskAccessModal({ onOpenSettings, onDismiss }) {
  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 backdrop-blur-soft animate-fade-in">
      <div className="glass-popover w-[500px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[min(85vh,calc(var(--app-h,100dvh)-2rem))] overflow-y-auto rounded-panel shadow-popover animate-glass-rise">
        <div className="px-5 py-4 border-b border-canvas-deep flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
            <ShieldAlert size={16} className="text-amber-700" />
          </div>
          <div className="flex-1 text-[14px] font-medium text-ink font-body">需要文件访问权限</div>
          <button onClick={onDismiss} className="p-1.5 hover:bg-canvas-warm rounded transition-colors">
            <X size={14} className="text-ink-faint" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3 text-[13px] text-ink-soft font-body leading-relaxed">
          <p>macOS 系统默认拒绝 app 读取 Downloads / Desktop / Documents 等受保护目录。<br/>未授权时,Claude 在这些目录里读文件会失败。</p>
          <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 space-y-2 text-[12px]">
            <div className="font-medium text-ink">一次性授权步骤(永久有效)</div>
            <ol className="list-decimal list-inside space-y-1 text-ink-muted">
              <li>点下方按钮打开 系统设置 → 完全磁盘访问</li>
              <li>点 <span className="px-1 py-0.5 rounded bg-canvas-deep font-mono text-[11px]">+</span> 选 <span className="font-mono">/Applications/Claude GUI.app</span></li>
              <li>打开开关,**完全退出本 app**(右键 Dock 图标 → 退出),重新打开</li>
            </ol>
          </div>
          <p className="text-[11px] text-ink-faint">每次 build app(adhoc 签名),按 bundle ID 持久化的"完全磁盘访问"会保留;按 cdhash 的"Downloads 单目录"则会失效——所以选完全磁盘访问。</p>
        </div>
        <div className="px-5 py-3 border-t border-canvas-deep flex items-center justify-between gap-2 bg-canvas-warm/40">
          <button onClick={onDismiss} className="px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink rounded-md hover:bg-canvas-warm transition-colors">我已授权,不再提醒</button>
          <div className="flex items-center gap-2">
            <button onClick={onDismiss} className="px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink rounded-md hover:bg-canvas-warm transition-colors">以后再说</button>
            <button onClick={onOpenSettings}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-on-accent bg-accent hover:bg-accent/90 rounded-md transition-colors">
              <ExternalLink size={12} /> 打开系统设置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
