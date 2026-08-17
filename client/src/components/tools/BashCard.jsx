import React, { useState } from 'react';
import { Terminal, ChevronDown, ChevronRight, Loader2 } from '../Icon.jsx';

const PREVIEW_LINES = 8;

export function BashCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const cmd = toolCall.input?.command || '';
  const desc = toolCall.input?.description || '';
  const result = toolCall.result;
  const isError = result?.isError;
  const output = typeof result?.content === 'string' ? result.content : '';
  const lines = output.split('\n');
  const hasMore = lines.length > PREVIEW_LINES;
  const shown = expanded ? output.slice(0, 16000) : lines.slice(0, PREVIEW_LINES).join('\n');

  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 bg-[#1e1e1e] flex items-center gap-2 hover:bg-[#262626] transition-colors text-left"
      >
        <Terminal size={12} className="text-green-400 shrink-0" />
        <span className="text-green-400 font-mono text-[11px] shrink-0">$</span>
        <code className="text-gray-100 font-mono text-[11.5px] truncate flex-1">{cmd || '(empty)'}</code>
        {!result && <Loader2 size={11} className="text-gray-400 animate-spin shrink-0" />}
        {result && (
          isError
            ? <span className="text-red-400 text-[10px] shrink-0">错误</span>
            : <span className="text-green-400 text-[10px] shrink-0">✓</span>
        )}
        {expanded
          ? <ChevronDown size={12} className="text-gray-400 shrink-0" />
          : <ChevronRight size={12} className="text-gray-400 shrink-0" />}
      </button>

      {desc && (
        <div className="px-3 py-1 bg-canvas-warm text-[10px] text-ink-faint font-body border-b border-canvas-deep">
          {desc}
        </div>
      )}

      {expanded && result && output && (
        <pre className={`px-3 py-2 text-[11px] font-mono overflow-auto whitespace-pre-wrap leading-relaxed max-h-[600px] ${
          isError ? 'bg-red-50 text-red-700' : 'bg-canvas-warm text-ink-muted'
        }`}>
          {output}
        </pre>
      )}
    </div>
  );
}
