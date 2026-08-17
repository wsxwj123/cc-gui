import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, GitBranch, Loader2, Square, User } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { CoworkBlocks } from './TurnBubble.jsx';
import { PermissionPrompt } from './PermissionPrompt.jsx';
import { LoadingMark, useCyclingVerb, ElapsedTime } from './LoadingBits.jsx';
import { stopNoOwnerNotice } from './tools/TaskCard.jsx';
import { resolveOwnedAgent } from '../utils/agentOwner.js';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { advanceScrollTransaction, beginScrollTransaction, keyRequestsReading, shouldPauseAutoScroll } from '../utils/scroll.js';

// 上下文占用简写(与主会话徽章同口径:k 计)。
function fmtTok(n) {
  if (!n || n <= 0) return null;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// #9/O4 子代理会话窗口:样式对齐正常会话(用户气泡在右、回复在左、思考/工具折叠),
// 标题处「母会话标题 / 子代理名」层级面包屑,点母会话标题返回。
// 数据来自 store.activeAgents[agentId](流式累积的 text/thinking/toolCalls)。
export function SubagentView({ agentId, paneId, active = false, parentTitle, parentSessionId = null, onBack }) {
  // 与 TaskCard 同一归属判定:activeAgents 按 tool_use.id 全局唯一,分支(fork)会话
  // 复制出的卡片撞源会话的 id —— 不校验就会在分支窗格里渲染【源会话正在流的实时内容】,
  // 停止键也会停到源会话。归属不符时按"数据不可用"处理(走下面的 !agent 早退)。
  const agent = resolveOwnedAgent(useStore((s) => s.activeAgents[agentId]), parentSessionId);
  // hooks 必须在下面的早退 return 之前(rules-of-hooks)。
  const verb = useCyclingVerb();
  const scrollRef = useRef(null);
  const followBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const scrollTransactionRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  // 兜底:store 拿不到具体名/model 时(provider 不发子代理流),从 server 提取的
  // sessions.subagents 按 toolUseId(= agentId)对回 agentType / model / 上下文占用 / cwd。
  const sessionsList = useStore((s) => s.sessions);
  let metaAgent;
  for (const sess of (Array.isArray(sessionsList) ? sessionsList : [])) {
    metaAgent = sess?.subagents?.find?.((a) => a.toolUseId === agentId);
    if (metaAgent) break;
  }

  // 与 TaskCard 同一优先级:命名实例名(teammateName,未被 subagent_type 抢占的那份)
  // 优先于泛化类型名,否则命名队友在这里也显示成 general-purpose。
  const rawName = agent?.teammateName || agent?.name || null;
  const isGeneric = !rawName || rawName === 'Task' || rawName === 'Agent';
  const name = (isGeneric && metaAgent?.agentType) ? metaAgent.agentType : (rawName || '子代理');
  const agentModel = agent?.model || metaAgent?.model || null;
  const description = agent?.description || '';
  const prompt = agent?.prompt || '';
  const blocks = agent?.blocks || [];
  const status = agent?.status || 'working';
  const working = status === 'working' || status === 'starting';
  const nonTerminal = !['done', 'error', 'stopped'].includes(status);

  const scrollOwnerKey = `${paneId}:${parentSessionId}:${agentId}`;
  useEffect(() => {
    followBottomRef.current = true;
    lastScrollTopRef.current = 0;
    scrollTransactionRef.current = null;
    setAtBottom(true);
  }, [scrollOwnerKey]);

  const writeProgrammaticScroll = useCallback((el, target, kind) => {
    const transaction = beginScrollTransaction(kind, target);
    scrollTransactionRef.current = transaction;
    el.scrollTop = target;
    requestAnimationFrame(() => {
      if (scrollTransactionRef.current === transaction) scrollTransactionRef.current = null;
    });
  }, []);

  useEffect(() => {
    if (!followBottomRef.current) return;
    const id = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) {
        const target = Math.max(0, el.scrollHeight - el.clientHeight);
        writeProgrammaticScroll(el, target, 'follow');
      }
    });
    return () => cancelAnimationFrame(id);
  }, [blocks, agent?.result, working, writeProgrammaticScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const previousTop = lastScrollTopRef.current;
    const movedUp = shouldPauseAutoScroll({ previousTop, currentTop: el.scrollTop });
    const target = scrollTransactionRef.current?.kind === 'follow'
      ? Math.max(0, el.scrollHeight - el.clientHeight)
      : scrollTransactionRef.current?.target;
    const result = advanceScrollTransaction(scrollTransactionRef.current, {
      previousTop,
      currentTop: el.scrollTop,
      target,
    });
    scrollTransactionRef.current = result.transaction;
    lastScrollTopRef.current = el.scrollTop;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (result.handled) return;
    if (result.expired) followBottomRef.current = distance <= 40;
    else if (movedUp || result.userMovedAway) followBottomRef.current = false;
    else if (distance < 40) followBottomRef.current = true;
    setAtBottom(distance < 120);
  };
  const markReading = useCallback(() => {
    scrollTransactionRef.current = null;
    followBottomRef.current = false;
    setAtBottom(false);
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const onReadingKey = (event) => {
      const target = event.target;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      if (keyRequestsReading(event.key)) markReading();
    };
    window.addEventListener('keydown', onReadingKey);
    return () => window.removeEventListener('keydown', onReadingKey);
  }, [active, markReading]);

  if (!agent) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-ink-faint bg-canvas">
        <Bot size={28} className="opacity-40" />
        <div className="text-sm font-body">该子代理数据已不可用</div>
        <button onClick={onBack} className="text-accent text-xs underline">返回母会话</button>
      </div>
    );
  }

  const statusMeta = {
    starting: { label: '启动中', cls: 'text-blue-600' },
    working:  { label: '工作中', cls: 'text-blue-600' },
    needs_input: { label: '等待输入', cls: 'text-violet-600' },
    done:     { label: '已完成', cls: 'text-green-600' },
    error:    { label: '错误', cls: 'text-red-600' },
    stopped:  { label: '已停止', cls: 'text-ink-muted' },
  }[status] || { label: status, cls: 'text-ink-muted' };

  return (
    // bg-canvas 不透明 — 杜绝下层母会话内容透视(玻璃效果导致"下方显示母会话信息")
    <div className="flex-1 flex flex-col min-h-0 bg-canvas">
      {/* 标题栏 — 与正常会话 header 同样式,层级:母会话 / 子代理 */}
      <div className="glass-bar shrink-0 px-6 py-3 border-b border-canvas-deep">
        <div className="max-w-[var(--content-max)] mx-auto min-w-0">
          <div className="flex items-center gap-2 text-[15px] font-display font-semibold min-w-0">
            <button
              onClick={onBack}
              className="text-ink-muted hover:text-accent transition-colors truncate max-w-[40%] shrink-0"
              title="点击返回母会话"
            >
              {parentTitle || '母会话'}
            </button>
            <span className="text-ink-faint shrink-0 font-normal">/</span>
            <Bot size={15} className="text-violet-600 shrink-0" />
            <span className="text-ink truncate">{name}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] font-mono text-ink-faint flex-wrap">
            {agentModel && (
              <span className="px-1.5 py-px bg-violet-100 text-violet-700 rounded" title="该子代理实际使用的模型">
                {agentModel}
              </span>
            )}
            {/* #2 上下文占用徽章(与主会话同口径:最后一次调用的 input+cache 之和,服务端
                从子代理 jsonl 提取);无数据(provider 不落盘 usage)不显示。 */}
            {fmtTok(metaAgent?.contextTokens) && (
              <span className="px-1.5 py-px bg-canvas-deep text-ink-muted rounded" title="子代理当前上下文占用(最后一次调用口径)">
                {fmtTok(metaAgent.contextTokens)} tokens
              </span>
            )}
            {/* #11 worktree 徽标:子代理在 worktree 隔离副本里干活时显示(路径含 .claude/worktrees,
                或 cwd 本身就是独立 worktree 目录),便于后期合并回主分支。文本优先分支名
                (jsonl 顶层 gitBranch),比 agent-xxx 目录名有语义。 */}
            {metaAgent?.cwd && /[/\\]\.claude[/\\]worktrees[/\\]|worktree/i.test(metaAgent.cwd) && (
              <span className="px-1.5 py-px bg-amber-100 text-amber-700 rounded flex items-center gap-1" title={`该子代理工作在独立 worktree:${metaAgent.cwd}${metaAgent.gitBranch ? `(分支 ${metaAgent.gitBranch})` : ''}`}>
                <GitBranch size={9} />{metaAgent.gitBranch || metaAgent.cwd.split(/[/\\]/).pop()}
              </span>
            )}
            <span className={`${statusMeta.cls} flex items-center gap-1 font-body`}>
              {working && <Loader2 size={10} className="animate-spin" />}
              {statusMeta.label}
            </span>
            {/* 部件①单卡停止:非终态时显示。停止链路走 store action(反查 pid + stop-task 端点 +
                乐观收尾)。sessionId 以【本视图所属母会话】为准,agent 捕获值垫底 ——
                agent.sessionId 是发起时钉的会话,分支场景下它指向源会话(Bug5 现象②)。 */}
            {nonTerminal && (
              <button
                onClick={async () => {
                  // D5:同 TaskCard —— 没有 slot 认领(provider 不发 task 事件)时给一次提示,
                  // 否则卡片闪一下转回运行中、零解释。
                  const r = await useStore.getState().stopSingleTask(parentSessionId || agent.sessionId, agentId);
                  if (r?.noOwner) confirmDialog(stopNoOwnerNotice(r.procAlive), { confirmText: '知道了' });
                }}
                className="px-1.5 py-px rounded bg-canvas-deep text-ink-muted hover:text-error hover:bg-error/10 flex items-center gap-1 transition-colors font-body"
                title="停止该子代理/teammate"
              >
                <Square size={9} className="fill-current" />停止
              </button>
            )}
            {description && <span className="truncate font-body">{description}</span>}
          </div>
        </div>
      </div>

      {/* 消息流 — 正常会话气泡样式 */}
      <div className="flex-1 min-h-0 relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onWheel={(event) => { if (event.deltaY < 0) markReading(); }}
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (event.clientX >= rect.right - 16) markReading();
          }}
          data-subagent-scroll
          className="h-full overflow-y-auto"
        >
          {/* 派发 prompt = 用户气泡(右侧) */}
          {prompt && (
            <div className="group px-6 py-4">
            <div className="max-w-[var(--content-max)] mx-auto flex flex-row-reverse gap-3">
              <div className="shrink-0 mt-0.5 w-[34px] h-[34px] rounded-full bg-accent/15 flex items-center justify-center">
                <User size={16} className="text-accent" />
              </div>
              <div className="flex-1 min-w-0 flex flex-col items-end">
                <div className="text-[13px] font-medium text-ink font-body mb-1.5">派发任务</div>
                <div className="max-w-[85%] bg-canvas-warm border border-canvas-deep rounded-2xl px-4 py-2.5">
                  <div className="text-[13.5px] text-ink font-body whitespace-pre-wrap max-h-[40vh] overflow-y-auto">{prompt}</div>
                </div>
              </div>
            </div>
          </div>
          )}

        {/* 子代理回复 = Claude 气泡(左侧):思考折叠 + 工具列表 + 正文 */}
        <div className="group px-6 py-4">
          <div className="max-w-[var(--content-max)] mx-auto flex gap-3">
            <div className="mt-0.5 w-[34px] h-[34px] rounded-full bg-violet-100 flex items-center justify-center shrink-0">
              <Bot size={17} className="text-violet-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[13px] font-medium text-ink font-body">{name}</span>
                {agentModel && (
                  <span className="text-[10px] px-1.5 py-px bg-violet-100 text-violet-700 rounded font-mono">{agentModel}</span>
                )}
              </div>

              {/* §1.5 硬约束:与母会话共用 CoworkBlocks(思考+工具按时序分组折叠、活跃段
                  实时展开、正文落地自动收起),逐字节一致,仅多"子代理"标识。子代理无重做入口,
                  onRetryTool 不传。blocks 空(某些 provider 不流式子代理内部)→ 走下方 result 兜底。 */}
              {blocks.length > 0 ? (
                // CoworkBlocks 已按时序渲染思考/工具/正文,正文无需再单独渲染。
                <CoworkBlocks blocks={blocks} isLive={working} dockKeyPrefix={`agent:${agentId}`} />
              ) : agent.result ? (
                // 有些 provider 不流式子代理内部内容,输出在 tool_result 里。
                <div className="text-[13.5px] text-ink font-body">
                  <MarkdownRenderer content={typeof agent.result === 'string' ? agent.result : JSON.stringify(agent.result)} />
                </div>
              ) : null}
              {/* #2 底部加载动画+动态文本:与主会话流式状态行同款视觉物(LoadingMark+动态词+
                  耗时,橙色 #D97757),取代原来的灰色"子代理运行中…"。 */}
              {working && (
                <div className="flex items-center gap-2 mt-2 text-[13px] font-body animate-fade-in" style={{ color: '#D97757' }}>
                  <span className="shrink-0 inline-flex items-center"><LoadingMark size={13} /></span>
                  <span className="font-mono truncate font-medium" style={{ color: '#D97757' }}>{verb}</span>
                  <span style={{ color: '#D97757' }}>…</span>
                  <ElapsedTime startedAt={agent.startedAt} className="ml-1" />
                </div>
              )}
            </div>
          </div>
        </div>
        </div>
        {!atBottom && (
          <button
            onClick={() => {
              const el = scrollRef.current;
              if (el) {
                const target = Math.max(0, el.scrollHeight - el.clientHeight);
                writeProgrammaticScroll(el, target, 'return-bottom');
              }
              followBottomRef.current = true;
              setAtBottom(true);
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 bg-canvas border border-canvas-deep hover:bg-canvas-warm rounded-full p-2 shadow-sm transition-colors"
            title="回到底部"
            aria-label="回到底部"
          >
            <ChevronDown size={14} className="text-ink-muted" />
          </button>
        )}
      </div>

      {/* 子代理的权限申请也在此显示,使在子代理视图内同样可审批(母会话视图同一张卡;
          二者共享 store,按 id 幂等;hydrate 交给母会话那张避免重复 respond)。 */}
      <div className="shrink-0 px-6">
        <div className="max-w-[var(--content-max)] mx-auto">
          <PermissionPrompt sessionId={parentSessionId} hydrate={false} />
        </div>
      </div>
    </div>
  );
}
