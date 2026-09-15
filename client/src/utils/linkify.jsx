import React from 'react';
import { openExternalUrl } from './openExternal.js';

// 纯文本里的裸 URL → 可点击链接(点开默认浏览器,与 markdown `a` 组件同通道)。
// 用于不走 MarkdownRenderer 的纯文本面:工具输出(Bash/MCP 卡)、用户气泡等。
// 只认 http(s),边界排除常见尾随标点与括号(markdown/论坛链接常被包住)。
const URL_RE = /https?:\/\/[^\s<>"'）)\]}]+[^\s<>"'）)\]{}.,;:!?]/g;

export function Linkify({ text, className = '' }) {
  const s = String(text ?? '');
  if (!s) return null;
  const parts = [];
  let last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s)) !== null) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  parts.push(s.slice(last));
  if (parts.length === 1) return <span className={className}>{s}</span>;
  return (
    <span className={className}>
      {parts.map((p, i) => (/^https?:\/\//.test(p) ? (
        <a
          key={i}
          href={p}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => { e.preventDefault(); openExternalUrl(p); }}
          className="text-accent hover:text-accent-hover underline underline-offset-2 break-all"
        >
          {p}
        </a>
      ) : p))}
    </span>
  );
}
