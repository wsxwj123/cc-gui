import React, { useState, useRef, useEffect, useContext, useMemo } from 'react';
import {
  Brain, Copy, Check, ChevronDown, ChevronRight,
  Wrench, BookOpen, Pencil, Terminal, FileText, Search,
  Globe, Edit3, Loader2, RotateCcw, Bot, GitBranch
} from './Icon.jsx';
import { ModelBadge, ProviderAvatar, AssistantName } from './ModelBadge.jsx';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { cacheHitPct, formatHitPct } from '../utils/cacheStats.js';
import { GenuiActionProvider } from '../genui/host/action-context.jsx';
import { BashCard } from './tools/BashCard.jsx';
import { EditDiffCard } from './tools/EditDiffCard.jsx';
import { ReadCard } from './tools/ReadCard.jsx';
import { TaskCard, TaskOwnerContext } from './tools/TaskCard.jsx';
import { SubagentCostContext } from './tools/SubagentCost.jsx';
import { buildSubagentCostIndex } from '../utils/subagentCost.js';
import { WorkflowCard } from './tools/WorkflowCard.jsx';
import { GrepGlobCard } from './tools/GrepGlobCard.jsx';
import { WebCard } from './tools/WebCard.jsx';
import { SkillCard } from './tools/SkillCard.jsx';
import {
  computeCostForMessage, costUnavailableReason, costSourceLabel, costUnknownNote, COST_REASON_TEXT,
  formatCost, displayUsd, isPlanBilling, costTitle,
} from '../utils/pricing.js';
import { copyText } from '../utils/clipboard.js';
import { shouldShowBottomCopy } from '../utils/scroll.js';
import { useStore, roundStripEnd } from '../stores/sessionStore.js';
import { TASK_TOOL_NAMES, rebuildTodosFromTaskCalls } from '../utils/todos.js';
import {
  formatInputPreview, thinkingLabel, groupCoworkBlocks, activeGroupKey,
  stripSummary, isFoldableSegment, getSkillDocReadName,
} from '../utils/streamStatus.js';
import { Linkify } from '../utils/linkify.jsx';

// Tools that get their own bespoke inline card (rendered in chronological order
// inside the turn). Anything not in this set falls through to ToolCallsGroup,
// the generic category-grouped collapsible.
const INLINE_TOOL_NAMES = new Set([
  'Bash', 'Edit', 'MultiEdit', 'Write', 'Read',
  // 'Agent' 与 'Task' 都是子代理派发工具(不同 provider/CLI 命名不同),都走 TaskCard。
  'Task', 'Agent', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Skill',
]);

// 工作流派发工具。独立成卡(阶段 + 助手表),不进 INLINE_TOOL_NAMES 的通用卡片路径,
// 也不随聊天模式的"执行了 N 步操作"折起 —— 它是这条消息的主体,一次能跑几十分钟。
const WORKFLOW_TOOL = 'Workflow';

// skilldoc 识别(读 skills/<name>/SKILL.md 当技能横幅)在 utils/streamStatus.js —
// 下方 skilldoc 渲染分支与摘要(stripSummary)的分组共用那一份唯一实现,
// 不在这里另留一份(两份实现会慢慢跑偏:摘要多算一步、渲染一个段都没有)。

// hoverOnly:Skill 横幅 / 子代理卡片直接铺在回复流里,重做按钮常显会破坏版面 —
// 悬停(移动端弱化常显)才浮现,功能与折叠组内一致。
function ToolCallWithRetry({ toolCall, onRetryTool, hoverOnly = false, children }) {
  return (
    <div className={`space-y-1 ${hoverOnly ? 'group/tcretry' : ''}`}>
      {/* B4 显式只读退出(PLAN §1.3.2):工具结果卡片是模型输出的**回显**,不是用户的
          操作面。所有 tools/* 富卡片都经这里,一处退出全覆盖;不靠"碰巧拿不到 Provider"
          —— 卡片就在窗格里,Provider 挂窗格根之后它们反而会变成可交互。 */}
      <GenuiActionProvider value={null}>{children}</GenuiActionProvider>
      {onRetryTool && (
        <div className={`flex justify-end ${hoverOnly ? 'opacity-0 group-hover/tcretry:opacity-100 max-md:opacity-60 transition-opacity' : ''}`}>
          <button
            onClick={() => onRetryTool(toolCall)}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-accent-muted bg-accent-subtle/40 text-[11px] font-medium text-accent hover:bg-accent-subtle hover:border-accent transition-colors font-body"
            title="回退到这个工具调用之前，让 AI 从这一步重新执行"
          >
            <RotateCcw size={12} />
            <span>重做此工具</span>
          </button>
        </div>
      )}
    </div>
  );
}

function InlineToolCard({ toolCall, onRetryTool }) {
  return (
    <ToolCallWithRetry toolCall={toolCall} onRetryTool={onRetryTool}>
      {renderRichToolCard(toolCall)}
    </ToolCallWithRetry>
  );
}

// 给 SubagentView 复用:子代理工具调用本应与母会话同样式(用户报告)。
// CoworkBlocks:母/子共用的有序 blocks 渲染(§1.5 硬约束,单一渲染路径)。
export { InlineToolCard, renderRichToolCard, ToolCallsGroup };

// 停止合成终态的统一降级卡(fable 判官严重项):合成 result 是 {isError:false,
// interrupted:true},五张专用卡(Bash/EditDiff/Read/GrepGlob/Web)只有成功/失败两分支,
// 会把"被停止"渲染成绿勾成功——EditDiffCard 最误导(未应用的 Edit 像已写入)。
// 灰色"已停止"行,不绿勾、不显示成功产物;点开可看输入参数(信息不丢)。
function InterruptedToolCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getToolIcon(toolCall.name);
  // 写入类工具的中断态必须明确表达"未应用":改动没有写入文件。
  const isWriteTool = toolCall.name === 'Edit' || toolCall.name === 'MultiEdit' || toolCall.name === 'Write';
  const preview = formatInputPreview(toolCall.input);
  return (
    <div className="border border-canvas-sunken bg-canvas rounded-md overflow-hidden opacity-80">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-canvas-warm/60 transition-colors text-left"
      >
        <Icon size={12} className="text-ink-faint shrink-0" />
        <span className="text-[11px] font-mono text-ink-muted truncate flex-1">{toolCall.name}</span>
        {preview && (
          <span className="text-[10px] text-ink-faint font-mono truncate max-w-[200px]">{preview}</span>
        )}
        <span className="text-[10px] text-ink-faint shrink-0">{isWriteTool ? '已停止（未应用）' : '已停止'}</span>
      </button>
      {expanded && (
        <div className="border-t border-canvas-sunken p-2.5 animate-fade-in">
          <div className="text-[9px] uppercase tracking-wider text-ink-faint mb-1">
            输入（工具被停止,无返回结果{isWriteTool ? ',改动未写入文件' : ''}）
          </div>
          <pre className="text-[11px] bg-canvas-warm rounded p-2 overflow-x-auto max-h-48 font-mono text-ink-muted">
            {JSON.stringify(toolCall.input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}


// MCP 工具通用卡:输入参数(折叠) + 文本输出(Linkify,裸 URL 可点) + 图像块 <img>。
// 图像块来源见 utils/toolResult.js 的 extractToolResultImages(computer-use 截图主用例)。
function McpToolCard({ toolCall }) {
  const [expanded, setExpanded] = useState(true);
  const result = toolCall.result;
  const images = Array.isArray(result?.images) ? result.images : [];
  const nameParts = (toolCall.name || '').split('__');
  const shortName = nameParts.pop() || toolCall.name;
  const serverName = nameParts[1] || '';
  const running = !result;
  const inputStr = toolCall.input && Object.keys(toolCall.input).length
    ? JSON.stringify(toolCall.input, null, 2) : '';
  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 bg-canvas-warm flex items-center gap-2 hover:bg-canvas-deep/20 transition-colors text-left"
      >
        <Wrench size={12} className="text-ink-muted shrink-0" />
        <span className="font-mono text-[11px] text-ink-muted truncate flex-1">{shortName}</span>
        {serverName && <span className="text-[10px] text-ink-faint shrink-0">{serverName}</span>}
        {running
          ? <Loader2 size={11} className="text-ink-faint animate-spin shrink-0" />
          : result?.isError
            ? <span className="text-red-400 text-[10px] shrink-0">错误</span>
            : <Check size={11} className="text-green-400 shrink-0" />}
      </button>
      {expanded && (
        <div className="border-t border-canvas-sunken p-2.5 space-y-2">
          {inputStr && (
            <pre className="text-[10px] bg-canvas-warm rounded p-2 overflow-x-auto max-h-32 font-mono text-ink-faint">{inputStr}</pre>
          )}
          {result?.content && (
            <pre className="text-[11px] whitespace-pre-wrap break-all max-h-64 overflow-auto font-mono text-ink-muted"><Linkify text={result.content} /></pre>
          )}
          {images.length > 0 && (
            <div className="space-y-2">
              {images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mime};base64,${img.data}`}
                  alt={`${shortName} 结果 ${i + 1}`}
                  loading="lazy"
                  className="max-w-full h-auto rounded border border-canvas-deep"
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Returns the rich card React element for a tool, or null when no
// specialty renderer exists for that tool name.
function renderRichToolCard(toolCall) {
  // 统一在分发层拦截中断合成终态(逐卡加分支必漏,新增专用卡自动覆盖)。
  // Skill 例外:SkillCard 自带中断态横幅(样式更贴合,保留)。Task/Agent 天然不进
  // (finalizePendingToolCalls 不给它们补 result,状态走 activeAgents/TaskCard)。
  if (toolCall.result?.interrupted && toolCall.name !== 'Skill') {
    return <InterruptedToolCard toolCall={toolCall} />;
  }
  // MCP 工具(mcp__server__tool):此前落 ToolCallsGroup 通用折叠,computer-use 截图
  // 等带图像块的结果在界面上完全不可见(用户反馈"工具调用时并没有显示图片")。
  // 通用卡:文本输出 + 图像块就地渲染。有专用卡的名称仍走下方 switch。
  if (toolCall.name.startsWith('mcp__')) return <McpToolCard toolCall={toolCall} />;
  switch (toolCall.name) {
    case 'Bash': return <BashCard toolCall={toolCall} />;
    case 'Edit':
    case 'MultiEdit':
    case 'Write': return <EditDiffCard toolCall={toolCall} />;
    case 'Read': return <ReadCard toolCall={toolCall} />;
    case 'Task':
    case 'Agent': return <TaskCard toolCall={toolCall} />;
    case 'Grep':
    case 'Glob': return <GrepGlobCard toolCall={toolCall} />;
    case 'WebSearch':
    case 'WebFetch': return <WebCard toolCall={toolCall} />;
    case 'Skill': return <SkillCard toolCall={toolCall} />;
    default: return null;
  }
}

// ─── Tool category config ──────────────────────────────────────
const CATEGORY_CONFIG = {
  // U9a:子代理派发(Task/Agent)是特殊调用,折叠条里单列紫色分组 + 头部徽章,
  // 不再与普通工具混在 "调用" 里无从分辨。
  agent: {
    label: '子代理',
    icon: Bot,
    color: 'text-violet-600',
    bg: 'bg-violet-50',
    border: 'border-violet-200',
  },
  skill: {
    label: '读取',
    icon: BookOpen,
    color: 'text-ink-muted',
    bg: 'bg-canvas-warm',
    border: 'border-canvas-deep',
  },
  write: {
    label: '写入',
    icon: Pencil,
    color: 'text-accent',
    bg: 'bg-accent-subtle',
    border: 'border-accent-muted',
  },
  call: {
    label: '调用',
    icon: Wrench,
    color: 'text-ink-soft',
    bg: 'bg-canvas-warm',
    border: 'border-canvas-deep',
  },
};

const TOOL_ICONS = {
  Bash: Terminal,
  Read: FileText,
  Edit: Edit3,
  Write: FileText,
  Grep: Search,
  WebSearch: Globe,
  WebFetch: Globe,
  Agent: Wrench,
};

function getToolIcon(name) {
  return TOOL_ICONS[name] || Wrench;
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ─── Copy Button ───────────────────────────────────────────────
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <button
      onClick={async () => {
        if (await copyText(text)) {
          clearTimeout(timerRef.current); // 连点复制:清旧 timer,保住新状态的完整时长
          setCopied(true);
          timerRef.current = setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="p-1 hover:bg-canvas-deep rounded"
      title="复制"
    >
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} className="text-ink-faint" />}
    </button>
  );
}

// AskUserQuestion 在 -p mode 被 CLI reject(headless 禁用),hook 把用户选项以
// `deny + reason="[用户已通过界面回答]\n..."` 反馈给模型 → CLI 写 jsonl 时
// result.isError=true。Bug #3:气泡显示"1 错误"很误导,实际上用户已经成功答题。
function isAskAnswered(toolCall) {
  if (toolCall?.name !== 'AskUserQuestion') return false;
  const content = toolCall?.result?.content;
  const text = typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content.map((c) => c?.text || '').join('') : '');
  return /^\s*\[用户已通过界面回答\]/.test(text);
}

// O1: ExitPlanMode 在 headless 下被 hook deny 收尾(批准计划的正常机制),
// isError=true 是机制副作用而非失败。识别批准 reason → 渲染"✅ 计划已批准"。
function isPlanApproved(toolCall) {
  if (toolCall?.name !== 'ExitPlanMode') return false;
  const content = toolCall?.result?.content;
  const text = typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content.map((c) => c?.text || '').join('') : '');
  return /用户已批准此计划/.test(text);
}

// O1 孪生:计划审批里「需要修改(追加反馈)」和「取消」都走 deny+feedback → CLI 写 isError=true,
// 但都是正常流程不是失败。后端 deny message 固定含尾串「再次调用 ExitPlanMode 重新提交」(refine
// 指引),取消额外以「用户取消计划」开头。据此把两者从错误态摘除并给友好文案。真正的工具失败文本
// 不含该尾串,仍正确显红。
function planDenyState(toolCall) {
  if (toolCall?.name !== 'ExitPlanMode') return null;
  const content = toolCall?.result?.content;
  const text = typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content.map((c) => c?.text || '').join('') : '');
  if (!toolCall?.result?.isError || !/再次调用 ExitPlanMode 重新提交/.test(text)) return null;
  return /^\s*用户取消计划/.test(text) ? 'cancelled' : 'refining';
}

// ─── Single Tool Call Row ──────────────────────────────────────
function ToolCallRow({ toolCall, onRetryTool }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getToolIcon(toolCall.name);
  const askAnswered = isAskAnswered(toolCall);
  const planApproved = isPlanApproved(toolCall);
  const planDeny = planDenyState(toolCall); // 'refining'(追加修改)| 'cancelled'(取消)| null
  const hasError = toolCall.result?.isError && !askAnswered && !planApproved && !planDeny;
  const preview = formatInputPreview(toolCall.input);

  return (
    <ToolCallWithRetry toolCall={toolCall} onRetryTool={onRetryTool}>
      <div className={`border rounded-md overflow-hidden ${hasError ? 'border-error/30 bg-error-subtle/40' : 'border-canvas-sunken bg-canvas'}`}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-canvas-warm/60 transition-colors text-left"
        >
          <Icon size={12} className="text-ink-muted shrink-0" />
          <span className="text-[11px] font-mono text-ink-soft truncate flex-1">
            {toolCall.name}
          </span>
          {preview && (
            <span className="text-[10px] text-ink-faint font-mono truncate max-w-[200px]">
              {preview}
            </span>
          )}
          {toolCall.result ? (
            hasError ? (
              <span className="text-[10px] text-error">错误</span>
            ) : toolCall.result.interrupted ? (
              // 停止补的合成终态:未回执工具被掐断,显示"已停止"而非绿勾冒充完成
              <span className="text-[10px] text-ink-faint">已停止</span>
            ) : planApproved ? (
              <span className="text-[10px] text-success">✅ 计划已批准</span>
            ) : planDeny === 'refining' ? (
              <span className="text-[10px] text-accent">准备修改</span>
            ) : planDeny === 'cancelled' ? (
              <span className="text-[10px] text-ink-faint">已取消</span>
            ) : askAnswered ? (
              <span className="text-[10px] text-success">已答</span>
            ) : (
              <span className="text-[10px] text-success">✓</span>
            )
          ) : (
            <Loader2 size={10} className="text-ink-faint animate-spin" />
          )}
        </button>

        {expanded && (
          <div className="border-t border-canvas-sunken p-2.5 space-y-2 animate-fade-in">
            <div>
              <div className="text-[9px] uppercase tracking-wider text-ink-faint mb-1">输入</div>
              <pre className="text-[11px] bg-canvas-warm rounded p-2 overflow-x-auto max-h-32 font-mono text-ink-muted">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
            {toolCall.result && (
              <div>
                <div className="text-[9px] uppercase tracking-wider text-ink-faint mb-1">
                  结果 {hasError && <span className="text-error">错误</span>}
                </div>
                <pre className={`text-[11px] rounded p-2 overflow-x-auto max-h-48 font-mono ${hasError ? 'bg-error-subtle text-error' : 'bg-canvas-warm text-ink-muted'}`}>
                  {typeof toolCall.result.content === 'string'
                    ? toolCall.result.content.slice(0, 4000)
                    : JSON.stringify(toolCall.result.content, null, 2)?.slice(0, 4000)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </ToolCallWithRetry>
  );
}

// TASK_TOOL_NAMES / rebuildTodosFromTaskCalls 已抽到 ../utils/todos.js,
// 与 App.jsx 的 currentTodos 共用同一份重建算法(BK-8a)。

// 任务清单渲染器(TodoListCard)已移除:清单统一只在输入框上方的常驻面板
// (App.jsx currentTodos → TodoPanel)显示,对话流内不再内联,避免一份清单两处重复。

// ─── Tool Calls Group (collapsed by category) ─────────────────
function ToolCallsGroup({ toolCalls, onRetryTool }) {
  const [expanded, setExpanded] = useState(false);

  // Group by category. U9a:Task/Agent 按名字强制归入 agent 组(其 category
  // 兜底是 'call',单看 category 分不出子代理)。
  const groups = { agent: [], skill: [], write: [], call: [] };
  for (const tc of toolCalls) {
    const cat = (tc.name === 'Task' || tc.name === 'Agent') ? 'agent' : (tc.category || 'call');
    (groups[cat] || (groups.call)).push(tc);
  }

  const totalCalls = toolCalls.length;
  // 排除已答的 AskUserQuestion:CLI 写 isError=true 是 headless reject 副作用,
  // 用户实际通过 GUI picker 提交了答案,不算错误(Bug #3)。
  const errorCount = toolCalls.filter((tc) => tc.result?.isError && !isAskAnswered(tc) && !isPlanApproved(tc)).length;

  // Build summary line
  const summaryParts = [];
  for (const [cat, items] of Object.entries(groups)) {
    if (items.length > 0) {
      const cfg = CATEGORY_CONFIG[cat];
      summaryParts.push(`${items.length} ${cfg.label}`);
    }
  }

  // 同 TodoListCard:不自带 fade-up,避免固化重挂时重放入场动画导致闪烁。
  return (
    <div className="border-l-2 border-canvas-deep/40">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 pl-3 pr-3 py-1.5 hover:bg-canvas-warm/40 rounded-r-md transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown size={13} className="text-ink-faint shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-ink-faint shrink-0" />
        )}
        <Wrench size={13} className="text-ink-muted shrink-0" />
        <span className="text-xs text-ink-soft font-body">
          {totalCalls} 次工具调用
        </span>
        <span className="text-[10px] text-ink-faint font-mono">
          ({summaryParts.join(', ')})
        </span>
        {groups.agent.length > 0 && (
          <span className="text-[10px] text-violet-700 bg-violet-50 border border-violet-200 rounded px-1.5 py-px font-mono flex items-center gap-1 shrink-0">
            <Bot size={10} /> 含 {groups.agent.length} 个子代理调用
          </span>
        )}
        {errorCount > 0 && (
          <span className="text-[10px] text-error ml-auto">{errorCount} 错误</span>
        )}
      </button>

      {/* Expanded: show all tool calls grouped by category */}
      {expanded && (
        <div className="pl-3 pr-2 pt-1 pb-2 space-y-3 animate-fade-in">
          {Object.entries(groups).map(([cat, items]) => {
            if (items.length === 0) return null;
            const cfg = CATEGORY_CONFIG[cat];
            const CatIcon = cfg.icon;
            return (
              <div key={cat}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <CatIcon size={11} className={cfg.color} />
                  <span className={`text-[10px] font-medium ${cfg.color}`}>
                    {cfg.label} ({items.length})
                  </span>
                </div>
                <div className="space-y-1">
                  {items.map((tc, i) => {
                    // Use the rich specialty card (BashCard/EditDiffCard/...)
                    // when one exists — each is independently collapsible.
                    // Falls back to generic ToolCallRow for unknown tools.
                    const rich = renderRichToolCard(tc);
                    return rich
                      ? (
                        <ToolCallWithRetry key={tc.id || i} toolCall={tc} onRetryTool={onRetryTool}>
                          {rich}
                        </ToolCallWithRetry>
                      )
                      : <ToolCallRow key={tc.id || i} toolCall={tc} onRetryTool={onRetryTool} />;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Cowork WorkGroup (一段正文之前的思考+工具打包折叠)──────────
// 折叠内部按时序混排:思考段折成一行(ThinkingFold,与工具行同规则默认收起),工具卡
// 复用 renderRichToolCard/ToolCallRow。活跃段默认展开随流刷新,正文落地后收起。
function WorkGroup({ items, expanded, onToggle, onRetryTool }) {
  const toolN = items.reduce((n, b) => n + (b.type === 'tool_use' ? 1 : 0), 0);
  const hasThinking = items.some((b) => b.type === 'thinking');
  const parts = [];
  if (hasThinking) parts.push('思考');
  if (toolN > 0) parts.push(`${toolN} 次工具调用`);
  const summary = parts.join(' · ') || '工作过程';
  return (
    <div className="border-l-2 border-canvas-deep/40">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 pl-3 pr-3 py-1.5 hover:bg-canvas-warm/40 rounded-r-md transition-colors text-left"
      >
        {expanded
          ? <ChevronDown size={13} className="text-ink-faint shrink-0" />
          : <ChevronRight size={13} className="text-ink-faint shrink-0" />}
        {hasThinking
          ? <Brain size={13} className="text-ink-muted shrink-0" />
          : <Wrench size={13} className="text-ink-muted shrink-0" />}
        <span className="text-xs text-ink-soft font-body">{summary}</span>
      </button>
      {expanded && (
        <div className="pl-3 pr-2 pt-1 pb-2 space-y-2 animate-fade-in">
          {items.map((b, i) => {
            // 思考链与工具行一致:默认折叠一行,点击展开(用户要求)。
            if (b.type === 'thinking') return <ThinkingFold key={`th-${i}`} content={b.content} />;
            const tc = b.toolCall;
            const rich = renderRichToolCard(tc);
            return rich
              ? <ToolCallWithRetry key={tc.id || `t-${i}`} toolCall={tc} onRetryTool={onRetryTool}>{rich}</ToolCallWithRetry>
              : <ToolCallRow key={tc.id || `t-${i}`} toolCall={tc} onRetryTool={onRetryTool} />;
          })}
        </div>
      )}
    </div>
  );
}

// 思考链折叠(自管展开态,WKWebView <summary> 坑规避)。与工具行同规则:默认折叠成
// 一行(Chevron + Brain + 首句截断),点击展开/收起,展开态 max-h-64 内滚。流式在飞的
// 思考走的也是这里(streamingBlocks → CoworkBlocks),同样默认折叠,折叠头 label 随内容更新。
// 展开态放在这个叶子组件内部而非父级:父级不因某块展开而整树重渲,也不会给上层
// React.memo(MessageList / TurnBubble) 传新身份 prop 打穿记忆化。
function ThinkingFold({ content }) {
  const [open, setOpen] = useState(false);
  // 第三方 provider 落盘非标准 thinking 块时 content 可能是对象,直接渲染会白屏(判官 B#5)。
  // 守卫收在组件内 = 两个渲染点(WorkGroup / 聊天模式)一次覆盖。
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink-muted cursor-pointer font-body w-full text-left"
      >
        <ChevronRight size={11} className={`transition-transform shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Brain size={12} className="shrink-0" />
        <span className="truncate">{thinkingLabel(text)}</span>
      </button>
      {open && (
        <div className="thinking-block mt-2 p-4 rounded-lg text-xs text-ink-muted whitespace-pre-wrap max-h-64 overflow-y-auto font-body leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}

// ─── 条带折叠(2026-09-13)──────────────────────────────────────
// 一轮问答 = 一条条带:可折段(kind==='group')收起时只留一行摘要,正文段与
// task/workflow/skill/skilldoc 段恒显不折(R114:工作流/子代理跑到哪一步必须看得见)。
// 用 context 而不是新 prop —— 红线 I2「既有导出签名零改动」:CoworkBlocks 的 props 是它
// 对外签名的一部分,加参数即改签名;context 是既有代码里反复使用的旁路(TaskOwnerContext…)。
export const StripRoundContext = React.createContext({ forceOpen: false, headless: false, summary: null });
export const StripAutoContext = React.createContext(false);      // true = 本轮异常收尾/整轮展开
export const StripHeadlessContext = React.createContext(false);  // true = 不渲染摘要行(⚡并入的非首段)
export const StripSummaryContext = React.createContext(null);    // 整轮摘要覆盖(⚡在途,首段用)
export const StripUsageCallsContext = React.createContext(null); // 本轮 usageCalls(直播期恒 null)

// ─── CoworkBlocks:母会话 + 子代理共用的有序 blocks 渲染(单一渲染路径)──
// 非聊天模式 → cowork 分组折叠(WorkGroup);聊天模式 → 维持现状(思考小折叠 +
// 工具折成"执行了 N 步操作"一行)。Task/Skill/技能文档独立成段(折叠外醒目渲染)。
// 折叠展开态 = 用户手动覆盖 ?? 是否活跃段(活跃段随流实时展开,正文落地自动收起)。
export function CoworkBlocks({
  blocks, isLive = false, onRetryTool,
  dockKeyPrefix = 'blocks', trailing = null,
  chatMode = false, chatExpanded = false, chatFoldBar = null, chatUnfoldBar = null,
}) {
  const [override, setOverride] = useState(() => new Map());       // group key → 用户设定展开态
  // 条带整体开合态(null = 跟随自动态)。组件局部、不持久、不上提:口径 6「不记忆」——
  // 换会话/重开面板/换 worktree 绑定都会卸载本组件,自然回到默认态。
  const [stripOpen, setStripOpen] = useState(null);
  // 工作流卡片的归属会话(与 TaskCard 同一把:fork 复制出的卡片共享 tool_use.id)。
  const ownerSid = useContext(TaskOwnerContext);
  // 条带的三项输入(全是旁路 context,不改 props):
  const stripAutoCtx = useContext(StripAutoContext);
  const stripHeadless = useContext(StripHeadlessContext);
  const injectedSummary = useContext(StripSummaryContext);
  const usageCalls = useContext(StripUsageCallsContext);
  // 点开工作流内层助手:卡片只负责水合并回调,落到哪个窗格由这里定(与 TaskCard 的
  // openAgentView 同款,取渲染所在/焦点 pane)——卡片自己读 activeTabIndex 会分屏串扰。
  const openWfAgent = (key) => { const st = useStore.getState(); st.setViewingAgent(st.activeTabIndex, key); };
  // 思考小折叠的展开态归 ThinkingFold 自己管(叶子 state),这里不再持有 —— 展开一块
  // 不必重渲整个 CoworkBlocks 子树。
  const list = Array.isArray(blocks) ? blocks : [];

  // 聊天模式:维持现状 —— 思考小折叠 + 工具折成"执行了 N 步操作"一行,不做 cowork 分组
  // (按原始 block 顺序逐块渲染,保持思考/工具的交错顺序,不重排)。
  if (chatMode) {
    const out = [];
    let bucket = [];
    let hiddenTools = 0;
    const flushBucket = (keyHint) => {
      if (bucket.length > 0) { out.push(<ToolCallsGroup key={`bucket-${keyHint}`} toolCalls={bucket} onRetryTool={onRetryTool} />); bucket = []; }
    };
    list.forEach((b, i) => {
      if (b.type === 'text' && b.content) {
        flushBucket(i);
        out.push(<MarkdownRenderer key={`b-${i}`} content={b.content} dockKeyPrefix={`${dockKeyPrefix}:${i}`} isStreaming={isLive} />);
        return;
      }
      // 未展开:收起工具/子代理/skill(思考照常显示,清单不计)。工作流不在此列 ——
      // 见 WORKFLOW_TOOL 的注释,折起来就等于看不到它跑到哪一阶段。
      if (!chatExpanded && b.type === 'tool_use' && b.toolCall && b.toolCall.name !== WORKFLOW_TOOL) {
        if (!TASK_TOOL_NAMES.has(b.toolCall.name)) hiddenTools++;
        return;
      }
      if (b.type === 'thinking' && b.content) {
        flushBucket(i);
        out.push(<ThinkingFold key={`b-${i}`} content={b.content} />);
        return;
      }
      if (b.type === 'tool_use' && b.toolCall) {
        if (TASK_TOOL_NAMES.has(b.toolCall.name)) { flushBucket(i); return; }
        if (b.toolCall.name === 'Skill') {
          const skillOf = (tc) => tc?.input?.skill || tc?.input?.name || tc?.name;
          const sameSkill = (blk) => blk?.type === 'tool_use' && blk.toolCall?.name === 'Skill' && skillOf(blk.toolCall) === skillOf(b.toolCall);
          if (sameSkill(list[i - 1])) return;
          const calls = [b.toolCall];
          for (let j = i + 1; j < list.length && sameSkill(list[j]); j++) calls.push(list[j].toolCall);
          flushBucket(i);
          const latest = calls[calls.length - 1];
          out.push(<ToolCallWithRetry key={`b-${i}`} toolCall={latest} onRetryTool={onRetryTool} hoverOnly><SkillCard toolCall={latest} calls={calls} /></ToolCallWithRetry>);
          return;
        }
        const skillDocName = getSkillDocReadName(b.toolCall);
        if (skillDocName) {
          flushBucket(i);
          out.push(<ToolCallWithRetry key={`b-${i}`} toolCall={b.toolCall} onRetryTool={onRetryTool} hoverOnly><SkillCard toolCall={b.toolCall} nameOverride={skillDocName} subLabel="读取技能文档" /></ToolCallWithRetry>);
          return;
        }
        if (b.toolCall.name === WORKFLOW_TOOL) {
          flushBucket(i);
          out.push(<WorkflowCard key={`b-${i}`} toolUseId={b.toolCall.id} ownerSessionId={ownerSid} toolCall={b.toolCall} onOpenAgent={openWfAgent} />);
          return;
        }
        if (b.toolCall.name === 'Task' || b.toolCall.name === 'Agent') {
          flushBucket(i);
          out.push(<ToolCallWithRetry key={`b-${i}`} toolCall={b.toolCall} onRetryTool={onRetryTool} hoverOnly><TaskCard toolCall={b.toolCall} /></ToolCallWithRetry>);
          return;
        }
        bucket.push(b.toolCall);
      }
    });
    flushBucket('end');
    if (!chatExpanded && hiddenTools > 0 && chatFoldBar) out.push(chatFoldBar(`执行了 ${hiddenTools} 步操作`));
    if (chatExpanded && chatUnfoldBar && list.some((b) => b.type === 'tool_use' && b.toolCall && !TASK_TOOL_NAMES.has(b.toolCall.name))) out.push(chatUnfoldBar);
    // 聊天模式不做条带(那条路径自己就把整轮过程折成一行「执行了 N 步操作」),
    // 根上仍带 data-strip-root + state=off —— 便于区分"这条路径不走条带"与"渲染坏了"。
    return <div data-strip-root data-strip-state="off" className="space-y-2">{out}{trailing}</div>;
  }

  // 非聊天模式:cowork 分组折叠。每段正文前连续的思考+通用工具打包成一个 WorkGroup。
  const segments = groupCoworkBlocks(list);
  const activeKey = activeGroupKey(segments, isLive);
  // 条带(§3.1/D.1):原 div.space-y-2 变成条带根,第一个子元素是摘要行,之后每个段包一层
  // 带 data-strip-item 的 div(唯一新增的包装层,所有段都包,便于测试数数目)。
  // 收起 = **只给可折段(group)带 hidden**(保留 DOM,只不参与布局);正文段与
  // task/workflow/skill/skilldoc 段任何状态下都不带。段序 = groupCoworkBlocks 的输出序,一个不重排。
  // 摘要优先用上层注入的**整轮**数值(⚡并入切段时头行只画在首段,账要按整轮算)。
  const summary = injectedSummary || stripSummary(list, usageCalls);
  const hasFold = summary.steps > 0;
  const open = stripOpen === null ? stripAutoCtx || isLive : stripOpen;
  const headText = [
    '思考与工具调用',
    summary.rounds == null ? `${summary.steps} 步` : `${summary.rounds} 轮 ${summary.steps} 步`,
    ...(summary.tail ? [summary.tail] : []),
  ].join(' · ');
  const out = segments.map((seg) => {
    const foldable = isFoldableSegment(seg);
    const body = (() => {
      switch (seg.kind) {
        case 'text':
          return <MarkdownRenderer content={seg.content} dockKeyPrefix={`${dockKeyPrefix}:${seg.index}`} isStreaming={isLive} />;
        case 'task':
          return (
            <ToolCallWithRetry toolCall={seg.toolCall} onRetryTool={onRetryTool} hoverOnly>
              <TaskCard toolCall={seg.toolCall} />
            </ToolCallWithRetry>
          );
        case 'workflow':
          return (
            <WorkflowCard toolUseId={seg.toolCall.id} ownerSessionId={ownerSid}
              toolCall={seg.toolCall} onOpenAgent={openWfAgent} />
          );
        case 'skill': {
          const latest = seg.calls[seg.calls.length - 1];
          return (
            <ToolCallWithRetry toolCall={latest} onRetryTool={onRetryTool} hoverOnly>
              <SkillCard toolCall={latest} calls={seg.calls} />
            </ToolCallWithRetry>
          );
        }
        case 'skilldoc':
          return (
            <ToolCallWithRetry toolCall={seg.toolCall} onRetryTool={onRetryTool} hoverOnly>
              <SkillCard toolCall={seg.toolCall} nameOverride={seg.name} subLabel="读取技能文档" />
            </ToolCallWithRetry>
          );
        case 'group': {
          const expanded = override.has(seg.key) ? override.get(seg.key) : (seg.key === activeKey);
          return (
            <WorkGroup
              items={seg.items}
              expanded={expanded}
              onToggle={() => setOverride((p) => { const n = new Map(p); n.set(seg.key, !expanded); return n; })}
              onRetryTool={onRetryTool}
            />
          );
        }
        default:
          return null;
      }
    })();
    return (
      <div key={`seg-${seg.key}`} data-strip-item={seg.kind} hidden={(foldable && !open) || undefined}>
        {body}
      </div>
    );
  });

  return (
    <div
      data-strip-root
      data-strip-state={hasFold ? (open ? 'open' : 'closed') : 'none'}
      // 无 usageCalls 时写空串(而不是不写属性):"有属性但为空"与"没这功能"要能区分。
      data-strip-rounds={summary.rounds == null ? '' : String(summary.rounds)}
      data-strip-steps={String(summary.steps)}
      className="space-y-2"
    >
      {/* 摘要行恒为内容区第一个子元素(不搬家:流式期与收官后都在这个位置)。 */}
      {hasFold && !stripHeadless && (
        <button
          type="button"
          data-strip="head"
          aria-expanded={open ? 'true' : 'false'}
          title="展开/收起这一轮的过程"
          onClick={() => setStripOpen(!open)}
          className="w-full flex items-center gap-2 pl-3 pr-3 py-1.5 border-l-2 border-canvas-deep/40 hover:bg-canvas-warm/40 rounded-r-md transition-colors text-left"
        >
          {open
            ? <ChevronDown size={13} className="text-ink-faint shrink-0" />
            : <ChevronRight size={13} className="text-ink-faint shrink-0" />}
          <Wrench size={13} className="text-ink-muted shrink-0" />
          <span className="text-xs text-ink-soft font-body truncate min-w-0">{headText}</span>
        </button>
      )}
      {out}{trailing}
    </div>
  );
}

// ─── Usage Display ─────────────────────────────────────────────
function UsageDisplay({ message }) {
  // hook 必须无条件调用:移到 early return 之前(原在 if(!usage)return 之后=条件调用 hook,
  // usage 有无切换时 hooks 数量变→React 崩;ESLint rules-of-hooks 抓出的真隐患)。
  const provider = useStore((s) => s.currentProvider);
  const usage = message?.usage;
  if (!usage) return null;
  const model = message.model;
  const costUsd = message.costUsd;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  // 计费唯一入口:带 message 是为了 usageCalls(逐次 API 调用各自的时刻)—— 分时段价的
  // 模型必须按每次调用自己的时间戳判档,汇总后的 usage 拆不回"哪一段在什么时刻"。
  const cost = computeCostForMessage(message, provider);
  const unavailable = cost ? null : costUnavailableReason(model, usage, provider, { at: message.timestamp });
  // Z1:CLI result 事件的 total_cost_usd 是官方计费口径的权威成本,优先于单价表
  // 估算。第三方 provider 下 CLI 仍按 Claude 价目计算(模型名是伪装的),不可信。
  const official = !provider || (provider.providerHint || 'anthropic') === 'anthropic';
  // 套餐包月(Claude 订阅 / Kimi Code)下,CLI 上报的 total_cost_usd 是"按 API 单价这轮
  // 值多少钱",不是用户的账单 → 不显示(computeCost 已返回 null,这条走的是另一条路)。
  // 判据必须带 model:订阅态下跑按量付费模型的回合是真花钱的,不能一起藏。
  // R3:用户为这个模型填了实付单价 → 他的单价赢过 CLI 的 total_cost_usd。CLI 那个数字
  // 是按 Anthropic 官网价目算的"这轮值多少钱",用户填的才是他实付的。
  const authoritative = official && !isPlanBilling(provider, model)
    && cost?.source !== 'user'
    && typeof costUsd === 'number' && costUsd > 0;
  // R43(用户实报「token 明细过于技术化」):行内只留 输入 / 输出 / 金额,四项明细
  // (缓存命中 / 缓存写入 / 本轮累计读取 / 整轮命中率)收进本行容器的悬停提示。
  // 悬停必须挂在本行容器上(即金额的直接父容器):计价套件按「金额的直接父容器」定位轮末
  // 费用位,多包一层容器、或把 title 挂到更外层,都会让它失准。
  // 「本轮累计读取」(旧名会让人误以为"我的上下文有 6 万 token")= 输入 + 缓存命中 + 缓存写入,
  // 是这一轮所有底层 API 调用提示侧 token 之和 —— 一轮里模型每调一次 API 都要重读整段上下文,
  // 累加自然大于单次窗口。数值口径与旧名时期一字未改,只是不再占据行内版面。
  return (
    <div
      data-cgui="usage-line"
      data-usage-scope="turn"
      title={`缓存命中 ${cacheRead.toLocaleString()} · 缓存写入 ${cacheWrite.toLocaleString()}\n本轮累计读取 ${(input + cacheRead + cacheWrite).toLocaleString()}（= 输入 ${input.toLocaleString()} + 缓存命中 ${cacheRead.toLocaleString()} + 缓存写入 ${cacheWrite.toLocaleString()}；一轮里模型每次调用 API 都要重读整段上下文，累计读取量会大于单次上下文大小）\n整轮命中率 ${cacheRead + cacheWrite + input > 0 ? formatHitPct(cacheHitPct(cacheRead, cacheWrite, input)) : '—'}（= 整轮 cache_read /（普通 input + cache_read + cache_creation），整轮所有 API 调用累计加权；切模型或进程冷启的那一轮偏低属正常。分母 0 显示 —）`}
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-faint mt-2 pt-2 border-t border-canvas-deep/50"
    >
      <span title="input_tokens — 仅指未命中缓存的新 token(Anthropic 计费口径),不是全部输入">输入 {input.toLocaleString()}</span>
      <span>输出 {output.toLocaleString()}</span>
      {/* R24 轮末徽章:这里是【整轮】口径(整轮所有 API 调用累计),名字必须叫「整轮命中率」;
          顶部标题行那条单次调用口径叫「最近API命中率」,会话累计在用量面板 —— 三处不得混用。
          R43:整段(名字 + 加权累计公式 + 分母守卫 + 0 分母回退)原样搬进行容器悬停,一字未改;
          分母(普通 input + read + creation)为 0 时仍显示「—」,不显示 0.0%。 */}
      {Array.isArray(usage.ccgui_usage?.codes) && usage.ccgui_usage.codes.length > 0 && (
        <span className="text-error" title="上游回报的用量字段无效或自相矛盾，数字原样保留、费用按未知处理">
          {usage.ccgui_usage.codes.join(' / ')}
        </span>
      )}
      {/* R24 费用展示:来源(用户手填单价 / 按官网价估算 / 官方计费口径)与费用必居其一,拿不到价
          (官方价目里查不到该型号,也不做最长前缀近似)时如实写「未定价」,不显示 0 总价。
          R42:来源词不再占行内版面(窄面板下它把这条行撑换行),改为金额 title 的**首行**(悬停可见)。
          「已知小计」说明仍留在行内 —— 它是"钱没算全"的声明,收起来等于把部分金额当成完整金额。 */}
      {(authoritative || cost) ? (
        <>
          {/* R42:ml-auto 原挂在被删的来源 span 上 —— 迁到金额自己身上(不再包一层容器:
              包了会让金额的父元素从行容器变成容器,"轮末费用位"这类按父元素文本定位的
              既有探针会失准,且金额与「已知小计」说明本来就该贴着)。 */}
          <span
            data-cgui="usage-amount"
            className="ml-auto text-accent/80 font-mono"
            // R3:非 authoritative 分支的说明文案由 pricing.js 统一给(三个费用显示点共用),
            // 用户填过单价时如实说明是按他填写的单价算,不再说"按官网价估算"。
            // R42:title 首行 = 来源词(官方计费口径 或 costSourceLabel),第二行起为原有说明。
            title={
              authoritative
                ? `官方计费口径\nCLI 上报的本轮实际成本（total_cost_usd，官方计费口径；美元计价模型按 1 USD ≈ 7.2 CNY 换算，人民币计价模型为原生定价）`
                : `${costSourceLabel(cost)}\n${costTitle(cost)}`
            }
          >
            {formatCost(authoritative ? costUsd : displayUsd(cost.totalUsd, cost.currency))}
          </span>
          {cost && costUnknownNote(cost) && (
            <span className="text-[9px] text-ink-ghost" title="上面金额是已知小计，不含被判定为未知的那部分费用">
              {costUnknownNote(cost)}
            </span>
          )}
        </>
      ) : (
        !usage.ccgui_usage?.codes?.length && unavailable && (
          <span className="ml-auto text-[9px] text-ink-ghost" title={`${unavailable.detail}（费用未知，不显示 0）`}>
            {COST_REASON_TEXT[unavailable.reason] || COST_REASON_TEXT.NO_PRICE}
          </span>
        )
      )}
    </div>
  );
}

// ─── Turn Bubble ───────────────────────────────────────────────
// Memoized: a long session renders dozens of these (each with markdown + many
// tool-call rows). Without memo, every streaming token / dropdown toggle /
// unrelated state change re-renders ALL of them, saturating the main thread and
// making the whole UI (provider & model menus included) feel laggy. `turn` comes
// from the persisted `messages` array which is referentially stable while a NEW
// turn streams into separate state, so memo lets the old turns skip re-render.
function TurnBubbleInner({ turn, onRetry, onRetryTool, onFork, retryActive }) {
  const [showThinking, setShowThinking] = useState(false);
  const chatMode = useStore((s) => s.chatMode);
  const [chatExpanded, setChatExpanded] = useState(false);
  // A 项:子代理逐条计价的 provider —— 与 UsageDisplay 取的是同一个 store 字段。
  const provider = useStore((s) => s.currentProvider);
  // 条带:本会话的异常收尾记录(按 sessionId 取,不按 uuid)。选择器返回**记录的引用**,
  // 没写过时引用不变 → 同会话其它轮写入那一次之外不触发本行重渲染。
  const roundStripRec = useStore((s) => (turn.sessionId ? s.roundStrip?.[turn.sessionId] : null));
  const round = useContext(StripRoundContext);

  // 长回复(气泡高过所在窗格可视区)在气泡末尾补一个复制按钮 —— 看到末尾时顶部那个
  // 已经滚出视野。判据只比高度不追滚动位置(shouldShowBottomCopy 单测)。
  // 一个 ResizeObserver 同时盯气泡和容器:容器那份把分屏切换/窗口缩放一并覆盖,
  // 不用另挂 window.resize + 防抖。状态是本气泡的叶子 state,不外传、不引发全列表重渲。
  const bubbleRef = useRef(null);
  const [showBottomCopy, setShowBottomCopy] = useState(false);
  useEffect(() => {
    const el = bubbleRef.current;
    // ponytail: 找不到滚动容器(非聊天流宿主)就不判、不显示 —— 拿 window 高度当容器
    // 高度在分屏下必然判错,宁可少一个按钮。
    const scroller = el?.closest?.('[data-chat-scroll]');
    if (!el || !scroller || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const next = shouldShowBottomCopy({ bubbleH: el.offsetHeight, viewH: scroller.clientHeight });
      setShowBottomCopy((prev) => (prev === next ? prev : next));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(scroller);
    measure();
    return () => ro.disconnect();
  }, []);
  // 聊天模式:未展开时把思考/工具/子代理/skill 折叠成一行"思考并执行了 N 步操作 ›",
  // 点开还原完整过程;展开后给一行"收起过程"。两条在有序 blocks 与 legacy 路径共用。
  const chatFoldBar = (label) => (
    <button key="chat-fold" onClick={() => setChatExpanded(true)}
      className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink-muted cursor-pointer font-body mt-1">
      <ChevronRight size={11} /><span>{label}</span>
    </button>
  );
  const chatUnfoldBar = (
    <button key="chat-unfold" onClick={() => setChatExpanded(false)}
      className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink-muted cursor-pointer font-body mt-1">
      <ChevronDown size={11} /><span>收起过程</span>
    </button>
  );

  // Historical turns loaded from .jsonl may have these fields absent or as a
  // bare string instead of an array — guard so .join() never throws.
  const fullText = Array.isArray(turn.text) ? turn.text.join('\n') : (turn.text || '');
  const fullThinking = Array.isArray(turn.thinking) ? turn.thinking.join('\n') : (turn.thinking || '');

  // NEW canonical render path: if `turn.blocks` is present, render content
  // strictly in the order Claude emitted it (text → tool → text → tool → write).
  // This is what makes the UI match the CLI: a "thinking" segment, then a Bash
  // call+result, then more reasoning text, then an Edit, then summary text.
  const hasOrderedBlocks = Array.isArray(turn.blocks) && turn.blocks.length > 0;

  // Legacy bucket path (kept for historical messages loaded from .jsonl which
  // don't have a blocks array — they get the old grouped-by-type layout).
  let toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
  // "重做此工具"乐观截断在无 blocks 的旧 turn 上也要生效:把 toolCalls 裁到被点
  // 工具之前(persisted turn 一般都有 blocks 走上面的路径,这里是兜底)。
  let legacyShowRetrying = false;
  if (turn._retryTrimToolId && !hasOrderedBlocks) {
    const ci = toolCalls.findIndex((tc) => tc.id === turn._retryTrimToolId);
    if (ci >= 0) { toolCalls = toolCalls.slice(0, ci); legacyShowRetrying = true; }
  }
  // 任务清单(TodoWrite 或 TaskCreate/TaskUpdate)聚合成一份,挂在最后一个任务工具上。
  const taskCalls = toolCalls.filter((tc) => TASK_TOOL_NAMES.has(tc.name));
  const rebuiltTodos = rebuildTodosFromTaskCalls(taskCalls);
  // latestTodo 现仅用于 isStreaming 判定(本 turn 是否已有任务清单内容),不再内联渲染。
  const latestTodo = rebuiltTodos && rebuiltTodos.length > 0 ? rebuiltTodos : null;
  const inlineCalls = toolCalls.filter((tc) => INLINE_TOOL_NAMES.has(tc.name));
  const groupedCalls = toolCalls.filter(
    (tc) => !TASK_TOOL_NAMES.has(tc.name) && !INLINE_TOOL_NAMES.has(tc.name)
  );
  const hasInlineCalls = inlineCalls.length > 0;
  const hasGroupedCalls = groupedCalls.length > 0;
  const isStreaming = !fullText && !fullThinking && !latestTodo && !hasInlineCalls && !hasGroupedCalls && !hasOrderedBlocks;

  // turn.uuid === 'streaming' is App.jsx's signal that this turn is still being
  // produced — spin the avatar mark to mirror the CLI's rotating progress glyph.
  const isLiveStream = turn.uuid === 'streaming';
  // 条带默认态(真值表见 INTERFACE §E):四项输入缺一不可 —— 流式中 / 本地停止副本
  // (`chat-stopped-*` 的 interrupted,哨兵 uuid 不查表,靠数据里现成字段兜)/
  // 本地报错副本的 errorAction / 落盘后的异常窗口记录。**没有**"空闲态"这类触发点:
  // 收起是默认值,不是事件(坑 2)。
  const stripAuto = !!round.forceOpen || isLiveStream || !!turn.interrupted
    || roundStripEnd(roundStripRec, turn.sessionId, turn.timestamp) != null
    || !!turn.errorAction;
  // A 项:本回合子代理金额的两个索引(toolUseId / agentId),供卡片各自取自己那份。
  // 数据来源两份,同一形状(都是 subUsage.agents[]):①读 jsonl 历史时服务端挂的;
  // ②本地副本('streaming*' / 'chat-*',App.jsx 拼的)由"子代理完成即推"的条目现拼
  // (liveSubUsage,2026-09-13 补齐)。history=false 只压"未能计价"小标 —— 那个占位
  // 对还在跑的子代理是误导文案;有金额的(priced>0)照样画。
  const subagentCost = useMemo(
    () => buildSubagentCostIndex(turn.subUsage?.agents, provider),
    [turn.subUsage, provider],
  );
  const subagentCostHistory = !/^(streaming|chat-)/.test(turn.uuid || '');
  // provider 引用变化(切 provider)会重算索引,故把 context 值也钉成稳定身份:
  // 上下文一变,树内所有卡片(含 React.memo 的 WorkflowCard)都会跟着重渲,
  // 流式期间每来一个 token 重渲一遍整批卡片正是历史上卡顿的老路。
  const subagentCostValue = useMemo(
    () => ({ index: subagentCost, history: subagentCostHistory }),
    [subagentCost, subagentCostHistory],
  );

  return (
    // 本回合的会话归属(session-reader 给每条历史 turn 打的 record.sessionId)供给
    // 树内所有 TaskCard:分支(fork)复制出的卡片与源会话共用 tool_use.id,没有这个值
    // 就会取到源会话正在跑的 agent(显示运行中 + 停错会话)。流式的本地 turn 没有
    // sessionId 字段 → null → 完全走原逻辑。
    <TaskOwnerContext.Provider value={turn.sessionId || null}>
    <SubagentCostContext.Provider value={subagentCostValue}>
    {/* 入场动画只给"正在流式"的临时 turn 播放。回复完成后这条会从 streaming(key=
        'streaming') 切到 chatMessages(key='chat-assistant-…') 再切到 jsonl(真 uuid),
        三次换 key → React 反复卸载重挂 TurnBubble。若固化后的 turn 仍带 animate-fade-up,
        每次重挂都会重放淡入 → 用户看到"回复完成后闪烁一下再显示"。固化 turn 去掉动画即可。 */}
    <div ref={bubbleRef} className={`group px-6 py-4 ${isLiveStream ? 'animate-fade-up' : ''}`} style={isLiveStream ? { animationDuration: '0.25s' } : undefined}>
      <div className="max-w-[var(--content-max)] mx-auto flex items-start gap-4">
        {/* Avatar — tinted by the actual provider behind the model.
            无 mt + 标题行 min-h-[34px] items-center → 头像与「Claude …」标题行等高、
            垂直中线对齐(与流式 Connecting 头像位一致),不再偏下(用户报图4错位)。 */}
        <ProviderAvatar model={turn.model} size={34} thinking={isLiveStream} />

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-2 mb-1.5 min-h-[34px]">
            <AssistantName model={turn.model} />
            {turn.model && <ModelBadge model={turn.model} compact />}
            <span className="text-[11px] text-ink-faint font-mono">{formatTime(turn.timestamp)}</span>
            <div className="flex-1" />
            {onRetry && !isLiveStream && turn.uuid !== 'streaming' && (
              // Bug #6:重做这一轮回复。AI 模型本身随机,重做不保证调同一组工具 —
              // 这是"让 AI 基于同一 prompt 重新生成,可能重选工具/重选实现"的功能。
              // 一键 = trim 到这条 turn 之前的 user message + resend 它(复用 handleRollback)。
              <button
                onClick={() => onRetry(turn)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-ink-faint hover:text-accent hover:bg-canvas-warm transition-colors"
                title="回滚到这条 AI 回复之前,让 AI 重新生成(包括重新调工具)"
              >
                <RotateCcw size={11} />
                <span className="hidden md:inline">重做</span>
              </button>
            )}
            <CopyButton text={fullText} />
            {onFork && (
              <button
                onClick={() => onFork(turn.uuid)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-ink-faint hover:text-accent hover:bg-canvas-warm transition-colors"
                title="从这条回复分叉出一条新线(只保留到此为止的上下文,丢弃其后对话,原会话不动)"
              >
                <GitBranch size={11} />
                <span className="hidden md:inline">分叉</span>
              </button>
            )}
          </div>

          {/* 聊天模式:把 AI 内容套进左对齐白气泡(bg-canvas-warm,微信主题下=白,左上角小圆角
              贴头像);非聊天模式用 display:contents 让 wrapper 透明,完全维持原文档流布局。 */}
          <div className={chatMode ? 'chat-ai-bubble inline-block align-top max-w-[85%] overflow-hidden bg-canvas-warm border border-canvas-deep rounded-panel rounded-tl-md px-3.5 py-2 [&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0' : 'contents'}>
          {/* Primary render path — preserves chronological order.
              We fold every RUN of consecutive tool_use blocks into a single
              ToolCallsGroup so the layout reads as: text → [round 1 tools] →
              text → [round 2 tools] → … instead of one card per tool. The
              user can expand the round bar to see each tool's collapsed card,
              then expand individual cards for details. */}
          {hasOrderedBlocks ? (() => {
            // "重做此工具"乐观回退:截断到被点工具调用之前,该工具及之后不再渲染,
            // 并在原位显示"正在重做此工具…"。服务端 trim+refetch 后此标记消失。
            const trimId = turn._retryTrimToolId;
            let renderBlocks = turn.blocks;
            let showRetrying = false;
            if (trimId) {
              const cut = turn.blocks.findIndex((b) => b.type === 'tool_use' && b.toolCall?.id === trimId);
              if (cut >= 0) { renderBlocks = turn.blocks.slice(0, cut); showRetrying = true; }
            }
            const trailing = (showRetrying && retryActive) ? (
              <div key="retrying" className="flex items-center gap-2 text-[12px] text-accent font-body px-1 py-1.5">
                <Loader2 size={12} className="animate-spin" />
                <span>正在重做此工具…</span>
              </div>
            ) : null;
            return (
              <StripAutoContext.Provider value={stripAuto}>
              <StripHeadlessContext.Provider value={!!round.headless}>
              <StripSummaryContext.Provider value={round.summary || null}>
              <StripUsageCallsContext.Provider value={Array.isArray(turn.usageCalls) ? turn.usageCalls : null}>
              <CoworkBlocks
                blocks={renderBlocks}
                isLive={isLiveStream}
                onRetryTool={onRetryTool}
                dockKeyPrefix={turn.uuid}
                trailing={trailing}
                chatMode={chatMode}
                chatExpanded={chatExpanded}
                chatFoldBar={chatFoldBar}
                chatUnfoldBar={chatUnfoldBar}
              />
              </StripUsageCallsContext.Provider>
              </StripSummaryContext.Provider>
              </StripHeadlessContext.Provider>
              </StripAutoContext.Provider>
            );
          })() : (
            <>
              {/* Legacy path for historical messages (no blocks array) */}
              {fullThinking && (
                <div className="mb-3">
                  <button
                    onClick={() => setShowThinking(!showThinking)}
                    className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink-muted transition-colors font-body"
                  >
                    <Brain size={12} className="shrink-0" />
                    <span className="truncate">{thinkingLabel(fullThinking)}</span>
                    <span className="text-[10px] shrink-0">{showThinking ? '▾' : '▸'}</span>
                  </button>
                  {showThinking && (
                    <div className="thinking-block mt-2 p-4 rounded-lg text-xs text-ink-muted whitespace-pre-wrap max-h-64 overflow-y-auto font-body leading-relaxed">
                      {fullThinking}
                    </div>
                  )}
                </div>
              )}
              {fullText && <MarkdownRenderer content={fullText} dockKeyPrefix={turn.uuid} isStreaming={isLiveStream} />}
              {/* 任务清单只走输入框上方常驻面板,legacy 路径同样不再内联渲染(见上)。 */}
              {!(chatMode && !chatExpanded) && hasInlineCalls && (
                <div className="mt-2 space-y-2">
                  {inlineCalls.map((tc, i) => (
                    <InlineToolCard key={tc.id || `inline-${i}`} toolCall={tc} onRetryTool={onRetryTool} />
                  ))}
                </div>
              )}
              {!(chatMode && !chatExpanded) && hasGroupedCalls && (
                <div className="mt-2"><ToolCallsGroup toolCalls={groupedCalls} onRetryTool={onRetryTool} /></div>
              )}
              {/* 聊天模式折叠/收起(legacy 路径,只折工具,思考照常显示) */}
              {chatMode && !chatExpanded && (hasInlineCalls || hasGroupedCalls) &&
                chatFoldBar(`执行了 ${inlineCalls.length + groupedCalls.length} 步操作`)}
              {chatMode && chatExpanded && (hasInlineCalls || hasGroupedCalls) && chatUnfoldBar}
              {legacyShowRetrying && retryActive && (
                <div className="flex items-center gap-2 text-[12px] text-accent font-body px-1 py-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  <span>正在重做此工具…</span>
                </div>
              )}
            </>
          )}
          </div>

          {/* Streaming indicator */}
          {isStreaming && (
            <div className="flex items-center gap-1.5 pt-1">
              <div className="w-2 h-2 rounded-full bg-accent/40" style={{ animation: 'breathe 1.4s ease-in-out infinite' }} />
              <div className="w-2 h-2 rounded-full bg-accent/40" style={{ animation: 'breathe 1.4s ease-in-out infinite 0.2s' }} />
              <div className="w-2 h-2 rounded-full bg-accent/40" style={{ animation: 'breathe 1.4s ease-in-out infinite 0.4s' }} />
            </div>
          )}

          {/* #2 气泡内中文状态行已移除 — 只保留气泡外橙色工作文本(App.jsx StreamingStatusLine,
              claude-code 原生 tool 名/动词 + 前置 spinner),避免同屏两行语义重复。 */}

          {/* Usage */}
          <UsageDisplay message={turn} />
          {/* 末尾右下操作行:长回复补的复制按钮(与顶部同一个 CopyButton)+ 重做这条回复。
              两者共用一行,免得各占一行叠在正文下面。 */}
          {(showBottomCopy || (onRetry && !isLiveStream && turn.uuid !== 'streaming')) && (
            <div className="flex justify-end items-center gap-1 mt-2">
              {showBottomCopy && <CopyButton text={fullText} />}
              {onRetry && !isLiveStream && turn.uuid !== 'streaming' && (
                <button
                  onClick={() => onRetry(turn)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-ink-faint hover:text-accent hover:bg-canvas-warm transition-colors"
                  title="回滚到这条 AI 回复之前，让 AI 重新生成"
                >
                  <RotateCcw size={12} />
                  <span>重做这条回复</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </SubagentCostContext.Provider>
    </TaskOwnerContext.Provider>
  );
}

export const TurnBubble = React.memo(TurnBubbleInner);
