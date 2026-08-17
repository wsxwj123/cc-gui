import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal, FileText, Search, Globe, Wrench, Edit3 } from './Icon.jsx';

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

const TOOL_COLORS = {
  Bash: { bg: '#FEF3C7', fg: '#92400E', icon: '#D97706' },
  Read: { bg: '#DBEAFE', fg: '#1E40AF', icon: '#3B82F6' },
  Edit: { bg: '#E0E7FF', fg: '#3730A3', icon: '#6366F1' },
  Write: { bg: '#E0E7FF', fg: '#3730A3', icon: '#6366F1' },
  Grep: { bg: '#D1FAE5', fg: '#065F46', icon: '#10B981' },
  WebSearch: { bg: '#FCE7F3', fg: '#9D174D', icon: '#EC4899' },
  WebFetch: { bg: '#FCE7F3', fg: '#9D174D', icon: '#EC4899' },
  Agent: { bg: '#EDE9FE', fg: '#5B21B6', icon: '#8B5CF6' },
};

function getToolIcon(name) {
  return TOOL_ICONS[name] || Wrench;
}

function getToolColor(name) {
  return TOOL_COLORS[name] || { bg: '#F3F4F6', fg: '#374151', icon: '#6B7280' };
}

function formatInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  if (input.query) return input.query;
  const keys = Object.keys(input);
  const firstVal = input[keys[0]];
  if (typeof firstVal === 'string') return firstVal.slice(0, 100);
  return JSON.stringify(input, null, 2).slice(0, 100);
}

export function ToolCallCard({ toolCall, result }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getToolIcon(toolCall.name);
  const color = getToolColor(toolCall.name);
  const preview = formatInput(toolCall.input);
  const hasError = result?.isError;

  return (
    <div
      className="border rounded-lg overflow-hidden my-2 animate-fade-up"
      style={{
        borderColor: hasError ? '#FCA5A5' : 'var(--color-canvas-deep)',
        background: hasError ? '#FEF2F2' : 'var(--color-canvas-warm)',
      }}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-canvas-deep/50 transition-colors text-left"
      >
        <span className="shrink-0" style={{ color: color.icon }}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span
          className="w-5 h-5 rounded flex items-center justify-center shrink-0"
          style={{ background: color.bg }}
        >
          <Icon size={11} style={{ color: color.icon }} />
        </span>
        <span className="text-xs font-medium font-mono" style={{ color: color.fg }}>
          {toolCall.name}
        </span>
        <span className="text-xs text-ink-faint truncate flex-1 font-mono">
          {preview}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-canvas-deep p-3 space-y-3 animate-fade-in">
          {/* Input */}
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-ink-faint mb-1.5">
              输入参数
            </div>
            <pre className="text-xs bg-canvas rounded-md border border-canvas-sunken p-3 overflow-x-auto max-h-48 font-mono text-ink-soft leading-relaxed">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {result && (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-ink-faint mb-1.5">
                返回结果
                {hasError && (
                  <span className="ml-2 text-error font-normal">错误</span>
                )}
              </div>
              <pre
                className={`text-xs rounded-md border p-3 overflow-x-auto max-h-64 font-mono leading-relaxed ${
                  hasError
                    ? 'bg-error-subtle border-red-200 text-red-700'
                    : 'bg-canvas border-canvas-sunken text-ink-soft'
                }`}
              >
                {typeof result.content === 'string'
                  ? result.content.slice(0, 4000)
                  : JSON.stringify(result.content, null, 2)?.slice(0, 4000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
