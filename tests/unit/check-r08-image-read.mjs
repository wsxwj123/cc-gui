#!/usr/bin/env node
// R08：preview 为空时按受权原图路径显示 + raw 字节入口的错误/边界语义。
// 覆盖：MIME/字节、0 字节 200 空体、缺参 400、目录 400、越界 403、不存在 404（{ok:false,code,error}
// 且不含敏感信息）、最多 4 个并行 raw 读（第 5 个 429 FILE_READ_BUSY，释放后可再读）、
// 以及客户端 imageAttachmentSrc 的来源选择（preview 优先 / raw 兜底 / 都没有 → null）。
// 抽查第 1 条补充：真实上传目录（os.tmpdir()/cgui-attachments）里的附件必须可 raw 读
// ——那是"preview 被 96KiB 预算裁空的大图刷新后靠什么显示"的唯一来源；同时守住边界：
// 只是这一个目录放行，tmpdir 下别的目录/目录里指向外面的 symlink 仍然 403。
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// realpath：macOS 的 /var 是 /private/var 的符号链接，safePath 走 realpath 后
// 前缀对不上 HOME，会误判成越界 403（测试环境问题，不是实现问题）。
const home = await realpath(await mkdtemp(join(tmpdir(), 'cgui-r08-read-')));
process.env.HOME = home; // safePath 的边界常量在 import 时读 homedir
process.env.USERPROFILE = home;

// 越界路径：临时 HOME 之外、也不在任何 ~/.claude/projects 工作区里。
const outside = join(tmpdir(), `cgui-r08-outside-${Date.now()}`, 'secret.png');
await mkdir(join(outside, '..'), { recursive: true });
await writeFile(outside, 'outside');

const express = (await import('express')).default;
const filesRoutes = (await import(`../../server/routes/files.js?r08=${Date.now()}`)).default;
const { imageAttachmentSrc, loadAttachmentImageBytes, IMAGE_READ_BUSY_RETRY_DELAYS_MS, IMAGE_READ_MAX_PARALLEL } =
  await import('../../client/src/utils/attachments.js');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0u8AAAAASUVORK5CYII=', 'base64');
const imagePath = join(home, 'real image with space %.png');
await writeFile(imagePath, png);
const emptyPath = join(home, 'empty.png');
await writeFile(emptyPath, Buffer.alloc(0));
const bigPath = join(home, 'big.png');
await writeFile(bigPath, Buffer.alloc(4 * 1024 * 1024, 7));

// 真实上传目录：与 server/routes/upload.js 的 UPLOAD_DIR 同一个（<tmpdir>/cgui-attachments）。
const uploadDir = join(tmpdir(), 'cgui-attachments');
await mkdir(uploadDir, { recursive: true });
const uploadedPath = join(uploadDir, `r08-uploaded-${Date.now()}.png`);
await writeFile(uploadedPath, png);
const uploadEscape = join(uploadDir, `r08-uploaded-link-${Date.now()}.png`);
await symlink(outside, uploadEscape); // 目录里预埋的 symlink 指向 $HOME 外

const app = express();
app.use('/api', filesRoutes);
const server = await new Promise((resolve, reject) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  instance.once('error', reject);
});

const port = server.address().port;
const read = (query) => fetch(`http://127.0.0.1:${port}/api/files/read?${query}`);
const encoded = (p, extra = '') => `path=${encodeURIComponent(p)}${extra}`;

let failure = null;
try {
  // 正确 MIME 与逐字节相等（路径里有空格和 % 也不受影响）。
  const ok = await read(encoded(imagePath, '&raw=1'));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /^image\/png(?:;|$)/);
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);

  // 0 字节文件：200 + 空体（图片 UI 据解码失败显示不可用）。
  const empty = await read(encoded(emptyPath, '&raw=1'));
  assert.equal(empty.status, 200);
  assert.equal((await empty.arrayBuffer()).byteLength, 0);

  // 真实上传的附件（抽查第 1 条）：`<tmpdir>/cgui-attachments/<uuid>.png` 必须能 raw 读到
  // 逐字节原图 —— 上传大图的 preview 会被 96KiB 预算裁空，刷新后只剩这条回退。
  const uploaded = await read(encoded(uploadedPath, '&raw=1'));
  assert.equal(uploaded.status, 200, '真实上传目录里的附件必须可读（否则刷新后永久「图片不可用」）');
  assert.match(uploaded.headers.get('content-type'), /^image\/png(?:;|$)/);
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), png);

  // 非法/缺路径 400；目录 400；越界 403；不存在 404 —— 统一 {ok:false,code,error}。
  const cases = [
    [await read(''), 400],
    [await read('path=relative/file.png&raw=1'), 400],
    [await read(encoded(home, '&raw=1')), 400],
    [await read(encoded(outside, '&raw=1')), 403],
    // 上传目录只放行它自己：同在上传目录里的 symlink 指向 $HOME 外，realpath 后落点越界 → 403。
    [await read(encoded(uploadEscape, '&raw=1')), 403],
    [await read(encoded(join(home, 'definitely missing image.png'), '&raw=1')), 404],
  ];
  for (const [res, status] of cases) {
    assert.equal(res.status, status, `期望 HTTP ${status}`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(typeof body.code, 'string');
    assert.equal(typeof body.error, 'string');
    assert.doesNotMatch(JSON.stringify(body), /(?:token|authorization|cookie|stack|at\s+\S+\s+\()/i,
      '错误体不含凭证/堆栈');
  }

  // 最多 4 个并行 raw 读：第 5 个 429 FILE_READ_BUSY；释放后可以再读。
  const held = [];
  const holdOne = () => new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/files/read?${encoded(bigPath, '&raw=1')}`, (res) => {
      res.pause(); // 不消费 body：背压让服务端保持"在读"
      resolve({ req, res });
    });
    req.on('error', reject);
  });
  for (let i = 0; i < 4; i += 1) held.push(await holdOne());
  assert.equal(held.every(({ res }) => res.statusCode === 200), true, '前 4 个并行读都是 200');
  const busy = await read(encoded(imagePath, '&raw=1'));
  assert.equal(busy.status, 429);
  assert.deepEqual((await busy.json()).code, 'FILE_READ_BUSY');
  for (const { req } of held) req.destroy();
  // 释放是异步的（close 事件），给一个明确的等待窗口，避免把竞态写成假红。
  const deadline = Date.now() + 3000;
  let recovered = null;
  while (Date.now() < deadline) {
    recovered = await read(encoded(imagePath, '&raw=1'));
    if (recovered.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(recovered.status, 200, '客户端取消后配额立即释放');
} catch (error) {
  failure = error;
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
if (failure) throw failure;

// 抽查第 4 条：raw 原图入口的 4 并行配额是全进程共享的，第 5 张图会拿到 429
// FILE_READ_BUSY；客户端必须对它做【有界】退避重试，其他失败一次即判失败。
{
  const attempts = [];
  const delays = [];
  const blob = { size: 3 };
  const busyThenOk = await loadAttachmentImageBytes('/api/files/read?path=x&raw=1', {
    fetchImpl: async (url) => {
      attempts.push(url);
      return attempts.length < 3 ? { ok: false, status: 429 } : { ok: true, blob: async () => blob };
    },
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.equal(busyThenOk, blob, '429 退避重试后正常拿到字节');
  assert.equal(attempts.length, 3, '重试到成功为止');
  assert.deepEqual(delays, [250, 700], '退避间隔按常量递增');

  // 一直 429：次数封顶（合同禁止"失败无限自动重试"），最后如实抛 429。
  let busyCalls = 0;
  await assert.rejects(
    loadAttachmentImageBytes('/api/files/read?path=x&raw=1', {
      fetchImpl: async () => { busyCalls += 1; return { ok: false, status: 429 }; },
      sleep: async () => {},
    }),
    (error) => error.status === 429,
  );
  assert.equal(busyCalls, IMAGE_READ_BUSY_RETRY_DELAYS_MS.length + 1, '429 重试次数有上限');

  // 其他失败一律不重试（403 越界 / 404 不存在 / 500 读取失败都是终态）。
  for (const status of [403, 404, 500]) {
    let calls = 0;
    await assert.rejects(
      loadAttachmentImageBytes('/api/files/read?path=x&raw=1', {
        fetchImpl: async () => { calls += 1; return { ok: false, status }; },
        sleep: async () => { throw new Error(`HTTP ${status} 不该退避重试`); },
      }),
      (error) => error.status === status,
    );
    assert.equal(calls, 1, `HTTP ${status} 只请求一次`);
  }

  // 客户端并发闸门：同时发起 6 张图（一条消息第 5 张起就超服务端 4 并行），在飞行中的
  // 请求数不能超过 4 —— 否则 6 个重试会在同一时刻再撞一次上限，重试次数耗光后仍永久失败
  // （实测 4/6）。这里用带 gate 的假 fetch 观察真实并发峰值。
  {
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    const gate = [];
    const loads = Array.from({ length: 6 }, (_, i) => loadAttachmentImageBytes(`/api/files/read?path=${i}&raw=1`, {
      fetchImpl: () => {
        inFlight += 1;
        started += 1;
        peak = Math.max(peak, inFlight);
        return new Promise((resolve) => gate.push(() => {
          inFlight -= 1;
          resolve({ ok: true, blob: async () => ({ i }) });
        }));
      },
      sleep: async () => {},
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(started, 4, '前 4 个立即发出，其余排队');
    while (gate.length) gate.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (gate.length) gate.shift()();
    const blobs = await Promise.all(loads);
    assert.equal(blobs.length, 6);
    assert.ok(peak <= IMAGE_READ_MAX_PARALLEL, `在飞请求数峰值 ${peak} 必须 ≤ ${IMAGE_READ_MAX_PARALLEL}`);
    assert.equal(started, 6, '排队的不丢');
  }
}

// 客户端来源选择。
{
  assert.equal(imageAttachmentSrc({ preview: 'data:image/png;base64,AAA', path: '/x.png' }), 'data:image/png;base64,AAA',
    'preview 优先');
  assert.equal(imageAttachmentSrc({ preview: null, path: '/Users/me/我的 图 (1).png' }),
    `/api/files/read?path=${encodeURIComponent('/Users/me/我的 图 (1).png')}&raw=1`, '无 preview 用受权原图入口');
  assert.equal(imageAttachmentSrc({ preview: null, path: '' }), null, '既无 preview 又无 path → null（按不可用占位）');
}

console.log('✓ check-r08-image-read: raw 字节/MIME、0 字节、错误码矩阵、4 并行上限与释放、图片来源全过');
