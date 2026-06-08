import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';
import { copyText } from '../utils/clipboard.js';
import { ArtifactPreview, isPreviewable } from './ArtifactPreview.jsx';

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="flex items-center gap-1 text-[10px] text-[#9a8e78] hover:text-[#cabba0] transition-colors"
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? '已复制' : '复制'}
    </button>
  );
}

// Code block with copy + collapse: long blocks show the first 5 lines and a
// toggle to expand the rest (keeps long tool output / files from flooding chat).
function CodeBlock({ lang, code }) {
  const lines = code.split('\n');
  const COLLAPSE_AT = 5;
  const collapsible = lines.length > COLLAPSE_AT;
  const [expanded, setExpanded] = useState(false);
  const shown = collapsible && !expanded ? lines.slice(0, COLLAPSE_AT).join('\n') : code;
  return (
    <div className="relative group my-3">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#2b2722] rounded-t-lg border border-[#3a342b] border-b-0">
        <span className="text-[11px] font-mono text-[#9a8e78]">{lang || 'code'}</span>
        <CopyButton text={code} />
      </div>
      <pre className={`bg-[#211e19] border border-[#3a342b] border-t-0 p-4 overflow-x-auto text-[13px] leading-relaxed font-mono text-[#e8e2d6] ${collapsible ? 'rounded-b-none' : 'rounded-b-lg'}`}>
        <code>{shown}</code>
      </pre>
      {collapsible && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full text-[11px] font-mono text-[#9a8e78] hover:text-[#cabba0] bg-[#2b2722] border border-[#3a342b] border-t-0 rounded-b-lg py-1 transition-colors"
        >
          {expanded ? '收起' : `展开剩余 ${lines.length - COLLAPSE_AT} 行 ▾`}
        </button>
      )}
    </div>
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
      // html/svg/mermaid 代码块给「代码/预览」切换;其余语言走普通代码块。
      if (isPreviewable(lang)) return <ArtifactPreview lang={lang} code={codeStr} />;
      return <CodeBlock lang={lang} code={codeStr} />;
    }

    return (
      <code
        className="bg-canvas-warm border border-canvas-deep px-1.5 py-0.5 rounded text-[0.88em] font-mono text-accent"
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

// 把 markdown 图片 src 解析成 webview 能加载的地址。相对/绝对文件系统路径
// 改写到 raw 文件端点(相对 md 文件自身目录解析);http(s)/data/blob 原样保留。
// 没有 basePath(如聊天气泡)则不改写,保持原行为。
function resolveImageSrc(src, basePath) {
  if (!src) return src;
  const s = String(src).trim();
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  if (!basePath) return s;
  const baseDir = String(basePath).replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  const rel = s.replace(/\\/g, '/');
  const isAbs = rel.startsWith('/') || /^[A-Za-z]:\//.test(rel);
  const joined = isAbs ? rel : `${baseDir}/${rel}`;
  // 折叠 ./ 与 ../,保留路径前缀(POSIX 的 `/` 或 Windows 的 `C:/`)
  const m = joined.match(/^([A-Za-z]:\/|\/)/);
  const prefix = m ? m[0] : '/';
  const out = [];
  for (const seg of joined.slice(prefix.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/api/files/read?path=${encodeURIComponent(prefix + out.join('/'))}&raw=1`;
}

export function MarkdownRenderer({ content, basePath }) {
  // basePath 变化时才重建 components,避免每次渲染都生成新 img 组件。
  const components = useMemo(() => ({
    ...markdownComponents,
    img: ({ src, alt, title }) => (
      <img
        src={resolveImageSrc(src, basePath)}
        alt={alt || ''}
        title={title}
        loading="lazy"
        className="max-w-full h-auto my-3 rounded border border-canvas-deep"
      />
    ),
  }), [basePath]);
  return (
    <div className="markdown-content text-[15px] font-reading leading-relaxed">
      {/* remarkGfm: GitHub-flavored markdown — tables, strikethrough, task
          lists, autolinks. Without it Claude's `| col | col |` tables come
          out as a single run-on text line (which is what was happening). */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
