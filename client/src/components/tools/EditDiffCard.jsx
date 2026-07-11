import React, { useState } from 'react';
import { FileText, ChevronDown, ChevronRight, Loader2, FilePlus2 } from 'lucide-react';
import { DiffViewer } from '../DiffViewer.jsx';

function unifiedDiff(filePath, oldStr, newStr, label = 'change') {
  const file = String(filePath || label).replace(/^[/\\]+/, '');
  const oldLines = oldStr == null ? [] : String(oldStr).split('\n');
  const newLines = newStr == null ? [] : String(newStr).split('\n');
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@',
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

export function EditDiffCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const name = toolCall.name;
  const filePath = toolCall.input?.file_path || '';
  const fileName = filePath.split(/[/\\]+/).pop() || filePath;
  const result = toolCall.result;
  const isError = result?.isError;

  let hunks = [];
  if (name === 'Edit') {
    if (toolCall.input?.old_string != null || toolCall.input?.new_string != null) {
      hunks = [{ diff: unifiedDiff(filePath, toolCall.input.old_string ?? '', toolCall.input.new_string ?? '') }];
    }
  } else if (name === 'MultiEdit') {
    const edits = Array.isArray(toolCall.input?.edits) ? toolCall.input.edits : [];
    hunks = edits.map((e, i) => ({
      diff: unifiedDiff(filePath, e.old_string ?? '', e.new_string ?? '', `edit-${i + 1}`),
    }));
  } else if (name === 'Write') {
    const content = toolCall.input?.content || '';
    if (content) hunks = [{ diff: unifiedDiff(filePath, null, content, 'new-file') }];
  }

  // ---/+++ 文件头只在每个 hunk 的前两行;正文里 `--`/`++` 开头的内容行(SQL 注释等)
  // 拼上 diff 符号后同前缀,全局排除会少计(与 file-changes.js diffStats 同口径)。
  const countHunk = (diff) => {
    let a = 0, d = 0;
    diff.split('\n').forEach((l, i) => {
      if (i < 2 && (l.startsWith('+++') || l.startsWith('---'))) return;
      if (l.startsWith('+')) a += 1; else if (l.startsWith('-')) d += 1;
    });
    return [a, d];
  };
  const adds = hunks.reduce((acc, h) => acc + countHunk(h.diff)[0], 0);
  const dels = hunks.reduce((acc, h) => acc + countHunk(h.diff)[1], 0);

  const opLabel = name === 'Write' ? '新建' : name === 'MultiEdit' ? `${hunks.length} 处改动` : '编辑';
  const FileIcon = name === 'Write' ? FilePlus2 : FileText;

  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden bg-canvas animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 bg-canvas-warm hover:bg-canvas-deep/40 transition-colors text-left"
      >
        {expanded
          ? <ChevronDown size={12} className="text-ink-faint shrink-0" />
          : <ChevronRight size={12} className="text-ink-faint shrink-0" />}
        <FileIcon size={12} className="text-accent shrink-0" />
        <span className="text-xs font-mono text-ink-soft truncate">{fileName}</span>
        <span className="text-[10px] text-ink-faint font-body shrink-0">{opLabel}</span>
        <span className="ml-auto flex items-center gap-2 text-[10px] font-mono shrink-0">
          {dels > 0 && <span className="text-red-500">−{dels}</span>}
          {adds > 0 && <span className="text-green-600">+{adds}</span>}
        </span>
        {!result && <Loader2 size={11} className="text-ink-faint animate-spin shrink-0" />}
        {result && (isError
          ? <span className="text-red-500 text-[10px] shrink-0">错误</span>
          : <span className="text-success text-[10px] shrink-0">✓</span>)}
      </button>

      {expanded && (
        <div className="border-t border-canvas-deep">
          <div className="px-3 py-1 text-[9px] text-ink-ghost truncate font-mono">{filePath}</div>
          {hunks.length === 0 ? (
            <div className="px-3 py-2 text-[10px] text-ink-faint font-body">参数仍在传输…</div>
          ) : hunks.map((hunk, hi) => (
            <div key={hi} className={hi > 0 ? 'border-t border-canvas-deep' : ''}>
              <DiffViewer diff={hunk.diff} maxHeight="max-h-64" />
            </div>
          ))}
          {isError && result?.content && (
            <div className="border-t border-canvas-deep px-3 py-2 text-[11px] text-red-700 bg-red-50/50 font-mono whitespace-pre-wrap">
              {String(result.content).slice(0, 800)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
