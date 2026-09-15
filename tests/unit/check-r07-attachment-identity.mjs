#!/usr/bin/env node
// R07：附件元数据按 sessionId+messageId 一次写入且不可变；旧 textHash 条目只做读兼容兜底。
// 覆盖：created true/false、异载荷 409、非法 400、1MiB/413、空数组合法、不同 messageId 同内容各存一份、
// 写入超时 504 且不落盘、reader 侧身份索引优先 + 哈希兜底 + 空附件不注入。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile as writeFileRaw } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'cgui-r07-attach-'));
process.env.HOME = home; // routes 模块路径常量在 import 时读取 homedir
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%

const express = (await import('express')).default;
const sessionsRoutes = (await import(`../../server/routes/sessions.js?r07-attach=${Date.now()}`)).default;
const { attachmentTextHash, attachmentMessageFields, attachmentMetaForIdentities } =
  await import('../../server/services/session-reader.js');
const { createAttachmentSidecarStore } = await import('../../server/services/attachment-sidecar-store.js');

const attachment = (name) => ({ kind: 'image', name, path: `/tmp/${name}`, preview: null, bytes: name.length });
const payload = (messageId, text = 'FB attachment text', extra = {}) => ({
  messageId, text, displayText: null, attachments: [attachment('a.png')], ...extra,
});

// 与 index.js 同形：verify 记录请求体原始字节数（1MiB 上限按 UTF-8 字节算）。
const app = express();
app.use(express.json({
  limit: '25mb',
  verify: (req, _res, buf) => { req.jsonBodyBytes = buf.length; },
}));
app.use('/api', sessionsRoutes);
const server = await new Promise((resolve, reject) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  instance.once('error', reject);
});

let failure = null;
try {
  const port = server.address().port;
  const sid = '22222222-2222-2222-2222-222222222222';
  const endpoint = `http://127.0.0.1:${port}/api/sessions/${sid}/attachments`;
  const post = (body) => fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  // 首次写入 created:true；同载荷重试（键序不同）created:false；并发同载荷只落一条。
  const first = await post(payload('msg-1'));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, messageId: 'msg-1', created: true });
  const reordered = { displayText: null, attachments: payload('msg-1').attachments, text: 'FB attachment text', messageId: 'msg-1' };
  const retry = await post(reordered);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).created, false, '同身份同载荷重试幂等');
  const [c1, c2] = await Promise.all([post(payload('msg-c', 'same text')), post(payload('msg-c', 'same text'))]);
  assert.deepEqual([c1.status, c2.status], [200, 200]);
  const createdFlags = [(await c1.json()).created, (await c2.json()).created].sort();
  assert.deepEqual(createdFlags, [false, true], '并发同身份只创建一次');

  // 同身份异载荷 → 409 ATTACHMENT_CONFLICT，原记录不动。
  const conflict = await post(payload('msg-1', 'FB attachment text changed'));
  assert.equal(conflict.status, 409);
  assert.deepEqual((await conflict.json()).code, 'ATTACHMENT_CONFLICT');

  // 不同 messageId 即使正文与附件完全相同，各存一份。
  const twin = await post(payload('msg-2'));
  assert.equal((await twin.json()).created, true);

  // 空数组合法且不是删除。
  const empty = await post({ messageId: 'msg-empty', text: 'no attachments', attachments: [] });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).created, true);
  const emptyRetry = await post({ messageId: 'msg-empty', text: 'no attachments', attachments: [] });
  assert.equal((await emptyRetry.json()).created, false);
  const stillThere = JSON.parse(await readFile(join(home, '.claude-gui', 'attachments', `${sid}.json`), 'utf8'));
  assert.equal(stillThere.messages['msg-1'].attachments.length, 1, '空数组写入不删旧附件');

  // 非法 messageId / text / attachments / displayText → 400 ATTACHMENT_INVALID。
  for (const bad of [
    payload(''),
    payload('bad id with space'),
    payload('x'.repeat(129)),
    { messageId: 'msg-x', text: 42, attachments: [] },
    { messageId: 'msg-x', text: 'ok', attachments: 'nope' },
    { messageId: 'msg-x', text: 'ok', attachments: [], displayText: 5 },
  ]) {
    const res = await post(bad);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'ATTACHMENT_INVALID');
  }

  // 1MiB 恰好通过、+1 字节 413 ATTACHMENT_TOO_LARGE（按请求体 UTF-8 字节）。
  const fitBase = { messageId: 'msg-fit', text: '', displayText: null, attachments: [] };
  const fit = { ...fitBase, text: 'a'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(fitBase))) };
  assert.equal(Buffer.byteLength(JSON.stringify(fit)), 1024 * 1024);
  assert.equal((await post(fit)).status, 200);
  const over = { ...fit, messageId: 'msg-over', text: `${fit.text}a` };
  const tooLarge = await post(over);
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, 'ATTACHMENT_TOO_LARGE');

  assert.equal((await readdir(join(home, '.claude-gui', 'attachments'))).some((name) => name.includes('.tmp-')), false,
    '原子替换不留临时文件');
} catch (error) {
  failure = error;
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
if (failure) throw failure;

// ── reader 侧：身份索引优先于 textHash；空附件不注入；哈希兜底仍可用 ──────────────
{
  const sidecar = {
    byMessageId: { 'msg-1': { attachments: [attachment('by-id.png')], displayText: 'by id' } },
    byHash: { [attachmentTextHash('same text')]: { attachments: [attachment('by-hash.png')], displayText: 'by hash' } },
  };
  assert.equal(attachmentMessageFields(sidecar, ['msg-1'], 'same text').attachments[0].name, 'by-id.png',
    '身份命中时不再看 textHash');
  assert.equal(attachmentMessageFields(sidecar, ['msg-missing'], 'same text').attachments[0].name, 'by-hash.png',
    '身份未命中回退旧哈希条目（读兼容）');
  assert.deepEqual(attachmentMessageFields(sidecar, ['msg-unknown'], 'other text'), {},
    '无任何命中不注入字段');
  const emptySidecar = { byMessageId: { 'msg-2': { attachments: [], displayText: 'x' } }, byHash: {} };
  assert.deepEqual(attachmentMessageFields(emptySidecar, ['msg-2'], 't'), {},
    '空附件数组不注入 attachments/displayText（否则气泡渲染成空壳）');
  assert.equal(attachmentMetaForIdentities(sidecar, [null, undefined, 'msg-1'], 'x').displayText, 'by id');
}

// ── 写入超时：不在响应之后继续补写（文件必须没被创建）────────────────────────────
{
  const timeoutDir = await mkdtemp(join(tmpdir(), 'cgui-r07-attach-timeout-'));
  let clock = 0;
  const store = createAttachmentSidecarStore({
    directory: timeoutDir,
    hashText: attachmentTextHash,
    now: () => { clock += 1000; return clock; }, // 第一次算 deadline，第二次已过期
  });
  await assert.rejects(
    store.write('session-slow', { messageId: 'msg-slow', text: 't', attachments: [], timeoutMs: 100 }),
    (error) => error.code === 'ATTACHMENT_TIMEOUT' && error.status === 504,
  );
  assert.equal(store.pendingSessionCount(), 0, '超时后锁生命周期结束');
  assert.deepEqual(await readdir(timeoutDir), [], '超时提交不留文件，也不在后台补写');
}

// ── 重启后同身份仍由已保存记录判重（文件即真相）────────────────────────────────
{
  const dir = await mkdtemp(join(tmpdir(), 'cgui-r07-attach-restart-'));
  const write = async (store, messageId, text) => store.write('session-r', { messageId, text, attachments: [], displayText: null });
  await write(createAttachmentSidecarStore({ directory: dir, hashText: attachmentTextHash }), 'msg-r', 'hello');
  const before = await readFile(join(dir, 'session-r.json'), 'utf8');
  const afterRestart = createAttachmentSidecarStore({ directory: dir, hashText: attachmentTextHash });
  const result = await write(afterRestart, 'msg-r', 'hello');
  assert.equal(result.created, false, '重启后同身份同载荷仍判重');
  await assert.rejects(write(afterRestart, 'msg-r', 'hello!'), (error) => error.code === 'ATTACHMENT_CONFLICT');
  assert.equal(await readFile(join(dir, 'session-r.json'), 'utf8'), before, '冲突不改写已保存记录');
  // 损坏的 sidecar 不应被静默覆盖成新内容（读失败必须抛出，而不是当成空文件）。
  await writeFileRaw(join(dir, 'session-broken.json'), 'not json');
  await assert.rejects(
    createAttachmentSidecarStore({ directory: dir, hashText: attachmentTextHash })
      .write('session-broken', { messageId: 'm', text: 't', attachments: [], displayText: null }),
  );
}

console.log('✓ check-r07-attachment-identity: messageId 幂等/冲突/边界/超时 + reader 身份优先与哈希兜底全过');
