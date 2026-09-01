#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentSidecarStore } from '../../server/services/attachment-sidecar-store.js';

const home = await mkdtemp(join(tmpdir(), 'cgui-r33-sidecar-http-'));
process.env.HOME = home; // routes 模块路径常量在 import 时读取 homedir
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%,不同设沙箱失效
const express = (await import('express')).default;
const sessionsRoutes = (await import(`../../server/routes/sessions.js?r33-sidecar=${Date.now()}`)).default;
const { attachmentTextHash } = await import('../../server/services/session-reader.js');

const attachment = (name) => ({ kind: 'text', name, path: `/tmp/${name}`, bytes: name.length, preview: null });
const body = (text, name = `${text}.txt`) => ({ text, displayText: text, attachments: [attachment(name)] });

// 两个独立 HTTP 客户端并发写同 session：响应均成功，最终文件保留两个 textHash。
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', sessionsRoutes);
const server = await new Promise((resolve, reject) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  instance.once('error', reject);
});
let failure = null;
try {
  const port = server.address().port;
  const sid = '11111111-1111-1111-1111-111111111111';
  const endpoint = `http://127.0.0.1:${port}/api/sessions/${sid}/attachments`;
  const post = (payload) => fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const [first, second] = await Promise.all([post(body('alpha')), post(body('beta'))]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const file = join(home, '.claude-gui', 'attachments', `${sid}.json`);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(new Set(Object.keys(saved)), new Set([attachmentTextHash('alpha'), attachmentTextHash('beta')]),
    '并发 HTTP read-merge-write 不丢任一 textHash');
  assert.equal(saved[attachmentTextHash('alpha')].displayText, 'alpha');
  assert.equal(saved[attachmentTextHash('beta')].displayText, 'beta');

  // 同 textHash 重试是覆盖同键而非追加重复项。
  const retry = await post(body('alpha', 'alpha-retry.txt'));
  assert.equal(retry.status, 200);
  const retried = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.keys(retried).length, 2);
  assert.equal(retried[attachmentTextHash('alpha')].attachments[0].name, 'alpha-retry.txt');
  assert.equal((await readdir(join(home, '.claude-gui', 'attachments'))).some((name) => name.includes('.tmp-')), false,
    '原子替换不留临时文件');
} catch (error) {
  failure = error;
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
if (failure) throw failure;

// 不同 session 的网络/磁盘阶段可并行：A 的 writeFile 被门控时，B 仍能进入 writeFile。
const parallelDir = await mkdtemp(join(tmpdir(), 'cgui-r33-sidecar-parallel-'));
let releaseA;
let markAStarted;
const aStarted = new Promise((resolve) => { markAStarted = resolve; });
const aGate = new Promise((resolve) => { releaseA = resolve; });
let bStarted = false;
const parallelFs = {
  ...realFs,
  writeFile: async (file, ...args) => {
    if (String(file).includes('session-a.json.tmp-')) {
      markAStarted();
      await aGate;
    }
    if (String(file).includes('session-b.json.tmp-')) bStarted = true;
    return realFs.writeFile(file, ...args);
  },
};
let tempSeq = 0;
const parallelStore = createAttachmentSidecarStore({
  directory: parallelDir,
  hashText: attachmentTextHash,
  fs: parallelFs,
  makeTempId: () => String(++tempSeq),
});
const writeA = parallelStore.write('session-a', body('one'));
await aStarted;
const writeB = parallelStore.write('session-b', body('two'));
// B 到 writeFile 之前还要走 mkdir + readFile 两次真实 I/O,不是一个 tick 能保证的。
// 赌 setTimeout(0) 会在机器忙时随机变红;改成带截止时间地等这个条件出现 ——
// 真有全局锁时 B 永远起不来,照样在截止后红,红的语义一个字不变。
const bDeadline = Date.now() + 5000;
while (!bStarted && Date.now() < bDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(bStarted, true, '不同 session 不共用全局锁');
releaseA();
await Promise.all([writeA, writeB]);
assert.equal(parallelStore.pendingSessionCount(), 0, '完成后锁 map 有界清空');

// 一次原子写失败不会毒死该 session 队尾；临时文件清理后下一次重试成功。
const retryDir = await mkdtemp(join(tmpdir(), 'cgui-r33-sidecar-retry-'));
let failOnce = true;
const retryFs = {
  ...realFs,
  writeFile: async (...args) => {
    if (failOnce) { failOnce = false; throw new Error('simulated disk failure'); }
    return realFs.writeFile(...args);
  },
};
const retryStore = createAttachmentSidecarStore({
  directory: retryDir,
  hashText: attachmentTextHash,
  fs: retryFs,
  makeTempId: () => 'retry',
});
await assert.rejects(retryStore.write('session-retry', body('failed-first')), /simulated disk failure/);
assert.equal(retryStore.pendingSessionCount(), 0, '失败后锁生命周期同样结束');
await retryStore.write('session-retry', body('retry-ok'));
const retrySaved = JSON.parse(await readFile(join(retryDir, 'session-retry.json'), 'utf8'));
assert.ok(retrySaved[attachmentTextHash('retry-ok')], '同 session 写失败后可重试成功');
assert.equal((await readdir(retryDir)).some((name) => name.includes('.tmp-')), false);

console.log('✓ check-r33-server-sidecar-concurrency: 并发HTTP、跨session并行、原子替换与失败重试全过');
