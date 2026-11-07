import React, { useState } from 'react';
import { FileText, FilePlus2 } from '../Icon.jsx';
import { ToolCardShell, cardStatusOf } from './ToolCardShell.jsx';
import { DiffViewer } from '../DiffViewer.jsx';
// r64 M3:原来的私有 unifiedDiff 提到 utils/ 共用(genui 的 diff 节点也要拼同一种文本)。
import { unifiedDiff } from '../../utils/unifiedDiff.js';

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
    <ToolCardShell
      toolName={name}
      status={cardStatusOf(result)}
      Icon={FileIcon}
      title={fileName || '(未命名文件)'}
      titleMono
      titleHint={filePath}
      meta={(adds > 0 || dels > 0) ? (
        <>
          {adds > 0 && <span className="tc-add">+{adds}</span>}
          {dels > 0 && <span className="tc-del">−{dels}</span>}
        </>
      ) : null}
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
    >
      <div className="tc-sub font-mono truncate" title={filePath}>{opLabel} · {filePath}</div>
      {hunks.length === 0 ? (
        <div className="tc-sub">参数仍在传输…</div>
      ) : (
        <div className="space-y-2">
          {hunks.map((hunk, hi) => (
            <DiffViewer key={hi} diff={hunk.diff} maxHeight="max-h-64" />
          ))}
        </div>
      )}
      {isError && result?.content && (
        <pre className="tc-block tc-block-err whitespace-pre-wrap mt-2">
          {String(result.content).slice(0, 800)}
        </pre>
      )}
    </ToolCardShell>
  );
}
