// CU-R16-*: text input — encoding length, read-back verification, no silent success.
// CU-R17-*: key names, aliases and real effects.
// Contract: .devflow/INTERFACE.md「桌面操控与Codex对齐」第 13、18、19 段.
//
// All effect cases type into the disposable TextEdit document and read the result back through the
// Accessibility API (`helpers/cu-ax-probe.swift`) — an oracle that belongs to macOS, not to the
// product, so a success claim can be falsified. A file oracle is unusable here: this machine has
// `NSCloseAlwaysConfirmsChanges=1`, so TextEdit never writes the opened document back on its own.
// Every call re-resolves the target from window_list first.
import { test, expect } from '@playwright/test';
import {
  EnvironmentBlocked,
  assertFrontUnchanged,
  expectToolError,
  frontAppBaseline,
  requireActionTool,
  uniqueId,
  withoutTouchingDesktop,
  withInstance,
} from './helpers/cu-mcp.mjs';
import {
  assertTargetUnchanged,
  ensureFixture,
  expectTargetDoc,
  readTargetDoc,
  resetTargetDoc,
  waitForTarget,
} from './helpers/cu-fixture.mjs';

const EMOJI = '\u{1F600}';

function actionArgs(client, target, extra = {}) {
  const args = { actionId: uniqueId('cu_in'), target, foreground: false, ...extra };
  if (client.lastSnapshotId) args.snapshotId = client.lastSnapshotId;
  return args;
}

async function currentTarget(client) {
  // 每次输入前都重新解析：pid/windowId/bundleId 必须是本套件自建的那个窗口。
  return await waitForTarget(client);
}

/** Types `text` into the disposable window and returns the receipt. */
async function typeInto(client, target, text) {
  await assertTargetUnchanged(client, target); // 每次输入前核对目标身份
  return await client.call('type', actionArgs(client, target, { text }), { timeoutMs: 40_000 });
}

/** Presses one key string against the disposable window. */
async function pressKey(client, target, keys) {
  await assertTargetUnchanged(client, target);
  return await client.call('key', actionArgs(client, target, { keys }), { timeoutMs: 40_000 });
}

function requireFixtureWindow() {
  ensureFixture();
}

/** Fixture preparation: the effect cases below assume the disposable document starts empty. */
function startFromEmptyDocument(target) {
  resetTargetDoc(target);
}

// ---------------------------------------------------------------------------
// R16 — type
// ---------------------------------------------------------------------------

test('CU-R16-01 非字符串 text（数字/数组/对象/null/布尔）→ CU_INVALID_ARGUMENT', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'type');
    const target = { bundleId: 'com.example.cu-batch-nonexistent', pid: 999_999, windowId: 999_999_999 };
    for (const text of [42, ['a'], { text: 'a' }, null, true]) {
      const res = await withoutTouchingDesktop('CU-R16-01', () =>
        client.call('type', actionArgs(client, target, { text })),
      );
      expectToolError(res, { code: 'CU_INVALID_ARGUMENT' });
    }
  });
});

test('CU-R16-02 空串成功且零动作（目标文档不变）', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'type');
    const target = await currentTarget(client);
    const before = readTargetDoc(target);
    const res = await typeInto(client, target, '');
    expect(res.isError, `an empty string is a legal no-op; text: ${res.text.slice(0, 200)}`).toBe(false);
    expect(readTargetDoc(target), 'an empty type must not change the document').toBe(before);
  });
});

test('CU-R16-03 5000 个码点（emoji）必须接受 —— 不得按 UTF-16 单元计成 10000 而拒绝', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'type');
    const target = await currentTarget(client);
    const res = await typeInto(client, target, EMOJI.repeat(5_000));
    expect(
      res.structuredContent?.code,
      'exactly 5000 code points is inside the documented limit; a UTF-16 count would reject it as 10000',
    ).not.toBe('CU_INVALID_ARGUMENT');
  });
});

test('CU-R16-04 5001 个码点 → CU_INVALID_ARGUMENT，零投递', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'type');
    const target = { bundleId: 'com.example.cu-batch-nonexistent', pid: 999_999, windowId: 999_999_999 };
    for (const text of [EMOJI.repeat(5_001), 'a'.repeat(5_001)]) {
      const res = await withoutTouchingDesktop('CU-R16-04', () =>
        client.call('type', actionArgs(client, target, { text })),
      );
      expectToolError(res, { code: 'CU_INVALID_ARGUMENT' });
    }
  });
});

test('CU-R16-05 中文/emoji/组合字符按原文投递并读回：码点逐一相等，未归一未拆坏', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'type');
    const target = await currentTarget(client);
    startFromEmptyDocument(target);
    // U+0065 U+0301 (decomposed é) + 中文 + 星形平面字符 + ZWJ 组合 emoji
    const text = `décomposé ${EMOJI} 中文 \u{1F469}‍\u{1F4BB}`;
    const res = await typeInto(client, target, text);
    expect(res.isError, `typing must be accepted; text: ${res.text.slice(0, 200)}`).toBe(false);
    await expectTargetDoc(target, text);
    expect(res.structuredContent?.verification, 'a readable target must verify the delivered text').toBe('verified');
  });
});

test('CU-R16-06 [环境] 目标不支持读回时 → verification=unknown 且不得声称成功', async () => {
  throw new EnvironmentBlocked(
    'no non-readable text target is preparable on this machine (the gap needs an app whose text cannot be read back); ' +
      'see README「不可制备清单」',
  );
});

test('CU-R16-07 [环境] 目标与焦点不符（前台类调用）→ CU_TARGET_CHANGED', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'type');
    const target = await currentTarget(client);
    // 该分支只在 foreground 调用下可达，而 foreground:true 会抢用户前台 —— 默认拒绝执行。
    const front = await frontAppBaseline();
    const res = await client.call(
      'type',
      actionArgs(client, target, { text: uniqueId('cu_r16_07'), foreground: true }),
      { timeoutMs: 40_000 },
    );
    await assertFrontUnchanged(front, 'CU-R16-07');
    expectToolError(res, { code: 'CU_TARGET_CHANGED' });
  });
});

test('CU-R16-08 后台目标不接受输入时 → CU_BACKGROUND_UNSUPPORTED，且不改用户前台', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'type');
    const target = await currentTarget(client);
    startFromEmptyDocument(target);
    const marker = uniqueId('cu_r16_08');
    const res = await withoutTouchingDesktop('CU-R16-08', () => typeInto(client, target, marker));
    if (res.isError) {
      expect(
        ['CU_BACKGROUND_UNSUPPORTED', 'CU_TARGET_CHANGED', 'CU_PERMISSION_REQUIRED'],
        'a refused background type names a documented code',
      ).toContain(res.structuredContent?.code);
      return;
    }
    // 声称成功就必须有证据：文本要真的出现在目标文档里。
    await expectTargetDoc(target, marker);
  });
});

test('CU-R16-09 反向：回执声称 verified 时文本必须真的落到文档里（逐码点比对）', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'type');
    const target = await currentTarget(client);
    startFromEmptyDocument(target);
    const marker = uniqueId('cu_r16_09');
    const res = await typeInto(client, target, marker);
    if (res.isError) throw new EnvironmentBlocked(`type refused (${res.structuredContent?.code}); nothing to falsify`);
    if (res.structuredContent?.verification !== 'verified') {
      throw new EnvironmentBlocked(
        `verification=${res.structuredContent?.verification}: the read-back claim is not being made, so "verified implies landed" is not observable here`,
      );
    }
    await expectTargetDoc(target, marker);
  });
});

test('CU-R16-10 反向：unknown 的回执不得打印"成功完成"', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'type');
    const target = await currentTarget(client);
    const res = await typeInto(client, target, uniqueId('cu_r16_10'));
    if (res.isError) return; // 失败路径由 expectToolError 系列覆盖
    const verification = res.structuredContent?.verification;
    if (verification === 'unknown') {
      expect(res.text, 'an unverified dispatch must not claim completion').not.toMatch(/成功完成|已完成|successfully/i);
    }
  });
});

// ---------------------------------------------------------------------------
// R17 — key
// ---------------------------------------------------------------------------

const ALIAS_PAIRS = [
  ['up', 'arrow_up'],
  ['down', 'arrow_down'],
  ['left', 'arrow_left'],
  ['right', 'arrow_right'],
  ['escape', 'esc'],
  ['return', 'enter'],
  ['cmd+c', 'command+c'],
  ['option+a', 'alt+a'],
  ['ctrl+a', 'control+a'],
  ['Shift+Tab', 'shift+tab'],
];

test('CU-R17-01 别名与大小写等价：全部不被 CU_UNSUPPORTED_KEY 拒绝', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'key');
    const target = await currentTarget(client);
    for (const aliases of ALIAS_PAIRS) {
      for (const keys of aliases) {
        const res = await pressKey(client, target, keys);
        expect(
          res.structuredContent?.code,
          `"${keys}" is a documented alias/supported key and must not be refused as unsupported`,
        ).not.toBe('CU_UNSUPPORTED_KEY');
      }
    }
  });
});

const REJECTED_KEYS = ['', 'f13', 'meta+a', 'a+b', 'cmd+c+d', 'cmd+cmd+a', 'cmd+', '+a', 'unknown_key'];

test('CU-R17-01b 合同点名的单键（tab/space/backspace/delete/数字/字母）不被拒绝', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'key');
    const target = await currentTarget(client);
    for (const keys of ['tab', 'space', 'backspace', 'delete', 'a', 'Z', '7']) {
      const res = await pressKey(client, target, keys);
      expect(res.structuredContent?.code, `"${keys}" is a documented key and must not be refused`).not.toBe(
        'CU_UNSUPPORTED_KEY',
      );
    }
  });
});

test('CU-R17-02 空串/不支持键/多键组合/重复修饰符 → CU_UNSUPPORTED_KEY，整串在投递前拒绝', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'key');
    const target = await currentTarget(client);
    for (const keys of REJECTED_KEYS) {
      const res = await pressKey(client, target, keys);
      expectToolError(res, { code: 'CU_UNSUPPORTED_KEY' });
    }
  });
});

test('CU-R17-03 反向：整串被拒后不得留下部分按键（"a+f13" 不产生任何字符）', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'key');
    const target = await currentTarget(client);
    const before = readTargetDoc(target);
    const res = await pressKey(client, target, 'a+f13');
    expectToolError(res, { code: 'CU_UNSUPPORTED_KEY' });
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(readTargetDoc(target), 'the rejected string must not deliver the "a" half').toBe(before);
  });
});

test('CU-R17-04 不支持的键只做拒绝，不动用户前台（反向）', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'key');
    const target = await currentTarget(client);
    const res = await withoutTouchingDesktop('CU-R17-04', () => pressKey(client, target, 'f13'));
    expectToolError(res, { code: 'CU_UNSUPPORTED_KEY' });
  });
});

test('CU-R17-05 方向键真的生效：输 ab → 左移 → 输 x 得 "axb"', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'key');
    const target = await currentTarget(client);
    startFromEmptyDocument(target);
    const seed = uniqueId('cu_r17_05');
    expect((await typeInto(client, target, `${seed}ab`)).isError, 'seeding the document must work').toBe(false);
    await expectTargetDoc(target, `${seed}ab`);
    expect((await pressKey(client, target, 'arrow_left')).isError, 'arrow_left must work in the target').toBe(false);
    await typeInto(client, target, 'x');
    await expectTargetDoc(target, `${seed}axb`);
  });
});

test('CU-R17-06 修饰组合真的生效：cmd+a 全选后被输入替换，且不留残按下修饰符', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'key');
    const target = await currentTarget(client);
    startFromEmptyDocument(target);
    await typeInto(client, target, uniqueId('cu_r17_06'));
    expect((await pressKey(client, target, 'cmd+a')).isError, 'cmd+a must work in the target').toBe(false);
    await typeInto(client, target, 'z');
    await expectTargetDoc(target, 'z');
  });
});

test('CU-R17-07 return 真的生效：两段文本落在两行', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'key');
    const target = await currentTarget(client);
    startFromEmptyDocument(target);
    const first = uniqueId('cu_r17_07a');
    const second = uniqueId('cu_r17_07b');
    await typeInto(client, target, first);
    expect((await pressKey(client, target, 'return')).isError, 'return must work in the target').toBe(false);
    await typeInto(client, target, second);
    await expectTargetDoc(target, `${first}\n${second}`);
  });
});

test('CU-R17-08 backspace 与 delete 别名都向后删（不得变成前向删除）', async () => {
  requireFixtureWindow();
  await withInstance(async client => {
    requireActionTool(client, 'key');
    const target = await currentTarget(client);
    startFromEmptyDocument(target);
    await typeInto(client, target, 'abc');
    expect((await pressKey(client, target, 'backspace')).isError, 'backspace must work in the target').toBe(false);
    await expectTargetDoc(target, 'ab');
    await typeInto(client, target, 'c');
    expect((await pressKey(client, target, 'delete')).isError, 'delete is the documented alias of backspace').toBe(false);
    await expectTargetDoc(target, 'ab');
  });
});
