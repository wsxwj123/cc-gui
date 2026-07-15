import React from 'react';
import { Bot, Loader2, User } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { CoworkBlocks } from './TurnBubble.jsx';
import { PermissionPrompt } from './PermissionPrompt.jsx';

// #9/O4 子代理会话窗口:样式对齐正常会话(用户气泡在右、回复在左、思考/工具折叠),
// 标题处「母会话标题 / 子代理名」层级面包屑,点母会话标题返回。
// 数据来自 store.activeAgents[agentId](流式累积的 text/thinking/toolCalls)。
export function SubagentView({ agentId, parentTitle, parentSessionId = null, onBack }) {
  const agent = useStore((s) => s.activeAgents[agentId]);
  // 兜底:store 拿不到具体名/model 时(provider 不发子代理流),从 server 提取的
  // sessions.subagents 按 toolUseId(= agentId)对回 agentType / model。
  const sessionsList = useStore((s) => s.sessions);
  let metaAgent;
  for (const sess of (Array.isArray(sessionsList) ? sessionsList : [])) {
    metaAgent = sess?.subagents?.find?.((a) => a.toolUseId === agentId);
    if (metaAgent) break;
  }

  if (!agent) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-ink-faint bg-canvas">
        <Bot size={28} className="opacity-40" />
        <div className="text-sm font-body">该子代理数据已不可用</div>
        <button onClick={onBack} className="text-accent text-xs underline">返回母会话</button>
      </div>
    );
  }

  const rawName = agent.name || null;
  const isGeneric = !rawName || rawName === 'Task' || rawName === 'Agent';
  const name = (isGeneric && metaAgent?.agentType) ? metaAgent.agentType : (rawName || '子代理');
  const agentModel = agent.model || metaAgent?.model || null;
  const description = agent.description || '';
  const prompt = agent.prompt || '';
  const blocks = agent.blocks || [];
  const status = agent.status || 'working';
  const working = status === 'working' || status === 'starting';

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
          <div className="flex items-center gap-2 mt-0.5 text-[11px] font-mono text-ink-faint">
            {agentModel && (
              <span className="px-1.5 py-px bg-violet-100 text-violet-700 rounded" title="该子代理实际使用的模型">
                {agentModel}
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
              ) : working ? (
                <div className="flex items-center gap-2 text-ink-faint text-sm font-body">
                  <Loader2 size={14} className="animate-spin" /> 子代理运行中…
                </div>
              ) : null}
            </div>
          </div>
        </div>
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
