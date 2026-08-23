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
