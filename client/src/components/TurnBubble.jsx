import React, { useState } from 'react';
import {
  Brain, Copy, Check, ChevronDown, ChevronRight,
  Wrench, BookOpen, Pencil, Terminal, FileText, Search,
  Globe, Edit3, Loader2, CheckSquare, Square, CircleDot, ListTodo, RotateCcw, Bot
} from 'lucide-react';
import { ModelBadge, ProviderAvatar } from './ModelBadge.jsx';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { BashCard } from './tools/BashCard.jsx';
import { EditDiffCard } from './tools/EditDiffCard.jsx';
import { ReadCard } from './tools/ReadCard.jsx';
import { TaskCard } from './tools/TaskCard.jsx';
import { GrepGlobCard } from './tools/GrepGlobCard.jsx';
import { WebCard } from './tools/WebCard.jsx';
import { SkillCard } from './tools/SkillCard.jsx';
import { computeCost, formatCost } from '../utils/pricing.js';
import { copyText } from '../utils/clipboard.js';
import { useStore } from '../stores/sessionStore.js';

// Tools that get their own bespoke inline card (rendered in chronological order
// inside the turn). Anything not in this set falls through to ToolCallsGroup,
// the generic category-grouped collapsible.
const INLINE_TOOL_NAMES = new Set([
  'Bash', 'Edit', 'MultiEdit', 'Write', 'Read',
  // 'Agent' 与 'Task' 都是子代理派发工具(不同 provider/CLI 命名不同),都走 TaskCard。
  'Task', 'Agent', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Skill',
]);

function ToolCallWithRetry({ toolCall, onRetryTool, children }) {
  return (
    <div className="space-y-1">
      {children}
      {onRetryTool && (
        <div className="flex justify-end">
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
export { InlineToolCard, renderRichToolCard };

// Returns the rich card React element for a tool, or null when no
// specialty renderer exists for that tool name.
function renderRichToolCard(toolCall) {
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

function formatInputPreview(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input.command) return input.command;
  if (input.file_path) return input.file_path.split('/').pop();
  if (input.pattern) return input.pattern;
  if (input.query) return input.query;
  return '';
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
  return (
    <button
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="opacity-0 group-hover:opacity-100 max-md:opacity-60 transition-opacity p-1 hover:bg-canvas-deep rounded"
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

// ─── Single Tool Call Row ──────────────────────────────────────
function ToolCallRow({ toolCall, onRetryTool }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getToolIcon(toolCall.name);
  const askAnswered = isAskAnswered(toolCall);
  const planApproved = isPlanApproved(toolCall);
  const hasError = toolCall.result?.isError && !askAnswered && !planApproved;
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
            ) : planApproved ? (
              <span className="text-[10px] text-success">✅ 计划已批准</span>
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

// ─── TodoWrite renderer ───────────────────────────────────────
// The TodoWrite tool's input is `{ todos: [{ content, status, activeForm }] }`.
// CLI renders it as a checkbox list with status markers; we mirror that here so
// users see the plan rather than a raw JSON dump.
function TodoListCard({ toolCall }) {
  const todos = Array.isArray(toolCall.input?.todos) ? toolCall.input.todos : [];
  if (todos.length === 0) return null;

  // Status counts for the header badge.
  const completed = todos.filter((t) => t.status === 'completed').length;
  const active = todos.filter((t) => t.status === 'in_progress').length;
  const pending = todos.filter((t) => t.status === 'pending').length;

  const statusIcon = (status) => {
    if (status === 'completed') return <CheckSquare size={13} className="text-success shrink-0" />;
    if (status === 'in_progress') return <CircleDot size={13} className="text-accent shrink-0 animate-pulse" />;
    return <Square size={13} className="text-ink-faint shrink-0" />;
  };

  const rowClass = (status) => {
    if (status === 'completed') return 'text-ink-faint line-through';
    if (status === 'in_progress') return 'text-ink font-medium';
    return 'text-ink-soft';
  };

  // 不自带 animate-fade-up:入场淡入由外层 turn 容器(446,仅 isLiveStream 时)统一播。
  // 子块各自带动画会在 turn 固化(streaming→chat-…→真uuid 三次换 key)重挂时重放,
  // 就是"回复完成后闪一下再显示"的来源。
  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden bg-canvas">
      <div className="px-3 py-2 bg-canvas-warm flex items-center gap-2 border-b border-canvas-deep">
        <ListTodo size={13} className="text-accent shrink-0" />
        <span className="text-xs text-ink-soft font-body">任务清单</span>
        <span className="text-[10px] text-ink-faint font-mono">
          {completed}/{todos.length} 完成{active > 0 && ` · ${active} 进行中`}{pending > 0 && ` · ${pending} 待办`}
        </span>
        {!toolCall.result && (
          <Loader2 size={11} className="text-ink-faint animate-spin ml-auto" />
        )}
      </div>
      <ul className="py-1.5">
        {todos.map((todo, i) => {
          // Show activeForm for in_progress items (matches CLI behavior — verb form for the active task)
          const text = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
          return (
            <li key={i} className="px-3 py-1 flex items-start gap-2 text-[12px] font-body leading-snug">
              {statusIcon(todo.status)}
              <span className={rowClass(todo.status)}>{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

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

// ─── Usage Display ─────────────────────────────────────────────
function UsageDisplay({ usage, model, costUsd }) {
  if (!usage) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const provider = useStore((s) => s.currentProvider);
  const cost = computeCost(model, usage, provider);
  // Z1:CLI result 事件的 total_cost_usd 是官方计费口径的权威成本,优先于单价表
  // 估算。第三方 provider 下 CLI 仍按 Claude 价目计算(模型名是伪装的),不可信。
  const official = !provider || (provider.providerHint || 'anthropic') === 'anthropic';
  const authoritative = official && typeof costUsd === 'number' && costUsd > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-faint mt-2 pt-2 border-t border-canvas-deep/50">
      <span title="input_tokens — 仅指未命中缓存的新 token(Anthropic 计费口径),不是全部输入">输入 {input.toLocaleString()}</span>
      <span>输出 {output.toLocaleString()}</span>
      {cacheRead > 0 && <span title="cache_read_input_tokens">缓存命中 {cacheRead.toLocaleString()}</span>}
      {cacheWrite > 0 && <span title="cache_creation_input_tokens">缓存写入 {cacheWrite.toLocaleString()}</span>}
      {(cacheRead > 0 || cacheWrite > 0) && (
        <span title="实际送入模型处理的输入总量 = 输入 + 缓存命中 + 缓存写入(整轮所有 API 调用累计)">
          实际输入 {(input + cacheRead + cacheWrite).toLocaleString()}
        </span>
      )}
      {(authoritative || cost) && (
        <span
          className="ml-auto text-accent/80 font-mono"
          title={
            authoritative
              ? 'CLI 上报的本轮实际成本（total_cost_usd，官方计费口径）'
              : `本条估算（${cost.currency === 'CNY' ? '原价 CNY，已按 1 USD ≈ 7.2 CNY 换算' : 'USD'}）\n` +
                `input ${formatCost(cost.breakdown.input)}\n` +
                `output ${formatCost(cost.breakdown.output)}\n` +
                `cache read ${formatCost(cost.breakdown.cacheRead)}\n` +
                `cache write ${formatCost(cost.breakdown.cacheWrite)}`
          }
        >
          {formatCost(authoritative ? costUsd : cost.totalUsd)}
        </span>
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
function TurnBubbleInner({ turn, onRetry, onRetryTool, retryActive }) {
  const [showThinking, setShowThinking] = useState(false);

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
  const todoCalls = toolCalls.filter((tc) => tc.name === 'TodoWrite');
  const latestTodo = todoCalls.length > 0 ? todoCalls[todoCalls.length - 1] : null;
  const inlineCalls = toolCalls.filter((tc) => INLINE_TOOL_NAMES.has(tc.name));
  const groupedCalls = toolCalls.filter(
    (tc) => tc.name !== 'TodoWrite' && !INLINE_TOOL_NAMES.has(tc.name)
  );
  const hasInlineCalls = inlineCalls.length > 0;
  const hasGroupedCalls = groupedCalls.length > 0;
  const isStreaming = !fullText && !fullThinking && !latestTodo && !hasInlineCalls && !hasGroupedCalls && !hasOrderedBlocks;

  // turn.uuid === 'streaming' is App.jsx's signal that this turn is still being
  // produced — spin the avatar mark to mirror the CLI's rotating progress glyph.
  const isLiveStream = turn.uuid === 'streaming';

  return (
    // 入场动画只给"正在流式"的临时 turn 播放。回复完成后这条会从 streaming(key=
    // 'streaming') 切到 chatMessages(key='chat-assistant-…') 再切到 jsonl(真 uuid),
    // 三次换 key → React 反复卸载重挂 TurnBubble。若固化后的 turn 仍带 animate-fade-up,
    // 每次重挂都会重放淡入 → 用户看到"回复完成后闪烁一下再显示"。固化 turn 去掉动画即可。
    <div className={`group px-6 py-4 ${isLiveStream ? 'animate-fade-up' : ''}`} style={isLiveStream ? { animationDuration: '0.25s' } : undefined}>
      <div className="max-w-[var(--content-max)] mx-auto flex gap-4">
        {/* Avatar — tinted by the actual provider behind the model */}
        <div className="mt-0.5">
          <ProviderAvatar model={turn.model} size={34} thinking={isLiveStream} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[13px] font-medium text-ink font-body">Claude</span>
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
          </div>

          {/* Primary render path — preserves chronological order.
              We fold every RUN of consecutive tool_use blocks into a single
              ToolCallsGroup so the layout reads as: text → [round 1 tools] →
              text → [round 2 tools] → … instead of one card per tool. The
              user can expand the round bar to see each tool's collapsed card,
              then expand individual cards for details. */}
          {hasOrderedBlocks ? (
            <div className="space-y-2">
              {(() => {
                const out = [];
                let bucket = [];
                const flushBucket = (keyHint) => {
                  if (bucket.length > 0) {
                    out.push(<ToolCallsGroup key={`bucket-${keyHint}`} toolCalls={bucket} onRetryTool={onRetryTool} />);
                    bucket = [];
                  }
                };
                // "重做此工具"乐观回退:截断到被点工具调用之前,该工具及之后不再渲染,
                // 并在原位显示"正在重做此工具…"。服务端 trim+refetch 后此标记消失,
                // 真正的重跑以流式气泡出现在同一位置。
                const trimId = turn._retryTrimToolId;
                let renderBlocks = turn.blocks;
                let showRetrying = false;
                if (trimId) {
                  const cut = turn.blocks.findIndex((b) => b.type === 'tool_use' && b.toolCall?.id === trimId);
                  if (cut >= 0) { renderBlocks = turn.blocks.slice(0, cut); showRetrying = true; }
                }
                renderBlocks.forEach((b, i) => {
                  if (b.type === 'text' && b.content) {
                    flushBucket(i);
                    out.push(<MarkdownRenderer key={`b-${i}`} content={b.content} />);
                    return;
                  }
                  if (b.type === 'thinking' && b.content) {
                    flushBucket(i);
                    out.push(
                      <details key={`b-${i}`} className="mb-1 group">
                        <summary className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink-muted cursor-pointer font-body list-none [&::-webkit-details-marker]:hidden">
                          <ChevronRight size={11} className="transition-transform group-open:rotate-90 shrink-0" />
                          <Brain size={12} />
                          <span>思考过程</span>
                        </summary>
                        <div className="thinking-block mt-2 p-4 rounded-lg text-xs text-ink-muted whitespace-pre-wrap max-h-64 overflow-y-auto font-body leading-relaxed">
                          {b.content}
                        </div>
                      </details>
                    );
                    return;
                  }
                  if (b.type === 'tool_use' && b.toolCall) {
                    // TodoWrite: only render the latest snapshot; never bucket.
                    if (b.toolCall.name === 'TodoWrite') {
                      flushBucket(i);
                      const isLatestTodo = !renderBlocks.slice(i + 1).some(
                        (b2) => b2.type === 'tool_use' && b2.toolCall?.name === 'TodoWrite'
                      );
                      if (isLatestTodo) {
                        out.push(
                          <ToolCallWithRetry key={`b-${i}`} toolCall={b.toolCall} onRetryTool={onRetryTool}>
                            <TodoListCard toolCall={b.toolCall} />
                          </ToolCallWithRetry>
                        );
                      }
                      return;
                    }
                    // Every other tool — Bash/Read/Edit/Grep/Web/Skill/Task/etc.
                    // accumulates into the current round bucket regardless of
                    // whether it was previously rendered as an inline card.
                    bucket.push(b.toolCall);
                    return;
                  }
                });
                flushBucket('end');
                if (showRetrying && retryActive) {
                  out.push(
                    <div key="retrying" className="flex items-center gap-2 text-[12px] text-accent font-body px-1 py-1.5">
                      <Loader2 size={12} className="animate-spin" />
                      <span>正在重做此工具…</span>
                    </div>
                  );
                }
                return out;
              })()}
            </div>
          ) : (
            <>
              {/* Legacy path for historical messages (no blocks array) */}
              {fullThinking && (
                <div className="mb-3">
                  <button
                    onClick={() => setShowThinking(!showThinking)}
                    className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink-muted transition-colors font-body"
                  >
                    <Brain size={12} />
                    <span>思考过程</span>
                    <span className="text-[10px]">{showThinking ? '▾' : '▸'}</span>
                  </button>
                  {showThinking && (
                    <div className="thinking-block mt-2 p-4 rounded-lg text-xs text-ink-muted whitespace-pre-wrap max-h-64 overflow-y-auto font-body leading-relaxed">
                      {fullThinking}
                    </div>
                  )}
                </div>
              )}
              {fullText && <MarkdownRenderer content={fullText} />}
              {latestTodo && (
                <div className="mt-2">
                  <ToolCallWithRetry toolCall={latestTodo} onRetryTool={onRetryTool}>
                    <TodoListCard toolCall={latestTodo} />
                  </ToolCallWithRetry>
                </div>
              )}
              {hasInlineCalls && (
                <div className="mt-2 space-y-2">
                  {inlineCalls.map((tc, i) => (
                    <InlineToolCard key={tc.id || `inline-${i}`} toolCall={tc} onRetryTool={onRetryTool} />
                  ))}
                </div>
              )}
              {hasGroupedCalls && (
                <div className="mt-2"><ToolCallsGroup toolCalls={groupedCalls} onRetryTool={onRetryTool} /></div>
              )}
              {legacyShowRetrying && retryActive && (
                <div className="flex items-center gap-2 text-[12px] text-accent font-body px-1 py-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  <span>正在重做此工具…</span>
                </div>
              )}
            </>
          )}

          {/* Streaming indicator */}
          {isStreaming && (
            <div className="flex items-center gap-1.5 pt-1">
              <div className="w-2 h-2 rounded-full bg-accent/40" style={{ animation: 'breathe 1.4s ease-in-out infinite' }} />
              <div className="w-2 h-2 rounded-full bg-accent/40" style={{ animation: 'breathe 1.4s ease-in-out infinite 0.2s' }} />
              <div className="w-2 h-2 rounded-full bg-accent/40" style={{ animation: 'breathe 1.4s ease-in-out infinite 0.4s' }} />
            </div>
          )}

          {/* Usage */}
          <UsageDisplay usage={turn.usage} model={turn.model} costUsd={turn.costUsd} />
          {onRetry && !isLiveStream && turn.uuid !== 'streaming' && (
            <div className="flex justify-end mt-2">
              <button
                onClick={() => onRetry(turn)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-ink-faint hover:text-accent hover:bg-canvas-warm transition-colors"
                title="回滚到这条 AI 回复之前，让 AI 重新生成"
              >
                <RotateCcw size={12} />
                <span>重做这条回复</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const TurnBubble = React.memo(TurnBubbleInner);
