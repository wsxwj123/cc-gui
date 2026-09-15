#!/usr/bin/env node
// R07（阶段05 抽查第 3 条）：附件 sidecar outbox 的【存量条目迁移】与【队首失败不堵死】。
//
// 修前两个缺陷：
//   ① 升级前写进 localStorage 的条目 payload 只有 {text,attachments,displayText}，而服务端
//      新契约 messageId 必填 → 这些条目每次都 400 ATTACHMENT_INVALID；
//   ② postEntry 把非 2xx 一律当"可重试保留"，flushSession 撞上就 return → 该会话此后每条
//      新附件消息的 sidecar 都发不出去（刷新后图片/说明全丢）。
// 覆盖：存量条目补出稳定合法 messageId 并成功出队、确定性拒绝(400/409/413)丢出队列让后面
// 的走并如实报数、暂时性失败(503/网络)仍原样保留、notice 文案。
import assert from 'node:assert/strict';
import {
  ATTACHMENT_SIDECAR_OUTBOX_KEY,
  attachmentSidecarNotice,
  createAttachmentSidecarOutbox,
  isPermanentAttachmentRejection,
} from '../../client/src/utils/attachments.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

const attachment = (name) => ({ kind: 'image', name, path: `/tmp/${name}`, preview: null, bytes: 9 });
// 升级前的存量形态：没有 messageId。
const legacyPayload = (name) => ({
  text: `请查看附件\n\n附件:\n@/tmp/${name}`,
  displayText: `查看 ${name}`,
  attachments: [attachment(name)],
});
const legacyEntry = (id, sessionId, name) => ({ id, ownerKey: null, sessionId, createdAt: 1, payload: legacyPayload(name) });

assert.equal(isPermanentAttachmentRejection(400), true);
assert.equal(isPermanentAttachmentRejection(409), true);
assert.equal(isPermanentAttachmentRejection(413), true);
assert.equal(isPermanentAttachmentRejection(408), false, '408 是暂时性');
assert.equal(isPermanentAttachmentRejection(429), false, '429 是暂时性');
assert.equal(isPermanentAttachmentRejection(503), false);
assert.equal(isPermanentAttachmentRejection(undefined), false);

// ── ① 存量无 messageId 条目：补出稳定合法 id，POST 成功后出队，之后不再重复补 ──────────
{
  const storage = new MemoryStorage();
  storage.setItem(ATTACHMENT_SIDECAR_OUTBOX_KEY, JSON.stringify([legacyEntry('legacy-1', 'sid-a', 'old.png')]));
  const bodies = [];
  const outbox = createAttachmentSidecarOutbox({
    storage,
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200 }; },
  });
  const first = outbox.read()[0];
  assert.equal(typeof first.payload.messageId, 'string', '读到存量条目就要补 messageId（否则每条都 400）');
  assert.match(first.payload.messageId, /^[A-Za-z0-9_-]{1,128}$/, '补出来的 id 必须过服务端 messageId 正则');
  assert.equal(outbox.read()[0].payload.messageId, first.payload.messageId, '同一层条目每次读到同一个 id（重放幂等）');

  const result = await outbox.flushSession('sid-a');
  assert.deepEqual({ ok: result.ok, retained: result.retained, dropped: result.dropped }, { ok: true, retained: false, dropped: 0 });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].messageId, first.payload.messageId, 'POST 带上补出来的 messageId');
  assert.equal(bodies[0].attachments.length, 1, '其余载荷字段原样保留');
  assert.equal(outbox.read().length, 0, '2xx 后出队');
}

// ── ② 队首被确定性拒绝：丢它、放后面的走，且不重试第二遍 ──────────────────────────
{
  const storage = new MemoryStorage();
  storage.setItem(ATTACHMENT_SIDECAR_OUTBOX_KEY, JSON.stringify([
    legacyEntry('bad', 'sid-b', 'bad.png'),
    { ...legacyEntry('good', 'sid-b', 'good.png'), payload: { ...legacyPayload('good.png'), messageId: 'chat-user-1' } },
  ]));
  const posted = [];
  const outbox = createAttachmentSidecarOutbox({
    storage,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      posted.push(body.messageId);
      // 第一条（存量补出来的 id）确定性拒绝，第二条正常。
      return body.messageId === 'bad' ? { ok: false, status: 400 } : { ok: true, status: 200 };
    },
  });
  const result = await outbox.flushSession('sid-b');
  assert.deepEqual(posted, ['bad', 'chat-user-1'], '队首被拒不能挡住后面那条（修前只会 POST 一次然后永久卡住）');
  assert.deepEqual({ ok: result.ok, dropped: result.dropped }, { ok: true, dropped: 1 });
  assert.equal(outbox.read().length, 0, '被拒的丢出队列、成功的出队');
  assert.match(attachmentSidecarNotice(result) || '', /1 条附件卡片被服务端拒绝/, '丢弃要如实提示');

  const retry = await outbox.flushSession('sid-b');
  assert.equal(posted.length, 2, '丢弃后不再重试同一条');
  assert.deepEqual({ ok: retry.ok, dropped: retry.dropped }, { ok: true, dropped: 0 });
}

// ── ③ 暂时性失败（503 / 网络）仍然保留重试，不丢数据、也不假装成功 ──────────────────
{
  for (const reply of [
    async () => ({ ok: false, status: 503 }),
    async () => { throw new Error('offline'); },
  ]) {
    const storage = new MemoryStorage();
    storage.setItem(ATTACHMENT_SIDECAR_OUTBOX_KEY, JSON.stringify([legacyEntry('keep', 'sid-c', 'keep.png')]));
    const outbox = createAttachmentSidecarOutbox({
      storage,
      fetchImpl: async () => { const r = await reply(); return r; },
    });
    const result = await outbox.flushSession('sid-c');
    assert.equal(result.ok, false);
    assert.equal(result.retained, true, '暂时性失败必须保留在本机恢复队列');
    assert.equal(result.dropped, undefined);
    assert.equal(outbox.read().length, 1, '不清账');
  }
}

// ── ④ 新契约载荷（已带 messageId）不受迁移影响 ────────────────────────────────
{
  const storage = new MemoryStorage();
  const outbox = createAttachmentSidecarOutbox({ storage, fetchImpl: async () => ({ ok: true, status: 200 }) });
  await outbox.stageAndFlush({
    sessionId: 'sid-d',
    payload: { messageId: 'chat-user-42', text: 't', attachments: [attachment('new.png')], displayText: 'd' },
  });
  assert.equal(storage.getItem(ATTACHMENT_SIDECAR_OUTBOX_KEY), '[]', '新契约载荷照常发完即出队');
}

console.log('✓ check-r07-attachment-outbox: 存量条目迁移 + 队首确定性拒绝不堵队列 + 暂时性失败保留全过');
