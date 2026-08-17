import React, { useState } from 'react';
import { Search, ChevronDown, ChevronRight, Loader2, FileText } from '../Icon.jsx';

// Combined renderer for Grep + Glob. Input shape:
//   Grep: { pattern, path?, glob?, output_mode?, head_limit?, ... }
//   Glob: { pattern, path? }
// Result is typically a newline-separated list of file paths (Glob) or
// "filename:line:match" rows (Grep).
export function GrepGlobCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const name = toolCall.name; // 'Grep' | 'Glob'
  const pattern = toolCall.input?.pattern || '';
  const path = toolCall.input?.path || '';
  const glob = toolCall.input?.glob || '';
  const result = toolCall.result;
  const isError = result?.isError;
  const content = typeof result?.content === 'string' ? result.content : '';
  const lines = content.split('\n').filter(Boolean);
  const PREVIEW = 6;
  const shown = expanded ? lines.slice(0, 200) : lines.slice(0, PREVIEW);
  const hasMore = lines.length > PREVIEW;

  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden bg-canvas animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 bg-canvas-warm hover:bg-canvas-deep/40 transition-colors text-left"
      >
        {expanded
          ? <ChevronDown size={12} className="text-ink-faint shrink-0" />
          : <ChevronRight size={12} className="text-ink-faint shrink-0" />}
        <Search size={12} className="text-indigo-600 shrink-0" />
        <span className="text-xs font-mono text-ink-soft shrink-0">{name}</span>
        <code className="text-[11px] text-ink truncate flex-1 bg-canvas-deep/40 px-1.5 py-0.5 rounded">{pattern || '(empty)'}</code>
        {!result && <Loader2 size={11} className="text-ink-faint animate-spin shrink-0" />}
        {result && (isError
          ? <span className="text-error text-[10px] shrink-0">错误</span>
          : <span className="text-ink-faint text-[10px] shrink-0">{lines.length} 行</span>)}
      </button>

      {(path || glob) && (
        <div className="px-3 py-1 text-[10px] text-ink-faint font-mono border-b border-canvas-deep flex gap-2">
          {path && <span>路径: {path}</span>}
          {glob && <span>过滤: {glob}</span>}
        </div>
      )}

      {expanded && result && (
        <div className={`px-3 py-2 text-[11px] font-mono whitespace-pre-wrap leading-relaxed overflow-auto max-h-[600px] ${
          isError ? 'bg-red-50 text-red-700' : 'bg-canvas-warm/40 text-ink-muted'
        }`}>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <FileText size={10} className="text-ink-ghost shrink-0 mt-0.5" />
              <span className="truncate">{l}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
