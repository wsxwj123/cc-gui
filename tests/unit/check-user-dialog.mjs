#!/usr/bin/env node
// 拒答重试卡(CLI request_user_dialog / refusal_fallback_prompt)的护栏。
// 真实拒答无法在测试里触发(要构造违规提问),故 payload 与 result 取值按 CLI 二进制里的
// zod 定义造 fixture,锁的是 GUI 这一侧的数据流与裁决翻译。
// 锁住的行为:
//   ① onUserDialog 与 supportedDialogKinds 必须成对出现在 chat.js 的 options 里 ——
//      只给 kinds 不给回调 SDK 在选项入口抛错;只给回调不声明 kind 则 CLI 一条对话框都不发
//      (失败闭合),整张卡永远不出现却看不出哪里坏了
//   ② 认不出的 dialogKind 必须回 cancelled(协议要求),不许建卡等人
//   ③ 裁决翻译:两个按钮 → completed + result;取消/拒绝/系统清卡 → cancelled
//   ④ 界面外来的任意 result 值不许直达 CLI(局域网客户端也能 POST /respond)
//   ⑤ 停止清卡时必须发 cancelled 而不是不应答 —— 不应答要等到 CLI 的 park 超时才收场
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import permissionsRouter, {
  requestUserDialog, userDialogResultFrom, dropPendingForSession,
} from '../../server/routes/permissions.js';
import { clients } from '../../server/broadcast.js';

const seen = [];
clients.add({ readyState: 1, send: (m) => seen.push(JSON.parse(m)) });
const lastOfType = (t) => [...seen].reverse().find((e) => e.type === t);

// CLI 二进制里 refusal_fallback_prompt 的 payload 形态(apiRefusalCategory 是开放字符串)。
const FIXTURE = {
  dialogKind: 'refusal_fallback_prompt',
  payload: {
    originalModel: 'claude-opus-4-8',
    fallbackModel: 'claude-sonnet-4-6',
    apiRefusalCategory: 'catch_all',
    guidanceText: '该请求被当前模型拒绝，可换用备用模型重试。',
    retractedMessageUuids: ['uuid-a', 'uuid-b'],
  },
  toolUseID: 'toolu_01',
};

// ── ① 声明与回调成对(源码锁) ──────────────────────────────────
{
  const src = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  assert.ok(/onUserDialog:/.test(src), 'chat.js 的 options 必须挂 onUserDialog');
  assert.ok(
    /supportedDialogKinds:\s*\['refusal_fallback_prompt'\]/.test(src),
    'supportedDialogKinds 必须声明 refusal_fallback_prompt,否则 CLI 一条对话框都不发',
  );
  assert.ok(/onElicitation:/.test(src), 'chat.js 的 options 必须挂 onElicitation,否则 MCP 表单请求被自动拒绝');
}

// ── ③④ 裁决翻译 ───────────────────────────────────────────────
{
  assert.deepEqual(
    userDialogResultFrom({ decision: 'allow', byUser: true, content: { result: 'retry_fallback' } }),
    { behavior: 'completed', result: 'retry_fallback' },
  );
  assert.deepEqual(
    userDialogResultFrom({ decision: 'allow', byUser: true, content: { result: 'edit_prompt' } }),
    { behavior: 'completed', result: 'edit_prompt' },
  );
  assert.deepEqual(userDialogResultFrom({ decision: 'deny', byUser: true }), { behavior: 'cancelled' }, '取消 = cancelled');
  assert.deepEqual(userDialogResultFrom({ decision: 'deny', reason: 'CLI 进程已退出' }), { behavior: 'cancelled' }, '系统清卡 = cancelled');
  assert.deepEqual(userDialogResultFrom({}), { behavior: 'cancelled' }, '缺省 = cancelled');
  // ④ 白名单之外的取值一律 cancelled(含「用户没点按钮但 content 被伪造」的情况)
  assert.deepEqual(
    userDialogResultFrom({ decision: 'allow', byUser: true, content: { result: 'do_whatever' } }),
    { behavior: 'cancelled' }, '界面外来的任意 result 不许直达 CLI',
  );
  assert.deepEqual(
    userDialogResultFrom({ decision: 'allow', content: { result: 'retry_fallback' } }),
    { behavior: 'cancelled' }, '不是用户作答(无 byUser)一律 cancelled',
  );
}

// ── 卡片数据流:payload 五个字段原样到界面 ──────────────────────
{
  const p = requestUserDialog({ ...FIXTURE, sessionId: 'sid-dlg', cwd: '/tmp' });
  const req = lastOfType('permission:request').request;
  assert.equal(req.kind, 'dialog', '前端按 kind 分派到拒答卡');
  assert.equal(req.dialogKind, 'refusal_fallback_prompt');
  assert.deepEqual(req.payload, FIXTURE.payload, 'payload 原样透传(卡片要显示模型名/指引/撤回条数)');
  assert.equal(req.toolUseID, 'toolu_01');
  assert.equal(req.sessionId, 'sid-dlg', '带 sessionId 才会被停止清卡认领');
  assert.ok(!('toolName' in req), 'kind 卡不带 toolName,不进危险命令/白名单/切档重裁的判定');

  // ⑤ 停止清卡 → cancelled,且当场结掉不等 CLI 超时
  dropPendingForSession('sid-dlg');
  const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('清卡后没应答,CLI 要等到 park 超时')), 1000))]);
  assert.deepEqual(r, { behavior: 'cancelled' });
  assert.equal(lastOfType('permission:resolved').id, req.id, '撤卡广播必须发');
}

// ── HTTP 全链路:按钮 → /respond → CLI 结果 ────────────────────
{
  const app = express();
  app.use(express.json());
  app.use('/api', permissionsRouter);
  const server = app.listen(0);
  await new Promise((ok) => server.once('listening', ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const answer = async (body) => {
    const p = requestUserDialog({ ...FIXTURE, sessionId: 'sid-http' });
    const id = lastOfType('permission:request').request.id;
    await fetch(`${base}/permissions/respond/${id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return p;
  };

  assert.deepEqual(
    await answer({ decision: 'allow', content: { result: 'retry_fallback' } }),
    { behavior: 'completed', result: 'retry_fallback' }, '「换备用模型重试」按钮',
  );
  assert.deepEqual(
    await answer({ decision: 'allow', content: { result: 'edit_prompt' } }),
    { behavior: 'completed', result: 'edit_prompt' }, '「我改一下提问」按钮',
  );
  assert.deepEqual(await answer({ decision: 'deny' }), { behavior: 'cancelled' }, 'Esc / 取消按钮');
  assert.deepEqual(
    await answer({ decision: 'allow', content: { result: 'nonsense' } }),
    { behavior: 'cancelled' }, '伪造的 result 被挡在服务端',
  );

  server.close();
}

console.log('✓ check-user-dialog: 拒答重试卡(kinds 声明成对 / 裁决翻译 / 取值白名单 / 清卡发 cancelled)');
