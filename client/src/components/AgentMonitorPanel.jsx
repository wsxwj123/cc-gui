import React, { useEffect, useState, useRef } from 'react';
import { Bot, Loader2, Square, Clock, RefreshCw, Terminal, ChevronDown, ChevronRight, Maximize2, PlayCircle } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';

function fmtElapsed(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

// Card for a single server-side agent (chat-process or cli-session). Shows
// the prompt preview, elapsed time, model, and a stop button that the parent
// has wired with a fallback path for cli-session pids.
function RemoteAgentCard({ agent, stoppingPid, onStop }) {
  return (
    <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-2.5">
      <div className="flex items-center gap-2 mb-1">
        <Terminal size={11} className="text-blue-600" />
        <span className="text-xs font-medium text-ink font-mono truncate">
          {agent.kind === 'chat-process' ? `chat #${agent.pid}` : (agent.name || `cli #${agent.pid}`)}
        </span>
        <div className="ml-auto"><StatusBadge status={agent.status} /></div>
      </div>
      {(agent.promptPreview || agent.lastResponse) && (
        <div className="text-[10.5px] text-ink-muted font-body line-clamp-2" title={agent.promptPreview || agent.lastResponse}>
          {agent.promptPreview || agent.lastResponse}
        </div>
      )}
      <div className="flex items-center gap-3 mt-1.5 text-[10px] text-ink-faint font-mono">
        {agent.startedAt && <span className="flex items-center gap-1"><Clock size={9} />{fmtElapsed(agent.elapsedMs ?? (Date.now() - agent.startedAt))}</span>}
        {agent.model && <span className="truncate">{agent.model}</span>}
        {agent.cwd && <span className="truncate opacity-70" title={agent.cwd}>{agent.cwd.split('/').pop()}</span>}
      </div>
      {agent.pid && agent.stoppable !== false && (
        <div className="mt-2 flex justify-end">
          <button
            onClick={() => onStop(agent.pid)}
            disabled={stoppingPid === agent.pid}
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 transition-colors disabled:opacity-50"
          >
            {stoppingPid === agent.pid ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
            停止
          </button>
        </div>
      )}
    </div>
  );
}

// Bucket wrapping multiple remote agent cards under a status heading.
function RemoteBucket({ title, titleColor, defaultOpen, agents, stoppingPid, onStop }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-faint font-body py-1 hover:text-ink-muted"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className={titleColor}>{title}</span>
        <span className="text-ink-ghost">({agents.length})</span>
      </button>
      {open && (
        <div className="space-y-2 mt-1.5">
          {agents.map((a, i) => <RemoteAgentCard key={a.pid || a.id || i} agent={a} stoppingPid={stoppingPid} onStop={onStop} />)}
        </div>
      )}
    </div>
  );
}

// Collapsible bucket — group header click toggles open, click on each
// agent card expands its details inline.
function AgentBucket({ title, titleColor, defaultOpen, agents }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-faint font-body py-1 hover:text-ink-muted"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className={titleColor}>{title}</span>
        <span className="text-ink-ghost">({agents.length})</span>
      </button>
      {open && (
        <div className="space-y-2 mt-1.5">
          {agents.map((a) => <AgentCard key={a.id} agent={a} />)}
        </div>
      )}
    </div>
  );
}

// Single agent card — click to expand and see thinking / tool calls / final result.
function AgentCard({ agent }) {
  const [expanded, setExpanded] = useState(false);
  const setViewingAgent = useStore((s) => s.setViewingAgent);
  const text = agent.text ? agent.text.join('') : '';
  const thinking = agent.thinking ? agent.thinking.join('') : '';
  const tools = agent.toolCalls || [];
  const hasDetail = text || thinking || tools.length > 0 || agent.result;
  return (
    <div className="bg-canvas-warm border border-violet-200 rounded-lg overflow-hidden">
      <button
        onClick={() => hasDetail && setExpanded(!expanded)}
        className="w-full p-2.5 text-left"
        disabled={!hasDetail}
      >
        <div className="flex items-center gap-2 mb-1">
          {hasDetail && (expanded ? <ChevronDown size={11} className="text-violet-600 shrink-0" /> : <ChevronRight size={11} className="text-violet-600 shrink-0" />)}
          <Bot size={11} className="text-violet-600 shrink-0" />
          <span className="text-xs font-medium text-ink font-mono truncate">{agent.name || 'Task'}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <StatusBadge status={agent.status} />
            {/* #9 进入子代理会话窗口 */}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); if (agent.id) setViewingAgent(agent.id); }}
              className="p-0.5 rounded text-violet-500 hover:text-violet-800 hover:bg-violet-100 cursor-pointer"
              title="在子代理会话窗口打开"
            >
              <Maximize2 size={11} />
            </span>
          </div>
        </div>
        {agent.description && (
          <div className="text-[10.5px] text-ink-muted font-body truncate pl-5">{agent.description}</div>
        )}
        <div className="flex items-center gap-3 mt-1.5 pl-5 text-[10px] text-ink-faint font-mono">
          {agent.startedAt && <span className="flex items-center gap-1"><Clock size={9} />{fmtElapsed(Date.now() - agent.startedAt)}</span>}
          {tools.length > 0 && <span>{tools.length} 工具</span>}
        </div>
      </button>
      {expanded && hasDetail && (
        <div className="border-t border-violet-200 px-3 py-2 space-y-2 text-[11px] bg-canvas">
          {thinking && (
            <details>
              <summary className="cursor-pointer text-[10px] text-ink-faint uppercase tracking-wider font-body">思考 ({thinking.length} 字)</summary>
              <div className="mt-1 text-ink-muted whitespace-pre-wrap max-h-40 overflow-y-auto font-body">{thinking}</div>
            </details>
          )}
          {tools.length > 0 && (
            <div>
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body mb-1">工具调用 ({tools.length})</div>
              {tools.map((tc, i) => (
                <div key={tc.id || i} className="flex items-center gap-1.5 text-[11px] font-mono text-ink-soft py-0.5">
                  <span className="w-1 h-1 rounded-full bg-violet-400 shrink-0" />
                  <span>{tc.name}</span>
                  {tc.result ? (tc.result.isError ? <span className="text-error">✗</span> : <span className="text-success">✓</span>) : <Loader2 size={10} className="text-ink-faint animate-spin" />}
                </div>
              ))}
            </div>
          )}
          {text && (
            <div>
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body mb-1">回复</div>
              <div className="text-ink"><MarkdownRenderer content={text} /></div>
            </div>
          )}
          {agent.result && (
            <details>
              <summary className="cursor-pointer text-[10px] text-ink-faint uppercase tracking-wider font-body">最终结果</summary>
              <pre className="mt-1 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto p-1.5 rounded bg-canvas-warm text-ink-muted">{String(agent.result).slice(0, 4000)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    streaming:   { label: '运行中',  bg: 'bg-blue-50',  fg: 'text-blue-700',   border: 'border-blue-200' },
    starting:    { label: '启动中',  bg: 'bg-amber-50', fg: 'text-amber-700',  border: 'border-amber-200' },
    working:     { label: '工作中',  bg: 'bg-blue-50',  fg: 'text-blue-700',   border: 'border-blue-200' },
    done:        { label: '完成',    bg: 'bg-green-50', fg: 'text-green-700',  border: 'border-green-200' },
    idle:        { label: '空闲',    bg: 'bg-amber-50', fg: 'text-amber-700',  border: 'border-amber-200' },
    stopped:     { label: '已停止',  bg: 'bg-red-50',   fg: 'text-red-700',    border: 'border-red-200' },
    error:       { label: '错误',    bg: 'bg-red-50',   fg: 'text-red-700',    border: 'border-red-200' },
    needs_input: { label: '待输入',  bg: 'bg-violet-50', fg: 'text-violet-700', border: 'border-violet-200' },
  };
  const m = map[status] || { label: status || '—', bg: 'bg-canvas-warm', fg: 'text-ink-muted', border: 'border-canvas-deep' };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${m.bg} ${m.fg} border ${m.border}`}>
      {m.label}
    </span>
  );
}

// 后台任务卡片(claude `Bash run_in_background:true`)。实时输出不进 stream-json,
// 而是持续写入磁盘 .output 文件 —— 这里按 offset 增量轮询 /api/bgtask/output 做 tail。
// 状态启发式:文件大小连续若干次不增长 → 视为"完成"(无显式退出码事件)。
function BgTaskCard({ task }) {
  const [expanded, setExpanded] = useState(true);
  const [output, setOutput] = useState('');
  // 'running'=输出在增长;'idle'=一段时间无新输出(**无法确知是否已结束**,故不谎称"完成")。
  // 没有显式退出码事件,只能据"输出是否增长"启发式判断,所以最多到"空闲",不到"完成"。
  const [phase, setPhase] = useState('running'); // running | idle | stopped
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [stopNote, setStopNote] = useState('');
  const offsetRef = useRef(0);
  const staleRef = useRef(0);
  const stoppedRef = useRef(false);
  const preRef = useRef(null);

  useEffect(() => {
    if (!task.outputPath) return;
    let cancelled = false;
    const poll = async () => {
      if (stoppedRef.current) return; // 已手动停止 → 不再轮询
      try {
        const r = await fetch(`/api/bgtask/output?path=${encodeURIComponent(task.outputPath)}&offset=${offsetRef.current}`);
        const d = await r.json();
        if (cancelled || stoppedRef.current || !d.exists) return;
        if (d.content) {
          setOutput((prev) => (prev + d.content).slice(-40000)); // 只留尾部 40KB,防超长撑爆
          offsetRef.current = d.size;
          staleRef.current = 0;
          setPhase('running');
        } else {
          staleRef.current += 1;
          if (staleRef.current >= 6) setPhase('idle'); // ~9s 无增长 → 标"空闲"(不等于"完成")
        }
      } catch {}
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [task.outputPath]);

  // 1s tick 驱动"已运行时长"跳动(只在运行中跳;空闲后停更省渲染)
  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // 输出增长时自动滚到底部
  useEffect(() => {
    if (expanded && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [output, expanded]);

  // 手动中断后台任务(用户怕它损坏文件时随时停)。服务端按 .output 句柄/命令行精确
  // 定位进程再杀;定位不到(可能已结束)如实提示,不乱杀。
  const onStop = async (e) => {
    e.stopPropagation();
    if (stopping || phase === 'stopped' || !task.outputPath) return;
    setStopping(true); setStopNote('');
    try {
      const r = await fetch('/api/bgtask/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: task.outputPath }),
      });
      const d = await r.json();
      if (d.ok && d.located) { stoppedRef.current = true; setPhase('stopped'); }
      else setStopNote('未定位到进程(可能已结束)。若仍在运行,请在系统任务管理器手动结束');
    } catch { setStopNote('停止失败,请重试或手动结束'); }
    setStopping(false);
  };

  const elapsed = task.startedAt ? now - task.startedAt : 0;
  return (
    <div className="bg-canvas-warm border border-amber-200 rounded-lg overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full p-2.5 text-left">
        <div className="flex items-center gap-2 mb-1">
          {expanded ? <ChevronDown size={11} className="text-amber-600 shrink-0" /> : <ChevronRight size={11} className="text-amber-600 shrink-0" />}
          <PlayCircle size={11} className="text-amber-600 shrink-0" />
          <span className="text-xs font-medium text-ink font-mono truncate" title={task.command}>
            {task.description || task.command || '后台命令'}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <StatusBadge status={phase === 'stopped' ? 'stopped' : (phase === 'running' ? 'streaming' : 'idle')} />
            {phase !== 'stopped' && task.outputPath && (
              <span
                role="button"
                tabIndex={0}
                onClick={onStop}
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 cursor-pointer disabled:opacity-50"
                title="中断这个后台任务(杀掉其进程)"
              >
                {stopping ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}停止
              </span>
            )}
          </div>
        </div>
        {task.command && (
          <div className="text-[10.5px] text-ink-muted font-mono truncate pl-5" title={task.command}>$ {task.command}</div>
        )}
        <div className="flex items-center gap-3 mt-1.5 pl-5 text-[10px] text-ink-faint font-mono">
          {task.startedAt && <span className="flex items-center gap-1"><Clock size={9} />{fmtElapsed(elapsed)}</span>}
          {task.shellId && <span className="truncate opacity-70" title={task.shellId}>{task.shellId}</span>}
        </div>
        {stopNote && <div className="mt-1.5 pl-5 text-[10px] text-amber-700 font-body leading-snug">{stopNote}</div>}
      </button>
      {expanded && (
        <div className="border-t border-amber-200 bg-canvas">
          {output ? (
            <pre ref={preRef} className="m-0 px-3 py-2 font-mono text-[10.5px] leading-snug whitespace-pre-wrap break-words text-ink-muted max-h-56 overflow-y-auto">{output}</pre>
          ) : (
            <div className="px-3 py-3 text-[10.5px] text-ink-faint font-body text-center">{task.outputPath ? '等待输出…' : '无输出文件路径'}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Right-side panel showing live subagent / chat-process state. Polls
 * /api/agents/active every 1.5s while mounted. Also merges in the
 * client-side `activeAgents` store (Task-tool subagents we tracked locally
 * from the current stream).
 */
export function AgentMonitorPanel() {
  const [remote, setRemote] = useState({ agents: [], sources: { chatProcesses: 0, cliSessions: 0 } });
  const [loading, setLoading] = useState(true);
  const [stoppingPid, setStoppingPid] = useState(null);
  const localAgents = useStore((s) => s.activeAgents);
  const bgTasks = useStore((s) => s.bgTasks);
  const paneSessions = useStore((s) => s.paneSessions);

  const fetchActive = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await fetch('/api/agents/active');
      const data = await r.json();
      setRemote({
        agents: Array.isArray(data.agents) ? data.agents : [],
        sources: data.sources || { chatProcesses: 0, cliSessions: 0 },
      });
    } catch {}
    if (!silent) setLoading(false);
  };

  useEffect(() => {
    fetchActive();
    const id = setInterval(() => fetchActive(true), 1500);
    return () => clearInterval(id);
  }, []);

  // Stop a child process. Two endpoints exist:
  //   /api/chat/:pid/stop      — only knows our own chat-process spawns
  //   /api/processes/:pid/kill — whitelist-checked kill for any pid in the CLI
  //                              sessions registry (covers cli-session agents)
  // Try chat-stop first; on 404 fall back to processes-kill.
  const stop = async (pid) => {
    if (!pid) return;
    setStoppingPid(pid);
    try {
      const r = await fetch(`/api/chat/${pid}/stop`, { method: 'POST' });
      if (r.status === 404) {
        await fetch(`/api/processes/${pid}/kill`, { method: 'POST' });
      }
      await new Promise((r) => setTimeout(r, 400));
      await fetchActive(true);
    } catch {}
    setStoppingPid(null);
  };

  // Merge local + remote — local agents come from current stream's Task
  // tool_uses; remote includes our chat-process metadata and CLI's view.
  const localList = Object.values(localAgents);
  // 后台任务:只显示本 stream 捕获到、且已拿到输出文件路径的(以 A 通道为准,
  // 避免列出 tasks 目录里的历史幽灵 .output)。并且**只显示当前打开的会话**的后台任务
  // (按所有分屏窗格的 sessionId 过滤)—— 否则切会话后旧卡片会永久堆积且持续轮询。
  // sessionId 为空的(draft 阶段启动、无法归属)也显示,避免误藏。最新启动的排在最前。
  const openSessionIds = new Set((paneSessions || []).filter(Boolean).map((s) => s.sessionId).filter(Boolean));
  const bgList = Object.values(bgTasks || {})
    .filter((t) => t.outputPath && (!t.sessionId || openSessionIds.has(t.sessionId)))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  // Bucket by status. 'working'/'starting' default expanded, the rest folded.
  const buckets = {
    working:    localList.filter((a) => a.status === 'working' || a.status === 'starting' || !a.status),
    waiting:    localList.filter((a) => a.status === 'needs_input'),
    done:       localList.filter((a) => a.status === 'done'),
    error:      localList.filter((a) => a.status === 'error'),
  };
  const BUCKET_META = {
    working: { label: '工作中', defaultOpen: true,  color: 'text-blue-600' },
    waiting: { label: '等待输入', defaultOpen: true, color: 'text-violet-600' },
    done:    { label: '已完成', defaultOpen: false, color: 'text-green-600' },
    error:   { label: '错误',   defaultOpen: false, color: 'text-red-600' },
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-canvas-deep shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-ink-faint font-body flex items-center gap-1.5">
            <Bot size={11} />Subagent 监控
          </span>
          <button onClick={() => fetchActive()} className="p-1 text-ink-faint hover:text-ink-muted" title="刷新">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <p className="text-[10px] text-ink-faint mt-1 font-body leading-snug">
          实时显示当前活跃的 subagent 与本地 Claude 子进程。
          数据源：本地 chat <b>{remote.sources.chatProcesses}</b> · CLI session <b>{remote.sources.cliSessions}</b>
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Local Task tool subagents (from current stream) — grouped by status */}
        {localList.length > 0 && (
          <section>
            <h3 className="text-[10px] uppercase tracking-widest text-ink-faint font-body mb-2 flex items-center gap-1.5">
              <Bot size={10} />当前对话内 Task ({localList.length})
            </h3>
            <div className="space-y-3">
              {Object.entries(buckets).map(([key, agents]) => {
                if (agents.length === 0) return null;
                return (
                  <AgentBucket
                    key={key}
                    title={BUCKET_META[key].label}
                    titleColor={BUCKET_META[key].color}
                    // 本地子代理一律默认展开:跑完进 done 桶被折叠是"看不见子代理活动"
                    // 的主因之一,这里全部展开,确保捕获到的子代理都直接可见。
                    defaultOpen
                    agents={agents}
                  />
                );
              })}
            </div>
          </section>
        )}

        {/* 后台任务(Bash run_in_background / python 后台)— 实时 tail .output 文件 */}
        {bgList.length > 0 && (
          <section>
            <h3 className="text-[10px] uppercase tracking-widest text-ink-faint font-body mb-2 flex items-center gap-1.5">
              <PlayCircle size={10} />后台任务 ({bgList.length})
            </h3>
            <div className="space-y-2">
              {bgList.map((t) => <BgTaskCard key={t.id} task={t} />)}
            </div>
          </section>
        )}

        {/* Server-side chat children + CLI agents — bucketed by status so the
            "working" ones default open and finished/errored ones fold away. */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-ink-faint font-body mb-2 flex items-center gap-1.5">
            <Terminal size={10} />Claude 子进程 ({remote.agents.length})
          </h3>
          {remote.agents.length > 0 ? (
            (() => {
              const isWorking = (a) => ['streaming', 'starting', 'running', 'working'].includes(a.status);
              const isDone = (a) => ['done', 'finished', 'completed'].includes(a.status);
              const isError = (a) => ['error', 'failed'].includes(a.status);
              const isWaiting = (a) => ['needs_input', 'waiting'].includes(a.status);
              const groups = [
                { key: 'working', label: '工作中', color: 'text-blue-600', defaultOpen: true, list: remote.agents.filter(isWorking) },
                { key: 'waiting', label: '等待输入', color: 'text-violet-600', defaultOpen: true, list: remote.agents.filter(isWaiting) },
                { key: 'done', label: '已完成', color: 'text-green-600', defaultOpen: false, list: remote.agents.filter(isDone) },
                { key: 'error', label: '错误', color: 'text-red-600', defaultOpen: false, list: remote.agents.filter(isError) },
                { key: 'other', label: '其他', color: 'text-ink-muted', defaultOpen: false, list: remote.agents.filter((a) => !isWorking(a) && !isDone(a) && !isError(a) && !isWaiting(a)) },
              ].filter((g) => g.list.length > 0);
              return (
                <div className="space-y-3">
                  {groups.map((g) => (
                    <RemoteBucket key={g.key} title={g.label} titleColor={g.color} defaultOpen={g.defaultOpen} agents={g.list} stoppingPid={stoppingPid} onStop={stop} />
                  ))}
                </div>
              );
            })()
          ) : (
            <div className="text-[11px] text-ink-faint font-body py-4 text-center bg-canvas-warm border border-canvas-deep rounded-lg">
              {loading ? '加载中…' : '没有活跃的 subagent'}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
