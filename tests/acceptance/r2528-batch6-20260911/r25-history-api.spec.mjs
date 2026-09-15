// R25 —— GUI 思考签名与历史处理兼容（HTTP 合同面）
//
// 合同来源：.devflow/INTERFACE.md「官方辅助能力、历史与外部项目（R25–R28）」历史变换段
// （dry-run/提交/错误码/零改写/兼容性）+ 补充边界矩阵 history/official-query 行
// +「公共规则、身份与错误」。
//
// 观测手段：公开 HTTP（/api/sessions/:sid/{trim,compact-segment,trim-before-tool,strip-thinking,
// repair-official-compat}）与公开 messages 读回。文件级版本用响应里的 baseVersion/resultVersion
// 比较，不读私有 JSONL。
import { test, expect } from '@playwright/test';
import * as rt from './helpers/r2528-runtime.mjs';

/** 内容不敏感的用例共用一个夹具（只做"拒绝/零改写"比较，不依赖会话里还剩什么）。 */
let shared = null;
async function throwawaySession(request, baseURL) {
  if (!shared) shared = await rt.createFixtureSession(request, baseURL, { messages: 2, label: 'R2528_SHARED' });
  return shared;
}

/** 内容敏感的用例各自新开夹具（避免前一个用例改写后影响后一个用例的判断）。 */
async function freshSession(request, baseURL, options = {}) {
  return await rt.createFixtureSession(request, baseURL, { messages: 2, label: 'R2528_FRESH', ...options });
}

/** 200 信封期望失败时，409 SESSION_RUNNING 单独点出"运行中"口径歧义（见 README）。 */
function expectSuccess(result, label) {
  const detail = result.status === 409 && result.body?.code === 'SESSION_RUNNING'
    ? `${label}: 409 SESSION_RUNNING 出现在一个回合已达终态的夹具会话上 —— ` +
      '请核对"运行中"的定义（是否把常驻 CLI 进程也算运行中）；若是，夹具制备需按 README「合同歧义」调整'
    : `${label}: 期望成功信封，实际 HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 240)}`;
  expect(result.status, detail).toBe(200);
}

async function previewTrim(request, baseURL, fixture, anchor) {
  return await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
    projectHash: fixture.projectHash, uuid: anchor, dryRun: true,
  });
}

test.describe('R25 历史变换与官方兼容（HTTP）', () => {
  test('R25-01 trim 预览缺 dryRun → 400 SESSION_INVALID_INPUT 且零会话改写', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchor = rt.anchorFor(before, fixture.markers[0]);

    const result = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
      projectHash: fixture.projectHash, uuid: anchor,
    });

    rt.expectJsonError(result, { status: 400, code: 'SESSION_INVALID_INPUT', mustNotContain: [anchor] });
    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-01 缺 dryRun');
  });

  test('R25-02 trim 预览 dryRun 非布尔 → 400 SESSION_INVALID_INPUT 且零会话改写', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchor = rt.anchorFor(before, fixture.markers[0]);

    const result = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
      projectHash: fixture.projectHash, uuid: anchor, dryRun: 'true',
    });

    rt.expectJsonError(result, { status: 400, code: 'SESSION_INVALID_INPUT' });
    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-02 非布尔 dryRun');
  });

  test('R25-03 trim 缺 projectHash → 400 SESSION_INVALID_INPUT', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);

    const result = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
      uuid: '11111111-1111-1111-1111-111111111111', dryRun: true,
    });

    rt.expectJsonError(result, { status: 400, code: 'SESSION_INVALID_INPUT' });
  });

  test('R25-04 trim 锚点缺失或时间非法 → 400 SESSION_INVALID_INPUT', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);

    const noAnchor = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
      projectHash: fixture.projectHash, dryRun: true,
    });
    rt.expectJsonError(noAnchor, { status: 400, code: 'SESSION_INVALID_INPUT' });

    const badTime = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
      projectHash: fixture.projectHash, fromTimestamp: 'not-a-date', dryRun: true,
    });
    rt.expectJsonError(badTime, { status: 400, code: 'SESSION_INVALID_INPUT' });
  });

  test('R25-05 未知会话或未知锚点 → 404 SESSION_NOT_FOUND', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);

    const unknownSession = await rt.postHistoryOp(request, baseURL, 'no-such-session-r2528', 'trim', {
      projectHash: fixture.projectHash, uuid: '11111111-1111-1111-1111-111111111111', dryRun: true,
    });
    rt.expectJsonError(unknownSession, { status: 404, code: 'SESSION_NOT_FOUND' });

    const unknownAnchor = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
      projectHash: fixture.projectHash, uuid: '11111111-1111-1111-1111-111111111111', dryRun: true,
    });
    rt.expectJsonError(unknownAnchor, { status: 404, code: 'SESSION_NOT_FOUND' });
  });

  test('R25-06 trim 合法预览 → 200 预览信封字段齐全', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);

    const result = await previewTrim(request, baseURL, fixture, rt.anchorFor(before, fixture.markers[1]));

    expectSuccess(result, 'R25-06 trim 预览');
    rt.expectPreviewEnvelope(result.body);
  });

  test('R25-07 预览零会话改写（反向）：连续两次预览 baseVersion 一致且消息不变', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchor = rt.anchorFor(before, fixture.markers[1]);

    const first = await previewTrim(request, baseURL, fixture, anchor);
    expectSuccess(first, 'R25-07 第一次预览');
    rt.expectPreviewEnvelope(first.body);
    const second = await previewTrim(request, baseURL, fixture, anchor);
    expectSuccess(second, 'R25-07 第二次预览');
    rt.expectPreviewEnvelope(second.body);

    expect(second.body.baseVersion, '两次未发生写入的预览必须基于同一个 baseVersion').toBe(first.body.baseVersion);
    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-07 预览');
  });

  test('R25-08 提交夹带不同参数 → 409 SESSION_OPERATION_CONFLICT 且零会话改写', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchorSecond = rt.anchorFor(before, fixture.markers[1]);
    const anchorFirst = rt.anchorFor(before, fixture.markers[0]);

    const preview = await previewTrim(request, baseURL, fixture, anchorSecond);
    expectSuccess(preview, 'R25-08 预览');

    const submit = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
      projectHash: fixture.projectHash,
      uuid: anchorFirst,
      dryRun: false,
      baseVersion: preview.body.baseVersion,
      previewToken: preview.body.previewToken,
    });

    rt.expectJsonError(submit, { status: 409, code: 'SESSION_OPERATION_CONFLICT', mustNotContain: [anchorFirst] });
    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-08 参数不符的提交');
  });

  test('R25-09 未知预览 token 提交 → 409 且零会话改写', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchor = rt.anchorFor(before, fixture.markers[1]);

    const result = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
      projectHash: fixture.projectHash,
      uuid: anchor,
      dryRun: false,
      baseVersion: 'r2528-not-a-real-version',
      previewToken: 'r2528-not-a-real-token',
    });

    expect(result.status, `未知预览提交必须 409，实际 ${result.status} ${JSON.stringify(result.body).slice(0, 200)}`).toBe(409);
    expect(
      ['SESSION_OPERATION_CONFLICT', 'SESSION_PREVIEW_EXPIRED'],
      `未知/过期预览的 code 必须取自合同枚举（got ${result.body?.code}）`,
    ).toContain(result.body?.code);
    expect(result.body?.ok, '失败必须是 ok:false 信封').toBe(false);
    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-09 未知预览 token');
  });

  test('R25-10 trim 提交成功 → 200 提交信封且后文确实被截去', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchor = rt.anchorFor(before, fixture.markers[1]);

    const preview = await previewTrim(request, baseURL, fixture, anchor);
    expectSuccess(preview, 'R25-10 预览');

    const submit = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
      projectHash: fixture.projectHash,
      uuid: anchor,
      dryRun: false,
      baseVersion: preview.body.baseVersion,
      previewToken: preview.body.previewToken,
    });
    expectSuccess(submit, 'R25-10 提交');
    rt.expectSubmitEnvelope(submit.body);

    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    expect(rt.messagesContain(after.body, fixture.markers[1]),
      'R25-10 从第二个标记起截去后文：被截去的标记不得再出现在 messages 里').toBe(false);
    expect(rt.messagesContain(after.body, fixture.markers[0]),
      'R25-10 截断锚点之前的内容必须原样保留').toBe(true);
    expect(submit.body.report, '提交报告不得为空').toBeTruthy();
    if (preview.body.requiresNewSession === false) {
      expect(submit.body.resultSessionId, '预览判定留在原会话时，resultSessionId 必须指向结果会话').toBeTruthy();
    }
  });

  test('R25-11 已完成预览的同进程重放 → 返回缓存结果且不二次写入', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchor = rt.anchorFor(before, fixture.markers[1]);

    const preview = await previewTrim(request, baseURL, fixture, anchor);
    expectSuccess(preview, 'R25-11 预览');
    const payload = {
      projectHash: fixture.projectHash, uuid: anchor, dryRun: false,
      baseVersion: preview.body.baseVersion, previewToken: preview.body.previewToken,
    };
    const submit = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', payload);
    expectSuccess(submit, 'R25-11 提交');
    rt.expectSubmitEnvelope(submit.body);
    const afterFirst = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);

    const replay = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', payload);
    expectSuccess(replay, 'R25-11 重放');
    expect(replay.body.resultVersion, '重放必须返回原结果（resultVersion 相同）').toBe(submit.body.resultVersion);
    expect(replay.body.backupRef, '重放必须返回原结果的 backupRef').toBe(submit.body.backupRef);
    const afterReplay = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    rt.expectNoSessionWrite(afterFirst, afterReplay, 'R25-11 重放');
  });

  test('R25-12 预览后会话出现新内容 → 提交 409 SESSION_CHANGED 且零会话改写', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchor = rt.anchorFor(before, fixture.markers[1]);

    const preview = await previewTrim(request, baseURL, fixture, anchor);
    expectSuccess(preview, 'R25-12 预览');

    const extraMarker = rt.uniqueId('R2528_EXTRA');
    const extra = await rt.postJson(request, baseURL, '/api/chat', {
      prompt: `${extraMarker} 追加内容`, cwd: fixture.workspace, sessionId: fixture.sessionId,
    });
    expect(extra.status, `追加一条用户消息必须被接受（${JSON.stringify(extra.body).slice(0, 160)}）`).toBe(200);
    await expect.poll(async () => {
      const now = await rt.readMessages(request, baseURL, fixture.sessionId, fixture.projectHash);
      return rt.messagesContain(now.body, extraMarker);
    }, { message: 'R25-12 追加的消息必须落进会话', timeout: 20_000 }).toBe(true);
    // 追加消息会同时开一个回合；回合未到终态时正确回答是 SESSION_RUNNING，所以轮询到它落定，
    // 再断言"有新内容"的那条 409 SESSION_CHANGED。
    let submit = null;
    await expect.poll(async () => {
      submit = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
        projectHash: fixture.projectHash, uuid: anchor, dryRun: false,
        baseVersion: preview.body.baseVersion, previewToken: preview.body.previewToken,
      });
      return submit.status;
    }, { message: 'R25-12 追加内容后提交必须被拒绝（回合落定后应为 409）', timeout: 30_000, intervals: [2_000] }).toBe(409);

    rt.expectJsonError(submit, { status: 409, code: 'SESSION_CHANGED' });
    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    expect(rt.messagesContain(after.body, extraMarker), 'R25-12 被拒绝的提交不得动到刚追加的内容').toBe(true);
    expect(rt.messagesContain(after.body, fixture.markers[1]), 'R25-12 被拒绝的提交不得执行截断').toBe(true);
  });

  test('R25-13 运行中的会话拒绝历史操作 → 409 SESSION_RUNNING', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const section = rt.fixtureSection('runningSession');
    const sessionId = rt.requireField(section, 'sessionId');
    const projectHash = rt.requireField(section, 'projectHash');
    const before = await rt.sessionSnapshot(request, baseURL, sessionId, projectHash);
    const anchor = rt.firstUserAnchor(before);

    const result = await rt.postHistoryOp(request, baseURL, sessionId, 'trim', {
      projectHash, uuid: anchor, dryRun: true,
    });

    rt.expectJsonError(result, { status: 409, code: 'SESSION_RUNNING' });
    const after = await rt.sessionSnapshot(request, baseURL, sessionId, projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-13 运行中拒绝');
  });

  test('R25-14 strip-thinking 预览 → 200 预览信封且零会话改写', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);

    const result = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'strip-thinking', {
      projectHash: fixture.projectHash, dryRun: true,
    });

    expectSuccess(result, 'R25-14 strip-thinking 预览');
    rt.expectPreviewEnvelope(result.body);
    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-14 预览');
  });

  test('R25-15 strip-thinking 提交 → 200 且非思考内容不丢', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);

    const preview = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'strip-thinking', {
      projectHash: fixture.projectHash, dryRun: true,
    });
    expectSuccess(preview, 'R25-15 预览');
    rt.expectPreviewEnvelope(preview.body);

    const submit = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'strip-thinking', {
      projectHash: fixture.projectHash, dryRun: false,
      baseVersion: preview.body.baseVersion, previewToken: preview.body.previewToken,
    });
    expectSuccess(submit, 'R25-15 提交');
    rt.expectSubmitEnvelope(submit.body);

    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    for (const marker of fixture.markers) {
      expect(rt.messagesContain(after.body, marker),
        `R25-15 strip-thinking 不得丢掉非思考内容（${marker} 仍在）`).toBe(true);
    }
  });

  test('R25-16 compact-segment direction 缺失或非法 → 400 SESSION_INVALID_INPUT', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);
    const snapshot = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchor = rt.anchorFor(snapshot, fixture.markers[0]);

    const missing = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'compact-segment', {
      projectHash: fixture.projectHash, uuid: anchor, dryRun: true,
    });
    rt.expectJsonError(missing, { status: 400, code: 'SESSION_INVALID_INPUT' });

    const illegal = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'compact-segment', {
      projectHash: fixture.projectHash, uuid: anchor, direction: 'sideways', dryRun: true,
    });
    rt.expectJsonError(illegal, { status: 400, code: 'SESSION_INVALID_INPUT' });
  });

  test('R25-17 compact-segment 预览必须带摘要（明确请求 compact 时才生成）', async ({ request }) => {
    rt.requireModel('生成压缩摘要需要一次真实模型调用');
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL, { messages: 3 });
    const snapshot = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchor = rt.anchorFor(snapshot, fixture.markers[1]);

    const result = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'compact-segment', {
      projectHash: fixture.projectHash, uuid: anchor, direction: 'before', dryRun: true,
    });

    expectSuccess(result, 'R25-17 compact 预览');
    rt.expectPreviewEnvelope(result.body);
    expect(result.body.summary, '明确请求 compact 的预览必须带摘要预览').toBeTruthy();
    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    rt.expectNoSessionWrite(snapshot, after, 'R25-17 预览');
  });

  test('R25-18 GET repair-official-compat 只读体检 → 200 {changed,report,compatibility} 且不写会话', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);

    const result = await rt.getRepairCompat(request, baseURL, fixture.sessionId, fixture.projectHash);

    expectSuccess(result, 'R25-18 GET repair');
    expect(typeof result.body.changed, 'GET 体检必须报告 changed 布尔').toBe('boolean');
    expect(result.body.report, 'GET 体检必须带 report').toBeTruthy();
    expect(typeof result.body.compatibility, 'GET 体检必须带 compatibility').toBe('string');
    expect(result.body.summary, 'GET 体检不得生成摘要').toBeUndefined();
    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-18 GET 体检');
  });

  test('R25-19 repair-official-compat 预览 → 200 信封且零会话改写', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);

    const result = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'repair-official-compat', {
      projectHash: fixture.projectHash, dryRun: true,
    });

    expectSuccess(result, 'R25-19 repair 预览');
    rt.expectPreviewEnvelope(result.body);
    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-19 repair 预览');
  });

  test('R25-20 trim 预览不得生成摘要（摘要只在明确请求 compact 时出现）', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);
    const snapshot = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);

    const result = await previewTrim(request, baseURL, fixture, rt.anchorFor(snapshot, fixture.markers[0]));

    expectSuccess(result, 'R25-20 trim 预览');
    rt.expectPreviewEnvelope(result.body); // 前置守卫：拿到的必须真是预览信封，否则"没有摘要"不成立
    expect(result.body.summary, 'trim 预览不得附带摘要').toBeUndefined();
  });

  test('R25-21 预览容量 64：第 65 个在提交中的预览 → 503 SESSION_PREVIEW_BUSY', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await throwawaySession(request, baseURL);
    const snapshot = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const anchor = rt.anchorFor(snapshot, fixture.markers[0]);

    let last = null;
    for (let index = 0; index < 65; index += 1) {
      // 每个预览用不同的规范业务参数（不同 ISO 时间锚点），确保占的是不同的预览项。
      const fromTimestamp = new Date(Date.UTC(2026, 8, 11, 0, index, 0)).toISOString();
      last = await rt.postHistoryOp(request, baseURL, fixture.sessionId, 'trim', {
        projectHash: fixture.projectHash, fromTimestamp, dryRun: true,
      });
      if (index < 64) {
        expectSuccess(last, `R25-21 第 ${index + 1} 个预览`);
        rt.expectPreviewEnvelope(last.body);
      }
    }

    rt.expectJsonError(last, { status: 503, code: 'SESSION_PREVIEW_BUSY' });
  });

  test('R25-22 预览不停止活动任务（反向）：本次夹具会话的进程不被预览结束', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL, { messages: 1 }); // 新会话才有新鲜的进程可观测
    const snapshot = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    const before = await rt.getJson(request, baseURL, '/api/processes');
    expect(before.status, '/api/processes 必须可用作"预览不停任务"的观测面').toBe(200);

    const result = await previewTrim(request, baseURL, fixture, rt.anchorFor(snapshot, fixture.markers[0]));

    expectSuccess(result, 'R25-22 预览');
    const after = await rt.getJson(request, baseURL, '/api/processes');
    expect(after.status).toBe(200);
    // 只盯本用例夹具会话自己的进程：别的会话的空闲进程会被产品按自己的节奏回收，不属于本断言。
    const mine = (body) => (body?.sessionProcesses || [])
      .filter(p => p.sessionId === fixture.sessionId)
      .map(p => p.pid)
      .sort();
    const beforePids = mine(before.body);
    expect(beforePids.length, 'R25-22 夹具会话应当有可观测的本地进程（否则这条反向断言没有观测面）').toBeGreaterThan(0);
    for (const pid of beforePids) {
      expect(mine(after.body), `R25-22 预览不得结束夹具会话的进程 ${pid}`).toContain(pid);
    }
  });

  test('R25-23 正常发送只原样追加（反向）：旧消息 uuid 序列不变', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const fixture = await freshSession(request, baseURL, { messages: 1 });
    const before = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);

    const newMarker = rt.uniqueId('R2528_APPEND');
    const sent = await rt.postJson(request, baseURL, '/api/chat', {
      prompt: `${newMarker} 只回复 OK`, cwd: fixture.workspace, sessionId: fixture.sessionId,
    });
    expect(sent.status, `追加发送必须被接受（${JSON.stringify(sent.body).slice(0, 160)}）`).toBe(200);
    await expect.poll(async () => {
      const now = await rt.readMessages(request, baseURL, fixture.sessionId, fixture.projectHash);
      return rt.messagesContain(now.body, newMarker);
    }, { message: 'R25-23 新内容必须落进会话', timeout: 20_000 }).toBe(true);

    const after = await rt.sessionSnapshot(request, baseURL, fixture.sessionId, fixture.projectHash);
    for (const [index, uuid] of before.uuids.entries()) {
      expect(after.uuids[index], `R25-23 原样追加：第 ${index + 1} 条旧消息的 uuid 必须保持不变`).toBe(uuid);
    }
    expect(after.count, 'R25-23 原样追加只增加内容').toBeGreaterThan(before.count);
  });

  test('R25-24 越权读取备份引用 → 403（需要第二主体夹具）', async ({ request }) => {
    const section = rt.fixtureSection('secondPrincipal');
    const baseURL = rt.getRuntime().baseURL;
    const sessionId = rt.requireField(section, 'sessionId');
    const projectHash = rt.requireField(section, 'projectHash');
    const backupRef = rt.requireField(section, 'backupRef');
    // INTERFACE 固定了"按 backupRef 只读展示副本"的语义与 403/404/504，但没固定路由；
    // 路由模板由夹具提供（与 SB-* 对 agent 停止入口的处理一致），不猜。
    const template = rt.requireField(section, 'backupViewPathTemplate');
    const url = template
      .replace('{sessionId}', encodeURIComponent(sessionId))
      .replace('{projectHash}', encodeURIComponent(projectHash))
      .replace('{backupRef}', encodeURIComponent(backupRef));

    const result = await rt.getJson(request, baseURL, url);

    rt.expectJsonError(result, { status: 403 });
  });

  test('R25-25 兼容性无法验证时 409 SESSION_COMPATIBILITY_UNVERIFIED 且零会话改写', async ({ request }) => {
    const section = rt.fixtureSection('incompatibleSession');
    const baseURL = rt.getRuntime().baseURL;
    const before = await rt.sessionSnapshot(request, baseURL, section.sessionId, section.projectHash);
    const anchor = rt.anchorFor(before, section.anchorMarker);

    const preview = await rt.postHistoryOp(request, baseURL, section.sessionId, 'trim', {
      projectHash: section.projectHash, uuid: anchor, dryRun: true,
    });
    expectSuccess(preview, 'R25-25 预览');
    rt.expectPreviewEnvelope(preview.body);
    expect(preview.body.compatibility, '无法验证兼容的预览必须把 compatibility 标成未验证').not.toBe('compatible');

    const submit = await rt.postHistoryOp(request, baseURL, section.sessionId, 'trim', {
      projectHash: section.projectHash, uuid: anchor, dryRun: false,
      baseVersion: preview.body.baseVersion, previewToken: preview.body.previewToken,
    });

    rt.expectJsonError(submit, { status: 409, code: 'SESSION_COMPATIBILITY_UNVERIFIED' });
    const after = await rt.sessionSnapshot(request, baseURL, section.sessionId, section.projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-25 兼容性拒绝');
  });
});
