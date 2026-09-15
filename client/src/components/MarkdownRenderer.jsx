import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css'; // CJ-3:KaTeX 样式(katex 本体经 mermaid 已在依赖里)
import { openExternalUrl } from '../utils/openExternal.js';
import {
  resolveImageSrc, preprocessImages, oversizedImageDataNote,
} from '../utils/markdownImages.js';
import { ArtifactPreview, isPreviewable } from './ArtifactPreview.jsx';
import { CodeBlock } from './CodeBlock.jsx';
import { isGenuiLang } from './GenuiFence.jsx';
import { GenuiFenceGate } from './GenuiFenceGate.jsx';
import { dockKeyFor } from '../utils/artifactDock.js';

// 围栏代码渲染。抽成函数以便注入 dockKeyPrefix(#3 稳定停靠身份的前缀);node 由
// react-markdown 透传(passNode),node.position.start.offset 是本块在源文本中的起始偏移。
function renderCode({ children, className, node, dockKeyPrefix, isStreaming, ...props }) {
  // children 空值守卫:围栏刚开头(```lang 已到、正文一个字都还没到)时 react-markdown 给的
  // children 是 undefined,String(undefined) 会把字面量 "undefined" 当代码显示出来。
  // 这是既有瑕疵(今天任何语言的围栏在流式首帧都会闪一下),修在这个共用点一次覆盖所有语言。
  const codeStr = children == null ? '' : String(children).replace(/\n$/, '');
  // 块级判定:有 language-xxx 类名(带语言的围栏),或内容含换行。
  // 行内代码按 markdown 定义恒为单行,故"含换行"必是围栏代码块 —— 这一条专门兜住
  // **没标语言的围栏块**(纯 ``` ),否则它无 language- 类名会被误当行内,多行被压成
  // 一段"段落式"橙色等宽文字(用户截图的根因)。
  const isBlock = className?.includes('language-') || codeStr.includes('\n');
  const lang = className?.replace('language-', '') || '';

  if (isBlock) {
    // genui 围栏拦截(r64):cgui-ui / dsh-ui 两个标记就地渲染成组件。放在 isPreviewable
    // 之前只是顺序上的明确 —— 这两个标记不在可预览集合里,html/svg/mermaid 的既有预览
    // 行为一字不变(INTERFACE §1.1 并存要求)。
    // isStreaming 由调用点透传(TurnBubble 的 isLive/isLiveStream),不传即已定稿。
    // 经 GenuiFenceGate 而不是直接 GenuiFence:设置里的渲染开关关掉时退回普通代码块(§4.1)。
    if (isGenuiLang(lang)) return <GenuiFenceGate raw={codeStr} lang={lang} settled={!isStreaming} />;
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


// isStreaming:本条消息是否还在流式产出。genui 围栏据此决定要不要做结构补全、要不要
// 报解析失败(PLAN §1.4)。只有会渲染流式正文的调用点需要传(TurnBubble 三处),其余
// 一律不传 = 已定稿。**不查 DOM**:DOM 探测在 React 19 并发渲染下时序不可靠。
export function MarkdownRenderer({ content, basePath, dockKeyPrefix, isStreaming = false }) {
  // basePath/dockKeyPrefix 变化时才重建 components,避免每次渲染都生成新组件。
  // dockKeyPrefix 在流式全程稳定(turn.uuid 恒为 'streaming' 哨兵 + 块序号),故不会抖动。
  const components = useMemo(() => ({
    ...markdownComponents,
    // #3 注入 dockKeyPrefix,让可预览代码块拿到稳定停靠身份。
    code: (props) => renderCode({ ...props, dockKeyPrefix, isStreaming }),
    img: ({ src, alt, title }) => {
      const resolved = resolveImageSrc(src, basePath);
      const oversized = oversizedImageDataNote(resolved);
      // 超限 data 图片只给占位:整个 base64 字符串不进 DOM(几 MB 的 src 属性同样拖垮渲染)。
      if (oversized) {
        return (
          <div className="my-3 rounded border border-canvas-deep bg-canvas-warm px-3 py-2 text-[13px] text-ink-muted">
            🖼 {alt || '图片'} — {oversized}
          </div>
        );
      }
      return (
        <img
          src={resolved}
          alt={alt || ''}
          title={title}
          loading="lazy"
          className="max-w-full h-auto my-3 rounded border border-canvas-deep"
        />
      );
    },
  }), [basePath, dockKeyPrefix, isStreaming]);
  // 聊天气泡与文件预览统一做图片正文预处理(修复前聊天气泡保持原文,用户只看到路径)。
  // isStreaming 透传:流式中末行不转换,防半截 base64 的 img src 逐 chunk 增长反复重解码。
  const text = useMemo(() => preprocessImages(content, isStreaming), [content, isStreaming]);
  return (
    <div className="markdown-content text-[15px] font-reading leading-relaxed">
      {/* remarkGfm: GitHub-flavored markdown — tables, strikethrough, task
          lists, autolinks. Without it Claude's `| col | col |` tables come
          out as a single run-on text line (which is what was happening). */}
      {/* urlTransform 恒等:react-markdown 默认会把 `C:\`、`data:` 等非 http 协议的
          src 删成空(聊天气泡 data: 图片"明明写了却不显示"的根因之一)。关掉过滤让
          本地路径/data URL 原样进 img 组件;安全兜底:a 组件 href 白名单照旧生效,
          img 的 src 在浏览器里不执行脚本,data:/blob: 均为惰性资源。 */}
      {/* CJ-3:remarkMath 解析 $...$ / $$...$$,rehypeKatex 渲染成公式。rehype-katex 默认
          throwOnError:false → 错误公式标红不崩。注:不处理 \(..\) / \[..\](Claude 多用 $),
          如需可后续加预处理转换。 */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
        urlTransform={(u) => u}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
