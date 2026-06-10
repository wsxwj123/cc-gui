import React from 'react';
import { Bot, Loader2, User } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';

// #9/O4 子代理会话窗口:样式对齐正常会话(用户气泡在右、回复在左、思考/工具折叠),
// 标题处「母会话标题 / 子代理名」层级面包屑,点母会话标题返回。
// 数据来自 store.activeAgents[agentId](流式累积的 text/thinking/toolCalls)。
export function SubagentView({ agentId, parentTitle, onBack }) {
  const agent = useStore((s) => s.activeAgents[agentId]);

  if (!agent) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-ink-faint bg-canvas">
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
          <div className="flex items-center gap-2 mt-0.5 text-[11px] font-mono text-ink-faint">
            {agent.model && (
              <span className="px-1.5 py-px bg-violet-100 text-violet-700 rounded" title="该子代理实际使用的模型">
                {agent.model}
              </span>
            )}
            <span className={`${statusMeta.cls} flex items-center gap-1 font-body`}>
              {working && <Loader2 size={10} className="animate-spin" />}
              {statusMeta.label}
            </span>
            {description && <span className="truncate font-body">{description}</span>}
          </div>
        </div>
      </div>

      {/* 消息流 — 正常会话气泡样式 */}
      <div className="flex-1 overflow-y-auto">
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
                {agent.model && (
                  <span className="text-[10px] px-1.5 py-px bg-violet-100 text-violet-700 rounded font-mono">{agent.model}</span>
                )}
              </div>

              {thinkingOut && (
                <details className="mb-2 rounded-lg border border-canvas-deep bg-canvas-warm/40 overflow-hidden">
                  <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-ink-faint font-body">🧠 思考过程</summary>
                  <div className="px-3 pb-2.5 text-[12px] text-ink-soft font-body whitespace-pre-wrap max-h-72 overflow-y-auto">
                    {thinkingOut}
                  </div>
                </details>
              )}

              {tools.length > 0 && (
                <details className="mb-2 rounded-lg border border-canvas-deep bg-canvas overflow-hidden">
                  <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-ink-faint font-body">
                    🔧 {tools.length} 次工具调用
                  </summary>
                  <div className="px-3 pb-2.5 space-y-1.5">
                    {tools.map((tc, i) => (
                      <div key={tc.id || i} className="text-[12px] font-mono text-ink-soft flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                        <span className="truncate flex-1">{tc.name}</span>
                        {tc.result ? (
                          tc.result.isError
                            ? <span className="text-error shrink-0">✗</span>
                            : <span className="text-success shrink-0">✓</span>
                        ) : !working ? (
                          // U7:子代理整体已结束,内部工具必然结束 —— 不再转圈。
                          <span className="text-success shrink-0">✓</span>
                        ) : (
                          <Loader2 size={11} className="text-ink-faint animate-spin shrink-0" />
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {textOut ? (
                <div className="text-[13.5px] text-ink font-body"><MarkdownRenderer content={textOut} /></div>
              ) : agent.result ? (
                // 有些 provider 不流式子代理内部内容,输出在 tool_result 里。
                <div className="text-[13.5px] text-ink font-body">
                  <MarkdownRenderer content={typeof agent.result === 'string' ? agent.result : JSON.stringify(agent.result)} />
                </div>
              ) : working ? (
                <div className="flex items-center gap-2 text-ink-faint text-sm font-body">
                  <Loader2 size={14} className="animate-spin" /> 子代理运行中…
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
