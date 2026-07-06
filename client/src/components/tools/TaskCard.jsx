import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Maximize2, CheckCircle2, XCircle } from 'lucide-react';
import { useStore } from '../../stores/sessionStore.js';
import { MarkdownRenderer } from '../MarkdownRenderer.jsx';
import { extractToolResultText } from '../../utils/toolResult.js';

// Subagent card — Task tool calls. Pulls the live agent state (text/thinking/
// tool calls accumulated from stream_events with parent_tool_use_id) out of
// the store and renders them indented under the parent turn.
//
// `toolCall` here is the parent Task tool_use; toolCall.id matches the key
// in store.activeAgents.
export function TaskCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const agent = useStore((s) => s.activeAgents[toolCall.id]);
  const setViewingAgent = useStore((s) => s.setViewingAgent);
  // R1: 某些 CLI 版本不往父流发 parent_tool_use_id 事件,activeAgents 永远没有
  // model。兜底:会话对象的 subagents(server 从 subagents/*.meta.json + jsonl
  // 提取)按 toolUseId(全局唯一)对回本卡片。优先查实时刷新的 sessions 列表,
  // 再退到选中态快照。选择器只返回既有引用,find 在外面做(防 #185)。
  const sessionsList = useStore((s) => s.sessions);
  const paneSession = useStore((s) => s.paneSessions[s.activeTabIndex] || s.selectedSession);
  let metaAgent;
  for (const sess of [...(Array.isArray(sessionsList) ? sessionsList : []), paneSession]) {
    metaAgent = sess?.subagents?.find?.((a) => a.toolUseId === toolCall.id);
    if (metaAgent) break;
  }
  const agentModel = agent?.model || metaAgent?.model || null;

  // 名称优先级:input.subagent_type(实测 = web-search-agent 等具体名)→ store 里的
  // agent.name → server 提取的 metaAgent.agentType。最后才回退泛化文案。store 里的
  // agent.name 在某些 provider 下会停留在字面 'Agent'/'Task'(input 未解析成功时),
  // 这种情况下优先用 metaAgent.agentType 还原具体名。
  const rawName = toolCall.input?.subagent_type || agent?.name || null;
  const isGeneric = !rawName || rawName === 'Task' || rawName === 'Agent';
  const subagentType = (isGeneric && metaAgent?.agentType) ? metaAgent.agentType : (rawName || '子代理');
  const description = toolCall.input?.description || agent?.description || '';
  const prompt = toolCall.input?.prompt || '';

  // W1:完成判定与 Subagent 监控同源(activeAgents.status)。只看 toolCall.result 时,
  // 切走会话期间 tool_result 没写进本地流式副本 → 监控显示"完成"而卡片永远转圈。
  const agentDone = agent?.status === 'done' || agent?.status === 'error' || agent?.status === 'stopped';
  const isError = toolCall.result?.isError || agent?.status === 'error';
  const isDone = !!toolCall.result || agentDone;
  const isWorking = !isDone;

  // P2: 历史会话重载后 activeAgents(内存态)是空的,点放大查不到数据 → 之前没反应。
  // 兜底:打开前若 store 无此 agent,先从 toolCall 的 input/result 注册一份,再进入。
  const openAgentView = (e) => {
    e.stopPropagation();
    const st = useStore.getState();
    if (!st.activeAgents[toolCall.id]) {
      const resContent = toolCall.result?.content;
      st.upsertAgent(toolCall.id, {
        name: subagentType,
        description,
        prompt,
        model: agentModel,
        status: isDone ? (isError ? 'error' : 'done') : 'working',
        startedAt: Date.now(),
        sessionId: st.paneSessions[st.activeTabIndex]?.sessionId || st.selectedSession?.sessionId || null,
        result: resContent != null ? extractToolResultText(resContent) : null,
      });
    }
    st.setViewingAgent(st.activeTabIndex, toolCall.id);  // AZ6:渲染所在/焦点 pane
  };

  const textOut = agent ? agent.text.join('') : '';
  const thinkingOut = agent ? agent.thinking.join('') : '';
  const childTools = agent?.toolCalls || [];

  // 重设计(用户反馈原 accent 描边 + 实色标签太丑):生产级克制 —— 极细中性
  // 边框卡,去大色块;左侧图标位 = 运行中三点脉冲(accent)/ 结束后几何 agent
  // 图标 + 状态角点(绿/红);代理类型用小号大写字距标签(ink-muted),任务描述
  // 正文色;展开箭头与子代理窗口入口悬停浮现(展开态与触屏常显)。
  // 命名 group/tc:TurnBubble 外层已有 group,避免嵌套 group 互相触发。
  return (
    <div className="group/tc border border-canvas-deep rounded-lg overflow-hidden bg-canvas animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full pl-3 pr-2 py-2 flex items-center gap-2.5 hover:bg-canvas-warm transition-colors text-left"
      >
        {/* 图标位:运行中=三点脉冲;完成=绿色圆圈√(同会话完成标志);出错=红色圆圈× */}
        <span className="relative shrink-0 w-5 h-5 flex items-center justify-center text-ink-muted">
          {isWorking ? (
            <span className="tc-agent-dots text-accent" aria-label="运行中"><span /><span /><span /></span>
          ) : isError ? (
            <XCircle size={16} className="text-error" aria-label="子代理出错" />
          ) : (
            <CheckCircle2 size={16} className="text-success" aria-label="子代理完成" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[10px] uppercase tracking-[0.12em] text-ink-muted font-body shrink-0" title={`子代理: ${subagentType}`}>
              {subagentType}
            </span>
            {agentModel && (
              <span className="text-[9px] font-mono text-ink-faint truncate" title="该子代理实际使用的模型">
                {agentModel}
              </span>
            )}
          </div>
          {description && (
            <div className="text-[12px] text-ink font-body truncate mt-0.5">
              {description}
            </div>
          )}
        </div>
        {/* 悬停浮现:子代理窗口入口(#9) + 展开箭头;触屏无 hover,常显淡态 */}
        <span className={`shrink-0 flex items-center gap-0.5 transition-opacity ${expanded ? 'opacity-100' : 'opacity-0 group-hover/tc:opacity-100 max-md:opacity-60'}`}>
          <span
            role="button"
            tabIndex={0}
            onClick={openAgentView}
            className="p-1 rounded text-ink-faint hover:text-accent hover:bg-accent-subtle transition-colors cursor-pointer"
            title="在子代理会话窗口打开"
          >
            <Maximize2 size={12} />
          </span>
          {expanded
            ? <ChevronDown size={13} className="text-ink-faint" />
            : <ChevronRight size={13} className="text-ink-faint" />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-canvas-deep pl-3 ml-[21px] border-l border-l-canvas-deep bg-canvas">
          {prompt && (
            <details className="px-3 py-2 border-b border-canvas-deep">
              <summary className="cursor-pointer text-[10px] text-ink-faint uppercase tracking-wider font-body">
                派发 Prompt
              </summary>
              <div className="text-[11px] text-ink-muted font-body whitespace-pre-wrap mt-2 max-h-32 overflow-y-auto">
                {prompt}
              </div>
            </details>
          )}

          {thinkingOut && (
            <details className="px-3 py-2 border-b border-canvas-deep">
              <summary className="cursor-pointer text-[10px] text-ink-faint uppercase tracking-wider font-body">
                子代理思考
              </summary>
              <div className="text-[11px] text-ink-muted font-body whitespace-pre-wrap mt-2 max-h-48 overflow-y-auto">
                {thinkingOut}
              </div>
            </details>
          )}

          {childTools.length > 0 && (
            <div className="px-3 py-2 border-b border-canvas-deep space-y-1">
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body mb-1">
                子代理调用工具 ({childTools.length})
              </div>
              {childTools.map((tc, i) => (
                <div key={tc.id || i} className="text-[11px] font-mono text-ink-soft flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-accent/60" />
                  <span>{tc.name}</span>
                  {tc.result ? (
                    tc.result.isError
                      ? <span className="text-error">✗</span>
                      : <span className="text-success">✓</span>
                  ) : isDone ? (
                    // U7:Task 整体已收尾,内部工具必然结束 —— 不再转圈。
                    <span className="text-success">✓</span>
                  ) : (
                    <Loader2 size={10} className="text-ink-faint animate-spin" />
                  )}
                </div>
              ))}
            </div>
          )}

          {textOut && (
            <div className="px-3 py-2 border-b border-canvas-deep">
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body mb-1">
                子代理回复
              </div>
              <div className="text-[12px] text-ink font-body">
                <MarkdownRenderer content={textOut} />
              </div>
            </div>
          )}

          {toolCall.result && (
            <details className="px-3 py-2">
              <summary className="cursor-pointer text-[10px] text-ink-faint uppercase tracking-wider font-body">
                Task 工具最终结果
              </summary>
              <pre className={`text-[11px] font-mono whitespace-pre-wrap mt-2 max-h-64 overflow-y-auto p-2 rounded ${
                isError ? 'bg-red-50 text-red-700' : 'bg-canvas-warm text-ink-muted'
              }`}>
                {String(toolCall.result.content || '').slice(0, 8000)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
