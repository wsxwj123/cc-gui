import React, { useState } from 'react';
import { AlertTriangle, ExternalLink, RefreshCw, X } from 'lucide-react';

/**
 * 首次启动检测到 `claude` CLI 不存在时弹的模态。给小白:GUI 表面打开正常但
 * 后端 spawn ENOENT,没装 CLI 一发消息就报错。按平台给安装指引,装完点
 * "重新检测"再校验,装好就消失。
 *
 * 平台判定用 navigator.userAgent / navigator.platform — 客户端识别,因为
 * 这个组件可能跑在浏览器(局域网客户端连服务器),不是 server 平台。
 */
function detectPlatform() {
  const ua = (navigator.userAgent || '').toLowerCase();
  const plat = (navigator.platform || '').toLowerCase();
  if (ua.includes('windows') || plat.includes('win')) return 'windows';
  if (ua.includes('mac') || plat.includes('mac')) return 'mac';
  return 'linux';
}

const CmdBlock = ({ children }) => (
  <pre className="bg-canvas-deep rounded px-3 py-2 text-[12px] font-mono text-ink-soft overflow-x-auto whitespace-pre">
    {children}
  </pre>
);

export function CliMissingModal({ onRecheck, onDismiss }) {
  const [rechecking, setRechecking] = useState(false);
  const platform = detectPlatform();

  const handleRecheck = async () => {
    setRechecking(true);
    try { await onRecheck(); } finally { setRechecking(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in">
      <div className="glass-popover w-[520px] max-w-[calc(100vw-1.5rem)] max-h-[88vh] overflow-y-auto rounded-2xl shadow-2xl animate-glass-rise">
        <div className="px-5 py-4 border-b border-canvas-deep flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
            <AlertTriangle size={18} className="text-amber-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-medium text-ink font-body">未检测到 Claude CLI</div>
            <div className="text-[11px] text-ink-faint font-body mt-0.5">本应用是 Claude Code CLI 的图形外壳,需要先装 CLI 才能用</div>
          </div>
          <button onClick={onDismiss} className="p-1.5 hover:bg-canvas-warm rounded transition-colors" title="跳过(我自己装)">
            <X size={14} className="text-ink-faint" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 text-[13px] text-ink-soft font-body">
          {platform === 'mac' && (
            <>
              <div>在 <b>macOS</b> 终端任选一种:</div>
              <div className="space-y-1">
                <div className="text-[11px] text-ink-faint">推荐(官方一键安装):</div>
                <CmdBlock>{`curl -fsSL https://claude.ai/install.sh | bash`}</CmdBlock>
              </div>
              <div className="space-y-1">
                <div className="text-[11px] text-ink-faint">或 npm(需先装 Node ≥ 20):</div>
                <CmdBlock>{`npm install -g @anthropic-ai/claude-code`}</CmdBlock>
              </div>
              <div className="text-[11px] text-ink-faint">
                没装 Node?去 <a href="https://nodejs.org/" target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-0.5">nodejs.org<ExternalLink size={10} /></a> 下 LTS 版。
              </div>
            </>
          )}
          {platform === 'windows' && (
            <>
              <div>在 <b>Windows</b> PowerShell 或 CMD:</div>
              <div className="space-y-1">
                <div className="text-[11px] text-ink-faint">需先装 Node.js 20+:<a href="https://nodejs.org/" target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-0.5">nodejs.org<ExternalLink size={10} /></a></div>
                <CmdBlock>{`npm install -g @anthropic-ai/claude-code`}</CmdBlock>
              </div>
              <div className="text-[11px] text-ink-faint">
                装完重启 PowerShell,跑 <code className="bg-canvas-deep px-1 rounded">claude --version</code> 验证。
              </div>
            </>
          )}
          {platform === 'linux' && (
            <>
              <div>在 <b>Linux</b> 终端:</div>
              <CmdBlock>{`curl -fsSL https://claude.ai/install.sh | bash`}</CmdBlock>
              <div className="text-[11px] text-ink-faint">或用 <code className="bg-canvas-deep px-1 rounded">npm i -g @anthropic-ai/claude-code</code>(需 Node ≥ 20)。</div>
            </>
          )}

          <div className="pt-2 text-[11px] text-ink-faint border-t border-canvas-deep mt-3">
            装完先在终端跑一次 <code className="bg-canvas-deep px-1 rounded">claude</code>,确认能正常对话(已登录订阅或配好 API Key),再回来点"重新检测"。
          </div>
        </div>

        <div className="px-5 py-3 border-t border-canvas-deep flex items-center justify-end gap-2 bg-canvas-warm/40">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink rounded-md hover:bg-canvas-warm transition-colors"
          >
            跳过(自己装)
          </button>
          <button
            onClick={handleRecheck}
            disabled={rechecking}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-white bg-accent hover:bg-accent/90 rounded-md transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={rechecking ? 'animate-spin' : ''} />
            {rechecking ? '检测中…' : '我装好了,重新检测'}
          </button>
        </div>
      </div>
    </div>
  );
}
