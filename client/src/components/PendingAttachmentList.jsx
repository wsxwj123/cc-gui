import React from 'react';
import { FileText, Loader2, RefreshCw, X } from './Icon.jsx';
import { imageAttachmentSrc } from '../utils/attachments.js';
import { useAttachmentImageSrc } from '../hooks/useAttachmentImageSrc.js';

// r192:单张卡片。图片来源用 imageAttachmentSrc(预览优先;没有预览——大图、从待发列表取出的图、
// 编辑重发放回来的图——就按路径读原图),按路径读的来源经 useAttachmentImageSrc 加载(并发闸门 +
// 429 退避)。加载中 / 加载失败画成文件名卡片,不画破图;上传中、上传失败不读图,画法不变。
function PendingAttachmentCard({ attachment, onRemove, onRetry, onPreview }) {
  const isImage = attachment.kind === 'image' && attachment.status !== 'failed';
  // 上传中只认现成预览(与原画法一致),不按路径读图;上传完成后才退回按路径读原图。
  const imageSrc = !isImage ? null
    : attachment.status === 'uploading' ? (attachment.preview || null)
    : imageAttachmentSrc(attachment);
  const { src: displaySrc } = useAttachmentImageSrc(imageSrc);
  const uploadedImage = isImage && !!displaySrc;
  return (
    <div data-testid="attachment-item" className="relative group/att">
      {uploadedImage ? (
        <img
          src={displaySrc}
          alt={attachment.name}
          onClick={() => onPreview?.(attachment, displaySrc)}
          className="h-16 w-16 object-cover rounded-lg border border-canvas-deep shadow-panel cursor-zoom-in"
        />
      ) : (
        <div className={`h-16 w-40 rounded-lg border px-2 py-2 flex items-center gap-2 ${attachment.status === 'failed' ? 'border-error/40 bg-error-subtle/40' : 'border-canvas-deep bg-canvas-warm shadow-panel'}`}>
          {attachment.status === 'uploading'
            ? <Loader2 size={18} className="text-accent shrink-0 animate-spin" />
            : <FileText size={18} className={attachment.status === 'failed' ? 'text-error shrink-0' : 'text-accent shrink-0'} />}
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-ink font-body truncate" title={attachment.name}>{attachment.name}</div>
            <div className={`text-[9px] font-body truncate ${attachment.status === 'failed' ? 'text-error' : 'text-ink-faint'}`}>
              {attachment.status === 'uploading' ? '上传中…'
                : attachment.status === 'failed' ? (attachment.error || '上传失败')
                : `${Math.ceil((attachment.bytes || 0) / 1024)} KB`}
            </div>
          </div>
          {attachment.status === 'failed' && onRetry && (
            <button type="button" onClick={() => onRetry(attachment)} title="重试上传"
              className="p-1 rounded text-error hover:bg-error/10 shrink-0">
              <RefreshCw size={12} />
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="attachment-remove"
        onClick={() => onRemove?.(attachment)}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-canvas-deep text-ink-soft hover:bg-error hover:text-white flex items-center justify-center transition-colors opacity-100 md:opacity-0 md:group-hover/att:opacity-100"
        title="移除"
        aria-label={`移除附件 ${attachment.name || ''}`}
      >
        <X size={11} />
      </button>
      {uploadedImage && (
        <span className="absolute bottom-0 left-0 right-0 text-[9px] text-white bg-black/60 px-1 py-px rounded-b-lg truncate text-center">
          {attachment.name}
        </span>
      )}
    </div>
  );
}

export function PendingAttachmentList({ attachments, onRemove, onRetry, onPreview }) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-2 px-2">
      {attachments.map((attachment) => (
        <PendingAttachmentCard
          key={attachment.id || attachment.path || attachment.name}
          attachment={attachment}
          onRemove={onRemove}
          onRetry={onRetry}
          onPreview={onPreview}
        />
      ))}
    </div>
  );
}
