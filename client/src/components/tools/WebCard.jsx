import React, { useState } from 'react';
import { Globe, ChevronDown, ChevronRight, Loader2, ExternalLink } from '../Icon.jsx';
import { MarkdownRenderer } from '../MarkdownRenderer.jsx';
import { openExternalUrl } from '../../utils/openExternal.js';

// WebSearch input: { query, allowed_domains?, blocked_domains? }
// WebFetch input: { url, prompt }
// Result content is typically Markdown / formatted text.
export function WebCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const name = toolCall.name; // 'WebSearch' | 'WebFetch'
  const isFetch = name === 'WebFetch';
  const queryOrUrl = isFetch ? (toolCall.input?.url || '') : (toolCall.input?.query || '');
  const sidePrompt = isFetch ? (toolCall.input?.prompt || '') : '';
  const result = toolCall.result;
  const isError = result?.isError;
  const content = typeof result?.content === 'string' ? result.content : '';

  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden bg-canvas animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 bg-sky-50 hover:bg-sky-100 transition-colors text-left"
      >
        {expanded
          ? <ChevronDown size={12} className="text-sky-700 shrink-0" />
          : <ChevronRight size={12} className="text-sky-700 shrink-0" />}
        <Globe size={12} className="text-sky-600 shrink-0" />
        <span className="text-xs font-mono text-sky-900 shrink-0">{name}</span>
        <span className="text-[11px] text-ink truncate flex-1" title={queryOrUrl}>{queryOrUrl}</span>
        {isFetch && queryOrUrl && (
          // A <span>, not <a>: nesting an anchor inside this <button> is invalid
          // HTML (browsers hoist it unpredictably). Open via window.open instead.
          <span
            role="link"
            onClick={(e) => { e.stopPropagation(); openExternalUrl(queryOrUrl); }}
            className="text-sky-600 hover:text-sky-800 shrink-0 cursor-pointer"
            title="在浏览器打开"
          >
            <ExternalLink size={11} />
          </span>
        )}
        {!result && <Loader2 size={11} className="text-sky-500 animate-spin shrink-0" />}
        {result && (isError
          ? <span className="text-error text-[10px] shrink-0">错误</span>
          : <span className="text-success text-[10px] shrink-0">✓</span>)}
      </button>

      {sidePrompt && (
        <div className="px-3 py-1 text-[10px] text-ink-faint font-body border-b border-canvas-deep">
          指示: {sidePrompt.slice(0, 200)}
        </div>
      )}

      {expanded && result && (
        <div className={`px-3 py-2 text-[11px] max-h-[600px] overflow-y-auto ${
          isError ? 'bg-red-50 text-red-700' : 'bg-canvas-warm/40 text-ink-muted'
        }`}>
          {isError
            ? <pre className="font-mono whitespace-pre-wrap">{content}</pre>
            : <MarkdownRenderer content={content} />
          }
        </div>
      )}
    </div>
  );
}
