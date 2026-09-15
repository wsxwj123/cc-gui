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

// R08:图片附件的显示来源。preview(持久化预算内的 data URL)优先;没有 preview 时退回受权的
// 原图字节入口 —— "图片大/刷新后 preview 为空就整张不显示"是用户实报缺陷。持久化预算不变,
// 这里不重新存整图。都没有 → null(调用方按"图片不可用"占位处理)。
export function imageAttachmentSrc(attachment) {
  if (typeof attachment?.preview === 'string' && attachment.preview) return attachment.preview;
  if (typeof attachment?.path === 'string' && attachment.path) {
    return `/api/files/read?path=${encodeURIComponent(attachment.path)}&raw=1`;
  }
  return null;
}

// R09:一条消息的图片序列(灯箱只在这条序列里导航)。只数"能显示出来的图片"——
// 非图片附件跳过、既无 preview 又无 path 的跳过;顺序就是附件原顺序。调用方还要剔除
// 【加载失败】的(元数据说有来源、实际 403/404/解码失败),见 MessageBubble 的
// imageStates —— 否则计数与卡片矛盾、还能翻到破图上。
export function imageAttachmentSequence(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((attachment) => attachment?.kind === 'image' && imageAttachmentSrc(attachment));
}

// R08(阶段05 抽查第 4 条):raw 原图入口的并发是【进程级全局配额】—— INTERFACE 明文
// "最多 4 个并行 raw 读,超出 429 FILE_READ_BUSY",它与文件树预览、正文 markdown 图共用;
// 而前端图片一次 onError 就闩死"图片不可用"、明确不重试 → 一条消息里第 5 张及以后的图
// 永久显示不出来(文件其实存在)。修法:只对 429(并发配额)做【有界】退避重试,其余
// 4xx/5xx 与网络错误立刻判失败 —— 不做"失败无限自动重试"(合同明文禁止)。
export const IMAGE_READ_BUSY_RETRY_DELAYS_MS = [250, 700, 1500];
// 光退避重试不够:一条消息 6 张图时,6 个请求同一时刻重试又会一起撞 4 个上限,最后总有
// 若干张把重试次数耗光(实测 4/6,余下永久不可用)。客户端自己也守这条线:附件原图请求走
// 4 槽 FIFO 闸门,服务端配额就不会被自己人打满;429 退避作为兜底(文件树预览/正文 markdown
// 图没走闸门,仍可能占住配额)。
export const IMAGE_READ_MAX_PARALLEL = 4;
let activeImageReads = 0;
const imageReadWaiters = [];

function acquireImageReadSlot() {
  if (activeImageReads < IMAGE_READ_MAX_PARALLEL) {
    activeImageReads += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => { imageReadWaiters.push(resolve); });
}

function releaseImageReadSlot() {
  const next = imageReadWaiters.shift();
  if (next) { next(); return; } // 槽位直接转交给队首,activeImageReads 不变
  activeImageReads = Math.max(0, activeImageReads - 1);
}

/**
 * 取原图字节(经 fetch 才能看见 429)。返回 Blob;失败抛 Error,HTTP 状态挂在 error.status。
 * @param {string} src /api/files/read?…&raw=1
 */
export async function loadAttachmentImageBytes(src, {
  fetchImpl = (...args) => fetch(...args),
  delays = IMAGE_READ_BUSY_RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  acquire = acquireImageReadSlot,
  release = releaseImageReadSlot,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    await acquire();
    let blob = null;
    let failure = null;
    try {
      const response = await fetchImpl(src);
      if (response.ok) blob = await response.blob();
      else {
        failure = new Error(`HTTP ${response.status}`);
        failure.status = response.status;
      }
    } catch (error) {
      failure = error;
    } finally {
      release(); // 字节读完才放槽(服务端也是读到 end 才释放它的配额)
    }
    if (blob) return blob;
    if (failure?.status === 429 && attempt < delays.length) {
      await sleep(delays[attempt]);
      continue;
    }
    throw failure;
  }
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

// r63:回滚(仅回退消息/回退消息和文件/重做整轮)自动重发的负载。必须发完整 outbound
// (msg.text,含"附件:@path"段)并带原 meta —— 不得复用 edit 回填用的 displayText(剥掉了
// @path),否则 CLI 收不到文件、气泡无卡片、sidecar textHash 对不上(回归 90a93f5 的根因)。
// prompt === msg.text ⇒ 与原消息 sidecar 条目同 hash,meta 即使在途丢失刷新也能 rehydrate。
export function resendPayloadForMessage(msg) {
  const hasAttach = Array.isArray(msg?.attachments) && msg.attachments.length > 0;
  return {
    prompt: msg?.text || '',
    meta: hasAttach ? { attachments: msg.attachments, displayText: msg.displayText || '' } : undefined,
  };
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
// r49a-③:outbox 是"发不出去就留着重试"的队列,只进不出。绑定一旦失效(projectHash
// 两侧口径不一致等)条目永远清不掉,localStorage 被撑满后连主题/字号这些偏好都写不进去。
// 64 条 FIFO 封顶:附件卡片是可重发的旁路数据,丢最旧的一条远好过写死整个 localStorage。
export const ATTACHMENT_SIDECAR_OUTBOX_MAX = 64;
// 服务端对这几种状态是"确定性拒绝"(载荷非法/同 messageId 异载荷/超限/鉴权失败),重试
// 没有意义 —— 条目要丢出队列,否则它会永久堵住同会话后面所有条目(见 postEntry)。
// 408/429 是明文的暂时性(超时/限流),5xx 与网络错误同理,一律保留重试。
export function isPermanentAttachmentRejection(status) {
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
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

  // 阶段05 抽查第 3 条:升级前写入 outbox 的存量条目 payload 只有 {text,attachments,
  // displayText} —— 服务端新契约要求 messageId 必填,这些条目每条都 400 ATTACHMENT_INVALID,
  // 且 flushSession 遇到队首失败就 return,于是该会话此后每条新附件消息的 sidecar 都被堵死
  // (刷新后图片/说明全丢)。迁移:按条目 id 补一个【稳定】的合法 messageId(同一条目每次读到
  // 都一样 → 服务端幂等,重放 200 created:false,不会写重复)。补出来的 id 只承担"让写入通过"
  // 的职责:旧条目的回读本来就靠服务端一并写入的 textHash 条目,该行为未变。
  const legacyMessageId = (entry) => {
    const raw = String(entry?.id || `legacy-${entry?.createdAt || 0}`);
    return raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128) || 'legacy-attachment-entry';
  };
  const withMessageId = (entry) => {
    const payload = entry?.payload;
    if (!payload || typeof payload !== 'object') return entry;
    if (typeof payload.messageId === 'string' && payload.messageId) return entry;
    return { ...entry, payload: { ...payload, messageId: legacyMessageId(entry) } };
  };

  const read = () => {
    if (!storage) return [];
    try {
      const parsed = JSON.parse(storage.getItem(ATTACHMENT_SIDECAR_OUTBOX_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.map(withMessageId) : [];
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
      // 超限丢最旧(见 ATTACHMENT_SIDECAR_OUTBOX_MAX);只在入队处封顶,绑定/清账路径
      // 都只做减法,不会把队列顶大。
      return { next: [...current, entry].slice(-ATTACHMENT_SIDECAR_OUTBOX_MAX), value: entry };
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
      const status = response?.status;
      // 抽查第 3 条(堵死):服务端对这条载荷的拒绝是【确定性】的(400 载荷非法 / 409 同
      // messageId 异载荷 / 413 超限),重试一万次还是同一个结果;当"可重试"保留只会让
      // flushSession 永远卡在队首 —— 该会话后续消息的附件卡片再也发不出去。这类条目必须
      // 丢出队列让后面的走,并把丢弃数如实报给调用方(attachmentSidecarNotice)。
      // 5xx/408/429/网络错误仍是暂时性的,保留重试。
      if (isPermanentAttachmentRejection(status)) {
        const dropped = await mutate((current) => ({
          next: current.filter((item) => item?.id !== entry.id),
        }));
        // 清账失败就别报成功:条目还在,下一次仍会重放,不会无限循环(flushSession 见 !ok 即返回)。
        if (!dropped.ok) return { ...dropped, retained: true, error: dropped.error || 'persist-failed' };
        return { ok: true, retained: false, dropped: 1 };
      }
      return { ok: false, retained: true, error: 'http', status };
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
    let dropped = 0;
    for (;;) {
      await currentMutationTail();
      const entry = read().find((item) => item?.sessionId === sessionId);
      if (!entry) return { ok: true, retained: false, dropped };
      const posted = await postEntry(entry, sessionId);
      if (!posted.ok) return posted;
      dropped += posted.dropped || 0;
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
      let dropped = 0;
      for (;;) {
        await currentMutationTail();
        const entry = read().find((item) => (
          item?.ownerKey === ownerKey && (!item?.sessionId || item.sessionId === sessionId)
        ));
        if (!entry) return { ok: true, retained: false, matched, dropped };
        matched += 1;
        const posted = await postEntry(entry, sessionId);
        if (!posted.ok) return { ...posted, matched };
        dropped += posted.dropped || 0;
      }
    });
  };

  const flushAll = async () => {
    await currentMutationTail();
    const sessionIds = [...new Set(read().map((entry) => entry?.sessionId).filter(Boolean))];
    const results = await Promise.all(sessionIds.map((sessionId) => flushSession(sessionId)));
    return results.find((result) => !result.ok)
      || { ok: true, retained: false, dropped: results.reduce((n, result) => n + (result.dropped || 0), 0) };
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
  if (!result) return null;
  // 确定性拒绝的条目已被丢出队列(不再永久堵住后面的消息),如实说一声 —— 消息本身照常发出,
  // 丢的只是"刷新后恢复附件卡片"的旁路数据。
  if (result.dropped) return `${result.dropped} 条附件卡片被服务端拒绝（不会重试）；消息已发出，但刷新后这些卡片无法恢复。`;
  if (result.ok) return null;
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
