import React, { useState } from 'react';
import { AlertTriangle, ExternalLink, RefreshCw, X, Download, Wifi } from 'lucide-react';

/**
 * 首次启动检测到 `claude` CLI 不存在时弹的模态。给小白:GUI 表面打开正常但
 * 后端 spawn ENOENT,没装 CLI 一发消息就报错。按平台给安装指引 + 一键安装,
 * 装完点"重新检测"再校验,装好就消失。
 *
 * 一键安装走 POST /api/claude-install — 在「运行 server 的那台机器」上执行
 * (mac/linux: 官方 install.sh;win: npm)。因为 claude CLI 必须装在 server 端
 * 才能被 spawn,所以即便从局域网浏览器点,也是装到服务器主机,符合预期。
 *
 * 平台判定用 navigator.userAgent / navigator.platform — 客户端识别,用于决定
 * 「展示」哪种安装命令;真正执行时由 server 的 process.platform 决定命令。
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
  const [installing, setInstalling] = useState(false);
  const [installErr, setInstallErr] = useState('');
  const [launched, setLaunched] = useState(false);
  const platform = detectPlatform();

  const handleRecheck = async () => {
    setRechecking(true);
    try { await onRecheck(); } finally { setRechecking(false); }
  };

  // 一键安装:POST /api/claude-install → 服务端打开一个终端运行安装命令(可见进度 +
  // 让安装器写 PATH)。终端是独立异步进程,这里只负责"启动",装完由用户点"重新检测"。
  const handleInstall = async () => {
    setInstalling(true);
    setInstallErr('');
    setLaunched(false);
    try {
      const r = await fetch('/api/claude-install', { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        setLaunched(true);              // 提示用户去终端看进度,完成后点重新检测
      } else {
        setInstallErr(d.error || '启动终端失败,请确认已开启代理后重试,或用下方命令手动安装。');
      }
    } catch (e) {
      setInstallErr(e.message || '安装请求失败');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in">
      <div className="glass-popover w-[520px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[88vh] overflow-y-auto rounded-2xl shadow-2xl animate-glass-rise">
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
          {/* 代理提示 — 安装要访问 claude.ai / npm,墙内不开代理基本拉不动 */}
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <Wifi size={14} className="text-amber-700 shrink-0 mt-0.5" />
            <div className="text-[12px] text-amber-800 leading-snug">
              安装需访问 <code className="font-mono">claude.ai</code> / <code className="font-mono">npm</code>。
              请先打开 <b>Clash Verge</b> 等代理工具并<b>开启系统代理</b>,否则大概率因网络失败。
            </div>
          </div>

          {/* 一键安装 — 按检测到的系统在 server 端执行匹配命令 */}
          <div className="rounded-lg border border-accent/30 bg-accent-subtle/30 px-3 py-3 space-y-2">
            <div className="text-[12px] text-ink font-body">
              检测到系统:<b>{platform === 'mac' ? 'macOS' : platform === 'windows' ? 'Windows' : 'Linux'}</b>
              {platform === 'windows'
                ? '(将用 npm 安装,需已装 Node ≥ 20)'
                : '(将用官方 install.sh 一键安装)'}
            </div>
            <button
              onClick={handleInstall}
              disabled={installing || rechecking}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[13px] text-white bg-accent hover:bg-accent/90 rounded-md transition-colors disabled:opacity-50"
            >
              <Download size={14} className={installing ? 'animate-pulse' : ''} />
              {installing ? '启动安装中…' : '一键安装 Claude Code'}
            </button>
            {launched && (
              <div className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5">
                ✅ 已打开终端运行安装,请在终端里查看进度。装完回来点下方"我装好了,重新检测"。
              </div>
            )}
            {installErr && (
              <div className="text-[11px] text-error font-mono whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
                {installErr}
              </div>
            )}
          </div>

          <div className="text-[11px] text-ink-faint pt-1">或手动安装:</div>
          {platform === 'mac' && (
            <>
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
            disabled={rechecking || installing}
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
