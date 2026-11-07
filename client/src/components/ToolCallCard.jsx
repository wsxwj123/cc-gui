import React, { useState } from 'react';
import { Terminal, FileText, Search, Globe, Wrench, Edit3 } from './Icon.jsx';

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

// r158:不再按工具给固定色相(浅底在深色主题里是亮块),图标与名字一律取主题中性色。

function getToolIcon(name) {
  return TOOL_ICONS[name] || Wrench;
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
  const preview = formatInput(toolCall.input);
  const hasError = result?.isError;

  return (
    <div
      className="border rounded-lg overflow-hidden my-2 animate-fade-up"
      style={{
        borderColor: hasError ? 'color-mix(in srgb, var(--color-error) 38%, transparent)' : 'var(--cg-line)',
        background: hasError ? 'var(--color-error-subtle)' : 'var(--color-canvas-warm)',
      }}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded ? 'true' : 'false'}
        className="cg-fold w-full flex items-center gap-2.5 px-3 py-2 hover:bg-canvas-deep/50 text-left cursor-pointer"
      >
        <span
          className="w-5 h-5 rounded flex items-center justify-center shrink-0"
          style={{ background: 'var(--cg-fill-2)' }}
        >
          <Icon size={11} />
        </span>
        <span className="text-xs font-medium font-mono">
          {toolCall.name}
        </span>
        <span className="text-xs truncate flex-1 font-mono">
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
                    ? 'bg-error-subtle border-error/40 text-error'
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
