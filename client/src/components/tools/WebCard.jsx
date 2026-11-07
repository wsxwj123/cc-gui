import React, { useState } from 'react';
import { Globe, ExternalLink } from '../Icon.jsx';
import { ToolCardShell, cardStatusOf } from './ToolCardShell.jsx';
import { MarkdownRenderer } from '../MarkdownRenderer.jsx';
import { openExternalUrl } from '../../utils/openExternal.js';
import { ToolResultImages } from './ToolResultImages.jsx';

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
    <ToolCardShell
      toolName={name}
      status={cardStatusOf(result)}
      Icon={Globe}
      title={queryOrUrl}
      titleMono={isFetch}
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      headExtra={isFetch && queryOrUrl ? (
        // A <span>, not <a>: nesting an anchor inside this <button> is invalid
        // HTML (browsers hoist it unpredictably). Open via window.open instead.
        <span
          role="link"
          onClick={(e) => { e.stopPropagation(); openExternalUrl(queryOrUrl); }}
          className="shrink-0 cursor-pointer hover:text-ink"
          title="在浏览器打开"
        >
          <ExternalLink size={11} />
        </span>
      ) : null}
    >
      {sidePrompt && (
        <div className="tc-sub">指示: {sidePrompt.slice(0, 200)}</div>
      )}
      {result && (
        <>
        <ToolResultImages images={result.images} name={toolCall.name || 'WebCard'} className="mb-2" />
        <div className={`tc-block text-[11px] max-h-[600px] overflow-y-auto ${isError ? 'tc-block-err' : ''}`} style={isError ? undefined : { fontFamily: 'inherit' }}>
          {isError
            ? <pre className="font-mono whitespace-pre-wrap">{content}</pre>
            : <MarkdownRenderer content={content} />
          }
        </div>
        </>
      )}
    </ToolCardShell>
  );
}
