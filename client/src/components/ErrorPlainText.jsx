import React from 'react';
import { Linkify } from '../utils/linkify.jsx';

// r183:对话里的报错原文(上游接口 / 命令行 / 发送失败给出的文字)原样显示。
// 报错原文不是模型的话,可能来自不可信的中转站,不交给 MarkdownRenderer:
// 不解释 Markdown / HTML 写法、不出图片、不画 cgui-ui 组件,保留换行。
// 裸写的 http(s) 地址经 Linkify 变成可点链接(显示的文字就是真实地址,与工具输出同款)。
// 字号、行高、颜色与 .markdown-content 正文一致(15px / 1.7 / ink-soft)。
export default function ErrorPlainText({ text }) {
  return (
    <div
      data-cgui="error-text"
      className="text-[15px] font-reading whitespace-pre-wrap [overflow-wrap:anywhere]"
      style={{ lineHeight: 1.7, color: 'var(--color-ink-soft)' }}
    >
      <Linkify text={text} />
    </div>
  );
}
