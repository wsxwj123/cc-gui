import React from 'react';
import { FileText, Loader2, RefreshCw, X } from './Icon.jsx';

export function PendingAttachmentList({ attachments, onRemove, onRetry, onPreview }) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-2 px-2">
      {attachments.map((attachment) => {
        const key = attachment.id || attachment.path || attachment.name;
        const uploadedImage = attachment.status !== 'failed' && attachment.kind === 'image' && attachment.preview;
        return (
          <div key={key} data-testid="attachment-item" className="relative group/att">
            {uploadedImage ? (
              <img
                src={attachment.preview}
                alt={attachment.name}
                onClick={() => onPreview?.(attachment)}
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
      })}
    </div>
  );
}
