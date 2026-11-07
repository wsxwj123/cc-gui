import React, { useState } from 'react';
import { FileText } from '../Icon.jsx';
import { ToolCardShell, cardStatusOf } from './ToolCardShell.jsx';
import { ToolResultImages } from './ToolResultImages.jsx';

const PREVIEW_LINES = 10;
const MAX_EXPANDED_LINES = 400;

export function ReadCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const filePath = toolCall.input?.file_path || '';
  const fileName = filePath.split(/[/\\]+/).pop() || filePath;
  const offset = toolCall.input?.offset;
  const limit = toolCall.input?.limit;
  const result = toolCall.result;
  const isError = result?.isError;
  const content = typeof result?.content === 'string' ? result.content : '';
  // r132:Read 读的若是图片,结果里没有一行正文、只有 image 块(Anthropic source:{data} 等)。
  // 以前这张卡只渲染文本 → 卡片显示"1 行"、图完全看不到,用户只能去文件浏览器。现在出图,
  // 与 MCP 卡同一套(点开可放大)。折叠态仍默认收起,但标题上写清"图片 N 张",不用瞎点。
  const images = Array.isArray(result?.images) ? result.images.filter((i) => i && i.data) : [];
  const allLines = content.split('\n');
  const shown = expanded
    ? allLines.slice(0, MAX_EXPANDED_LINES).join('\n')
    : allLines.slice(0, PREVIEW_LINES).join('\n');

  // Range chip ("行 1-50" / "前 200 行" / "")
  let rangeLabel = '';
  if (offset && limit) rangeLabel = `行 ${offset}–${offset + limit - 1}`;
  else if (offset) rangeLabel = `从行 ${offset}`;
  else if (limit) rangeLabel = `前 ${limit} 行`;

  const countLabel = !result || isError
    ? ''
    : images.length > 0 ? `图片 ${images.length} 张` : `${allLines.length} 行`;

  return (
    <ToolCardShell
      toolName={toolCall.name || 'Read'}
      status={cardStatusOf(result)}
      Icon={FileText}
      title={fileName || '(未命名文件)'}
      titleMono
      titleHint={filePath}
      meta={(rangeLabel || countLabel) ? (
        <>
          {rangeLabel && <span>{rangeLabel}</span>}
          {countLabel && <span>{countLabel}</span>}
        </>
      ) : null}
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
    >
      {filePath && <div className="tc-sub font-mono truncate" title={filePath}>{filePath}</div>}
      {result && !isError && images.length > 0 && (
        <div className="pb-2" data-testid="read-card-images">
          <ToolResultImages images={images} name={fileName || '图片'} />
        </div>
      )}
      {/* 读图时 content 通常只剩一个空串/一行占位,不必再画一块空 <pre> */}
      {result && !isError && content && !(images.length > 0 && content.trim() === '') && (
        <pre className="tc-block whitespace-pre max-h-[600px]">
          {shown}
        </pre>
      )}
      {result && isError && (
        <pre className="tc-block tc-block-err whitespace-pre-wrap">
          {String(result.content || '').slice(0, 500)}
        </pre>
      )}
    </ToolCardShell>
  );
}
