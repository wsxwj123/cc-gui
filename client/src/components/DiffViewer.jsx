import React from 'react';

export function parseDiffLines(diffText) {
  // ---/+++ 文件头只在前两行:正文里被删/增的行本身以 `--`/`++` 开头(SQL 注释等)
  // 拼上 diff 符号后同为 ---/+++ 前缀,全局按前缀判会把它渲染成灰色文件头。
  return String(diffText || '').split('\n').map((text, i) => {
    if (i < 2 && (text.startsWith('+++') || text.startsWith('---'))) return { type: 'file', text };
    if (text.startsWith('@@')) return { type: 'hunk', text };
    if (text.startsWith('+')) return { type: 'add', text };
    if (text.startsWith('-')) return { type: 'del', text };
    return { type: 'ctx', text };
  });
}

export function DiffViewer({ diff, maxHeight = 'max-h-72' }) {
  const lines = parseDiffLines(diff).filter((line) => line.text !== '');
  if (lines.length === 0) {
    return <div className="text-[11px] text-ink-faint font-body px-3 py-2">没有可显示的 diff</div>;
  }

  return (
    <pre className={`text-[11px] font-mono leading-relaxed overflow-auto ${maxHeight}`}>
      {lines.map((line, i) => {
        const cls = line.type === 'add'
          ? 'bg-green-50 text-green-800'
          : line.type === 'del'
            ? 'bg-red-50 text-red-800'
            : line.type === 'hunk'
              ? 'bg-blue-50 text-blue-800'
              : line.type === 'file'
                ? 'bg-canvas-warm text-ink-muted'
                : 'text-ink-muted';
        return (
          <div key={i} className={`px-3 py-px whitespace-pre ${cls}`}>
            {line.text || ' '}
          </div>
        );
      })}
    </pre>
  );
}
