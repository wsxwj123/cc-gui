import React, { useState } from 'react';
import { Wrench, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { MarkdownRenderer } from '../MarkdownRenderer.jsx';

// Skill tool — input shape varies per skill, but typically has at least
// `skill` or the model calls a skill by name. Render generic key/value.
export function SkillCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const skillName = toolCall.input?.skill || toolCall.input?.name || toolCall.name;
  const result = toolCall.result;
  const isError = result?.isError;
  const content = typeof result?.content === 'string' ? result.content : '';

  const inputEntries = Object.entries(toolCall.input || {}).filter(([k]) => k !== 'skill' && k !== 'name');
  const inputPreview = inputEntries.length > 0
    ? inputEntries.map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 30) : JSON.stringify(v).slice(0, 30)}`).join(', ')
    : '';

  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden bg-canvas animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 bg-amber-50 hover:bg-amber-100 transition-colors text-left"
      >
        {expanded
          ? <ChevronDown size={12} className="text-amber-700 shrink-0" />
          : <ChevronRight size={12} className="text-amber-700 shrink-0" />}
        <Wrench size={12} className="text-amber-600 shrink-0" />
        <span className="text-xs font-mono text-amber-900 shrink-0">Skill</span>
        <span className="text-[11px] font-mono text-ink truncate flex-1">{skillName}</span>
        {!result && <Loader2 size={11} className="text-amber-500 animate-spin shrink-0" />}
        {result && (isError
          ? <span className="text-error text-[10px] shrink-0">错误</span>
          : <span className="text-success text-[10px] shrink-0">✓</span>)}
      </button>

      {inputPreview && (
        <div className="px-3 py-1 text-[10px] text-ink-faint font-mono border-b border-canvas-deep truncate">
          {inputPreview}
        </div>
      )}

      {expanded && (
        <>
          <details className="px-3 py-2 border-b border-canvas-deep" open>
            <summary className="cursor-pointer text-[10px] text-ink-faint uppercase tracking-wider font-body">
              输入参数
            </summary>
            <pre className="text-[11px] bg-canvas-warm rounded p-2 mt-1 overflow-x-auto max-h-32 font-mono text-ink-muted">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </details>

          {result && (
            <div className={`px-3 py-2 text-[11px] max-h-[600px] overflow-y-auto ${
              isError ? 'bg-red-50 text-red-700' : 'bg-canvas-warm/40 text-ink-muted'
            }`}>
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body mb-1">结果</div>
              {isError
                ? <pre className="font-mono whitespace-pre-wrap">{content}</pre>
                : <MarkdownRenderer content={content} />
              }
            </div>
          )}
        </>
      )}
    </div>
  );
}
