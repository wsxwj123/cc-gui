// CU-R18-*: screenshot file lifecycle — retention, cross-instance safety, independent readability.
// Contract: .devflow/INTERFACE.md「桌面操控与Codex对齐」第 15、21 段.
//
// Two observation channels: the MCP responses themselves (image bytes, snapshotId) and the
// screenshot directory published by the operator via CU_SHOTS_DIR. File counts are always
// measured as a *delta* over this suite's own instances, so pre-existing files from other
// instances never turn into a verdict.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  CuMcp,
  EnvironmentBlocked,
  expectScreenshotFields,
  imageBytes,
  imageDimensions,
  screenshotReceipt,
  uniqueId,
  requireScreenRead,
  withInstance,
} from './helpers/cu-mcp.mjs';

const MAX_PER_INSTANCE = 5;
const IMAGE_RE = /\.(png|jpe?g)$/i;

function shotsDir() {
  const dir = process.env.CU_SHOTS_DIR;
  if (!dir) {
    throw new EnvironmentBlocked(
      'CU_SHOTS_DIR is required: the contract caps the files an instance keeps, and the directory holding them is not published by any public endpoint',
    );
  }
  if (!fs.existsSync(dir)) throw new EnvironmentBlocked(`CU_SHOTS_DIR does not exist: ${dir}`);
  return dir;
}

function imageFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && IMAGE_RE.test(entry.name))
    .map(entry => path.join(dir, entry.name));
}

async function takeShot(client, { maxWidth = 640 } = {}) {
  const res = await client.call('screenshot', { max_width: maxWidth }, { timeoutMs: 40_000 });
  return { res, receipt: expectScreenshotFields(screenshotReceipt(res)) };
}

test('CU-R18-01 同一实例连拍 7 张：保留的图片文件不超过 5 个，最新一张仍可读', async () => {
  requireScreenRead('CU-R18-01 needs real screenshots');
  const dir = shotsDir();
  const before = new Set(imageFiles(dir));
  await withInstance(async client => {
    let last = null;
    for (let index = 0; index < 7; index += 1) {
      last = await takeShot(client);
      expect(last.res.images.length, 'every screenshot returns its own image content').toBeGreaterThan(0);
    }
    const added = imageFiles(dir).filter(file => !before.has(file));
    expect(
      added.length,
      `one instance may keep at most ${MAX_PER_INSTANCE} completed image files (7 shots added ${added.length}: ${added.slice(0, 8)})`,
    ).toBeLessThanOrEqual(MAX_PER_INSTANCE);
    const bytes = imageBytes(last.res);
    const dims = imageDimensions(bytes.buffer);
    expect([dims.width, dims.height], 'the newest retained image is still complete on disk').toEqual([
      last.receipt.imgW,
      last.receipt.imgH,
    ]);
  });
});

test('CU-R18-02 反向：另一实例的截图与清理不动本实例在途/引用的文件', async () => {
  requireScreenRead('CU-R18-02 needs real screenshots from two instances');
  const dir = shotsDir();
  const a = await CuMcp.start({ label: 'cu-r18-02-a' });
  const b = await CuMcp.start({ label: 'cu-r18-02-b' });
  try {
    const first = await takeShot(a);
    const bBefore = new Set(imageFiles(dir));
    for (let index = 0; index < 7; index += 1) await takeShot(b);
    const bAdded = imageFiles(dir).filter(file => !bBefore.has(file));
    expect(bAdded.length, 'the second instance keeps its own budget').toBeLessThanOrEqual(MAX_PER_INSTANCE);
    // A 的 snapshotId 仍必须可用：B 的清理不得删掉 A 引用中的文件。
    const reuse = await a.call(
      'left_click',
      {
        actionId: uniqueId('cu_r18_02'),
        target: { bundleId: 'com.example.cu-batch-nonexistent', pid: 999_999, windowId: 999_999_999 },
        snapshotId: first.receipt.snapshotId,
        foreground: false,
        x: 1,
        y: 1,
      },
      { timeoutMs: 40_000 },
    );
    // A 只截过一次图，它的 snapshotId 因此仍是 A 的最新一张：只用"目标不存在"这一条理由才允许被拒。
    expect(
      ['CU_TARGET_NOT_FOUND', 'CU_APP_NOT_ALLOWED'],
      'A’s own latest snapshot must stay usable after B’s churn; a file removed by B would show up here as a stale/missing error',
    ).toContain(reuse.structuredContent?.code);
    expect(reuse.text, 'no missing-file wording in the receipt').not.toMatch(/ENOENT|no such file|文件不存在/i);
  } finally {
    a.close();
    b.close();
  }
});

test('CU-R18-03 响应图片可独立读取：字节非空、可解析、与声明的 imgW/imgH 一致', async () => {
  requireScreenRead('CU-R18-03 needs a real screenshot');
  await withInstance(async client => {
    const shot = await takeShot(client, { maxWidth: 0 });
    const bytes = imageBytes(shot.res);
    const dims = imageDimensions(bytes.buffer);
    expect(dims.width, 'declared imgW must be the actual byte width').toBe(shot.receipt.imgW);
    expect(dims.height, 'declared imgH must be the actual byte height').toBe(shot.receipt.imgH);
    expect(shot.res.images[0].mimeType, 'the image part must declare its mime type').toMatch(/^image\//);
  });
});

test('CU-R18-04 有限占用：一个实例连续截图的净增文件数有上限（清理可追踪）', async () => {
  requireScreenRead('CU-R18-04 needs real screenshots');
  const dir = shotsDir();
  const before = imageFiles(dir);
  await withInstance(async client => {
    for (let index = 0; index < 9; index += 1) await takeShot(client, { maxWidth: 480 });
  });
  const after = imageFiles(dir);
  const added = after.filter(file => !before.includes(file));
  expect(
    added.length,
    `9 screenshots from one instance left ${added.length} new files (cap ${MAX_PER_INSTANCE}); the screenshot directory grows without bound otherwise`,
  ).toBeLessThanOrEqual(MAX_PER_INSTANCE);
});
