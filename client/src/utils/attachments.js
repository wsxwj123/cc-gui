import { queueKeyFor } from './steerQueue.js';

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

export const ATTACHMENT_SIDECAR_OUTBOX_KEY = 'cgui-attachment-sidecar-outbox:v1';
// 同一页面可有多个 outbox manager（测试注入、热重载、未来多挂载点）。以 storage
// 对象为键共享 RMW 队尾，避免各 manager 拿独立旧快照后互相覆盖。
const attachmentStorageMutationTails = new WeakMap();

export function attachmentSidecarPayloadForPersistence(payload) {
  if (!payload || !Array.isArray(payload.attachments)) return payload;
  const bounded = attachmentMetaForPersistence({
    attachments: payload.attachments,
    displayText: payload.displayText || '',
  });
  return {
    ...payload,
    attachments: bounded.attachments,
    displayText: bounded.displayText,
  };
}

// 附件 sidecar 的本地 outbox 是恢复真相源。所有读改写经过同一 mutationTail，flush
// 则按 session 串行；成功响应删除条目时重新读取最新快照，因此另一 session 同时入队/出队
// 不会被旧快照覆盖。服务端按消息 textHash 写 sidecar，同一条目的重试天然幂等。
export function createAttachmentSidecarOutbox({
  storage = typeof localStorage === 'undefined' ? null : localStorage,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  makeId = null,
} = {}) {
  let sequence = 0;
  const sessionTails = new Map();
  const currentMutationTail = () => (
    storage ? (attachmentStorageMutationTails.get(storage) || Promise.resolve()) : Promise.resolve()
  );

  const read = () => {
    if (!storage) return [];
    try {
      const parsed = JSON.parse(storage.getItem(ATTACHMENT_SIDECAR_OUTBOX_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  };

  const mutate = (buildNext) => {
    const run = currentMutationTail().catch(() => {}).then(() => {
      if (!storage) return { ok: false, retained: false, error: 'storage-unavailable' };
      const current = read();
      const built = buildNext(current);
      const next = built?.next || current;
      try {
        const serialized = JSON.stringify(next);
        storage.setItem(ATTACHMENT_SIDECAR_OUTBOX_KEY, serialized);
        if (storage.getItem(ATTACHMENT_SIDECAR_OUTBOX_KEY) !== serialized) {
          return { ok: false, retained: false, error: 'persist-unverified' };
        }
        return { ok: true, retained: true, value: built?.value };
      } catch (error) {
        return { ok: false, retained: false, error: 'persist-failed', cause: error };
      }
    });
    if (storage) attachmentStorageMutationTails.set(storage, run.then(() => undefined, () => undefined));
    return run;
  };

  const stage = async ({ ownerKey = null, sessionId = null, payload }) => {
    if ((!ownerKey && !sessionId) || !payload?.attachments?.length) {
      return { ok: false, retained: false, error: 'invalid-entry' };
    }
    const boundedPayload = attachmentSidecarPayloadForPersistence(payload);
    const createdAt = now();
    const id = makeId
      ? makeId({ ownerKey, sessionId, payload: boundedPayload, createdAt })
      : `attachment-sidecar-${createdAt}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : ++sequence}`;
    return mutate((current) => {
      const existing = current.find((entry) => entry?.id === id);
      if (existing) return { next: current, value: existing };
      const entry = { id, ownerKey, sessionId, payload: boundedPayload, createdAt };
      return { next: [...current, entry], value: entry };
    });
  };

  const bindOwner = (ownerKey, sessionId) => {
    if (!ownerKey || !sessionId) return Promise.resolve({ ok: false, retained: false, error: 'invalid-binding' });
    return mutate((current) => ({
      next: current.map((entry) => (entry?.ownerKey === ownerKey && !entry?.sessionId
        ? { ...entry, sessionId }
        : entry)),
    }));
  };

  const withSessionLock = (sessionId, work) => {
    if (!sessionId) return Promise.resolve({ ok: false, retained: true, error: 'missing-session' });
    const previous = sessionTails.get(sessionId) || Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    sessionTails.set(sessionId, run);
    void run.finally(() => {
      if (sessionTails.get(sessionId) === run) sessionTails.delete(sessionId);
    });
    return run;
  };

  const postEntry = async (entry, sessionId) => {
    let response;
    try {
      response = await fetchImpl(`/api/sessions/${sessionId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.payload),
      });
    } catch (cause) {
      return { ok: false, retained: true, error: 'network', cause };
    }
    if (!response?.ok) {
      return { ok: false, retained: true, error: 'http', status: response?.status };
    }
    const removed = await mutate((current) => ({
      next: current.filter((item) => item?.id !== entry.id),
    }));
    if (!removed.ok) {
      // POST 已成功但清账失败时保留条目，下次按同一 textHash 幂等重放。
      return { ...removed, retained: true };
    }
    return { ok: true, retained: false };
  };

  const flushSession = (sessionId) => withSessionLock(sessionId, async () => {
    for (;;) {
      await currentMutationTail();
      const entry = read().find((item) => item?.sessionId === sessionId);
      if (!entry) return { ok: true, retained: false };
      const posted = await postEntry(entry, sessionId);
      if (!posted.ok) return posted;
    }
  });

  // draft 恢复不能先把 UUID 扩写进 localStorage：接近 quota 时，绑定写入会失败，
  // 旧实现因此连本可成功的 POST 都不会发。这里以 ownerKey 直接发送；2xx 后才做
  // 缩小快照的删除。无匹配项只读不写，服务端 textHash 继续保证重放幂等。
  const flushOwner = (ownerKey, sessionId) => {
    if (!ownerKey || !sessionId) {
      return Promise.resolve({ ok: false, retained: true, matched: 0, error: 'invalid-binding' });
    }
    return withSessionLock(sessionId, async () => {
      let matched = 0;
      for (;;) {
        await currentMutationTail();
        const entry = read().find((item) => (
          item?.ownerKey === ownerKey && (!item?.sessionId || item.sessionId === sessionId)
        ));
        if (!entry) return { ok: true, retained: false, matched };
        matched += 1;
        const posted = await postEntry(entry, sessionId);
        if (!posted.ok) return { ...posted, matched };
      }
    });
  };

  const flushAll = async () => {
    await currentMutationTail();
    const sessionIds = [...new Set(read().map((entry) => entry?.sessionId).filter(Boolean))];
    const results = await Promise.all(sessionIds.map((sessionId) => flushSession(sessionId)));
    return results.find((result) => !result.ok) || { ok: true, retained: false };
  };

  const stageAndFlush = async (entry) => {
    const staged = await stage(entry);
    if (!staged.ok || !entry.sessionId) return staged;
    return flushSession(entry.sessionId);
  };

  const bindAndFlush = async (ownerKey, sessionId) => {
    const bound = await bindOwner(ownerKey, sessionId);
    if (!bound.ok) return bound;
    return flushSession(sessionId);
  };

  const ownerKeys = () => new Set(read().map((entry) => entry?.ownerKey).filter(Boolean));

  return { read, ownerKeys, stage, bindOwner, flushOwner, flushSession, flushAll, stageAndFlush, bindAndFlush };
}

const attachmentSidecarOutbox = createAttachmentSidecarOutbox();

export const persistAttachmentSidecar = (entry) => attachmentSidecarOutbox.stageAndFlush(entry);
export const bindAttachmentSidecars = (ownerKey, sessionId) => attachmentSidecarOutbox.flushOwner(ownerKey, sessionId);
export const pendingAttachmentSidecarOwnerKeys = () => attachmentSidecarOutbox.ownerKeys();
export const retryAttachmentSidecars = (sessionId = null) => (
  sessionId ? attachmentSidecarOutbox.flushSession(sessionId) : attachmentSidecarOutbox.flushAll()
);

export async function recoverAttachmentSidecarBindings(bindings, {
  bindImpl = bindAttachmentSidecars,
  ownerKeys = pendingAttachmentSidecarOwnerKeys(),
} = {}) {
  const unique = new Map();
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    if (binding?.ownerKey && binding?.sessionId && ownerKeys?.has(binding.ownerKey)) {
      unique.set(`${binding.ownerKey}\0${binding.sessionId}`, binding);
    }
  }
  const results = await Promise.all([...unique.values()].map(async ({ ownerKey, sessionId }) => {
    try {
      return await bindImpl(ownerKey, sessionId);
    } catch (cause) {
      return { ok: false, retained: true, error: 'unexpected', cause };
    }
  }));
  const failed = results.find((result) => !result?.ok);
  return failed
    ? { ...failed, ok: false, matched: results.length, results }
    : { ok: true, retained: false, matched: results.length, results };
}

export function draftSidecarBindingsForSessions(sessions, projectHash) {
  if (!projectHash || !Array.isArray(sessions)) return [];
  return sessions
    .filter((session) => session?.draftId && session?.sessionId)
    .map((session) => ({
      ownerKey: queueKeyFor({ projectHash, draftId: session.draftId }),
      sessionId: session.sessionId,
    }));
}

export function bindDraftAttachmentSidecarsOnInit(startedSession, sessionId, { bindImpl = bindAttachmentSidecars } = {}) {
  if (startedSession?.sessionId || !startedSession?.draftId || !sessionId) {
    return Promise.resolve({ ok: false, retained: true, error: 'not-draft-init' });
  }
  return bindImpl(queueKeyFor(startedSession), sessionId);
}

export function attachmentSidecarNotice(result) {
  if (!result || result.ok) return null;
  if (result.retained) return '附件卡片暂未同步，已保存在本机恢复队列；将在挂载或下次发送时自动重试。';
  return '附件卡片未能写入本地恢复队列（本地存储空间不足或不可用）；消息仍会发送，但刷新后卡片可能无法恢复。';
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
