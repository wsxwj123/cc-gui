import React, { useState } from 'react';
import {
  Sparkles, Brain, Copy, Check, ChevronDown, ChevronRight,
  Wrench, BookOpen, Pencil, Terminal, FileText, Search,
  Globe, Edit3, Loader2
} from 'lucide-react';
import { ModelBadge } from './ModelBadge.jsx';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';

// ─── Tool category config ──────────────────────────────────────
const CATEGORY_CONFIG = {
  skill: {
    label: '读取',
    icon: BookOpen,
    color: 'text-blue-600',
    bg: 'bg-blue-50',
    border: 'border-blue-200',
  },
  write: {
    label: '写入',
    icon: Pencil,
    color: 'text-amber-600',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
  },
  call: {
    label: '调用',
    icon: Wrench,
    color: 'text-violet-600',
    bg: 'bg-violet-50',
    border: 'border-violet-200',
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
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-canvas-deep rounded"
      title="复制"
    >
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} className="text-ink-faint" />}
    </button>
  );
}

// ─── Single Tool Call Row ──────────────────────────────────────
function ToolCallRow({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getToolIcon(toolCall.name);
  const hasError = toolCall.result?.isError;
  const preview = formatInputPreview(toolCall.input);

  return (
    <div className={`border rounded-md overflow-hidden ${hasError ? 'border-red-200 bg-red-50/50' : 'border-canvas-sunken bg-canvas'}`}>
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
            <span className="text-[10px] text-red-500">错误</span>
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
                结果 {hasError && <span className="text-red-500">错误</span>}
              </div>
              <pre className={`text-[11px] rounded p-2 overflow-x-auto max-h-48 font-mono ${hasError ? 'bg-red-50 text-red-700' : 'bg-canvas-warm text-ink-muted'}`}>
                {typeof toolCall.result.content === 'string'
                  ? toolCall.result.content.slice(0, 4000)
                  : JSON.stringify(toolCall.result.content, null, 2)?.slice(0, 4000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tool Calls Group (collapsed by category) ─────────────────
function ToolCallsGroup({ toolCalls }) {
  const [expanded, setExpanded] = useState(false);

  // Group by category
  const groups = { skill: [], write: [], call: [] };
  for (const tc of toolCalls) {
    const cat = tc.category || 'call';
    (groups[cat] || (groups.call)).push(tc);
  }

  const totalCalls = toolCalls.length;
  const errorCount = toolCalls.filter((tc) => tc.result?.isError).length;

  // Build summary line
  const summaryParts = [];
  for (const [cat, items] of Object.entries(groups)) {
    if (items.length > 0) {
      const cfg = CATEGORY_CONFIG[cat];
      summaryParts.push(`${items.length} ${cfg.label}`);
    }
  }

  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden animate-fade-up">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-canvas-warm/60 transition-colors text-left bg-canvas-warm"
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
        {errorCount > 0 && (
          <span className="text-[10px] text-red-500 ml-auto">{errorCount} 错误</span>
        )}
      </button>

      {/* Expanded: show all tool calls grouped by category */}
      {expanded && (
        <div className="border-t border-canvas-deep p-2.5 space-y-3 animate-fade-in">
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
                  {items.map((tc, i) => (
                    <ToolCallRow key={tc.id || i} toolCall={tc} />
                  ))}
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
function UsageDisplay({ usage }) {
  if (!usage) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  return (
    <div className="flex gap-3 text-[10px] text-ink-faint mt-2 pt-2 border-t border-canvas-deep/50">
      <span>输入 {input.toLocaleString()}</span>
      <span>输出 {output.toLocaleString()}</span>
      {cacheRead > 0 && <span>缓存 {cacheRead.toLocaleString()}</span>}
    </div>
  );
}

// ─── Turn Bubble ───────────────────────────────────────────────
export function TurnBubble({ turn }) {
  const [showThinking, setShowThinking] = useState(false);

  const fullText = turn.text.join('\n');
  const fullThinking = turn.thinking.join('\n');
  const hasToolCalls = turn.toolCalls.length > 0;
  const isStreaming = !fullText && !fullThinking && !hasToolCalls;

  return (
    <div className="group px-6 py-4 animate-fade-up" style={{ animationDuration: '0.25s' }}>
      <div className="max-w-3xl mx-auto flex gap-4">
        {/* Avatar */}
        <div className="shrink-0 mt-0.5">
          <div className="w-7 h-7 rounded-full bg-accent-subtle flex items-center justify-center">
            <Sparkles size={14} className="text-accent" />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[13px] font-medium text-ink font-body">Claude</span>
            {turn.model && <ModelBadge model={turn.model} compact />}
            <span className="text-[11px] text-ink-faint font-mono">{formatTime(turn.timestamp)}</span>
            <div className="flex-1" />
            <CopyButton text={fullText} />
          </div>

          {/* Thinking */}
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

          {/* Text */}
          {fullText && (
            <MarkdownRenderer content={fullText} />
          )}

          {/* Tool calls — all grouped in one collapsible block */}
          {hasToolCalls && (
            <div className="mt-2">
              <ToolCallsGroup toolCalls={turn.toolCalls} />
            </div>
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
          <UsageDisplay usage={turn.usage} />
        </div>
      </div>
    </div>
  );
}
