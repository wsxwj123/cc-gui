import React, { useState } from 'react';
import { Search, FileText } from '../Icon.jsx';
import { ToolCardShell, cardStatusOf } from './ToolCardShell.jsx';
import { ToolResultImages } from './ToolResultImages.jsx';

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
    <ToolCardShell
      toolName={name}
      status={cardStatusOf(result)}
      Icon={Search}
      title={pattern || '(empty)'}
      titleMono
      meta={result && !isError ? <span>{lines.length} 行</span> : null}
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
    >
      {(path || glob) && (
        <div className="tc-sub font-mono flex gap-2 min-w-0">
          {path && <span className="truncate">路径: {path}</span>}
          {glob && <span className="truncate">过滤: {glob}</span>}
        </div>
      )}
      {result && (
        <>
        <ToolResultImages images={result.images} name={toolCall.name || 'GrepGlobCard'} className="mb-2" />
        <div className={`tc-block whitespace-pre-wrap max-h-[600px] ${isError ? 'tc-block-err' : ''}`}>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2 min-w-0">
              <FileText size={10} className="text-ink-faint shrink-0 mt-1" />
              <span className="truncate">{l}</span>
            </div>
          ))}
        </div>
        </>
      )}
    </ToolCardShell>
  );
}
