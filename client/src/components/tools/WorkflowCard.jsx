import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Layers, Loader2, Square } from '../Icon.jsx';
import { useStore } from '../../stores/sessionStore.js';
import { resolveOwnedAgent } from '../../utils/agentOwner.js';
import { confirmDialog } from '../../utils/confirmDialog.jsx';
import { ElapsedTime } from '../LoadingBits.jsx';
import { stopNoOwnerNotice } from './TaskCard.jsx';
import { SubagentCostContext, SubagentCostTag } from './SubagentCost.jsx';
import {
  agentDisplayState, effectiveRunStatus, getWorkflowSnapshot, groupWorkflowPhases,
  phaseRowQuota, resolveRunRef, runDisplayStatus, selectWorkflowSource,
} from '../../utils/workflowView.js';

// 工作流卡片:聊天内联与监控面板共用的唯一渲染组件。
//
// 数据来自两条路(实时进度表 / 磁盘快照),由 selectWorkflowSource 一次判定该看哪份;
// 本组件只负责把选中的那份画出来,不做任何来源推断,也不解析工具正文。
//
// 内层助手【没有停止按钮】:CLI 的停止指令只认"任务"这一级,工作流内部的助手没有
// 任务编号可指,拿 agentId 去调只会静默落空并显示误导性的"任务表中已不存在"。

// 助手/运行状态共用一个徽章:cached / skipped / blocked / stopped / unknown 走同一套
// 中性样式,只换文案 —— 前两者在真实运行里极罕见,不值得各写一套配色。
const STATE_META = {
  queued:  { label: '排队',   cls: 'text-ink-faint bg-canvas-warm border-canvas-deep' },
  running: { label: '在跑',   cls: 'text-blue-700 bg-blue-50 border-blue-200' },
  done:    { label: '完成',   cls: 'text-green-700 bg-green-50 border-green-200' },
  error:   { label: '失败',   cls: 'text-red-700 bg-red-50 border-red-200' },
  cached:  { label: '完成(缓存命中)', cls: 'text-ink-muted bg-canvas-warm border-canvas-deep' },
  skipped: { label: '已跳过', cls: 'text-ink-muted bg-canvas-warm border-canvas-deep' },
  blocked: { label: '已拦截', cls: 'text-ink-muted bg-canvas-warm border-canvas-deep' },
  stopped: { label: '已停止', cls: 'text-ink-muted bg-canvas-warm border-canvas-deep' },
  unknown: { label: '未知',   cls: 'text-ink-faint bg-canvas-warm border-canvas-deep' },
};
const RUN_LABEL = { running: '运行中', done: '已完成', error: '失败', stopped: '已停止', unknown: '状态未知' };
const ACTIVE_STATES = new Set(['running', 'queued']);
const HYDRATE_STATUS = {
  done: 'done', cached: 'done',
  error: 'error', blocked: 'error', skipped: 'error',
  stopped: 'stopped', running: 'working', queued: 'working', unknown: 'stopped',
};

function Badge({ state, label }) {
  const m = STATE_META[state] || STATE_META.unknown;
  return (
    <span className={`shrink-0 px-1.5 py-px rounded border text-[10px] font-body leading-4 ${m.cls}`}>
      {label || m.label}
    </span>
  );
}

// 模型与外部工具产出的文本一律先过硬上限再交给 React 渲染(CSS 截断只挡视觉,
// 一条 40KB 的 label 照样进 DOM)。
function clip(v, max = 200) {
  const s = v == null ? '' : String(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
// 助手耗时:终态取 CLI 算好的 durationMs;没有 durationMs 时只有【这一行自己还在跑】才按
// 当前时间现算 —— 门若用整个运行的状态,已经结束但 CLI 没给 durationMs 的行(实证:
// cached:true 的缓存命中行一律无 durationMs,startedAt ≈ 整个运行的起点)会在运行期间显示
// 一个从运行起点起算、一直增长的假耗时(实测 42m,比任何真跑的助手都长);历史卡片里
// startedAt 更是几个月前那次运行的时刻,减出来是"距那次运行过了多久",不是耗时。
// 不挂每秒定时器 —— 一次工作流最多渲 200 行,每秒重渲整卡不值当;进度表本身每 10s
// 到一次,届时自然刷新。
function agentDuration(entry, isRunning) {
  if (Number.isFinite(entry?.durationMs)) return fmtDuration(entry.durationMs);
  if (isRunning && Number.isFinite(entry?.startedAt)) return fmtDuration(Date.now() - entry.startedAt);
  return null;
}

function AgentRow({ entry, index, state, onOpen, compact }) {
  const label = clip(entry?.label) || `助手 ${index + 1}`;
  const tokens = fmtTokens(entry?.tokens);
  // 现算耗时的门 = 这一行自己的显示态在活跃态里,不是整个运行在不在跑。
  const dur = agentDuration(entry, ACTIVE_STATES.has(state));
  const lastTool = clip(entry?.lastToolSummary || entry?.lastToolName, 200);
  // 可点 = 有 agentId 且【挂点真的给了打开回调】(监控面板刻意不给:那里拿不到
  // projectHash,点开只会是空视图)。不可点时不给 role/tabIndex/手型/"点击查看"提示,
  // 免得每行都是骗点的死按钮,还成了 Tab 的死停靠点。
  const openable = !!entry?.agentId && typeof onOpen === 'function';
  return (
    <div
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={openable ? onOpen : undefined}
      onKeyDown={openable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(e); } } : undefined}
      title={openable ? `${label}\n点击查看该助手的完整对话` : label}
      className={`flex items-center gap-2 px-2 py-1 rounded-md text-[11px] font-body transition-colors ${
        openable ? 'cursor-pointer hover:bg-canvas-warm' : ''
      }`}
    >
      <span className="shrink-0 w-3 flex items-center justify-center">
        {state === 'running'
          ? <Loader2 size={10} className="text-blue-600 animate-spin" />
          : <span className={`w-1.5 h-1.5 rounded-full ${
              state === 'done' || state === 'cached' ? 'bg-success'
                : state === 'error' ? 'bg-error'
                  : state === 'queued' ? 'bg-ink-ghost' : 'bg-ink-faint'
            }`} />}
      </span>
      <span className="flex-1 min-w-0 truncate text-ink">{label}</span>
      {lastTool && !compact && (
        <span className="min-w-0 max-w-[9rem] truncate font-mono text-[10px] text-ink-faint" title={lastTool}>
          {lastTool}
        </span>
      )}
      {dur && <span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">{dur}</span>}
      {tokens && <span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">{tokens}</span>}
      <Badge state={state} />
    </div>
  );
}

function WorkflowCardImpl({ toolUseId, ownerSessionId = null, toolCall = null, fallbackAgents = null, compact = false, onOpenAgent = null }) {
  // 归属校验:activeAgents 按 tool_use.id 全局唯一,分支(fork)会话复制出的卡片撞源
  // 会话的 id —— 不校验就会渲染源会话正在跑的工作流,停止键也停到源会话头上。
  const agent = resolveOwnedAgent(useStore((s) => s.activeAgents[toolUseId]), ownerSessionId);
  const [snapshot, setSnapshot] = useState(null);
  const askedRef = useRef(false);
  const [override, setOverride] = useState(() => new Map());
  const [showAll, setShowAll] = useState(() => new Set());
  const [resultFull, setResultFull] = useState(false);

  const runStatus = runDisplayStatus(agent);
  const { ref, taskId } = resolveRunRef({ toolCall, agent });

  // 快照只在【非运行中】取:live 还在跑时读快照 = 读到上一轮续跑覆写的记录,界面会谎称
  // "已完成"。失败静默(不弹窗),但要把"已请求"复位 —— 用户点停止那条路必然赶在快照
  // 写盘之前发出请求,拿到 404 后若永久记成"已问过",本次挂载再也不取,结果与报错区
  // (只在 source==='snapshot' 时渲染)整场都出不来。复位只是允许【后续依赖变化】
  // (权威终态到达等)重新触发:同一份依赖不会因失败立即重发,不轮询、不自旋。
  useEffect(() => {
    if (askedRef.current || !ref || runStatus === 'running') return;
    askedRef.current = true;
    let alive = true;
    // taskId 一起给:同一个脚本续跑会覆写同名快照文件,缓存只按 runId 分键就会拿到上一轮那份。
    getWorkflowSnapshot(ref, { taskId }).then((s) => {
      if (!s) { askedRef.current = false; return; }
      if (alive) setSnapshot(s);
    });
    return () => { alive = false; };
  }, [ref?.runId, ref?.projectHash, ref?.sid, runStatus]);

  const pick = selectWorkflowSource({
    live: agent ? { progress: agent.wfProgress || null, status: runStatus, taskId: agent.taskId || null, startedAt: agent.startedAt ?? null } : null,
    snapshot,
    cardTaskId: taskId,
    fallbackAgents,
  });
  // 整体状态:live 条目在就用它;历史会话没有 live 条目(runStatus 恒 unknown)且这一刻
  // 看的就是磁盘快照时,用快照里的 status 补出来。顶部徽章、每个助手行的状态、阶段默认
  // 展开的"在跑"判定、以及要不要现算耗时,全部认这一个值 —— 只有停止按钮的渲染条件与
  // 快照请求时机仍认 runStatus(那两处问的是"此刻有没有活着的运行",不是"当时结局如何")。
  const effStatus = effectiveRunStatus(runStatus, pick.source, snapshot);
  const runActive = effStatus === 'running';
  const rows = pick.source === 'snapshot' ? (snapshot?.progress || []) : (agent?.wfProgress || []);
  const groups = useMemo(() => groupWorkflowPhases(pick.source === 'disk' || pick.source === 'none' ? null : rows), [rows, pick.source]);
  const quota = phaseRowQuota(groups.length);
  const totals = useMemo(() => {
    let agents = 0; let tokens = 0; let toolCalls = 0;
    for (const g of groups) {
      for (const a of g.agents) {
        agents += 1;
        if (Number.isFinite(a.tokens)) tokens += a.tokens;
        if (Number.isFinite(a.toolCalls)) toolCalls += a.toolCalls;
      }
    }
    return { agents, tokens, toolCalls };
  }, [groups]);

  const name = clip(agent?.name || snapshot?.workflowName || toolCall?.input?.name || 'workflow', 80);
  // A 项:这张卡片的金额 = 它名下【全部内层 agent】的合计(普通 Task 卡片同一条规则,
  // 只是那边名下只有 1 个)。数据来自本回合 subUsage.agents[] 按 toolUseId 归组。
  const subagentCost = useContext(SubagentCostContext);
  const costEntry = subagentCost?.index?.byToolUseId?.get(toolUseId);
  const meta = [
    groups.length > 0 ? `${groups.length} 阶段` : null,
    totals.agents > 0 ? `${totals.agents} 助手` : null,
    fmtTokens(totals.tokens) ? `${fmtTokens(totals.tokens)} tokens` : null,
    totals.toolCalls > 0 ? `${totals.toolCalls} 次工具` : null,
  ].filter(Boolean).join(' · ');
  const canStop = runStatus === 'running' && !!agent;

  const stopWorkflow = async (e) => {
    e?.stopPropagation?.();
    const ok = await confirmDialog('停止整个工作流?正在运行的助手会被中止,已完成的结果保留。', { danger: true });
    if (!ok) return;
    const r = await useStore.getState().stopSingleTask(ownerSessionId || agent?.sessionId || null, toolUseId);
    // 只有服务端明说"任务表里没有这个属主"(noOwner)才提示。用 !r?.stopped 当判据会把
    // 网络失败(同样返回 stopped:false)说成"对话进程已结束,无法再停止",而进程其实活着 ——
    // 用户以为停不掉就放弃重试。文案与 TaskCard / SubagentView 共用同一个函数。
    if (r?.noOwner) confirmDialog(stopNoOwnerNotice(r.procAlive), { confirmText: '知道了' });
  };

  // 点开单个助手看完整对话:复用既有子代理视图链路(store 键 'agent-<agentId>' +
  // 会话消息端点已支持回退扫 subagents/workflows)。projectHash 只来自服务端下发的
  // 运行引用,拿不到就不发请求(只展示进度表里已有的字段)。
  const openAgent = (entry) => {
    if (!entry?.agentId || typeof onOpenAgent !== 'function') return;
    const key = 'agent-' + entry.agentId;
    const prev = useStore.getState().activeAgents[key];
    // 每次点开都按当前进度表刷新派生字段:全仓没有别的写入方(内层助手不流经父流),
    // 只在条目不存在时写一次 = 在跑时点开过的助手,跑完再点仍显示"工作中"并一直计时。
    useStore.getState().upsertAgent(key, {
      // hydrated:这条是为了看转写现补的,不进监控桶、不被 level 剪枝。
      hydrated: true,
      wfInner: true,
      name: clip(entry.label, 80) || entry.agentId,
      agentType: entry.agentType || null,
      model: entry.model || null,
      description: clip(entry.lastToolSummary) || '',
      status: HYDRATE_STATUS[agentDisplayState(entry, effStatus)] || 'stopped',
      startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : (prev?.startedAt ?? Date.now()),
      sessionId: ownerSessionId || null,
    });
    // 转写只在还没取到内容时取:已经取到就不重复请求;此前没取到(含 projectHash 缺失
    // 导致压根没发过)则允许再取一次。
    const hasContent = !!(prev?.blocks?.length || prev?.text?.length || prev?.toolCalls?.length);
    const hash = ref?.projectHash;
    if (!hasContent && hash) {
      fetch(`/api/sessions/${encodeURIComponent(key)}/messages?projectHash=${encodeURIComponent(hash)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const msgs = Array.isArray(d) ? d : (d?.messages || []);
          const text = []; const thinking = []; const toolCalls = []; const blocks = [];
          for (const m of msgs) {
            if (m.type !== 'turn') continue;
            if (Array.isArray(m.thinking)) thinking.push(...m.thinking);
            if (Array.isArray(m.text)) text.push(...m.text);
            if (Array.isArray(m.toolCalls)) toolCalls.push(...m.toolCalls);
            // blocks 是对话视图真正渲染的那份(有序 {type,content|toolCall}[]);只写三个
            // 扁平数组 = 点开内层助手永远空白(SubagentView 读 agent.blocks,兜底 result)。
            if (Array.isArray(m.blocks)) blocks.push(...m.blocks);
          }
          if (text.length || thinking.length || toolCalls.length || blocks.length) {
            useStore.getState().upsertAgent(key, { text, thinking, toolCalls, blocks });
          }
        })
        .catch(() => {});
    }
    onOpenAgent(key);
  };

  // 展开态每次渲染现算,用户手点过的阶段(override)恒最高优先。
  // 不缓存"首次见到该阶段时的默认值":CLI 的第一份进度表就把全部阶段预告完(连零助手的
  // 收尾阶段都在表里),冻住默认值等于除第 1 阶段外全程折叠,"终态展开最后一个阶段"在
  // 实时卡片上永远轮不到。现算的代价是后来开跑的阶段会自动展开 —— 那正是想要的;而
  // override 保证用户折起来的阶段不会被进度表弹开,展开的阶段也不会在跑完那刻自己收起。
  const anyActive = groups.some((g) => g.agents.some((a) => ACTIVE_STATES.has(agentDisplayState(a, effStatus))));
  // 全终态时展开最后【一个派过助手的】阶段:阶段是开跑前就全量预告的,收尾时的最后
  // 一组常常是没派出助手的空阶段,展开它等于把真正有结果的那组藏起来。
  const withAgents = groups.filter((g) => g.agents.length);
  const lastKey = (withAgents.length ? withAgents[withAgents.length - 1] : groups[groups.length - 1])?.key ?? null;
  const isOpen = (g) => {
    if (override.has(g.key)) return override.get(g.key);
    if (g.agents.some((a) => ACTIVE_STATES.has(agentDisplayState(a, effStatus)))) return true;
    return !anyActive && g.key === lastKey;
  };
  const toggle = (key, open) => setOverride((p) => { const n = new Map(p); n.set(key, !open); return n; });

  const pad = compact ? 'px-2.5' : 'px-3';
  const resultText = pick.source === 'snapshot' && snapshot?.result != null ? String(snapshot.result) : '';
  const errorText = pick.source === 'snapshot' && snapshot?.error ? String(snapshot.error) : '';
  const cap = resultFull ? 20000 : 4000;

  // data-wf-card:留给真机验收的选择器。不用 data-cgui —— 那个命名空间归皮肤锚点
  // 注册表(skinAnchors.js)管,不在清单里的挂点会让 check-skin-anchors 变红。
  return (
    <div data-wf-card="" className="border border-canvas-deep rounded-lg overflow-hidden bg-canvas animate-fade-up">
      {/* 头:工作流名 · 整体状态 · 规模 · 停止整个工作流 */}
      <div className={`${pad} py-2 flex items-start gap-2.5 bg-canvas-warm/60 border-b border-canvas-deep`}>
        <span className="shrink-0 mt-px w-5 h-5 rounded-md bg-accent-subtle flex items-center justify-center text-ink-muted">
          <Layers size={12} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[12px] text-ink font-body truncate" title={name}>{name}</span>
            <Badge state={effStatus} label={RUN_LABEL[effStatus]} />
            {runActive && Number.isFinite(agent?.startedAt) && <ElapsedTime startedAt={agent.startedAt} />}
          </div>
          {(meta || subagentCost) && (
            <div className="mt-0.5 flex items-center gap-2 min-w-0 text-[10px] text-ink-faint font-body">
              {meta && <span className="truncate" title={meta}>{meta}</span>}
              <SubagentCostTag
                entry={costEntry}
                showMissing={subagentCost?.history === true}
                title="该工作流内部全部子代理的合计费用（各按自己的模型与调用时刻计价；不含在主回合金额里）"
              />
            </div>
          )}
        </div>
        {canStop && (
          <button
            onClick={stopWorkflow}
            className="shrink-0 px-1.5 py-px rounded border border-canvas-deep bg-canvas text-[10px] text-ink-muted hover:text-error hover:border-error/40 hover:bg-error/10 transition-colors font-body flex items-center gap-1"
            title="停止整个工作流"
          >
            <Square size={9} className="fill-current" />{!compact && '停止整个工作流'}
          </button>
        )}
      </div>

      {/* 降级横幅:续跑覆盖 / 未留下阶段信息 / 未提供进度信息。启动窗内单独走骨架。 */}
      {pick.note && pick.note !== '正在启动…' && (
        <div className={`${pad} py-1.5 text-[10px] font-body border-b border-canvas-deep ${
          pick.superseded ? 'bg-amber-50 text-amber-700' : 'bg-canvas-warm text-ink-muted'
        }`}>
          {pick.note}
        </div>
      )}

      {pick.note === '正在启动…' && (
        <div className={`${pad} py-2 flex items-center gap-2 text-[11px] text-ink-muted font-body`}>
          <Loader2 size={11} className="animate-spin text-ink-faint" />正在启动…
        </div>
      )}

      {/* 体:阶段分组 → 助手行。每阶段行数按配额裁,超出折进「显示全部」。 */}
      {groups.length > 0 && (
        <div className="divide-y divide-canvas-deep">
          {groups.map((g) => {
            const open = isOpen(g);
            const full = showAll.has(g.key);
            const shown = full ? g.agents : g.agents.slice(0, quota);
            const doneCount = g.agents.filter((a) => ['done', 'cached'].includes(agentDisplayState(a, effStatus))).length;
            return (
              <div key={g.key}>
                <button
                  onClick={() => toggle(g.key, open)}
                  className={`w-full ${pad} py-1.5 flex items-center gap-2 hover:bg-canvas-warm transition-colors text-left`}
                >
                  {open ? <ChevronDown size={11} className="shrink-0 text-ink-faint" /> : <ChevronRight size={11} className="shrink-0 text-ink-faint" />}
                  <span className="shrink-0 w-4 text-center font-mono text-[10px] text-ink-faint tabular-nums">
                    {g.index == null ? '·' : g.index}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[11px] text-ink font-body" title={g.title}>{clip(g.title, 80)}</span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
                    {doneCount}/{g.agents.length}
                  </span>
                </button>
                {open && g.agents.length > 0 && (
                  <div className={`${compact ? 'px-1.5' : 'px-2'} pb-1.5 space-y-px`}>
                    {shown.map((a, i) => (
                      <AgentRow
                        key={a.agentId ?? ('i' + i)}
                        entry={a}
                        index={i}
                        state={agentDisplayState(a, effStatus)}
                        compact={compact}
                        onOpen={typeof onOpenAgent === 'function' ? () => openAgent(a) : null}
                      />
                    ))}
                    {!full && g.agents.length > quota && (
                      <button
                        onClick={() => setShowAll((p) => new Set(p).add(g.key))}
                        className="w-full px-2 py-1 text-left text-[10px] text-ink-faint hover:text-ink-muted font-body"
                      >
                        显示全部 ({g.agents.length})
                      </button>
                    )}
                  </div>
                )}
                {open && g.agents.length === 0 && (
                  <div className={`${pad} pb-1.5 text-[10px] text-ink-faint font-body`}>该阶段尚未派出助手</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 降级序 5:磁盘裸列表(只有 agentId / 类型 / 三态,没有阶段与标签)。 */}
      {pick.source === 'disk' && (
        <div className={`${compact ? 'px-1.5' : 'px-2'} py-1.5 space-y-px`}>
          {(fallbackAgents || []).map((a, i) => (
            <div key={a?.id ?? ('i' + i)} className="flex items-center gap-2 px-2 py-1 text-[11px] font-body">
              <span className="flex-1 min-w-0 truncate font-mono text-ink-muted">
                {clip(a?.agentType, 80) || 'agent'} <span className="text-ink-faint">#{String(a?.id ?? '').slice(-4)}</span>
              </span>
              <Badge state={a?.status === 'running' ? 'running' : (a?.status === 'done' ? 'done' : 'unknown')}
                label={a?.status === 'idle' ? '空闲' : undefined} />
            </div>
          ))}
        </div>
      )}

      {/* 结果与报错:一律纯文本,不走 markdown —— 这段内容全部由助手与外部工具产出。 */}
      {(resultText || errorText) && (
        <div className={`${pad} py-2 border-t border-canvas-deep space-y-2`}>
          {errorText && (
            <pre className="text-[11px] font-mono whitespace-pre-wrap p-2 rounded bg-red-50 text-red-700 max-h-48 overflow-y-auto">
              {errorText.slice(0, cap)}
            </pre>
          )}
          {resultText && (
            <details>
              <summary className="cursor-pointer text-[10px] text-ink-faint uppercase tracking-wider font-body">运行结果</summary>
              <pre className="text-[11px] font-mono whitespace-pre-wrap mt-2 p-2 rounded bg-canvas-warm text-ink-muted max-h-64 overflow-y-auto">
                {resultText.slice(0, cap)}
              </pre>
            </details>
          )}
          {!resultFull && (resultText.length > cap || errorText.length > cap) && (
            <button onClick={() => setResultFull(true)} className="text-[10px] text-ink-faint hover:text-ink-muted font-body">
              展开更多
            </button>
          )}
        </div>
      )}

      {/* 内层助手行没有停止按钮,原因写在这里,免得用户以为按钮丢了。 */}
      {totals.agents > 0 && (
        <div className={`${pad} py-1.5 border-t border-canvas-deep text-[10px] text-ink-faint font-body`}>
          工作流内的单个助手无法单独停止;可停止整个工作流。
        </div>
      )}
    </div>
  );
}

// 每 10s 一份全量进度表 + 长会话里可能同时挂着几十张卡片:不 memo 会把整条会话重渲。
export const WorkflowCard = React.memo(WorkflowCardImpl);
