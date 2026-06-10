import React from 'react';
import { Bot, ChevronLeft, Loader2 } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';

// #9 子代理会话窗口:点击某个子代理后,主区切换成该子代理的"对话视图"。
// 数据来自 store.activeAgents[agentId](流式累积的 text/thinking/toolCalls)。
// 顶部面包屑可点「母会话标题」返回。本质是 TaskCard 展开内容的全窗口版。
export function SubagentView({ agentId, parentTitle, onBack }) {
  const agent = useStore((s) => s.activeAgents[agentId]);

  if (!agent) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-ink-faint">
        <Bot size={28} className="opacity-40" />
        <div className="text-sm font-body">该子代理数据已不可用</div>
        <button onClick={onBack} className="text-accent text-xs underline">返回母会话</button>
      </div>
    );
  }

  const name = agent.name || 'Task';
  const description = agent.description || '';
  const prompt = agent.prompt || '';
  const thinkingOut = (agent.thinking || []).join('');
  const textOut = (agent.text || []).join('');
  const tools = agent.toolCalls || [];
  const status = agent.status || 'working';
  const working = status === 'working' || status === 'starting';

  const statusMeta = {
    starting: { label: '启动中', cls: 'text-blue-600' },
    working:  { label: '工作中', cls: 'text-blue-600' },
    needs_input: { label: '等待输入', cls: 'text-violet-600' },
    done:     { label: '已完成', cls: 'text-green-600' },
    error:    { label: '错误', cls: 'text-red-600' },
  }[status] || { label: status, cls: 'text-ink-muted' };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 面包屑 */}
      <div className="glass-bar shrink-0 px-6 py-3 border-b border-canvas-deep">
        <div className="max-w-[var(--content-max)] mx-auto flex items-center gap-2 text-[13px] font-body min-w-0">
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-ink-muted hover:text-accent transition-colors shrink-0"
            title="返回母会话"
          >
            <ChevronLeft size={15} />
            <span className="truncate max-w-[40vw]">{parentTitle || '母会话'}</span>
          </button>
          <span className="text-ink-faint shrink-0">›</span>
          <Bot size={14} className="text-violet-600 shrink-0" />
          <span className="font-mono text-violet-900 truncate">{name}</span>
          {agent.model && (
            <span className="text-[10px] px-1.5 py-px bg-violet-100 text-violet-700 rounded font-mono shrink-0" title="该子代理实际使用的模型">
              {agent.model}
            </span>
          )}
          <span className={`text-[11px] shrink-0 ${statusMeta.cls} flex items-center gap-1`}>
            {working && <Loader2 size={11} className="animate-spin" />}
            {statusMeta.label}
          </span>
        </div>
      </div>

      {/* 子代理对话内容 */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-[var(--content-max)] mx-auto space-y-4">
          {description && (
            <div className="text-sm text-ink-muted font-body">{description}</div>
          )}

          {prompt && (
            <details className="rounded-lg border border-canvas-deep bg-canvas-warm/50 overflow-hidden" open>
              <summary className="cursor-pointer px-3 py-2 text-[11px] text-ink-faint uppercase tracking-wider font-body">
                派发 Prompt
              </summary>
              <div className="px-3 pb-3 text-[12px] text-ink-muted font-body whitespace-pre-wrap max-h-60 overflow-y-auto">
                {prompt}
              </div>
            </details>
          )}

          {thinkingOut && (
            <details className="rounded-lg border border-canvas-deep bg-canvas overflow-hidden">
              <summary className="cursor-pointer px-3 py-2 text-[11px] text-ink-faint uppercase tracking-wider font-body">
                子代理思考
              </summary>
              <div className="px-3 pb-3 text-[12px] text-ink-soft font-body whitespace-pre-wrap max-h-80 overflow-y-auto">
                {thinkingOut}
              </div>
            </details>
          )}

          {tools.length > 0 && (
            <div className="rounded-lg border border-canvas-deep bg-canvas p-3">
              <div className="text-[11px] text-ink-faint uppercase tracking-wider font-body mb-2">
                调用工具 ({tools.length})
              </div>
              <div className="space-y-1.5">
                {tools.map((tc, i) => (
                  <div key={tc.id || i} className="text-[12px] font-mono text-ink-soft flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                    <span className="truncate flex-1">{tc.name}</span>
                    {tc.result ? (
                      tc.result.isError
                        ? <span className="text-error shrink-0">✗</span>
                        : <span className="text-success shrink-0">✓</span>
                    ) : (
                      <Loader2 size={11} className="text-ink-faint animate-spin shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {textOut ? (
            <div className="rounded-lg border border-canvas-deep bg-canvas px-4 py-3">
              <div className="text-[11px] text-ink-faint uppercase tracking-wider font-body mb-2">子代理回复</div>
              <div className="text-[13px] text-ink font-body"><MarkdownRenderer content={textOut} /></div>
            </div>
          ) : working ? (
            <div className="flex items-center gap-2 text-ink-faint text-sm">
              <Loader2 size={14} className="animate-spin" /> 子代理运行中…
            </div>
          ) : null}

          {/* 有些 provider 不流式子代理内部内容,子代理输出在 tool_result 里。 */}
          {agent.result && !textOut && (
            <div className="rounded-lg border border-canvas-deep bg-canvas px-4 py-3">
              <div className="text-[11px] text-ink-faint uppercase tracking-wider font-body mb-2">子代理输出</div>
              <div className="text-[13px] text-ink font-body">
                <MarkdownRenderer content={typeof agent.result === 'string' ? agent.result : JSON.stringify(agent.result)} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
