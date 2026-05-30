import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1 text-[10px] text-[#9a8e78] hover:text-[#cabba0] transition-colors"
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? '已复制' : '复制'}
    </button>
  );
}

const markdownComponents = {
  // ── Headings ──────────────────────────────────────────────────
  h1: ({ children }) => (
    <h1 className="text-[1.5em] font-display font-semibold text-ink mt-6 mb-3 pb-2 border-b border-canvas-deep">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[1.3em] font-display font-semibold text-ink mt-5 mb-2.5 pb-1.5 border-b border-canvas-deep/60">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[1.12em] font-display font-medium text-ink-soft mt-4 mb-2">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-[1em] font-display font-medium text-ink-soft mt-3 mb-1.5">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-[0.92em] font-display font-medium text-ink-muted mt-3 mb-1 uppercase tracking-wide">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-[0.88em] font-display font-medium text-ink-faint mt-3 mb-1 uppercase tracking-wide">
      {children}
    </h6>
  ),

  // ── Code ──────────────────────────────────────────────────────
  code: ({ children, className, ...props }) => {
    const codeStr = String(children).replace(/\n$/, '');
    const isBlock = className?.includes('language-');
    const lang = className?.replace('language-', '') || '';

    if (isBlock) {
      return (
        <div className="relative group my-3">
          <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#2b2722] rounded-t-lg border border-[#3a342b] border-b-0">
            <span className="text-[11px] font-mono text-[#9a8e78]">
              {lang || 'code'}
            </span>
            <CopyButton text={codeStr} />
          </div>
          <pre className="bg-[#211e19] border border-[#3a342b] border-t-0 rounded-b-lg p-4 overflow-x-auto text-[13px] leading-relaxed font-mono text-[#e8e2d6]">
            <code>{codeStr}</code>
          </pre>
        </div>
      );
    }

    return (
      <code
        className="bg-canvas-warm border border-canvas-deep px-1.5 py-0.5 rounded text-[0.88em] font-mono text-[#a65a3a]"
        {...props}
      >
        {children}
      </code>
    );
  },

  // ── Pre (handled by code block above) ─────────────────────────
  pre: ({ children }) => <>{children}</>,

  // ── Paragraph ─────────────────────────────────────────────────
  p: ({ children }) => (
    <p className="my-3 leading-relaxed">{children}</p>
  ),

  // ── Blockquote ────────────────────────────────────────────────
  blockquote: ({ children }) => (
    <blockquote className="border-l-3 border-accent-muted pl-4 my-3 text-ink-muted italic bg-accent-subtle/30 py-2 pr-3 rounded-r-md">
      {children}
    </blockquote>
  ),

  // ── Lists ─────────────────────────────────────────────────────
  ul: ({ children }) => (
    <ul className="my-2 ml-1 space-y-1 list-disc list-outside marker:text-ink-ghost pl-5">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-1 space-y-1 list-decimal list-outside marker:text-ink-ghost pl-5">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="leading-relaxed">{children}</li>
  ),

  // ── Table ─────────────────────────────────────────────────────
  table: ({ children }) => (
    <div className="overflow-x-auto my-3 border border-canvas-deep rounded-lg">
      <table className="w-full text-[13px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-canvas-warm">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border-b border-canvas-deep px-3 py-2 text-left font-medium text-ink-soft">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-canvas-deep/50 px-3 py-2 text-ink-muted">
      {children}
    </td>
  ),

  // ── Horizontal rule ───────────────────────────────────────────
  hr: () => (
    <hr className="border-none border-t border-canvas-deep my-5" />
  ),

  // ── Links ─────────────────────────────────────────────────────
  // Only allow http/https/mailto hrefs. Claude's markdown output is trusted-ish,
  // but a `javascript:`/`data:` URL in a link would execute on click — neutralize
  // it by dropping the href so the text still renders inert.
  a: ({ href, children }) => {
    const safe = typeof href === 'string' && /^(https?:|mailto:)/i.test(href.trim());
    return (
      <a
        href={safe ? href : undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent hover:text-accent-hover underline underline-offset-2 decoration-accent-muted hover:decoration-accent transition-colors"
      >
        {children}
      </a>
    );
  },

  // ── Strong / Em ───────────────────────────────────────────────
  strong: ({ children }) => (
    <strong className="font-semibold text-ink">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic text-ink-soft">{children}</em>
  ),
};

export function MarkdownRenderer({ content }) {
  return (
    <div className="markdown-content text-[15px] font-reading leading-relaxed">
      {/* remarkGfm: GitHub-flavored markdown — tables, strikethrough, task
          lists, autolinks. Without it Claude's `| col | col |` tables come
          out as a single run-on text line (which is what was happening). */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
