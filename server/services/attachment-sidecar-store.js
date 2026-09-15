import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// 附件元数据 sidecar(R07)。文件是一张 JSON 对象：
//   { "<textHash>": { attachments, displayText }, …,            ← 旧索引(只读兼容,写入仍带一份)
//     "messages": { "<messageId>": { text, attachments, displayText } } }  ← 新索引
// 新写入按 sessionId+messageId **一次写入且不可变**：同身份同载荷(键序无关、数组顺序与字符串
// 逐字敏感)幂等返回 created:false，同身份异载荷抛 409 ATTACHMENT_CONFLICT。旧 textHash 条目
// 继续按覆盖语义写，供「客户端还不知道 CLI 落盘 uuid」的普通发送回读(见 session-reader)。
const MESSAGES_KEY = 'messages';

export function attachmentConflictError(message) {
  return Object.assign(new Error(message), { code: 'ATTACHMENT_CONFLICT', status: 409 });
}
export function attachmentTimeoutError(message) {
  return Object.assign(new Error(message), { code: 'ATTACHMENT_TIMEOUT', status: 504 });
}

function normalizeAttachments(attachments) {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    name: attachment.name,
    path: attachment.path,
    preview: attachment.preview,
    bytes: attachment.bytes,
  }));
}

// 规范载荷：缺省 displayText 等于 null；附件只保留既有 5 个字段，键序固定，
// 因此 JSON.stringify 比较天然满足「对象键顺序无关、数组顺序/字符串逐字敏感」。
function normalizeEntry({ text, attachments, displayText }) {
  return {
    text,
    attachments: normalizeAttachments(attachments),
    displayText: typeof displayText === 'string' ? displayText : null,
  };
}

function sameEntry(a, b) {
  return a.text === b.text
    && (a.displayText ?? null) === (b.displayText ?? null)
    && JSON.stringify(a.attachments) === JSON.stringify(b.attachments);
}

export function createAttachmentSidecarStore({
  directory,
  hashText,
  fs = { mkdir, readFile, rename, unlink, writeFile },
  makeTempId = () => randomUUID(),
  now = () => Date.now(),
} = {}) {
  if (!directory || typeof hashText !== 'function') throw new Error('directory and hashText are required');
  const sessionTails = new Map();

  const write = (sessionId, { messageId, text, attachments, displayText = null, timeoutMs = 15_000 }) => {
    // 没有消息身份就只能按 textHash 覆盖写 —— 那正是 R07 要根除的"同正文互相串附件"。
    // 路由已校验;这里再挡一道,免得漏传时静默写成 messages["undefined"]。
    if (typeof messageId !== 'string' || !messageId) {
      return Promise.reject(Object.assign(new Error('messageId is required'), { code: 'ATTACHMENT_INVALID', status: 400 }));
    }
    const previous = sessionTails.get(sessionId) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      // 15 秒写入窗口(INTERFACE：ATTACHMENT_TIMEOUT)。落盘前再校验一次：超时就不写，
      // 也不在响应之后继续后台补写。
      const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, `${sessionId}.json`);
      let current;
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('attachment sidecar root must be an object');
        }
        current = parsed;
      } catch (error) {
        if (error?.code === 'ENOENT') current = {};
        else throw error;
      }
      const messages = (current[MESSAGES_KEY] && typeof current[MESSAGES_KEY] === 'object' && !Array.isArray(current[MESSAGES_KEY]))
        ? current[MESSAGES_KEY]
        : {};
      const entry = normalizeEntry({ text, attachments, displayText });
      const existing = messages[messageId];
      if (existing) {
        if (sameEntry(existing, entry)) return { created: false, entry: existing };
        throw attachmentConflictError('该 messageId 已写入不同附件元数据');
      }
      const next = {
        ...current,
        [hashText(text)]: {
          attachments: entry.attachments,
          displayText: entry.displayText ?? '',
        },
        [MESSAGES_KEY]: { ...messages, [messageId]: entry },
      };
      if (now() > deadline) throw attachmentTimeoutError('附件元数据写入超时');
      const temp = `${file}.tmp-${makeTempId()}`;
      try {
        // 内容含附件绝对路径与 preview 片段：按用户私有落盘,不跟随 umask 放宽。
        await fs.writeFile(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
        if (now() > deadline) throw attachmentTimeoutError('附件元数据写入超时');
        await fs.rename(temp, file);
      } catch (error) {
        try { await fs.unlink(temp); } catch {}
        throw error;
      }
      return { created: true, entry };
    });
    sessionTails.set(sessionId, run);
    const cleanup = () => {
      if (sessionTails.get(sessionId) === run) sessionTails.delete(sessionId);
    };
    run.then(cleanup, cleanup);
    return run;
  };

  return { write, pendingSessionCount: () => sessionTails.size };
}
