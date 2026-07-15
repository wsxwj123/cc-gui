import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css'; // CJ-3:KaTeX 样式(katex 本体经 mermaid 已在依赖里)
import { Copy, Check } from 'lucide-react';
import { copyText } from '../utils/clipboard.js';
import { openExternalUrl } from '../utils/openExternal.js';
import { ArtifactPreview, isPreviewable, CollapsibleCode } from './ArtifactPreview.jsx';
import { dockKeyFor } from '../utils/artifactDock.js';

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
// 折叠逻辑抽到 ArtifactPreview 的 CollapsibleCode 共用(artifact 代码视图同款,防漂移)。
function CodeBlock({ lang, code }) {
  return (
    <div className="relative group my-3">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#2b2722] rounded-t-lg border border-[#3a342b] border-b-0">
        <span className="text-[11px] font-mono text-[#9a8e78]">{lang || 'code'}</span>
        <CopyButton text={code} />
      </div>
      <CollapsibleCode
        code={code}
        className="bg-[#211e19] border border-[#3a342b] border-t-0 p-4 overflow-x-auto text-[13px] leading-relaxed font-mono text-[#e8e2d6]"
      />
    </div>
  );
}

// 围栏代码渲染。抽成函数以便注入 dockKeyPrefix(#3 稳定停靠身份的前缀);node 由
// react-markdown 透传(passNode),node.position.start.offset 是本块在源文本中的起始偏移。
function renderCode({ children, className, node, dockKeyPrefix, ...props }) {
  const codeStr = String(children).replace(/\n$/, '');
  // 块级判定:有 language-xxx 类名(带语言的围栏),或内容含换行。
  // 行内代码按 markdown 定义恒为单行,故"含换行"必是围栏代码块 —— 这一条专门兜住
  // **没标语言的围栏块**(纯 ``` ),否则它无 language- 类名会被误当行内,多行被压成
  // 一段"段落式"橙色等宽文字(用户截图的根因)。
  const isBlock = className?.includes('language-') || codeStr.includes('\n');
  const lang = className?.replace('language-', '') || '';

  if (isBlock) {
    // html/svg/mermaid 代码块给「代码/预览」切换;其余语言走普通代码块。
    if (isPreviewable(lang)) {
      const dockKey = dockKeyFor(dockKeyPrefix, node?.position?.start?.offset);
      return <ArtifactPreview lang={lang} code={codeStr} dockKey={dockKey} />;
    }
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
  // 无 dockKeyPrefix 版(默认);MarkdownRenderer 有前缀时在 useMemo 里覆盖注入。
  code: (props) => renderCode(props),

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
        // Tauri 壳(WKWebView/WebView2)拦截 target=_blank 跳转 → 点击无反应(#10)。
        // 改为走 openExternalUrl(经 /api/open-url 用 OS shell 开默认浏览器);浏览器
        // 模式下该 helper 自动 fallback 到 window.open,两端都能正常打开。
        onClick={safe ? (e) => { e.preventDefault(); openExternalUrl(href.trim()); } : undefined}
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
  let rel = s.replace(/\\/g, '/');
  // react-markdown 会把 URL 里的空格等编码成 %20。先解码回字面路径,末尾再 encodeURIComponent
  // 单次编码,否则 `%20` 会被二次编码成 `%2520` → 文件名对不上 → 404。
  try { rel = decodeURIComponent(rel); } catch {}
  // AI 常把绝对路径误拼成 ./ ../ // 开头的畸形相对路径(如 `..//Users/...`)。
  // 剥掉开头的 ./ ../ / 后若紧跟一个绝对路径(/Users、/home 或盘符 C:/),按绝对处理。
  const embedded = rel.match(/^[./]*((?:\/(?:Users|home)\/|[A-Za-z]:\/).*)$/);
  if (embedded) rel = embedded[1];
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

// AI 生成的 ![alt](路径含空格) 不符合 CommonMark:URL 含空格必须用 <> 包裹或编码,
// 否则解析器在第一个空格处断开 → 整条不被识别为图片,渲染成纯文本(用户截图就是这样)。
// 给"含空格、未包裹、非外链、无标题"的图片 URL 套上 <>,让它能被解析成 <img>。
function wrapSpacedImageUrls(md) {
  if (!md) return md;
  return md.replace(/(!\[[^\]]*\]\()([^)]+)(\))/g, (full, pre, url, post) => {
    const u = url.trim();
    if (u.startsWith('<') || u.includes('"') || /^(https?:|data:|blob:)/i.test(u) || !u.includes(' ')) return full;
    return `${pre}<${u}>${post}`;
  });
}

export function MarkdownRenderer({ content, basePath, dockKeyPrefix }) {
  // basePath/dockKeyPrefix 变化时才重建 components,避免每次渲染都生成新组件。
  // dockKeyPrefix 在流式全程稳定(turn.uuid 恒为 'streaming' 哨兵 + 块序号),故不会抖动。
  const components = useMemo(() => ({
    ...markdownComponents,
    // #3 注入 dockKeyPrefix,让可预览代码块拿到稳定停靠身份。
    code: (props) => renderCode({ ...props, dockKeyPrefix }),
    img: ({ src, alt, title }) => (
      <img
        src={resolveImageSrc(src, basePath)}
        alt={alt || ''}
        title={title}
        loading="lazy"
        className="max-w-full h-auto my-3 rounded border border-canvas-deep"
      />
    ),
  }), [basePath, dockKeyPrefix]);
  // 仅文件预览(有 basePath)才预处理空格图片 URL,聊天气泡保持原文不动。
  const text = useMemo(() => (basePath ? wrapSpacedImageUrls(content) : content), [content, basePath]);
  return (
    <div className="markdown-content text-[15px] font-reading leading-relaxed">
      {/* remarkGfm: GitHub-flavored markdown — tables, strikethrough, task
          lists, autolinks. Without it Claude's `| col | col |` tables come
          out as a single run-on text line (which is what was happening). */}
      {/* urlTransform 恒等(仅文件预览):默认会把 Windows 绝对路径 C:\ 当协议删掉,
          这里关掉过滤让本地路径原样进 img 组件;链接安全由 a 组件的 href 白名单兜底。 */}
      {/* CJ-3:remarkMath 解析 $...$ / $$...$$,rehypeKatex 渲染成公式。rehype-katex 默认
          throwOnError:false → 错误公式标红不崩。注:不处理 \(..\) / \[..\](Claude 多用 $),
          如需可后续加预处理转换。 */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
        urlTransform={basePath ? ((u) => u) : undefined}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
