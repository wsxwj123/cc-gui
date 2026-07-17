import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Check, X, Download, Terminal, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';

// 统一环境检查面板:node(硬需求,app 能跑=必在)/ claude CLI(硬需求)/ python(可选,
// 部分技能需要)。每项显示状态 + 缺失时一键在终端安装 + 重新检测。
// 首次启动当 claude 缺失时作为模态弹出;也可在设置里常驻打开。
// 注:node 缺失时这个面板根本渲染不出来(它由 node server 渲染)——那种情况走原生报错框。

const ROWS = [
  { key: 'node', label: 'Node.js', desc: '运行 GUI 后台服务(必需)', required: true },
  { key: 'claude', label: 'Claude Code CLI', desc: '对话核心,GUI 调用 claude(必需)', required: true },
  { key: 'git', label: 'Git', desc: '项目初始化 / 回滚 AI 改动 / worktree(可选但强烈建议)', required: false },
  { key: 'python', label: 'Python 3', desc: '部分技能需要:生图 / 出题 / bot 等(可选)', required: false },
  { key: 'uv', label: 'uv', desc: '部分 MCP 用 uvx 运行:Fetch / Paper Search 等(可选)', required: false },
];

// 未检测到时的说明文案(客观陈述:检测已覆盖 PATH、各盘常见安装目录与版本管理器落点;
// 仍未找到则多半确实未安装,或装在完全自定义的目录 —— 加入 PATH 后重新检测即可被识别)。
const MISSING_HINT = '检测范围包含 PATH、常见安装目录与各版本管理器。若已安装到自定义目录,需将该目录加入 PATH 后点「重新检测」。';

export default function EnvCheckPanel({ onDismiss, onRecheck, asModal = true }) {
  const [data, setData] = useState(null);
  const [checking, setChecking] = useState(false);
  const [launched, setLaunched] = useState({}); // key → true(已开终端装)
  const [expanded, setExpanded] = useState({}); // key → true(展开全部安装清单)

  const check = useCallback(async (force = false) => {
    setChecking(true);
    try {
      // force(点「重新检测」)带 refresh=1 绕过 server 端全量扫描缓存;打开面板用缓存,秒回。
      const r = await fetch(`/api/env-check${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
      setData(await r.json());
      // 重新检测=以最新结果为准,清掉"已开终端"的过渡态:安装失败(仍未装)时安装按钮
      // 得重新出现让用户重试,否则一直卡在"已开终端,装完点重新检测"再也点不了安装。
      setLaunched({});
    } catch { /* server 挂了不弹,免得更晕 */ }
    setChecking(false);
    // 同步父组件触发态(claude 装好后父级 cliInstalled=true → 自动关弹窗)
    onRecheck?.();
  }, [onRecheck]);
  useEffect(() => { check(); }, [check]);

  // method:仅 claude 用 'npm' | 'native';其余 target 不传(后端按 target 自带命令)。
  const install = async (key, method) => {
    try {
      const r = await fetch('/api/env-check/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: key, ...(method ? { method } : {}) }),
      });
      const d = await r.json();
      if (d.ok) setLaunched((p) => ({ ...p, [key]: true }));
    } catch {}
  };

  const body = (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Terminal size={16} className="text-accent" />
        <div className="text-[14px] font-medium text-ink font-body">环境检查</div>
      </div>
      <p className="text-[12px] text-ink-muted font-body leading-snug">
        Claude GUI 需要以下组件。缺失项可点「安装」在终端里一键装,装完点「重新检测」。
      </p>
      <div className="space-y-2">
        {ROWS.map((row) => {
          const item = data?.[row.key];
          const ok = item?.installed;
          const ver = item?.version;
          // meets 仅 node 返回(≥20 硬性);其余工具无最低版本要求,不显示达标标记。
          const belowMin = ok && item?.meets === false;
          const installs = Array.isArray(item?.installs) ? item.installs : [];
          const isExpanded = !!expanded[row.key];
          return (
            <div key={row.key} className="px-3 py-2.5 rounded-lg bg-canvas-warm/60 border border-canvas-deep">
              <div className="flex items-center gap-3">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${belowMin ? 'bg-warning/20 text-warning' : ok ? 'bg-success/20 text-success' : row.required ? 'bg-error/20 text-error' : 'bg-ink-faint/15 text-ink-faint'}`}>
                {belowMin ? <AlertTriangle size={12} /> : ok ? <Check size={12} /> : <X size={12} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink font-body flex items-center gap-2">
                  {row.label}
                  {!row.required && <span className="text-[10px] text-ink-faint border border-canvas-deep rounded px-1">可选</span>}
                  {ok && ver && <span className="text-[10px] text-ink-faint font-mono">{ver}</span>}
                  {belowMin && (
                    <span className="text-[10px] text-warning font-body">版本过低,需 ≥ {item.minVersion}</span>
                  )}
                </div>
                {/* 使用中的安装:实际解析到的二进制路径(env-check 返回 resolvedPath,全部工具) */}
                {ok && item?.resolvedPath && (
                  <div className="text-[10px] text-ink-faint font-mono truncate" title={item.resolvedPath}>
                    {item.resolvedPath}
                  </div>
                )}
                {!ok && data && (
                  <div className="text-[10px] text-ink-faint font-body leading-snug">{MISSING_HINT}</div>
                )}
                {/* 找到多个安装时可展开查看全部(路径+版本;标出使用中的那一个) */}
                {installs.length > 1 && (
                  <button
                    onClick={() => setExpanded((p) => ({ ...p, [row.key]: !p[row.key] }))}
                    className="mt-0.5 flex items-center gap-0.5 text-[10px] text-accent hover:text-accent-hover font-body">
                    {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    检测到 {installs.length} 个安装
                  </button>
                )}
              </div>
              {!ok && row.key !== 'node' && (
                launched[row.key]
                  ? <span className="text-[11px] text-success font-body shrink-0">已开终端,装完点重新检测</span>
                  : row.key === 'claude'
                    // CI-2:claude 给 npm / native 两个选项(原来只有 native=官方安装器,Win 上
                    // claude.ai 常被墙;npm 走 node、看得见进度、墙内更稳)。
                    ? <div className="shrink-0 flex items-center gap-1.5">
                        <button onClick={() => install('claude', 'npm')}
                          title="npm install -g @anthropic-ai/claude-code(走 node,看得见进度;墙内更稳)"
                          className="flex items-center gap-1 px-2.5 py-1 rounded text-[12px] font-medium text-white bg-accent hover:bg-accent-hover">
                          <Download size={12} />npm 安装
                        </button>
                        <button onClick={() => install('claude', 'native')}
                          title="官方安装器(claude.ai/install;墙内可能连不上)"
                          className="px-2.5 py-1 rounded text-[12px] font-medium text-ink border border-canvas-deep hover:bg-canvas-deep/40">
                          官方安装器
                        </button>
                      </div>
                    : <button onClick={() => install(row.key)}
                        className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded text-[12px] font-medium text-white bg-accent hover:bg-accent-hover">
                        <Download size={12} />安装
                      </button>
              )}
              {!ok && row.key === 'node' && (
                <span className="text-[11px] text-error font-body shrink-0">缺失(请重装 node 后重开)</span>
              )}
              </div>
              {isExpanded && installs.length > 1 && (
                <div className="mt-1.5 ml-8 space-y-1">
                  {installs.map((ins) => {
                    // resolvedPath 可能是入口路径也可能是 realpath(如 node 的 execPath 已解 symlink),两头都比。
                    const active = ins.path === item?.resolvedPath || (ins.real && ins.real === item?.resolvedPath);
                    return (
                      <div key={ins.path} className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] text-ink-faint font-mono truncate flex-1" title={ins.path}>{ins.path}</span>
                        {ins.version && <span className="text-[10px] text-ink-faint font-mono shrink-0">{ins.version}</span>}
                        {active && <span className="text-[9px] text-success border border-success/40 rounded px-1 shrink-0">使用中</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button onClick={() => check(true)} disabled={checking}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium text-ink border border-canvas-deep hover:bg-canvas-deep/40 disabled:opacity-50">
          <RefreshCw size={12} className={checking ? 'animate-spin' : ''} />{checking ? '检测中…' : '重新检测'}
        </button>
        {onDismiss && (
          <button onClick={onDismiss} className="px-3 py-1.5 rounded text-[12px] text-ink-faint hover:text-ink font-body">
            跳过
          </button>
        )}
      </div>
    </div>
  );

  if (!asModal) return body;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-[440px] max-h-[80vh] overflow-y-auto glass-thick rounded-2xl p-5 shadow-xl animate-glass-rise">
        {body}
      </div>
    </div>
  );
}
