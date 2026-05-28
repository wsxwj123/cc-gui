import React, { useState } from 'react';
import { FileText, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

const PREVIEW_LINES = 10;
const MAX_EXPANDED_LINES = 400;

export function ReadCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const filePath = toolCall.input?.file_path || '';
  const fileName = filePath.split('/').pop() || filePath;
  const offset = toolCall.input?.offset;
  const limit = toolCall.input?.limit;
  const result = toolCall.result;
  const isError = result?.isError;
  const content = typeof result?.content === 'string' ? result.content : '';
  const allLines = content.split('\n');
  const hasMore = allLines.length > PREVIEW_LINES;
  const shown = expanded
    ? allLines.slice(0, MAX_EXPANDED_LINES).join('\n')
    : allLines.slice(0, PREVIEW_LINES).join('\n');

  // Range chip ("行 1-50" / "前 200 行" / "")
  let rangeLabel = '';
  if (offset && limit) rangeLabel = `行 ${offset}–${offset + limit - 1}`;
  else if (offset) rangeLabel = `从行 ${offset}`;
  else if (limit) rangeLabel = `前 ${limit} 行`;

  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden bg-canvas animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 bg-canvas-warm hover:bg-canvas-deep/40 transition-colors text-left"
      >
        {expanded
          ? <ChevronDown size={12} className="text-ink-faint shrink-0" />
          : <ChevronRight size={12} className="text-ink-faint shrink-0" />}
        <FileText size={12} className="text-blue-500 shrink-0" />
        <span className="text-xs font-mono text-ink-soft truncate">{fileName}</span>
        {rangeLabel && (
          <span className="text-[10px] text-ink-faint font-mono shrink-0">{rangeLabel}</span>
        )}
        {!result && <Loader2 size={11} className="text-ink-faint animate-spin ml-auto shrink-0" />}
        {result && (
          isError
            ? <span className="text-red-500 text-[10px] ml-auto shrink-0">错误</span>
            : <span className="text-ink-faint text-[10px] ml-auto shrink-0">{allLines.length} 行</span>
        )}
      </button>

      {filePath && (
        <div className="px-3 py-1 text-[9px] text-ink-ghost truncate font-mono border-b border-canvas-deep">
          {filePath}
        </div>
      )}

      {expanded && result && !isError && content && (
        <pre className="px-3 py-2 text-[11px] font-mono text-ink-muted overflow-auto whitespace-pre leading-relaxed bg-canvas-warm/40 max-h-[600px]">
          {content}
        </pre>
      )}
      {result && isError && (
        <pre className="px-3 py-2 text-[11px] font-mono text-red-700 bg-red-50/50 whitespace-pre-wrap">
          {String(result.content || '').slice(0, 500)}
        </pre>
      )}
    </div>
  );
}
