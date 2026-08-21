#!/usr/bin/env node
// MCP elicitation 表单卡的护栏。直接 import 真实实现(不复刻),改坏了这里必红。
// 锁住的行为:
//   ① requestedSchema → 四种控件的映射:文本 / enum(enumNames 做显示名) / 布尔 / 数字(min,max)
//      认不出的类型退化成文本框 —— 卡片渲染不出来 = 用户永远填不了表 = 回合永久挂着
//   ② 必填门控:required 未填则不能提交;boolean 的 false 算已答不算空
//   ③ 提交值按 schema 类型转真值,空着的可选字段不带(服务器按 schema 校验会拒空串)
//   ④ 停止清卡(dropPendingForSession)必须把挂起的 Promise 翻译成 MCP 的 cancel 并结掉 ——
//      裸挂 = 停止后 MCP 服务器与 CLI 永久等一个不会来的答复
//   ⑤ 上游撤单(opts.signal abort)= 从表里删卡 + 广播 resolved + 回 cancel
//   ⑥ 用户点「拒绝」是 decline,系统清卡是 cancel —— 两者对 MCP 服务器是不同语义,不许混
//   ⑦ /respond 必须把 content 原样转给等待方(否则表单填了等于没填)
import assert from 'node:assert/strict';
import express from 'express';
import { elicitFields, elicitMissing, buildElicitContent, initialElicitValues } from '../../client/src/utils/elicitSchema.js';
import permissionsRouter, {
  requestElicitation, elicitationResultFrom, dropPendingForSession,
} from '../../server/routes/permissions.js';
import { clients } from '../../server/broadcast.js';

// 广播捕获:往 clients 里塞一个假客户端,拿到服务端真正发出去的 WS 消息。
const seen = [];
clients.add({ readyState: 1, send: (m) => seen.push(JSON.parse(m)) });
const lastOfType = (t) => [...seen].reverse().find((e) => e.type === t);

// ── ① schema → 控件 ────────────────────────────────────────────
{
  const fields = elicitFields({
    type: 'object',
    properties: {
      name: { type: 'string', title: '姓名', description: '身份证上的名字' },
      size: { type: 'string', enum: ['s', 'm'], enumNames: ['小', '中'] },
      agree: { type: 'boolean' },
      count: { type: 'integer', minimum: 1, maximum: 9 },
      ratio: { type: 'number' },
      weird: { type: 'array', items: { type: 'string' } },
      broken: null,
    },
    required: ['name', 'agree'],
  });
  const by = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.equal(fields.length, 7, '每个 property 出一个控件');
  assert.equal(by.name.type, 'text');
  assert.equal(by.name.label, '姓名', 'title 当显示名');
  assert.equal(by.name.description, '身份证上的名字');
  assert.equal(by.name.required, true);
  assert.equal(by.size.type, 'enum');
  assert.deepEqual(by.size.options, [{ value: 's', label: '小' }, { value: 'm', label: '中' }], 'enumNames 按下标对齐做 label');
  assert.equal(by.agree.type, 'boolean');
  assert.equal(by.count.type, 'number');
  assert.equal(by.count.integer, true);
  assert.equal(by.count.min, 1);
  assert.equal(by.count.max, 9);
  assert.equal(by.ratio.integer, false, 'number 不取整');
  assert.equal(by.ratio.min, null, '没写 minimum 就是 null,不能变成 0');
  assert.equal(by.weird.type, 'text', '认不出的类型退化成文本框');
  assert.equal(by.broken.type, 'text', '字段定义是 null 也不能炸,退化成文本框');
  assert.equal(by.size.label, 'size', '没 title 就用 key 当显示名');

  // enumNames 缺项 → 回落到值本身,不能出空按钮
  const partial = elicitFields({ properties: { c: { type: 'string', enum: ['a', 'b'], enumNames: ['甲'] } } });
  assert.deepEqual(partial[0].options, [{ value: 'a', label: '甲' }, { value: 'b', label: 'b' }]);

  // 恶意/空 schema 一律给空数组(卡片自己渲染「无需填写」),不许抛
  for (const bad of [null, undefined, {}, { properties: null }, { properties: [] }, 'nope']) {
    assert.deepEqual(elicitFields(bad), [], `不合法 schema 返回空数组: ${JSON.stringify(bad)}`);
  }
}

// ── ② 必填门控 + 初值 ──────────────────────────────────────────
{
  const fields = elicitFields({
    properties: { a: { type: 'string' }, ok: { type: 'boolean' }, n: { type: 'integer' } },
    required: ['a', 'ok', 'n'],
  });
  assert.deepEqual(elicitMissing(fields, {}), ['a', 'n'], 'boolean 不算未填(false 是合法答案)');
  assert.deepEqual(elicitMissing(fields, { a: '  ', n: 3 }), ['a'], '纯空白算未填');
  assert.deepEqual(elicitMissing(fields, { a: 'x', n: 0 }), [], '数字 0 算已填');

  const withDefault = elicitFields({ properties: { m: { type: 'string', default: 'hi' }, b: { type: 'boolean' } } });
  assert.deepEqual(initialElicitValues(withDefault), { m: 'hi', b: false }, 'default 进初值,布尔缺省 false');
}

// ── ③ 提交值构造 ──────────────────────────────────────────────
{
  const fields = elicitFields({
    properties: {
      name: { type: 'string' }, note: { type: 'string' },
      count: { type: 'integer' }, ratio: { type: 'number' }, agree: { type: 'boolean' },
    },
  });
  assert.deepEqual(
    buildElicitContent(fields, { name: 'x', note: '   ', count: '7.9', ratio: '1.5', agree: undefined }),
    { name: 'x', count: 7, ratio: 1.5, agree: false },
    'integer 取整、number 保留小数、空白可选字段整个不带、布尔恒带',
  );
  assert.deepEqual(buildElicitContent(fields, { count: 'abc' }), { agree: false }, '数字框里的非数字丢弃,不发 NaN');
}

// ── ⑥ 决定 → MCP 结果的翻译 ────────────────────────────────────
{
  assert.deepEqual(elicitationResultFrom({ decision: 'allow', content: { a: 1 }, byUser: true }), { action: 'accept', content: { a: 1 } });
  assert.deepEqual(elicitationResultFrom({ decision: 'allow', byUser: true }), { action: 'accept', content: {} }, 'accept 必带 content 对象');
  assert.deepEqual(elicitationResultFrom({ decision: 'allow', content: [1], byUser: true }), { action: 'accept', content: {} }, '数组不是合法 content');
  assert.deepEqual(elicitationResultFrom({ decision: 'deny', byUser: true }), { action: 'decline' }, '用户点拒绝 = decline');
  assert.deepEqual(elicitationResultFrom({ decision: 'deny', reason: 'CLI 进程已退出' }), { action: 'cancel' }, '系统清卡 = cancel(未作答)');
  assert.deepEqual(elicitationResultFrom({}), { action: 'cancel' });
}

// ── ④ 停止清卡:dropPendingForSession → cancel,且不挂死 ────────
{
  const p = requestElicitation({
    serverName: 'probe', message: '填一下', sessionId: 'sid-stop', cwd: '/tmp',
    requestedSchema: { type: 'object', properties: { a: { type: 'string' } } },
  });
  const req = lastOfType('permission:request').request;
  assert.equal(req.kind, 'elicitation', '广播出去的请求带 kind,前端据此分派卡片');
  assert.equal(req.serverName, 'probe');
  assert.equal(req.sessionId, 'sid-stop', 'sessionId 必须带,否则停止清卡按会话找不到它');
  assert.ok(req.requestedSchema?.properties?.a, 'schema 原样透传给卡片');
  assert.ok(!('toolName' in req), 'kind 卡不带 toolName:危险命令/白名单/切档重裁都按 toolName 判,带了会被误判');

  dropPendingForSession('sid-stop');
  const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('停止后 Promise 没结,MCP 会永久等')), 1000))]);
  assert.deepEqual(r, { action: 'cancel' }, '停止清卡 = cancel');
  assert.equal(lastOfType('permission:resolved').id, req.id, '撤卡广播必须发,否则界面残留一张死卡');

  // 再清一次不许有第二条终态广播(条目已从表里删干净)
  const before = seen.length;
  dropPendingForSession('sid-stop');
  assert.equal(seen.length, before, '条目已删除,重复清卡不再广播');
}

// ── ⑤ 上游撤单(signal abort) ─────────────────────────────────
{
  const ctrl = new AbortController();
  const p = requestElicitation({ serverName: 'probe', message: 'x', sessionId: 'sid-abort', signal: ctrl.signal });
  const id = lastOfType('permission:request').request.id;
  ctrl.abort();
  const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('abort 后 Promise 没结')), 1000))]);
  assert.deepEqual(r, { action: 'cancel' }, '上游撤单 = cancel');
  assert.equal(lastOfType('permission:resolved').id, id, 'abort 也要撤下界面上的卡');
  const before = seen.length;
  dropPendingForSession('sid-abort');
  assert.equal(seen.length, before, 'abort 已把条目删掉,后续清卡无事可做');

  // 已经 abort 的 signal:建卡即刻结掉,不留悬挂
  const done = new AbortController();
  done.abort();
  const r2 = await Promise.race([
    requestElicitation({ serverName: 'probe', message: 'x', sessionId: 'sid-pre', signal: done.signal }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('已 abort 的 signal 建卡后挂死')), 1000)),
  ]);
  assert.deepEqual(r2, { action: 'cancel' });
}

// ── ⑦ /respond 把表单值原样送回等待方 ──────────────────────────
{
  const app = express();
  app.use(express.json());
  app.use('/api', permissionsRouter);
  const server = app.listen(0);
  await new Promise((ok) => server.once('listening', ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const p = requestElicitation({
    serverName: 'probe', message: '填一下', sessionId: 'sid-http',
    requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  });
  // r26-H1:respond 必携 nonce(随 broadcast 下发,与 slot 逐字一致),无/错 nonce 一律 403。
  const reqMsg = lastOfType('permission:request').request;
  const { id, nonce } = reqMsg;

  const listed = await (await fetch(`${base}/permissions/pending`)).json();
  assert.ok(listed.items.some((x) => x.id === id && x.kind === 'elicitation'), '刷新补拉能看到表单卡');

  const noNonce = await fetch(`${base}/permissions/respond/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'allow', content: { name: '小明' } }),
  });
  assert.equal(noNonce.status, 403, 'r26-H1: 无 nonce respond 必须 403');
  await fetch(`${base}/permissions/respond/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'allow', content: { name: '小明' }, nonce }),
  });
  assert.deepEqual(await p, { action: 'accept', content: { name: '小明' } }, 'content 必须原样到达 MCP');

  // 拒绝按钮:同一条通道,只是没有 content
  const p2 = requestElicitation({ serverName: 'probe', message: 'x', sessionId: 'sid-http' });
  const req2 = lastOfType('permission:request').request;
  await fetch(`${base}/permissions/respond/${req2.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'deny', nonce: req2.nonce }),
  });
  assert.deepEqual(await p2, { action: 'decline' }, '界面上的拒绝 = decline(不是 cancel)');

  server.close();
}

console.log('✓ check-elicitation-card: MCP 表单卡(schema 映射 / 必填门控 / 提交值 / 停止清卡 / 撤单 / 应答回传)');
