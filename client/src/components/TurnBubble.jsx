import React, { useState, useRef, useEffect } from 'react';
import {
  Brain, Copy, Check, ChevronDown, ChevronRight,
  Wrench, BookOpen, Pencil, Terminal, FileText, Search,
  Globe, Edit3, Loader2, RotateCcw, Bot, GitBranch
} from './Icon.jsx';
import { ModelBadge, ProviderAvatar } from './ModelBadge.jsx';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { GenuiActionProvider } from '../genui/host/action-context.jsx';
import { BashCard } from './tools/BashCard.jsx';
import { EditDiffCard } from './tools/EditDiffCard.jsx';
import { ReadCard } from './tools/ReadCard.jsx';
import { TaskCard, TaskOwnerContext } from './tools/TaskCard.jsx';
import { GrepGlobCard } from './tools/GrepGlobCard.jsx';
import { WebCard } from './tools/WebCard.jsx';
import { SkillCard } from './tools/SkillCard.jsx';
import { computeCost, formatCost, isPlanBilling, costTitle } from '../utils/pricing.js';
import { copyText } from '../utils/clipboard.js';
import { shouldShowBottomCopy } from '../utils/scroll.js';
import { useStore } from '../stores/sessionStore.js';
import { TASK_TOOL_NAMES, rebuildTodosFromTaskCalls } from '../utils/todos.js';
import { formatInputPreview, thinkingLabel, groupCoworkBlocks, activeGroupKey } from '../utils/streamStatus.js';

// Tools that get their own bespoke inline card (rendered in chronological order
// inside the turn). Anything not in this set falls through to ToolCallsGroup,
// the generic category-grouped collapsible.
const INLINE_TOOL_NAMES = new Set([
  'Bash', 'Edit', 'MultiEdit', 'Write', 'Read',
  // 'Agent' 与 'Task' 都是子代理派发工具(不同 provider/CLI 命名不同),都走 TaskCard。
  'Task', 'Agent', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Skill',
]);

// AI 有时不走 Skill 工具,而是直接用读取类工具读 <skill>/SKILL.md 加载技能 —
// 这种调用也按 skill 横幅渲染(否则用户只看到一行普通 Read,不知道技能被加载)。
// 只认读取类工具(Read / mcp 各家 read_file);Edit/Write 碰 SKILL.md 是在开发
// 技能,不算加载。路径须含 skills/<name>/SKILL.md(兼容 Windows 反斜杠),
// skill 名取 SKILL.md 的上一级目录名;命中返回名字,否则 null。
const SKILL_DOC_PATH_RE = /[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/i;
function getSkillDocReadName(toolCall) {
  const name = toolCall?.name || '';
  // Read 原生工具,或 mcp 工具名末段形如 read_file / readfile(desktop-commander 等)
  const tail = name.split('__').pop() || '';
  const isReader = name === 'Read' || /^read_?file$/i.test(tail);
  if (!isReader) return null;
  const p = toolCall.input?.file_path || toolCall.input?.path;
  if (typeof p !== 'string') return null;
  const m = SKILL_DOC_PATH_RE.exec(p);
  return m ? m[1] : null;
}

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

// Returns the rich card React element for a tool, or null when no
// specialty renderer exists for that tool name.
function renderRichToolCard(toolCall) {
  // 统一在分发层拦截中断合成终态(逐卡加分支必漏,新增专用卡自动覆盖)。
  // Skill 例外:SkillCard 自带中断态横幅(样式更贴合,保留)。Task/Agent 天然不进
  // (finalizePendingToolCalls 不给它们补 result,状态走 activeAgents/TaskCard)。
  if (toolCall.result?.interrupted && toolCall.name !== 'Skill') {
    return <InterruptedToolCard toolCall={toolCall} />;
  }
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
      // 未展开:收起工具/子代理/skill(思考照常显示,清单不计)。
      if (!chatExpanded && b.type === 'tool_use' && b.toolCall) {
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
    return <div className="space-y-2">{out}{trailing}</div>;
  }

  // 非聊天模式:cowork 分组折叠。每段正文前连续的思考+通用工具打包成一个 WorkGroup。
  const segments = groupCoworkBlocks(list, { getSkillDocReadName });
  const activeKey = activeGroupKey(segments, isLive);
  const out = segments.map((seg) => {
    switch (seg.kind) {
      case 'text':
        return <MarkdownRenderer key={`t-${seg.key}`} content={seg.content} dockKeyPrefix={`${dockKeyPrefix}:${seg.index}`} isStreaming={isLive} />;
      case 'task':
        return (
          <ToolCallWithRetry key={`k-${seg.key}`} toolCall={seg.toolCall} onRetryTool={onRetryTool} hoverOnly>
            <TaskCard toolCall={seg.toolCall} />
          </ToolCallWithRetry>
        );
      case 'skill': {
        const latest = seg.calls[seg.calls.length - 1];
        return (
          <ToolCallWithRetry key={`k-${seg.key}`} toolCall={latest} onRetryTool={onRetryTool} hoverOnly>
            <SkillCard toolCall={latest} calls={seg.calls} />
          </ToolCallWithRetry>
        );
      }
      case 'skilldoc':
        return (
          <ToolCallWithRetry key={`k-${seg.key}`} toolCall={seg.toolCall} onRetryTool={onRetryTool} hoverOnly>
            <SkillCard toolCall={seg.toolCall} nameOverride={seg.name} subLabel="读取技能文档" />
          </ToolCallWithRetry>
        );
      case 'group': {
        const expanded = override.has(seg.key) ? override.get(seg.key) : (seg.key === activeKey);
        return (
          <WorkGroup
            key={`wg-${seg.key}`}
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
  });

  return <div className="space-y-2">{out}{trailing}</div>;
}

// ─── Usage Display ─────────────────────────────────────────────
function UsageDisplay({ usage, model, costUsd }) {
  // hook 必须无条件调用:移到 early return 之前(原在 if(!usage)return 之后=条件调用 hook,
  // usage 有无切换时 hooks 数量变→React 崩;ESLint rules-of-hooks 抓出的真隐患)。
  const provider = useStore((s) => s.currentProvider);
  if (!usage) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cost = computeCost(model, usage, provider);
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
          // R3:非 authoritative 分支的说明文案由 pricing.js 统一给(三个费用显示点共用),
          // 用户填过单价时如实说明是按他填写的单价算,不再说"按官网价估算"。
          title={
            authoritative
              ? 'CLI 上报的本轮实际成本（total_cost_usd，官方计费口径；美元计价模型按 1 USD ≈ 7.2 CNY 换算，人民币计价模型为原生定价）'
              : costTitle(cost)
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
function TurnBubbleInner({ turn, onRetry, onRetryTool, onFork, retryActive }) {
  const [showThinking, setShowThinking] = useState(false);
  const chatMode = useStore((s) => s.chatMode);
  const [chatExpanded, setChatExpanded] = useState(false);

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

  return (
    // 本回合的会话归属(session-reader 给每条历史 turn 打的 record.sessionId)供给
    // 树内所有 TaskCard:分支(fork)复制出的卡片与源会话共用 tool_use.id,没有这个值
    // 就会取到源会话正在跑的 agent(显示运行中 + 停错会话)。流式的本地 turn 没有
    // sessionId 字段 → null → 完全走原逻辑。
    <TaskOwnerContext.Provider value={turn.sessionId || null}>
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
          <UsageDisplay usage={turn.usage} model={turn.model} costUsd={turn.costUsd} />
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
    </TaskOwnerContext.Provider>
  );
}

export const TurnBubble = React.memo(TurnBubbleInner);
