// CU-R14-*: background click safety — failures must never fall back to a global click.
// CU-R15-*: coordinate validation, snapshot identity, Retina mapping.
// Contract: .devflow/INTERFACE.md「桌面操控与Codex对齐」第 13、16、17、20 段.
import { test, expect } from '@playwright/test';
import {
  CuMcp,
  EnvironmentBlocked,
  expectToolError,
  expectToolOk,
  requireActionTool,
  requireForeground,
  requireScreenRead,
  screenshotReceipt,
  expectScreenshotFields,
  cuDoctor,
  imageBytes,
  imageDimensions,
  uniqueId,
  windowList,
  withoutTouchingDesktop,
  withInstance,
} from './helpers/cu-mcp.mjs';
import { ensureFixture, waitForTarget } from './helpers/cu-fixture.mjs';

const GHOST = { bundleId: 'com.example.cu-batch-nonexistent', pid: 999_999, windowId: 999_999_999 };

/**
 * Snapshot-class failures are only reachable behind a valid, authorised target: the documented
 * order is 授权 → 目标 → 快照 ("任何动作执行前复核目标/授权"), and the build under test answers a
 * ghost target with `CU_TARGET_NOT_FOUND` before it ever looks at the snapshot (measured). So the
 * snapshot cases below aim at the suite's own disposable window instead of a ghost.
 */
function requireFixtureWindow() {
  ensureFixture();
}

function clickArgs(actionId, overrides = {}) {
  return {
    actionId,
    target: GHOST,
    snapshotId: uniqueId('cu_snap'),
    foreground: false,
    x: 1,
    y: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// R14 — no stealth global click
// ---------------------------------------------------------------------------

test('CU-R14-01 target 缺三字段之一 → CU_INVALID_ARGUMENT，零投递', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    for (const target of [
      { pid: 1, windowId: 1 },
      { bundleId: 'com.example.cu-batch-nonexistent', windowId: 1 },
      { bundleId: 'com.example.cu-batch-nonexistent', pid: 1 },
      { bundleId: '', pid: 1, windowId: 1 },
    ]) {
      const res = await withoutTouchingDesktop('CU-R14-01', () =>
        client.call('left_click', clickArgs(uniqueId('cu_r14_01'), { target })),
      );
      expectToolError(res, { code: 'CU_INVALID_ARGUMENT' });
    }
  });
});

test('CU-R14-02 非布尔 foreground（"true" / 1 / null）→ CU_INVALID_ARGUMENT', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    for (const foreground of ['true', 1, 0, null]) {
      const res = await withoutTouchingDesktop('CU-R14-02', () =>
        client.call('left_click', clickArgs(uniqueId('cu_r14_02'), { foreground })),
      );
      expectToolError(res, { code: 'CU_INVALID_ARGUMENT' });
    }
  });
});

test('CU-R14-03 未授权应用的 target → CU_APP_NOT_ALLOWED，零投递', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const res = await withoutTouchingDesktop('CU-R14-03', () =>
      client.call(
        'left_click',
        clickArgs(uniqueId('cu_r14_03'), {
          target: { bundleId: 'com.apple.finder', pid: 1, windowId: 1 },
        }),
      ),
    );
    expectToolError(res, { code: 'CU_APP_NOT_ALLOWED' });
  });
});

test('CU-R14-04 找不到窗口 → CU_TARGET_NOT_FOUND，回执不得声称已投递或全局', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const actionId = uniqueId('cu_r14_04');
    const res = await withoutTouchingDesktop('CU-R14-04', () => client.call('left_click', clickArgs(actionId)));
    const receipt = expectToolError(res, { code: 'CU_TARGET_NOT_FOUND', actionId });
    expect(receipt.method, 'a failed background click must not report a foreground/global method').not.toBe('foreground');
    expect(/前台|foreground|全局/i.test(res.text), 'the failure text must not describe a global click').toBe(false);
  });
});

test('CU-R14-05 反向：foreground 省略与 false 等价，两者都不产生全局点击', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const omitted = clickArgs(uniqueId('cu_r14_05a'));
    delete omitted.foreground;
    const a = await withoutTouchingDesktop('CU-R14-05 (omitted)', () => client.call('left_click', omitted));
    const b = await withoutTouchingDesktop('CU-R14-05 (false)', () =>
      client.call('left_click', clickArgs(uniqueId('cu_r14_05b'))),
    );
    expect(a.structuredContent?.code, 'omitted foreground behaves as background').toBe(b.structuredContent?.code);
    expect(a.structuredContent?.code).toBe('CU_TARGET_NOT_FOUND');
  });
});

test('CU-R14-06 反向：投递失败后真实指针位置不变（独立 CoreGraphics 探针）', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const res = await withoutTouchingDesktop('CU-R14-06', () =>
      client.call('left_click', clickArgs(uniqueId('cu_r14_06'))),
    );
    expectToolError(res, { code: 'CU_TARGET_NOT_FOUND' });
  });
});

test('CU-R14-07 反向：投递失败后用户前台应用不变（独立 lsappinfo 探针）', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'double_click');
    const res = await withoutTouchingDesktop('CU-R14-07', () =>
      client.call('double_click', clickArgs(uniqueId('cu_r14_07'))),
    );
    expectToolError(res, { code: 'CU_TARGET_NOT_FOUND' });
  });
});

test('CU-R14-08 相同 actionId 同参数重试 → 返回已有回执，不重新投递', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const actionId = uniqueId('cu_r14_08');
    const args = clickArgs(actionId);
    const first = await client.call('left_click', args);
    const second = await withoutTouchingDesktop('CU-R14-08 (retry)', () => client.call('left_click', args));
    if (first.structuredContent?.code) {
      expect(second.structuredContent?.code, 'the retry returns the recorded outcome').toBe(first.structuredContent.code);
    } else {
      expectToolOk(second, { actionId });
      expect(second.structuredContent.state, 'the retry is the same recorded action').toBe(first.structuredContent.state);
    }
    expect(second.structuredContent?.actionId).toBe(actionId);
  });
});

test('CU-R14-09 反向：失败回执不得声称成功完成', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const res = await client.call('left_click', clickArgs(uniqueId('cu_r14_09')));
    expectToolError(res, { code: 'CU_TARGET_NOT_FOUND' });
    expect(res.text, 'a failure receipt must not print a success claim').not.toMatch(/成功完成|已完成|successfully/i);
    if (res.structuredContent?.verification) {
      expect(['unknown', 'not-applicable'], 'a failed dispatch is never verified').toContain(
        res.structuredContent.verification,
      );
    }
  });
});

test('CU-R14-10 [环境] 显式 foreground:true 才允许全局 —— 默认不执行（会抢用户前台）', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    requireForeground('CU-R14-10');
    const res = await client.call('left_click', clickArgs(uniqueId('cu_r14_10'), { foreground: true }));
    expectToolError(res, { code: 'CU_TARGET_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// R15 — coordinates, snapshots, Retina mapping
// ---------------------------------------------------------------------------

test('CU-R15-01 没有有效截图映射时 → CU_SCREENSHOT_REQUIRED，零投递', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const args = clickArgs(uniqueId('cu_r15_01'));
    delete args.snapshotId;
    const res = await withoutTouchingDesktop('CU-R15-01', () => client.call('left_click', args));
    expectToolError(res, { code: 'CU_SCREENSHOT_REQUIRED' });
  });
});

test('CU-R15-02 负数坐标 → CU_INVALID_COORDINATE', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    for (const point of [{ x: -1, y: 5 }, { x: 5, y: -1 }, { x: -100000, y: -100000 }]) {
      const res = await withoutTouchingDesktop('CU-R15-02', () =>
        client.call('left_click', clickArgs(uniqueId('cu_r15_02'), point)),
      );
      expectToolError(res, { code: 'CU_INVALID_COORDINATE' });
    }
  });
});

test('CU-R15-03 小数坐标 → CU_INVALID_COORDINATE', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    for (const point of [{ x: 1.5, y: 5 }, { x: 5, y: 0.1 }]) {
      const res = await withoutTouchingDesktop('CU-R15-03', () =>
        client.call('left_click', clickArgs(uniqueId('cu_r15_03'), point)),
      );
      expectToolError(res, { code: 'CU_INVALID_COORDINATE' });
    }
  });
});

test('CU-R15-04 坐标类型错/非有限值必须被拒绝（JSON 无 NaN，字符串 NaN 是类型错）', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    for (const point of [{ x: 'NaN', y: 5 }, { x: '1e999', y: 0 }, { x: null, y: 5 }]) {
      const res = await withoutTouchingDesktop('CU-R15-04', () =>
        client.call('left_click', clickArgs(uniqueId('cu_r15_04'), point)),
      );
      // 合同把 NaN 归入 CU_INVALID_COORDINATE，但 JSON 里 NaN 只能以字符串到达（类型错），两者都算拒绝。
      expect(['CU_INVALID_COORDINATE', 'CU_INVALID_ARGUMENT'], 'non-finite coordinate must not be accepted').toContain(
        res.structuredContent?.code,
      );
    }
  });
});

test('CU-R15-05 越界坐标（x=imgW / y=imgH）→ CU_INVALID_COORDINATE，边界内最右下像素合法', async () => {
  requireScreenRead('CU-R15-05 needs the real image size');
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const shot = await client.call('screenshot', { max_width: 0 }, { timeoutMs: 40_000 });
    const receipt = expectScreenshotFields(screenshotReceipt(shot));
    const outside = await client.call(
      'left_click',
      clickArgs(uniqueId('cu_r15_05a'), {
        snapshotId: receipt.snapshotId,
        x: receipt.imgW,
        y: receipt.imgH,
      }),
    );
    expectToolError(outside, { code: 'CU_INVALID_COORDINATE' });
    // 最右下合法像素 (imgW-1, imgH-1) 必须可操作：不得再判 INVALID_COORDINATE。
    const inside = await client.call(
      'left_click',
      clickArgs(uniqueId('cu_r15_05b'), {
        snapshotId: receipt.snapshotId,
        x: receipt.imgW - 1,
        y: receipt.imgH - 1,
      }),
    );
    expect(inside.structuredContent?.code, 'the rightmost/bottom pixel is legal').not.toBe('CU_INVALID_COORDINATE');
  });
});

test('CU-R15-06 Retina 映射：窗口截图与主屏截图的像素/逻辑比例一致', async () => {
  requireScreenRead('CU-R15-06 needs both screenshots');
  await withInstance(async client => {
    const windows = await windowList(client);
    const display = windows.windows.find(window => window.width > 200 && window.height > 200);
    if (!display) throw new EnvironmentBlocked('no large window in window_list to compare against the main display');
    const full = screenshotReceipt(await client.call('screenshot', { max_width: 0 }, { timeoutMs: 40_000 }));
    expectScreenshotFields(full, { require: ['snapshotId', 'imgW', 'imgH', 'logicalBounds', 'displayId'] });
    const scaled = Number(full.logicalBounds?.width ?? full.logicalBounds?.w);
    if (!Number.isFinite(scaled)) {
      throw new EnvironmentBlocked(
        `screenshot.logicalBounds has no readable width: ${JSON.stringify(full.logicalBounds)}`,
      );
    }
    const factor = full.imgW / scaled;
    expect(factor, 'the screenshot must be an integer multiple of the logical width (Retina backing scale)').toBeLessThan(4);
    expect(Number.isInteger(factor) || Math.abs(factor - Math.round(factor * 2) / 2) < 0.01, 'a half-pixel scale is the only tolerated fraction').toBe(true);
    const bytes = imageBytes(await client.call('screenshot', { max_width: 0 }, { timeoutMs: 40_000 }));
    const dims = imageDimensions(bytes.buffer);
    expect([dims.width, dims.height], 'declared imgW/imgH must equal the real byte dimensions').toEqual([full.imgW, full.imgH]);
  });
});

test('CU-R15-07 旧 snapshotId（同实例再截图后）→ CU_STALE_SNAPSHOT，不按新前台猜坐标', async () => {
  requireScreenRead('CU-R15-07 needs two screenshots');
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const target = await waitForTarget(client);
    const first = expectScreenshotFields(screenshotReceipt(await client.call('screenshot', { max_width: 640 }, { timeoutMs: 40_000 })));
    await client.call('screenshot', { max_width: 640 }, { timeoutMs: 40_000 });
    const res = await client.call(
      'left_click',
      clickArgs(uniqueId('cu_r15_07'), { target, snapshotId: first.snapshotId, x: 10, y: 10 }),
    );
    expectToolError(res, { code: 'CU_STALE_SNAPSHOT' });
  });
});

test('CU-R15-08 跨实例 snapshotId → CU_STALE_SNAPSHOT', async () => {
  requireScreenRead('CU-R15-08 needs a screenshot from another instance');
  requireFixtureWindow();
  const a = await CuMcp.start({ label: 'cu-r15-08-a' });
  const b = await CuMcp.start({ label: 'cu-r15-08-b' });
  try {
    requireActionTool(b, 'left_click');
    const target = await waitForTarget(b);
    const shot = expectScreenshotFields(screenshotReceipt(await a.call('screenshot', { max_width: 640 }, { timeoutMs: 40_000 })));
    const res = await b.call(
      'left_click',
      clickArgs(uniqueId('cu_r15_08'), { target, snapshotId: shot.snapshotId, x: 10, y: 10 }),
    );
    expectToolError(res, { code: 'CU_STALE_SNAPSHOT' });
  } finally {
    a.close();
    b.close();
  }
});

test('CU-R15-09 有效且已授权的目标 + 从未签发的 snapshotId → CU_STALE_SNAPSHOT', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const target = await waitForTarget(client);
    const res = await withoutTouchingDesktop('CU-R15-09', () =>
      client.call(
        'left_click',
        clickArgs(uniqueId('cu_r15_09'), { target, snapshotId: 'cu_batch_never_issued_snapshot' }),
      ),
    );
    expectToolError(res, { code: 'CU_STALE_SNAPSHOT' });
  });
});

test('CU-R15-10 drag 任一端坐标非法 → CU_INVALID_COORDINATE，零投递', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'drag');
    for (const point of [{ x1: -1, y1: 1, x2: 5, y2: 5 }, { x1: 1, y1: 1, x2: 5.5, y2: 5 }]) {
      const res = await withoutTouchingDesktop('CU-R15-10', () =>
        client.call('drag', {
          actionId: uniqueId('cu_r15_10'),
          target: GHOST,
          snapshotId: uniqueId('cu_snap'),
          foreground: false,
          ...point,
        }),
      );
      expectToolError(res, { code: 'CU_INVALID_COORDINATE' });
    }
  });
});

test('CU-R15-11 drag 两端坐标缺失 → CU_INVALID_ARGUMENT', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'drag');
    const res = await withoutTouchingDesktop('CU-R15-11', () =>
      client.call('drag', {
        actionId: uniqueId('cu_r15_11'),
        target: GHOST,
        snapshotId: uniqueId('cu_snap'),
        foreground: false,
        x1: 1,
        y1: 1,
      }),
    );
    expectToolError(res, { code: 'CU_INVALID_ARGUMENT' });
  });
});

test('CU-R15-12 scroll：amount 非正整数（0 / -1 / 1.5）→ CU_INVALID_ARGUMENT，零投递', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'scroll');
    for (const amount of [0, -1, 1.5]) {
      const res = await withoutTouchingDesktop('CU-R15-12', () =>
        client.call('scroll', {
          actionId: uniqueId('cu_r15_12'),
          target: GHOST,
          snapshotId: uniqueId('cu_snap'),
          foreground: false,
          x: 1,
          y: 1,
          amount,
        }),
      );
      expectToolError(res, { code: 'CU_INVALID_ARGUMENT' });
    }
  });
});

test('CU-R15-13 主屏截图必须先获"允许主屏全部可见内容"授权，否则 CU_SCREEN_SCOPE_REQUIRED 且零像素', async () => {
  requireScreenRead(
    'CU-R15-13 touches display pixels either way: it passes when the call is refused, and fails when the desktop is returned without the opt-in',
  );
  await withInstance(async client => {
    const res = await client.call('screenshot', { max_width: 640 }, { timeoutMs: 40_000 });
    if (res.isError) {
      expectToolError(res, { code: 'CU_SCREEN_SCOPE_REQUIRED' });
      expect(res.images.length, 'a refused screenshot must not return pixels').toBe(0);
      return;
    }
    // 取到像素只有在用户确实勾选了主屏授权时才是合法的；否则就是"无授权取桌面"。
    expect(
      process.env.CU_SCREEN_SCOPE_OPTED_IN,
      'main-screen pixels came back without the documented opt-in: the instance must refuse with CU_SCREEN_SCOPE_REQUIRED ' +
        '(set CU_SCREEN_SCOPE_OPTED_IN=1 only if the operator ticked 允许主屏全部可见内容 in this instance)',
    ).toBe('1');
    expect(res.images.length, 'when pixels are returned they must be real image content').toBeGreaterThan(0);
  });
});

test('CU-R15-14 window_list 只列已授权应用的窗口：与 doctor 的按应用权限逐条交叉核对', async ({ request }) => {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance');
  await withInstance(async client => {
    const windows = await windowList(client);
    const doctor = await cuDoctor(request, baseURL);
    const apps = doctor.body?.permissions?.apps ?? doctor.body?.apps;
    expect(apps, 'doctor must publish the per-app permission statuses (INTERFACE 第 9 段)').toBeTruthy();
    const entries = Array.isArray(apps) ? apps : Object.entries(apps).map(([id, value]) => ({ id, ...value }));
    const allowed = new Set(
      entries
        .filter(entry => entry.granted === true || entry.allowed === true || entry.status === 'available')
        .map(entry => entry.bundleId || entry.id),
    );
    for (const window of windows.windows) {
      expect(
        allowed.has(window.bundleId ?? window.app),
        `window_list reported "${window.app}" / "${window.title}", which is not on the authorised app list (${[...allowed].join(', ') || 'empty'})`,
      ).toBe(true);
    }
  });
});
