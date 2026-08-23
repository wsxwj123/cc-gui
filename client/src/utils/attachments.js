function filePreviewDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function uploadAttachmentFile(file, { fetchImpl = fetch, previewReader = filePreviewDataUrl } = {}) {
  const response = await fetchImpl('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': file?.type || 'application/octet-stream',
      'X-Upload-Name': encodeURIComponent(file?.name || 'file'),
    },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  const isImage = data.kind === 'image' || String(file?.type || '').startsWith('image/');
  let preview = null;
  if (isImage) {
    try { preview = await previewReader(file); } catch {}
  }
  return {
    kind: data.kind || (isImage ? 'image' : 'text'),
    path: data.path,
    preview,
    name: file?.name || String(data.path || '').split(/[/\\]+/).pop() || 'file',
    bytes: data.bytes ?? file?.size ?? 0,
    status: 'uploaded',
  };
}

export function attachmentBlockReason(attachments) {
  const items = Array.isArray(attachments) ? attachments : [];
  if (items.some((item) => item?.status === 'uploading')) return 'uploading';
  if (items.some((item) => item?.status === 'failed')) return 'failed';
  return null;
}

export function buildAttachmentMessage(text, attachments) {
  const trimmed = String(text || '').trim();
  if (attachmentBlockReason(attachments)) return null;
  const ready = (Array.isArray(attachments) ? attachments : []).filter((item) => item?.path);
  if (!trimmed && ready.length === 0) return null;
  const attachmentRefs = ready.length
    ? `\n\n附件:\n${ready.map((item) => `@${item.path}`).join('\n')}`
    : '';
  const prompt = (trimmed || '请查看这些附件') + attachmentRefs;
  const meta = ready.length ? {
    attachments: ready.map((item) => ({
      kind: item.kind,
      name: item.name,
      path: item.path,
      preview: item.preview,
      bytes: item.bytes,
    })),
    displayText: trimmed,
  } : undefined;
  return { prompt, meta, displayText: trimmed };
}

// localStorage 队列只保存有界 preview。Home 页面仍持有完整内存预览；超过总预算的图片
// 在恢复/首卡中退化为带 name/path/bytes 的文件卡，绝不把 4MiB 图片膨胀后的 data URL
// 写进队列。预算按整条消息累计，而非“每附件”，多文件也有明确上限。
export const MAX_PERSISTED_ATTACHMENT_PREVIEW_CHARS = 96 * 1024;

export function attachmentMetaForPersistence(meta, maxPreviewChars = MAX_PERSISTED_ATTACHMENT_PREVIEW_CHARS) {
  if (!meta || !Array.isArray(meta.attachments)) return meta;
  const budget = Math.max(0, Number(maxPreviewChars) || 0);
  let used = 0;
  return {
    ...meta,
    attachments: meta.attachments.map((attachment) => {
      const preview = typeof attachment?.preview === 'string' ? attachment.preview : null;
      const keepPreview = !!preview && used + preview.length <= budget;
      if (keepPreview) used += preview.length;
      return { ...attachment, preview: keepPreview ? preview : null };
    }),
  };
}

let nextUploadId = 0;
export function pendingAttachment(file) {
  nextUploadId += 1;
  return {
    id: `attachment-${Date.now()}-${nextUploadId}`,
    file,
    name: file?.name || 'file',
    bytes: file?.size || 0,
    status: 'uploading',
  };
}
