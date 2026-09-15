import React, { useContext, useEffect, useMemo, useState, useRef } from 'react';
import { Bot, Loader2, Square, Clock, RefreshCw, Terminal, ChevronDown, ChevronRight, Maximize2, PlayCircle } from './Icon.jsx';
import { useStore } from '../stores/sessionStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { WorkflowCard } from './tools/WorkflowCard.jsx';
import { SubagentCostContext, SubagentCostTag } from './tools/SubagentCost.jsx';
import { buildSubagentCostIndex } from '../utils/subagentCost.js';
import {
  AGENT_TERMINAL_STATUSES, agentHydrationStatus, agentOpenFailureAction, buildAgentRows, fetchAgentHistory,
  locateParentPane, shouldApplyHistory, splitHistoryBlocks,
} from '../utils/agentView.js';

function fmtElapsed(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

// 折叠态持久化:关闭监控面板会卸载整棵子树(App.jsx setRightPanel(null)),裸 useState
// 每次重开都回默认值。按区块 id 存一张 { id: open } 表。
// 只做区块层,不做卡片层(AgentCard / BgTaskCard 的 expanded):卡片 id 是 tool_use_id,
// 每个新任务一个,持久化会让 localStorage 无界增长。
const FOLD_KEY = 'cgui-monitor-fold';
const readFold = () => {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY)) || {}; } catch { return {}; }
};
const writeFold = (id, open) => {
  try { const m = readFold(); m[id] = open; localStorage.setItem(FOLD_KEY, JSON.stringify(m)); } catch {}
};

// 监控面板顶层区块的统一可折叠外壳(用户要求:所有选项都能折叠/展开)。
// 标题行整行可点;默认展开,折叠态只留标题。内部 bucket(AgentBucket 等)本就可折叠,
// 这层管的是「当前对话内 Task / 后台任务 / 后台代理 / Claude 子进程」四个大区。
function FoldableSection({ id, icon, title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(() => readFold()[id] ?? defaultOpen);
  return (
    <section>
      <button onClick={() => setOpen((v) => { writeFold(id, !v); return !v; })}
        className="w-full text-left text-[10px] uppercase tracking-widest text-ink-faint font-body mb-2 flex items-center gap-1.5 hover:text-ink-muted transition-colors">
        {open ? <ChevronDown size={10} className="shrink-0" /> : <ChevronRight size={10} className="shrink-0" />}
        {icon}{title}
      </button>
      {open && children}
    </section>
  );
}

// 后台代理(claude --bg):CLI 原生的"派后台会话"能力包一层。列表来自
// /api/agents/background?all=1(claude agents --json --all,含已结束);会话答完
// 仍常驻可 attach,所以必须给停止按钮(走 /api/processes/:pid/kill 白名单)。
// 5s 轮询(比子代理 1.5s 慢:每次轮询要 spawn 一次 claude agents,别太频)。
// 运行中 → 终态迁移时推应用内提醒(复用 CompletionToasts);已完成的显示结束
// 时间/最终状态/结果摘要,并提供"查看结果"打开该会话的转写。

// 终态集合(与 server/routes/agents.js 的 BG_TERMINAL_STATES 对齐)
const BG_TERMINAL = new Set(['done', 'failed', 'killed', 'stopped', 'error']);

function fmtWhen(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// 打开后台代理的会话转写:会话已在某分屏窗格 → 聚焦;否则替换当前聚焦窗格
// (与 CompletionToasts 的跳转逻辑一致,{sessionId, projectHash} 即可加载消息)。
function openBgAgentSession(a) {
  if (!a?.sessionId || !a?.projectHash) return;
  const st = useStore.getState();
  const idx = (st.paneSessions || []).slice(0, st.paneCount).findIndex((p) => p?.sessionId === a.sessionId);
  if (idx >= 0) { st.setActiveTabIndex(idx); return; }
  const sess = { sessionId: a.sessionId, projectHash: a.projectHash, draft: false };
  if (st.activeTabIndex === 0) st.setSelectedSession(sess);
  else st.setPaneSession(st.activeTabIndex, sess);
}

function BackgroundAgentsSection({ stoppingPid, onStop }) {
  const selectedProject = useStore((s) => s.selectedProject);
  const [agents, setAgents] = useState([]);
  const [prompt, setPrompt] = useState('');
  // 后台代理的权限档。默认 acceptEdits(沿用既有行为);选 default 时服务端会给它挂上
  // PermissionRequest hook,授权请求以权限卡出现在界面上。
  const [permMode, setPermMode] = useState('acceptEdits');
  const [dispatching, setDispatching] = useState(false);
  const [note, setNote] = useState('');
  const [stoppingId, setStoppingId] = useState('');
  const mountedRef = useRef(true);
  const loadTimerRef = useRef(null); // dispatch 后的 1.5s 刷新定时器,卸载兜底
  // sessionId → 是否已达终态(上次轮询)。null = 尚未完成首次轮询,首轮只记录
  // 不提醒(避免面板一打开就把历史已完成的全部弹一遍)。
  const prevTerminalRef = useRef(null);

  const load = async () => {
    try {
      const r = await fetch('/api/agents/background?all=1');
      const d = await r.json();
      if (!mountedRef.current) return;
      if (!Array.isArray(d.agents)) return;
      const bg = d.agents.filter((a) => a.kind === 'background');
      // 运行中 → 终态迁移检测:上一轮见过且未终态、这一轮终态 → 应用内提醒
      const prev = prevTerminalRef.current;
      const next = {};
      for (const a of bg) {
        const key = a.sessionId || a.id;
        if (!key) continue;
        const terminal = BG_TERMINAL.has(a.state);
        next[key] = terminal;
        if (prev && prev[key] === false && terminal) {
          useStore.getState().pushCompletionToast({
            sessionId: a.sessionId,
            projectHash: a.projectHash || null,
            session: a.sessionId && a.projectHash ? { sessionId: a.sessionId, projectHash: a.projectHash, draft: false } : null,
            title: a.name || '后台代理',
            suffix: `后台代理结束(${a.state})`,
            summary: a.detail || a.resultPreview || '',
            ts: Date.now(),
          });
        }
      }
      prevTerminalRef.current = next;
      setAgents(bg);
    } catch {}
  };
  useEffect(() => {
    mountedRef.current = true;
    load();
    const id = setInterval(load, 5000);
    return () => { mountedRef.current = false; clearInterval(id); clearTimeout(loadTimerRef.current); };
  }, []);

  const dispatch = async () => {
    const p = prompt.trim();
    const cwd = selectedProject?.path;
    if (!p || !cwd || dispatching) return;
    setDispatching(true); setNote('');
    try {
      const r = await fetch('/api/agents/background/dispatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, prompt: p, permissionMode: permMode }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '派发失败');
      setPrompt('');
      setNote(d.output?.split('\n')[0] || '已派发');
      clearTimeout(loadTimerRef.current); // 连续派发:清旧句柄,防覆盖成孤儿卸载清不到
      loadTimerRef.current = setTimeout(load, 1500);
    } catch (e) { setNote(String(e.message || e)); }
    setDispatching(false);
  };

  // 停后台代理:走官方 `claude stop <id>`(见后端注释),按【各自的 id】停,不再 pid kill。
  // 修:pid 挂同一 supervisor → 旧版停一个连坐全停、停不动、已停仍显示运行中。
  const stopBg = async (a) => {
    const id = a.id || a.sessionId;
    if (!id || stoppingId) return;
    setStoppingId(id); setNote('');
    try {
      const r = await fetch('/api/agents/background/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '停止失败');
      await load(); // 立即刷新:真停后本轮 state→stopped,卡片移入已结束区
    } catch (e) { setNote(String(e.message || e)); }
    setStoppingId('');
  };

  // 运行中 = 未达终态(state 缺失但有活 pid 的旧版 CLI 输出也归运行中)。
  // 在等你的(blocked / 注册表 waiting)排最前:它们不会自己走完,不处理就一直卡着。
  const waitsForYou = (a) => a.state === 'blocked' || a.status === 'waiting';
  const running = agents.filter((a) => !BG_TERMINAL.has(a.state))
    .sort((x, y) => (waitsForYou(y) ? 1 : 0) - (waitsForYou(x) ? 1 : 0));
  // 已完成的按结束时间(缺失退回开始时间)倒序,只显示最近 10 条防列表无限膨胀;
  // 超过 30 天的结束态自动不再显示(用户要求"自动清除"——CLI 侧数据不动,仅从监控隐藏)。
  const THIRTY_D = 30 * 24 * 3600 * 1000;
  const now = Date.now();
  const finished = agents.filter((a) => BG_TERMINAL.has(a.state))
    // 按结束时间判 30 天;endedAt 缺失时退回 now(视为刚结束、保留显示)——不能退回 startedAt,
    // 否则一个月前启动、刚结束的长任务会被立即隐藏(结束时间未知就不该按启动时间当已过期)。
    .filter((a) => now - (a.endedAt || now) < THIRTY_D)
    .sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0))
    .slice(0, 10);

  return (
    <FoldableSection id="bg-agents" icon={<Bot size={10} />} title={`后台代理 (claude --bg) (${running.length})`}>
      <div className="flex items-center gap-1.5 mb-2">
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing && e.keyCode !== 229) dispatch(); }}
          placeholder={selectedProject ? `派一个后台任务到 ${selectedProject.name || '当前项目'}` : '先在左侧选择项目'}
          disabled={!selectedProject || dispatching}
          className="flex-1 min-w-0 text-[11px] font-body bg-canvas-warm border border-canvas-deep rounded px-2 py-1.5 text-ink focus:border-accent outline-none" />
        <button onClick={dispatch} disabled={!prompt.trim() || !selectedProject || dispatching}
          className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] font-medium text-on-accent bg-accent hover:bg-accent/90 disabled:opacity-40">
          {dispatching ? <Loader2 size={11} className="animate-spin" /> : <PlayCircle size={11} />}派发
        </button>
      </div>
      {/* 权限档独占一行:面板窄(~300px),与说明文字并排会把说明挤成四行 */}
      <div className="mb-2">
        <select value={permMode} onChange={(e) => setPermMode(e.target.value)} disabled={dispatching}
          className="w-full text-[11px] font-body bg-canvas-warm border border-canvas-deep rounded px-1.5 py-1 text-ink focus:border-accent outline-none">
          <option value="acceptEdits">自动执行文件编辑（acceptEdits）</option>
          <option value="default">逐项确认（default）</option>
          <option value="plan">规划（plan）</option>
        </select>
        <div className="text-[10px] text-ink-faint font-body leading-snug mt-1">
          {permMode === 'acceptEdits'
            ? '文件编辑自动执行，其余请求仍会询问（询问期间代理处于等待状态）。'
            : `${permMode === 'plan' ? '代理只做调研与计划，不写文件。' : '每项操作都要你确认。'}授权请求会以权限卡出现在界面上，标记为「后台代理」；5 分钟内未应答按拒绝处理。`}
        </div>
      </div>
      {note && <div className="text-[10px] text-ink-faint font-mono mb-2 truncate" title={note}>{note}</div>}
      {running.length > 0 && (
        <div className="space-y-2">
          {running.map((a) => (
            <div key={a.sessionId || a.pid || a.id} className="bg-canvas-warm border border-canvas-deep rounded-lg p-2.5">
              <div className="flex items-center gap-2">
                <Bot size={11} className="text-accent" />
                <span className="text-[11px] text-ink font-body truncate flex-1" title={a.name}>{a.name || `bg #${a.pid}`}</span>
                {a.state && <StatusBadge status={a.state} waitingFor={a.waitingFor} needs={a.needs} />}
                <span className="text-[10px] text-ink-faint font-mono shrink-0">{fmtElapsed(a.elapsedMs)}</span>
                {/* 运行中(含 blocked=等待授权/额度)也能直接查看会话,不必先停止 —— 修用户报
                    "受阻状态点停止后才能查看结果" */}
                {a.sessionId && a.projectHash && (
                  <button onClick={() => openBgAgentSession(a)} title="查看该代理会话(看它在等什么/进度)"
                    className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-canvas hover:bg-canvas-deep text-ink-soft border border-canvas-deep transition-colors">
                    <Maximize2 size={10} />查看
                  </button>
                )}
                {(a.id || a.sessionId) && (
                  <button onClick={() => stopBg(a)} disabled={stoppingId === (a.id || a.sessionId)}
                    className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 transition-colors disabled:opacity-50">
                    {stoppingId === (a.id || a.sessionId) ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}停止
                  </button>
                )}
              </div>
              {/* needs = CLI 写的人话待办(如 approve Write: /abs/path)。受阻的代理
                  在等什么,直接写出来,不用点进会话翻。 */}
              {a.needs && (
                <div className="text-[10.5px] text-amber-700 font-body line-clamp-2 mt-1" title={a.needs}>{a.needs}</div>
              )}
              {a.cwd && <div className="text-[10px] text-ink-faint font-mono truncate mt-1" title={a.cwd}>{a.cwd.split(/[/\\]+/).pop()}</div>}
            </div>
          ))}
        </div>
      )}
      {/* 已结束的后台代理:结束时间 + 最终状态 + 结果摘要 + 查看结果(打开会话转写) */}
      {finished.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-ink-faint font-body mb-1.5">已结束 ({finished.length})</div>
          <div className="space-y-2">
            {finished.map((a) => (
              <div key={a.sessionId || a.id} className="bg-canvas-warm border border-canvas-deep rounded-lg p-2.5">
                <div className="flex items-center gap-2">
                  <Bot size={11} className="text-ink-faint" />
                  <span className="text-[11px] text-ink font-body truncate flex-1" title={a.name}>{a.name || a.id || '后台代理'}</span>
                  <StatusBadge status={a.state} />
                  {/* 已终态无需停止按钮(claude stop 已把它移入此区);查看结果见下方 */}
                </div>
                {(a.detail || a.resultPreview) && (
                  <div className="text-[10.5px] text-ink-muted font-body line-clamp-2 mt-1" title={a.detail || a.resultPreview}>
                    {a.detail || a.resultPreview}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-1.5 text-[10px] text-ink-faint font-mono">
                  {a.endedAt && <span className="flex items-center gap-1"><Clock size={9} />结束于 {fmtWhen(a.endedAt)}</span>}
                  {a.cwd && <span className="truncate opacity-70" title={a.cwd}>{a.cwd.split(/[/\\]+/).pop()}</span>}
                  {a.sessionId && a.projectHash && (
                    <button onClick={() => openBgAgentSession(a)}
                      className="ml-auto shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-canvas hover:bg-canvas-deep text-ink-soft border border-canvas-deep transition-colors">
                      <Maximize2 size={10} />查看结果
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </FoldableSection>
  );
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
        <div className="ml-auto"><StatusBadge status={agent.status} waitingFor={agent.waitingFor} needs={agent.needs} /></div>
      </div>
      {(agent.promptPreview || agent.lastResponse) && (
        <div className="text-[10.5px] text-ink-muted font-body line-clamp-2" title={agent.promptPreview || agent.lastResponse}>
          {agent.promptPreview || agent.lastResponse}
        </div>
      )}
      <div className="flex items-center gap-3 mt-1.5 text-[10px] text-ink-faint font-mono">
        {agent.startedAt && <span className="flex items-center gap-1"><Clock size={9} />{fmtElapsed(agent.elapsedMs ?? (Date.now() - agent.startedAt))}</span>}
        {agent.model && <span className="truncate">{agent.model}</span>}
        {agent.cwd && <span className="truncate opacity-70" title={agent.cwd}>{agent.cwd.split(/[/\\]+/).pop()}</span>}
        {agent.cronHold && (
          <span className="font-body shrink-0" title="本会话创建过定时任务（/loop），进程暂缓闲置回收，最长 2 小时">
            保持存活（定时任务）
          </span>
        )}
      </div>
      {agent.pid && agent.stoppable !== false && (
        <div className="mt-2 flex justify-end">
          <button
            onClick={() => onStop(agent.pid, agent.sessionId)}
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
function RemoteBucket({ id, title, titleColor, defaultOpen, agents, stoppingPid, onStop }) {
  const [open, setOpen] = useState(() => readFold()[id] ?? defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => { writeFold(id, !v); return !v; })}
        className="w-full flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-faint font-body py-1 hover:text-ink-muted"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className={titleColor}>{title}</span>
        <span className="text-ink-ghost">({agents.length})</span>
      </button>
      {open && (
        <div className="space-y-2 mt-1.5">
          {/* key 优先 sessionId:同一 CLI supervisor 下的多个后台会话 pid 相同,
              按 pid 当 key 会撞键(同一条卡片被反复复用/错位)。 */}
          {agents.map((a, i) => <RemoteAgentCard key={a.sessionId || a.pid || a.id || i} agent={a} stoppingPid={stoppingPid} onStop={onStop} />)}
        </div>
      )}
    </div>
  );
}

// Collapsible bucket — group header click toggles open, click on each
// agent card expands its details inline.
function AgentBucket({ id, title, titleColor, defaultOpen, agents, readyFor = null }) {
  const [open, setOpen] = useState(() => readFold()[id] ?? defaultOpen);
  // A 项:桶内卡片自己取金额(索引在手,经 context 供给 —— WorkflowCard 与对话流同一份读法)。
  const costIndex = useContext(SubagentCostContext)?.index;
  const ctxReady = useMemo(() => ({ index: costIndex, history: true }), [costIndex]);
  const ctxPending = useMemo(() => ({ index: costIndex, history: false }), [costIndex]);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => { writeFold(id, !v); return !v; })}
        className="w-full flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-faint font-body py-1 hover:text-ink-muted"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className={titleColor}>{title}</span>
        <span className="text-ink-ghost">({agents.length})</span>
      </button>
      {open && (
        <div className="space-y-2 mt-1.5">
          {/* 工作流条目走整张阶段卡(与聊天内联同一个组件),普通子代理走 AgentCard。
              面板里不给 onOpenAgent:这里拿不到 projectHash(只有服务端随工具结果下发的
              运行引用才有),点开只会是一个没有转写的空视图。点内层助手请到聊天里那张卡。
              A 项:每条按"它归属的会话有没有加载好"给金额/小标(没加载 = 连小标都不画)。 */}
          {agents.map((a) => {
            const ready = typeof readyFor === 'function' ? readyFor(a) : true;
            return (
              <SubagentCostContext.Provider key={a.id} value={ready ? ctxReady : ctxPending}>
                {a.workflow ? <WorkflowCard toolUseId={a.id} ownerSessionId={a.sessionId || null} compact /> : <AgentCard agent={a} />}
              </SubagentCostContext.Provider>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Single agent card — click to expand and see thinking / tool calls / final result.
function AgentCard({ agent }) {
  const [expanded, setExpanded] = useState(false);
  // 终态(done/error/stopped)冻结时长:显示 finishedAt−startedAt 并停 tick。
  // 原注释"卡片在 agent 结束时卸载"是错的——done 桶照样渲染,无门控则完成后的
  // "已运行时长"永远往上跳(显示撒谎)。
  const terminal = agent.status === 'done' || agent.status === 'error' || agent.status === 'stopped';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (terminal) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [terminal]);
  const setViewingAgent = useStore((s) => s.setViewingAgent);
  // 后台会话判定:子代理归属的会话不在任何打开的窗格 → 标注 + 点击归位跳转。
  const paneSessions = useStore((s) => s.paneSessions);
  const paneCount = useStore((s) => s.paneCount);
  const inOpenPane = !agent.sessionId
    || (paneSessions || []).slice(0, paneCount).some((p) => p?.sessionId === agent.sessionId);
  // 兜底:很多 provider 不往父流发 parent_tool_use_id 子代理事件,activeAgents 里
  // 拿不到 model/具体 agentType。从 server 提取的 sessions.subagents(按 toolUseId
  // 对回,= activeAgents 的 key = agent.id)补 model 与 agentType。
  const sessionsList = useStore((s) => s.sessions);
  let metaAgent;
  for (const sess of (Array.isArray(sessionsList) ? sessionsList : [])) {
    metaAgent = sess?.subagents?.find?.((a) => a.toolUseId === agent.id);
    if (metaAgent) break;
  }
  // 名字优先级与 TaskCard / SubagentView 对齐:teammateName(input.name,模型给命名实例
  // 起的真名,SendMessage({to}) 寻址用的那个)> agent.name(已被 subagent_type 抢占)>
  // 兜底的 agentType。缺这条时会话里显示 xiaoming、监控面板却显示 GENERAL-PURPOSE。
  const displayName = agent.teammateName || agent.name || metaAgent?.agentType || '子代理';
  const displayModel = agent.model || metaAgent?.model || null;
  // A 项:该子代理自己的费用(来自已打开窗格消息里的 subUsage.agents[])。桶内条目都是
  // 本机正在跑的/刚水合的,还没配对到金额是常态(跑动中的子代理本来就没有)—— 故只在
  // 拿到金额时画金额,不画「未能计价」(那份数据要等这一轮落盘 + 历史刷新才有)。
  const costEntry = useContext(SubagentCostContext)?.index?.byToolUseId?.get(agent.id);
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
          <span className="text-xs font-semibold text-violet-900 font-mono truncate">{displayName}</span>
          {agent.workflow && (
            <span className="text-[9px] px-1 py-px bg-amber-100 text-amber-700 rounded font-body shrink-0" title="Workflow 工具起的工作流(整体作为一个单元显示;内层 agent 详情见会话转写)">工作流</span>
          )}
          {displayModel && (
            <span className="text-[9px] px-1 py-px bg-violet-100 text-violet-700 rounded font-mono shrink-0" title="该子代理实际使用的模型">
              {displayModel}
            </span>
          )}
          <SubagentCostTag entry={costEntry} title="该子代理自己的费用（按它自己的模型与调用时刻计价；不含在主回合金额里）" />
          <div className="ml-auto flex items-center gap-1.5">
            {!inOpenPane && (
              <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-muted rounded font-body shrink-0" title="该子代理归属的会话未打开在任何窗格,点放大自动跳转">
                后台会话
              </span>
            )}
            <StatusBadge status={agent.status} />
            {/* #9 进入子代理会话窗口。放大视图盖在焦点窗格上 —— 先归位:该子代理
                所属会话已开在某窗格 → 聚焦它;否则载入当前焦点窗格。不归位则
                面包屑母标题/权限弹窗都会挂到别的会话名下(fable 场景17)。 */}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                if (!agent.id) return;
                const st = useStore.getState();
                let tab = st.activeTabIndex;
                if (agent.sessionId) {
                  const idx = (st.paneSessions || []).slice(0, st.paneCount).findIndex((p) => p?.sessionId === agent.sessionId);
                  if (idx >= 0) {
                    st.setActiveTabIndex(idx);
                    tab = idx;
                  } else {
                    const sess = (st.sessions || []).find((s) => s.sessionId === agent.sessionId);
                    if (sess) {
                      if (tab === 0) st.setSelectedSession(sess); else st.setPaneSession(tab, sess);
                      st.fetchMessages(sess.sessionId, sess.projectHash, { tab, silent: true });
                    }
                  }
                }
                setViewingAgent(tab, agent.id);
              }}
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
          {agent.startedAt && (
            <span className="flex items-center gap-1">
              <Clock size={9} />
              {fmtElapsed((terminal ? (agent.finishedAt || now) : now) - agent.startedAt)}
            </span>
          )}
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
                  {tc.result ? (tc.result.isError ? <span className="text-error">✗</span> : <span className="text-success">✓</span>)
                    : ['done', 'error', 'stopped'].includes(agent.status) ? <span className="text-success">✓</span>
                    : <Loader2 size={10} className="text-ink-faint animate-spin" />}
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

// CLI 写在 ~/.claude/sessions/<pid>.json 的 waitingFor 取值 → 中文副标题。
// 会话真的停下来等人时才有值,它决定徽章旁边显示"在等什么"。
const WAITING_FOR_LABEL = {
  'permission prompt': '等待授权',
  'input needed': '等待输入',
  'dialog open': '有弹窗',
  'sandbox request': '等待沙箱放行',
  'worker request': '队友等待',
};

// waitingFor:等待原因,追加为徽章副标题;needs:CLI 写的人话待办,进 tooltip。
function StatusBadge({ status, waitingFor = null, needs = '' }) {
  const map = {
    streaming:   { label: '运行中',  bg: 'bg-blue-50',  fg: 'text-blue-700',   border: 'border-blue-200' },
    starting:    { label: '启动中',  bg: 'bg-amber-50', fg: 'text-amber-700',  border: 'border-amber-200' },
    working:     { label: '工作中',  bg: 'bg-blue-50',  fg: 'text-blue-700',   border: 'border-blue-200' },
    done:        { label: '完成',    bg: 'bg-green-50', fg: 'text-green-700',  border: 'border-green-200' },
    idle:        { label: '空闲',    bg: 'bg-amber-50', fg: 'text-amber-700',  border: 'border-amber-200' },
    stopped:     { label: '已停止',  bg: 'bg-red-50',   fg: 'text-red-700',    border: 'border-red-200' },
    error:       { label: '错误',    bg: 'bg-red-50',   fg: 'text-red-700',    border: 'border-red-200' },
    needs_input: { label: '待输入',  bg: 'bg-violet-50', fg: 'text-violet-700', border: 'border-violet-200' },
    // 'alive' = 外部 CLI 会话(终端/Claude Desktop)的进程还活着,是否正在生成无从判断
    // (注册表文件只在启动时写一次)。用中性色,不与"工作中"的活跃蓝混淆。
    alive:       { label: '存活',    bg: 'bg-canvas-warm', fg: 'text-ink-muted', border: 'border-canvas-deep' },
    // 后台代理(claude agents --json)的 state 取值(实测 2.1.200:working/blocked/done 等)
    running:     { label: '运行中',  bg: 'bg-blue-50',  fg: 'text-blue-700',   border: 'border-blue-200' },
    failed:      { label: '失败',    bg: 'bg-red-50',   fg: 'text-red-700',    border: 'border-red-200' },
    killed:      { label: '已终止',  bg: 'bg-red-50',   fg: 'text-red-700',    border: 'border-red-200' },
    blocked:     { label: '受阻',    bg: 'bg-amber-50', fg: 'text-amber-700',  border: 'border-amber-200' },
    // 'waiting' = CLI 注册表写下的"会话停下来等人"(waitingFor 说明等什么)。
    // 与 needs_input 同色系:两者都是"在等你",不是在跑。
    waiting:     { label: '等待中',  bg: 'bg-violet-50', fg: 'text-violet-700', border: 'border-violet-200' },
  };
  const m = map[status] || { label: status || '—', bg: 'bg-canvas-warm', fg: 'text-ink-muted', border: 'border-canvas-deep' };
  const sub = waitingFor ? (WAITING_FOR_LABEL[waitingFor] || String(waitingFor)) : '';
  return (
    <span title={needs || undefined}
      className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${m.bg} ${m.fg} border ${m.border}`}>
      {m.label}{sub ? ` · ${sub}` : ''}
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
  // D7:子代理内部起的后台任务带 agentId —— 显示归属,免得进程管理区冒出一条来路不明的命令。
  // 选择器只返回字符串(基元),不会因新引用触发 React #185。
  const ownerAgentName = useStore((s) => {
    if (!task.agentId) return '';
    const ag = s.activeAgents[task.agentId];
    return ag?.teammateName || ag?.name || '';
  });

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
      if (d.ok && d.located) {
        stoppedRef.current = true; setPhase('stopped');
        // #12:写回 store 终态——否则 status 永远停在创建时的 'running',任务清单转圈
        // (ChatInput bgWorking)与其他消费方拿到的都是死状态(判官抓的核心缺陷)。
        useStore.getState().upsertBgTask(task.id, { status: 'stopped' });
      }
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
          {ownerAgentName && (
            <span className="truncate opacity-70 font-body" title={`由子代理 ${ownerAgentName} 启动`}>子代理 {ownerAgentName}</span>
          )}
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
  const [wfAgents, setWfAgents] = useState([]); // workflow 内层 agent(磁盘轮询第四源)
  const [openError, setOpenError] = useState('');   // R11「查看」失败的第一行反馈(保留当前视图)
  const [openingKey, setOpeningKey] = useState(null); // 正在按身份读转写的条目
  // R11:按身份读转写的取消柄。合同:取消/切换目标只取消这次读取 —— 换目标时中止上一次,
  // 面板关闭时中止当前(中止不产生任何可见文案)。
  const readAbortRef = useRef(null);
  const localAgents = useStore((s) => s.activeAgents);
  const bgTasks = useStore((s) => s.bgTasks);
  const paneSessions = useStore((s) => s.paneSessions);
  const paneCount = useStore((s) => s.paneCount); // 打开会话集合按实际窗格数收窄(见 openSessionIds)
  const stoppedSessions = useStore((s) => s.stoppedSessions); // 已停会话表:wf 内层 agent 覆盖显示"已停止"
  // R11:子代理条目(含只存在于历史里的)。口径见 utils/agentView.js buildAgentRows。
  const sessionsByProject = useStore((s) => s.sessionsByProject);
  const projects = useStore((s) => s.projects);
  const paneMessages = useStore((s) => s.paneMessages);
  const paneMessagesSid = useStore((s) => s.paneMessagesSid);
  const provider = useStore((s) => s.currentProvider);
  const liveSubUsage = useStore((s) => s.liveSubUsage); // 直播补齐:完成即推来的子代理金额条目

  // A 项:子代理花费索引。源 = 已打开窗格消息里的 subUsage.agents[](服务端按归属挂好的),
  // 与 buildAgentRows 同一条归属守卫(只认 paneMessagesSid 对得上的那批),避免把上一个
  // 会话的金额算到这个会话的子代理头上。没加载好的母会话一条都没有 → 那几行连小标都不画
  // (那是"没数据",不是"没算出来";契约 §10.3 的最后一档)。
  const costForPanes = useMemo(() => {
    const agents = [];
    const loaded = new Set();
    // 直播补齐(2026-09-13):子代理【完成那一刻】服务端随事件推来的条目(见 App.jsx 的
    // task_notification 两条分支)。后台子代理往往在回合结束之后才跑完,只靠 paneMessages
    // 要等下一次刷新面板才有金额 —— 这里并进同一份索引(同一把 toolUseId/agentSessionId 键,
    // 与 buildAgentRows 的归属守卫不冲突:取不到行的条目根本没人查)。
    for (const a of Object.values(liveSubUsage || {})) agents.push(a);
    for (let i = 0; i < paneCount; i++) {
      const session = paneSessions?.[i];
      const sid = session?.sessionId;
      if (!sid || paneMessagesSid?.[i] !== sid) continue;
      loaded.add(sid);
      const messages = paneMessages?.[i];
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (message?.type === 'turn' && Array.isArray(message.subUsage?.agents)) agents.push(...message.subUsage.agents);
      }
    }
    return { index: buildSubagentCostIndex(agents, provider), loaded };
  }, [paneMessages, paneMessagesSid, paneSessions, paneCount, provider, liveSubUsage]);
  const costCtxReady = useMemo(() => ({ index: costForPanes.index, history: true }), [costForPanes]);
  const costCtxPending = useMemo(() => ({ index: costForPanes.index, history: false }), [costForPanes]);
  // 该条目归属的会话加载好了没有(没加载 = 不画金额也不画小标)。
  const costReadyFor = (sessionId) => !sessionId || costForPanes.loaded.has(sessionId);

  const mountedRef = useRef(true);
  const fetchActive = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await fetch('/api/agents/active');
      const data = await r.json();
      // 卸载守卫:1.5s 轮询的在途请求可能在组件卸载后才 resolve → 原来无条件 setRemote
      // 会对已卸载组件 setState(React 告警 + 可能用旧数据覆盖)。卸载后直接丢弃结果。
      if (!mountedRef.current) return;
      setRemote({
        agents: Array.isArray(data.agents) ? data.agents : [],
        sources: data.sources || { chatProcesses: 0, cliSessions: 0 },
      });
    } catch {}
    // workflow 内层 agent:只扫【当前打开会话】的 workflows 目录(面板关闭即停轮询)。
    // 多分屏窗格各自的 sid 都拉,合并去重;无 workflow 的会话返回空,零开销。
    try {
      const sids = [...new Map((useStore.getState().paneSessions || [])
        .filter((p) => p?.sessionId && p?.projectHash)
        .map((p) => [p.sessionId, p])).values()];
      const lists = await Promise.all(sids.map((p) => fetch(
        `/api/workflow-agents?projectHash=${encodeURIComponent(p.projectHash)}&sid=${encodeURIComponent(p.sessionId)}`,
      ).then((x) => x.json()).catch(() => ({ agents: [] }))));
      if (!mountedRef.current) return;
      const merged = [];
      const seen = new Set();
      // 附上归属 sid(lists[i] 对应 sids[i] 的查询):停止覆盖显示要按会话判,合并丢归属就判不了。
      lists.forEach((l, i) => {
        for (const a of (l.agents || [])) { if (!seen.has(a.id)) { seen.add(a.id); merged.push({ ...a, sessionId: sids[i]?.sessionId || null }); } }
      });
      setWfAgents(merged);
    } catch {}
    if (!silent && mountedRef.current) setLoading(false);
  };

  useEffect(() => {
    mountedRef.current = true;
    fetchActive();
    const id = setInterval(() => fetchActive(true), 1500);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
      readAbortRef.current?.abort();   // 关面板 = 取消这次读取(不产生可见错误)
    };
  }, []);

  // 让"跨项目 / 后台没打开过的母会话"也能进列表:已知项目的会话列表各拉一次
  // (store.sessionsByProject 与侧栏同一份缓存,拉过就复用)。只补缺的项目,不刷已有的 ——
  // 全刷会随 projects 引用变化反复发请求;要刷新走面板顶部的刷新钮。
  useEffect(() => {
    const st = useStore.getState();
    for (const p of (st.projects || [])) {
      if (p?.hash && !st.sessionsByProject[p.hash]) st.fetchSessionsForPanel(p.hash);
    }
  }, [projects]);

  const refreshAll = () => {
    fetchActive();
    const st = useStore.getState();
    for (const p of (st.projects || [])) if (p?.hash) st.fetchSessionsForPanel(p.hash);
  };

  const subRows = useMemo(() => buildAgentRows({
    sessionsByProject,
    // 只喂归属守卫认可的窗格消息(paneMessagesSid 对得上),否则会把上一个会话的历史
    // 当成这个会话的证据(fork/串扰同源)。
    panes: (paneSessions || []).slice(0, paneCount).map((session, i) => ({
      session,
      messages: (session?.sessionId && paneMessagesSid?.[i] === session.sessionId) ? paneMessages?.[i] : null,
    })),
    liveAgents: localAgents,
    openSessionIds: (paneSessions || []).slice(0, paneCount).map((s) => s?.sessionId).filter(Boolean),
  }), [sessionsByProject, paneSessions, paneCount, paneMessages, paneMessagesSid, localAgents]);

  /**
   * R11「查看」:按 (parentSessionId, projectHash) 准确定位母会话 —— 已开窗格复用、跨项目切项目、
   * 后台没打开就打开。失败时保留当前视图,按合同给四种人话之一,绝不先在错误的母会话上显示"数据不可用"。
   */
  const openAgentRow = async (row) => {
    if (openingKey) return;
    setOpenError('');
    // ① 身份不全(缺母会话/缺工具身份)= 定位不了,如实说,别去猜(当前视图原样保留)。
    if (!row?.parentSessionId || !row?.toolUseId) { setOpenError('无法确定母会话'); return; }
    const st = useStore.getState();
    // ② 定位母会话:已在某窗格打开 → 复用那个窗格(不新开);否则开在当前焦点窗格,
    //    跨项目先把项目切过去(侧栏跟着走,标题/面包屑才对得上)。
    const openTab = locateParentPane(st.paneSessions, st.paneCount, row.parentSessionId);
    const targetTab = openTab >= 0 ? openTab : st.activeTabIndex;
    const prev = openTab >= 0 ? null : { session: st.paneSessions[targetTab] || null, project: st.selectedProject || null };
    if (openTab < 0) {
      if (row.parentProjectHash && st.selectedProject?.hash !== row.parentProjectHash) {
        st.setSelectedProject((st.projects || []).find((p) => p.hash === row.parentProjectHash) || { hash: row.parentProjectHash });
      }
      st.setPaneSession(targetTab, { sessionId: row.parentSessionId, projectHash: row.parentProjectHash || null, draft: false });
      // silent:窗格 0 的非 silent 拉取会先把整格换成"加载中"早退,子代理视图(同一次点击
      // 的另一个效果)要等它回来才出现 —— 用户点了查看却先看到一屏转圈。这里静默替换:
      // 母会话内容回来之前,视图已经按身份挂在这一格上。
      st.fetchMessages(row.parentSessionId, row.parentProjectHash, { tab: targetTab, silent: true });
    }
    // ③ 装视图:状态按证据(在跑 = working;历史条目按证据落终态;没证据不降级)。
    //    活流条目(非 hydrated)只补身份字段,绝不覆盖它自己的 blocks/status —— 迟到的
    //    历史响应不得把在跑的源说成已完成。
    //    这一段必须与点击同一个 tick 完成:切窗格与开视图是"用户点了查看"的效果本身;
    //    按身份读转写是慢活,放到后面补内容(读失败再按分档回滚/提示)。
    const cur = st.activeAgents[row.toolUseId];
    // 全局表按 tool_use.id 唯一,而分支复制品与源代理共用同一个 id:条目记的是哪个母会话,
    // 就只能在哪个母会话的视图里显示。活流条目(非水合)绝不能覆盖 —— 那是源会话正在跑的
    // agent;我们自己水合的历史条目可以改绑(用户此刻要看的是另一个母会话下的同名任务)。
    const sameOwner = !cur || !cur.sessionId || cur.sessionId === row.parentSessionId || !!cur.hydrated;
    if (!row.live && sameOwner) {
      const running = row.running === true;
      const patch = {
        sessionId: row.parentSessionId,
        agentSessionId: row.agentSessionId || null,
        agentProjectHash: row.agentProjectHash || null,
        hasTranscript: row.hasTranscript === true,
        runEvidence: running ? 'running' : null,
      };
      if (!cur || cur.hydrated) {
        patch.hydrated = true;
        patch.name = row.agentType || cur?.name || '子代理';
        patch.description = row.description || cur?.description || '';
        patch.model = row.model || cur?.model || null;
        if (row.prompt && !cur?.prompt) patch.prompt = row.prompt;
        if (row.result && !cur?.result) patch.result = row.result;
        const keepStatus = cur?.hydrated && !AGENT_TERMINAL_STATUSES.has(cur.status || '');
        if (running) patch.status = 'working';
        else if (!keepStatus) patch.status = agentHydrationStatus({ running, hasTranscript: row.hasTranscript, result: row.result });
      }
      st.upsertAgent(row.toolUseId, patch);
    }
    st.setActiveTabIndex(targetTab);
    st.setViewingAgent(targetTab, row.toolUseId);

    // ④ 按身份把转写读回来(顺带核对 owner)。读失败分两档处理:
    //    硬失败(不存在/无权限/归属不可靠)= 这个母会话根本打不开 → 回滚刚才的切换,
    //    保留用户原来的视图,并说明卡在哪一步;临时失败 → 视图留着(身份是对的),
    //    提示可重试。任何一档都不会在错误的母会话上显示"数据不可用"。
    if (!(row.agentSessionId && row.agentProjectHash)) return;
    const rollback = () => {
      const s = useStore.getState();
      s.setViewingAgent(targetTab, null);
      if (prev) {
        s.setPaneSession(targetTab, prev.session);
        if (prev.project) s.setSelectedProject(prev.project);
        s.setActiveTabIndex(targetTab);
      }
    };
    readAbortRef.current?.abort();          // 换了目标:上一次读取只取消,不报错
    const ac = new AbortController();
    readAbortRef.current = ac;
    setOpeningKey(row.key);
    try {
      const res = await fetchAgentHistory({ agentSessionId: row.agentSessionId, projectHash: row.agentProjectHash, signal: ac.signal });
      if (!res.ok) {
        // 取消 → 不出文案;硬失败(不存在/无权限/归属不可靠)→ 回滚切换;
        // 超时等临时失败 → 视图与停止目标原样留着,只提示可重试(判据见 agentOpenFailureAction)。
        const action = agentOpenFailureAction(res);
        if (action === 'ignore') return;
        if (action === 'rollback') rollback();
        setOpenError(res.message);
        return;
      }
      const owner = res.owner;
      if (!owner || owner.parentSessionId !== row.parentSessionId || (owner.toolUseId || null) !== row.toolUseId) {
        rollback();                       // 归属对不上:宁可说定位不到,也不留在错的母会话上
        setOpenError('无法确定母会话');
        return;
      }
      // 迟到响应丢弃:目标已变(条目被换掉/归属变了/被活流接管)就不写。
      const now = useStore.getState();
      if (!shouldApplyHistory(now.activeAgents[row.toolUseId], row.parentSessionId)) return;
      const parts = splitHistoryBlocks(res.blocks);
      now.upsertAgent(row.toolUseId, {
        blocks: parts.blocks,
        agentSessionId: row.agentSessionId,
        agentProjectHash: row.agentProjectHash,
        hasTranscript: true,
        ...(parts.prompt ? { prompt: parts.prompt } : null),
      });
    } finally {
      setOpeningKey(null);
    }
  };

  // Stop a child process. Two endpoints exist:
  //   /api/chat/:pid/stop      — only knows our own chat-process spawns
  //   /api/processes/:pid/kill — whitelist-checked kill for any pid in the CLI
  //                              sessions registry (covers cli-session agents)
  // Try chat-stop first; on 404 fall back to processes-kill.
  const stop = async (pid, sessionId) => {
    if (!pid) return;
    setStoppingPid(pid);
    try {
      // 进程管理区停止=全杀(hard):用户点名停这个进程,后台 shell 任务一并停。
      const r = await fetch(`/api/chat/${pid}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hard: true }) });
      let killed = r.ok;
      if (r.status === 404) {
        const kr = await fetch(`/api/processes/${pid}/kill`, { method: 'POST' });
        killed = kr.ok;
      }
      // 停止链路 #2:从监控面板杀进程 = 流外杀点。本会话的 SSE 以 reader done 正常
      // 结束(finally turnAborted=false),taskManaged 子代理条目没有任何收尾路径 →
      // 通知 App 顶层按 sessionId 级联收尾(finalizeSessionAgents,幂等)。
      // 仅在进程确实被杀掉(killed)时派发——kill 失败(500/pid 不在白名单)进程还活着,
      // 派发会让非 taskManaged 子代理永久谎称 stopped(违背三态不谎称)。
      if (sessionId && killed) {
        window.dispatchEvent(new CustomEvent('cgui:session-procs-killed', { detail: { sessionId } }));
      }
      await new Promise((r) => setTimeout(r, 400));
      if (!mountedRef.current) return; // 卸载守卫:400ms 等待期间面板可能已关闭
      await fetchActive(true);
    } catch {}
    setStoppingPid(null);
  };

  // Merge local + remote — local agents come from current stream's Task
  // tool_uses; remote includes our chat-process metadata and CLI's view.
  // P1-3:activeAgents 是全局 map(不分会话),不过滤会把 A 会话的子代理显示在 B 面板,
  // 且完成的不消失、跨会话无限堆积。按当前打开会话过滤(同 bgList);sessionId 为空的
  // (旧条目/draft 阶段)保留显示避免误藏。
  // 窗格数收窄(与 AgentCard 的 inOpenPane 同口径):paneSessions 是按 tab 下标的数组,
  // 分屏从 4 格改回 1 格后,2~4 号槽位还留着当时的会话对象 —— 不 slice 就把"已经关掉的
  // 窗格"当成打开会话,它们的已完成子代理永远留在面板里(用户报的"久远残留"来源之一)。
  const openSessionIds = new Set((paneSessions || []).slice(0, paneCount).filter(Boolean).map((s) => s.sessionId).filter(Boolean));
  // 运行中的子代理即使归属后台会话(不在任何窗格)也放行显示(卡片标"后台会话",
  // 点放大自动归位跳转)——否则切走会话后还在跑的子代理在监控里隐身,"看不见活动"。
  // done/error/stopped 仍按打开会话过滤,防跨会话无限堆积。
  // 无 sessionId 的条目原本无条件放行(怕误藏 draft 期建的),但终态的无主条目谁也认领
  // 不了、又永不过期 = 跨会话永久残留;只对【还在跑】的无主条目保留这条豁免。
  // hydrated:翻历史会话点"放大"时 TaskCard 会给早已结束的历史 Task 补建 store 条目
  // (只为放大视图取数据),它们不属于"当前对话内 Task",不进监控列表。
  const localList = Object.values(localAgents)
    .filter((a) => !a.hydrated)
    .filter((a) => a.status === 'working' || a.status === 'starting' || !a.status
      || (a.sessionId ? openSessionIds.has(a.sessionId) : false));
  // 后台任务:只显示本 stream 捕获到、且已拿到输出文件路径的(以 A 通道为准,
  // 避免列出 tasks 目录里的历史幽灵 .output)。并且**只显示当前打开的会话**的后台任务
  // (按所有分屏窗格的 sessionId 过滤)—— 否则切会话后旧卡片会永久堆积且持续轮询。
  // sessionId 为空的(draft 阶段启动、无法归属)也显示,避免误藏。最新启动的排在最前。
  const bgList = Object.values(bgTasks || {})
    .filter((t) => t.outputPath && (!t.sessionId || openSessionIds.has(t.sessionId)))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  // Bucket by status. 'working'/'starting' default expanded, the rest folded.
  // stopped 桶:主会话停止时被掐掉的子代理。之前没有这个桶 → stopped 条目不落
  // 任何桶直接消失,但区块标题计数又算上它("Task (3)"却只有 2 张卡)。
  // 终态桶只留最近 10 条(与本面板「后台代理」区同一口径):activeAgents 是内存 map,
  // 只有整页刷新才清空,而 GUI 常连着开好几天 —— 同一个会话跑过的每个子代理都会在
  // 已完成桶里越堆越多。按结束时间倒序取最近 10 条,更早的自动退场(要看全量去会话转写)。
  // lastActivity 兜底是给 workflow 内层 agent 用的(它没有 finishedAt/startedAt,
  // 时间字段是磁盘 mtime);本地 Task 条目没有该字段,取值语义不变。
  const recentTerminal = (list) => list
    .slice()
    .sort((a, b) => (b.finishedAt || b.startedAt || b.lastActivity || 0) - (a.finishedAt || a.startedAt || a.lastActivity || 0))
    .slice(0, 10);
  const buckets = {
    working:    localList.filter((a) => a.status === 'working' || a.status === 'starting' || !a.status),
    waiting:    localList.filter((a) => a.status === 'needs_input'),
    done:       recentTerminal(localList.filter((a) => a.status === 'done')),
    stopped:    recentTerminal(localList.filter((a) => a.status === 'stopped')),
    error:      recentTerminal(localList.filter((a) => a.status === 'error')),
  };
  // 区块计数按【真正渲染出来的卡片数】算,否则终态截断后会出现"Task (23)"里只有 12 张卡。
  const shownTaskCount = Object.values(buckets).reduce((n, list) => n + list.length, 0);
  // workflow 内层 agent 同样要截断:一次 workflow 能起几十个内层 agent,跑完全留在
  // 列表里(用户实测 37 条堆满面板)。running 全留(在跑的一个都不能藏),终态
  // (done/idle)按最近活动时间取最近 10 条,与本地 Task 终态桶同一口径。
  // r114:已经被阶段视图接管的 workflow,内层 agent 不必在这里再列一遍裸行 —— 阶段卡里
  // 带 label / 阶段 / 耗时 / token,信息严格更多。判定【按 workflowId 逐个做】:用"当前是否
  // 存在任意带进度表的条目"这种全局条件,会在同会话里 A 有进度、B 没有时把 B 的裸列表
  // 一起藏掉。对应关系靠 agentId —— 进度表里出现过的 agentId 属于哪个 wf_ 目录,那个目录
  // 整体就算已接管。
  // 覆盖集只认【本次真正渲染出卡片的】那些工作流条目(= 上面桶里的,已按打开会话过滤 +
  // 终态截 10 条):从全量 localAgents 算,会在卡片被挤出桶(同会话又结束了 10 个子代理)
  // 或分屏收回后,卡片没了、裸行又被藏 —— 整个运行在面板里凭空消失。
  const coveredWorkflowIds = new Set();
  {
    const seen = new Set();
    for (const list of Object.values(buckets)) {
      for (const a of list) {
        if (a?.workflow && Array.isArray(a.wfProgress)) for (const e of a.wfProgress) if (e?.agentId) seen.add(e.agentId);
      }
    }
    for (const a of wfAgents) if (a.workflowId && seen.has(a.id)) coveredWorkflowIds.add(a.workflowId);
  }
  const wfBare = wfAgents.filter((a) => !coveredWorkflowIds.has(a.workflowId));
  const wfShown = [
    ...wfBare.filter((a) => a.status === 'running'),
    ...recentTerminal(wfBare.filter((a) => a.status !== 'running')),
  ];
  // 后台代理(cliKind='bg')在 /agents/active 里是【只读条目】,存在的意义是给 app 级
  // 角标当廉价数据源;面板里它们由上面「后台代理 (claude --bg)」那一区呈现(带停止/查看
  // 按钮),这里过滤掉,免得同一个代理在两处各显示一遍。
  const procAgents = remote.agents.filter((a) => a.cliKind !== 'bg' && a.cliKind !== 'background');
  const BUCKET_META = {
    working: { label: '工作中', defaultOpen: true,  color: 'text-blue-600' },
    waiting: { label: '等待输入', defaultOpen: true, color: 'text-violet-600' },
    done:    { label: '已完成', defaultOpen: false, color: 'text-green-600' },
    stopped: { label: '已停止', defaultOpen: false, color: 'text-ink-muted' },
    error:   { label: '错误',   defaultOpen: false, color: 'text-red-600' },
  };

  return (
    <SubagentCostContext.Provider value={costCtxReady}>
    <div data-cgui="agent-monitor" className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-canvas-deep shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-ink-faint font-body flex items-center gap-1.5">
            <Bot size={11} />Subagent 监控
          </span>
          <button onClick={refreshAll} className="p-1 text-ink-faint hover:text-ink-muted" title="刷新">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <p className="text-[10px] text-ink-faint mt-1 font-body leading-snug">
          实时显示当前活跃的 subagent 与本地 Claude 子进程。
          数据源：本地 chat <b>{remote.sources.chatProcesses}</b> · CLI session <b>{remote.sources.cliSessions}</b>
        </p>
        {/* 「查看」失败的第一行反馈:说清卡在哪一步,当前视图原样保留 */}
        {openError && (
          // 刻意不挂 data-cgui:锚点层是"跨版本稳定的 chrome 区域",这条是随时可变的
          // 临时提示行(可观测口径是它的文案本身,锁定用例也按文案找)。
          <div className="mt-1.5 text-[11px] text-amber-700 font-body leading-snug flex items-start gap-1.5">
            <span className="flex-1 min-w-0">{openError}</span>
            <button onClick={() => setOpenError('')} className="shrink-0 text-ink-faint hover:text-ink-muted underline">知道了</button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Local Task tool subagents (from current stream) — grouped by status */}
        {shownTaskCount > 0 && (
          <FoldableSection id="local-tasks" icon={<Bot size={10} />} title={`当前对话内 Task (${shownTaskCount})`}>
            <div className="space-y-3">
              {Object.entries(buckets).map(([key, agents]) => {
                if (agents.length === 0) return null;
                return (
                  <AgentBucket
                    key={key}
                    id={`bucket-${key}`}
                    title={BUCKET_META[key].label}
                    titleColor={BUCKET_META[key].color}
                    // 本地子代理一律默认展开:跑完进 done 桶被折叠是"看不见子代理活动"
                    // 的主因之一,这里全部展开,确保捕获到的子代理都直接可见。
                    defaultOpen
                    agents={agents}
                    readyFor={(a) => costReadyFor(a.sessionId)}
                  />
                );
              })}
            </div>
          </FoldableSection>
        )}

        {/* 子代理(含已结束、只剩历史的)—— 身份 = 母 sessionId + toolUseId。「查看」按身份
            定位母会话:已开窗格复用/跨项目/后台没打开都能开。行内的 toolUseId 是这条身份的
            唯一文本凭据(观测用),同名复制品(fork)与源代理按各自的母会话分开列。 */}
        {subRows.length > 0 && (
          <FoldableSection id="subagent-index" icon={<Bot size={10} />} title={`子代理 (${subRows.length})`}>
            <div className="space-y-1.5">
              {subRows.map((row) => (
                <div key={row.key} className="bg-canvas-warm border border-canvas-deep rounded-lg px-2.5 py-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Bot size={11} className={`shrink-0 ${row.running ? 'text-violet-600' : 'text-ink-faint'}`} />
                    <span className="text-[11px] font-mono text-ink truncate min-w-0 flex-1" title={row.agentType || '子代理'}>
                      {row.agentType || '子代理'}
                    </span>
                    {row.model && (
                      <span className="text-[9px] px-1 py-px bg-violet-100 text-violet-700 rounded font-mono shrink-0">{row.model}</span>
                    )}
                    {/* A 项:该子代理自己的费用。母会话没打开 = 根本没加载过它的消息 →
                        连小标都不画(costReadyFor 判的就是这个)。 */}
                    <SubagentCostTag
                      entry={costForPanes.index.byToolUseId.get(row.toolUseId)}
                      showMissing={costReadyFor(row.parentSessionId)}
                      title="该子代理自己的费用（按它自己的模型与调用时刻计价；不含在主回合金额里）"
                    />
                    <span className={`text-[9px] px-1 py-px rounded font-body shrink-0 ${
                      row.running ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-canvas-deep text-ink-muted'
                    }`}>{row.running ? '实时' : '历史'}</span>
                  </div>
                  {(row.description || row.prompt) && (
                    <div className="text-[10.5px] text-ink-muted font-body truncate mt-0.5 pl-4" title={row.description || row.prompt}>
                      {row.description || row.prompt}
                    </div>
                  )}
                  {/* 身份行:工具身份 + 「查看」在同一格 —— 观测脚本按这段文本找行再点查看,
                      身份与动作必须落在同一个最小容器里。 */}
                  <div className="flex items-center gap-1.5 mt-0.5 pl-4 min-w-0">
                    <span className="text-[9.5px] text-ink-faint font-mono truncate min-w-0 flex-1" title={row.toolUseId || row.agentSessionId || ''}>
                      {row.toolUseId || `${row.agentSessionId || '未知身份'}（无工具身份）`}
                    </span>
                    <button
                      onClick={() => openAgentRow(row)}
                      disabled={openingKey === row.key}
                      className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-canvas hover:bg-canvas-deep text-ink-soft border border-canvas-deep transition-colors disabled:opacity-50"
                      title="在母会话窗口里打开这个子代理"
                    >
                      {openingKey === row.key ? <Loader2 size={10} className="animate-spin" /> : <Maximize2 size={10} />}查看
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </FoldableSection>
        )}

        {/* 后台任务(Bash run_in_background / python 后台)— 实时 tail .output 文件 */}
        {bgList.length > 0 && (
          <FoldableSection id="bg-tasks" icon={<PlayCircle size={10} />} title={`后台任务 (${bgList.length})`}>
            <div className="space-y-2">
              {bgList.map((t) => <BgTaskCard key={t.id} task={t} />)}
            </div>
          </FoldableSection>
        )}

        {/* workflow 内层 agent(Workflow 工具起的并行 agent)— 磁盘轮询,不流经父流。
            整体 workflow 单元卡在上面「当前对话内 Task」区(带"工作流"badge);这里是它内部
            各 agent 的实时状态(running/idle/done,journal.jsonl result 定 done、mtime 判活)。 */}
        {wfShown.length > 0 && (
          <FoldableSection id="wf-agents" icon={<Bot size={10} />} title={`workflow 内层 agent (${wfShown.length})`}>
            <div className="space-y-1.5">
              {wfShown.map((a) => {
                // 主会话已被停止 → 前台 workflow 内层 agent 随主进程死,但服务端状态是
                // mtime 推断(无 stopped 态,存活窗内仍报 running)。按已停表覆盖显示:
                // 仅当该 agent 在停止时刻后【无新活动】才覆盖 —— 停止后仍在写 jsonl 的
                // 是独立进程(后台任务),如实显示 running,不误伤。done 是权威终态不覆盖。
                const stoppedAt = a.sessionId ? stoppedSessions[a.sessionId] : null;
                const forceStopped = stoppedAt && a.status !== 'done' && (a.lastActivity || 0) < stoppedAt;
                return (
                <div key={a.id} className="flex items-center gap-2 bg-canvas-warm border border-canvas-deep rounded-lg px-2.5 py-1.5">
                  <Bot size={11} className="text-violet-600 shrink-0" />
                  <span className="text-[11px] font-mono text-ink truncate flex-1" title={`${a.workflowId} · ${a.id}`}>
                    {a.agentType || 'agent'} <span className="text-ink-faint">#{String(a.id).slice(-4)}</span>
                  </span>
                  {/* A 项:该内层 agent 自己的费用(匹配口径 = agentSessionId 去 'agent-' 前缀 === 行 id) */}
                  <SubagentCostTag
                    entry={costForPanes.index.byAgentId.get(String(a.id))}
                    showMissing={costReadyFor(a.sessionId)}
                    title="该助手自己的费用（按它自己的模型与调用时刻计价；不含在主回合金额里）"
                  />
                  <StatusBadge status={forceStopped ? 'stopped' : (a.status === 'idle' ? 'idle' : a.status)} />
                </div>
                );
              })}
            </div>
          </FoldableSection>
        )}

        {/* 后台代理(claude --bg)— CLI 原生后台会话:派发/列表/停止 */}
        <BackgroundAgentsSection stoppingPid={stoppingPid} onStop={stop} />

        {/* Server-side chat children + CLI agents — bucketed by status so the
            "working" ones default open and finished/errored ones fold away.
            标题不叫"子进程":这里除了 GUI 自己起的 chat-process,还包含终端 / Claude Desktop
            开的 claude 会话(cli-session),它们不是 GUI 的子进程。 */}
        <FoldableSection id="claude-procs" icon={<Terminal size={10} />} title={`本机 Claude 进程 (${procAgents.length})`}>
          {procAgents.length > 0 ? (
            (() => {
              const isWorking = (a) => ['streaming', 'starting', 'running', 'working'].includes(a.status);
              const isDone = (a) => ['done', 'finished', 'completed'].includes(a.status);
              const isError = (a) => ['error', 'failed'].includes(a.status);
              const isWaiting = (a) => ['needs_input', 'waiting'].includes(a.status);
              // 外部 CLI 会话(终端 / Claude Desktop 开的 claude):只知道进程活着,不知道
              // 是否在生成 —— 单列一组,不进"工作中"。
              const isAlive = (a) => a.status === 'alive';
              // "等待输入"排最前:在等你的不会自己走完,不处理就一直卡着。
              const groups = [
                { key: 'waiting', label: '等待输入', color: 'text-violet-600', defaultOpen: true, list: procAgents.filter(isWaiting) },
                { key: 'working', label: '工作中', color: 'text-blue-600', defaultOpen: true, list: procAgents.filter(isWorking) },
                { key: 'alive', label: '存活（外部会话）', color: 'text-ink-muted', defaultOpen: false, list: procAgents.filter(isAlive) },
                { key: 'done', label: '已完成', color: 'text-green-600', defaultOpen: false, list: procAgents.filter(isDone) },
                { key: 'error', label: '错误', color: 'text-red-600', defaultOpen: false, list: procAgents.filter(isError) },
                { key: 'other', label: '其他', color: 'text-ink-muted', defaultOpen: false, list: procAgents.filter((a) => !isWorking(a) && !isDone(a) && !isError(a) && !isWaiting(a) && !isAlive(a)) },
              ].filter((g) => g.list.length > 0);
              return (
                <div className="space-y-3">
                  {groups.map((g) => (
                    <RemoteBucket key={g.key} id={`remote-${g.key}`} title={g.label} titleColor={g.color} defaultOpen={g.defaultOpen} agents={g.list} stoppingPid={stoppingPid} onStop={stop} />
                  ))}
                </div>
              );
            })()
          ) : (
            <div className="text-[11px] text-ink-faint font-body py-4 text-center bg-canvas-warm border border-canvas-deep rounded-lg">
              {loading ? '加载中…' : '没有活跃的 subagent'}
            </div>
          )}
        </FoldableSection>
      </div>
    </div>
    </SubagentCostContext.Provider>
  );
}
