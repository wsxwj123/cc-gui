import React, { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Loader2, Maximize2 } from 'lucide-react';
import { useStore } from '../../stores/sessionStore.js';
import { MarkdownRenderer } from '../MarkdownRenderer.jsx';

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

  const subagentType = toolCall.input?.subagent_type || agent?.name || 'Task';
  const description = toolCall.input?.description || agent?.description || '';
  const prompt = toolCall.input?.prompt || '';

  const isError = toolCall.result?.isError;
  const isDone = !!toolCall.result;
  const isWorking = !isDone;

  const textOut = agent ? agent.text.join('') : '';
  const thinkingOut = agent ? agent.thinking.join('') : '';
  const childTools = agent?.toolCalls || [];

  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden bg-canvas animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-start gap-2 bg-violet-50 hover:bg-violet-100 transition-colors text-left"
      >
        {expanded
          ? <ChevronDown size={12} className="text-violet-600 shrink-0 mt-0.5" />
          : <ChevronRight size={12} className="text-violet-600 shrink-0 mt-0.5" />}
        <Bot size={14} className="text-violet-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-violet-900 font-mono truncate">
              {subagentType}
            </span>
            {agent?.model && (
              <span className="text-[9px] px-1 py-px bg-violet-100 text-violet-700 rounded font-mono shrink-0" title="该子代理实际使用的模型">
                {agent.model}
              </span>
            )}
            {isWorking && <Loader2 size={11} className="text-violet-500 animate-spin shrink-0" />}
            {isDone && !isError && <span className="text-[10px] text-success shrink-0">完成</span>}
            {isError && <span className="text-[10px] text-error shrink-0">错误</span>}
          </div>
          {description && (
            <div className="text-[10.5px] text-ink-muted font-body truncate mt-0.5">
              {description}
            </div>
          )}
        </div>
        {/* #9 进入子代理会话窗口 */}
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); setViewingAgent(toolCall.id); }}
          className="shrink-0 p-1 rounded text-violet-500 hover:text-violet-800 hover:bg-violet-100 transition-colors cursor-pointer"
          title="在子代理会话窗口打开"
        >
          <Maximize2 size={12} />
        </span>
      </button>

      {expanded && (
        <div className="border-t border-violet-200 pl-3 ml-4 border-l-2 border-violet-300 bg-canvas">
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
                  <span className="w-1 h-1 rounded-full bg-violet-400" />
                  <span>{tc.name}</span>
                  {tc.result ? (
                    tc.result.isError
                      ? <span className="text-error">✗</span>
                      : <span className="text-success">✓</span>
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
