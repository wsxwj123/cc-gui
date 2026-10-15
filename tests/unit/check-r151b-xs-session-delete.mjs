#!/usr/bin/env node
// r151b:目标会话在本 GUI 里被删除时清跨会话消息(接口 X.3.6 末尾 2026-10-15 补的第一条)。
//   ① 收件箱文件不存在时删会话:不产生 ~/.claude-gui/xsession/ 下任何文件。
//   ② DELETE /api/sessions/:id → 以它为目标、还没结束的消息(pending / claimed)连同正文一并删除,每条广播一次 xs:message
//      (status 记为 dismissed、不带正文);已结束的不动;别的会话的消息不动;待处理计数随之减少;旧凭据兑换不了。
//   ③ 总开关关着时删会话照样清(关着时留下的待处理,之后打开也会计数)。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身;临时 HOME;端口 6900–6990(跳过 6710)。
// node tests/unit/check-r151b-xs-session-delete.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-xsdel-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
const PROJECT = '-tmp-r151b-xsdel';
const PROJ_DIR = join(HOME, '.claude', 'projects', PROJECT);
for (const d of [PROJ_DIR, join(HOME, '.claude-gui'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
const XS_DIR = join(HOME, '.claude-gui', 'xsession');
const setEnabled = (v) => writeFileSync(join(HOME, '.claude-gui', 'prefs.json'), JSON.stringify({ xsEnabled: v }));
const seedSession = (sid) => writeFileSync(join(PROJ_DIR, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${sid.slice(0, 8)}-u`, sessionId: sid, message: { role: 'user', content: '你好' } })}\n`);

registerR151bSdkStub();
const { default: express } = await import('express');
const { clients } = await import('../../server/broadcast.js');
const wsMsgs = [];
clients.add({ readyState: 1, send: (s) => wsMsgs.push(JSON.parse(s)) });
const { default: sessionRoutes } = await import('../../server/routes/sessions.js');
const xs = await import('../../server/services/xsession.js');
const store = await import('../../server/services/xsession-store.js');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); passed += 1; };

async function freePort() {
  for (let p = 6990; p >= 6900; p--) {
    if (p === 6710) continue;
    const free = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('6900-6990 没有空闲端口');
}
const app = express();
app.use(express.json());
app.use('/api', sessionRoutes);
const port = await freePort();
const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
const del = async (sid) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions/${sid}?projectHash=${PROJECT}`, { method: 'DELETE' });
  return { status: r.status, body: await r.json() };
};

const B = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const C = 'cccccccc-0000-4000-8000-0000000000c3';
const D = 'dddddddd-0000-4000-8000-0000000000d4';
try {
  // ① 收件箱文件不存在
  seedSession(D);
  eq(await del(D), { status: 200, body: { deleted: true } }, '删会话照常');
  ok(!existsSync(XS_DIR), '收件箱不存在时删会话不产生 xsession/ 下的任何文件');

  // ② 有消息
  setEnabled(true);
  seedSession(B); seedSession(C);
  const rows = [{ sessionId: B, title: '会话乙', projectDir: WORK }, { sessionId: C, title: '会话丙', projectDir: WORK }];
  const send = async (body, to) => (await xs.sendManualMessages({ to, body, fromSessionId: null }, rows))[0].id;
  const b1 = await send('给乙的一', [B]);
  const b2 = await send('给乙的二', [B]);
  const b3 = await send('给乙的三', [B]);
  const c1 = await send('给丙的一', [C]);
  const { token } = await xs.claimMessage(b2);
  await xs.dismissMessage(b3);
  eq((await xs.pendingSummary()).total, 2, '前置:待处理 2 条(b1、c1)');
  const bodies = () => readdirSync(join(XS_DIR, 'bodies')).sort();
  eq(bodies(), [`${b1}.txt`, `${b2}.txt`, `${c1}.txt`].sort(), '前置:未结束的三条有正文');

  wsMsgs.length = 0;
  eq(await del(B), { status: 200, body: { deleted: true } }, '删目标会话');
  const left = await store.listXsMessages();
  eq(left.map((m) => [m.id, m.status]), [[b3, 'dismissed'], [c1, 'pending']], '乙的未结束消息删掉;已结束的与别的会话的不动');
  eq(bodies(), [`${c1}.txt`], '正文一并删除');
  const xsEvents = wsMsgs.filter((e) => e.type === 'xs:message');
  eq(xsEvents.map((e) => [e.message.id, e.message.status, e.message.heldReason, e.message.heldText]), [[b1, 'dismissed', null, null], [b2, 'dismissed', null, null]],
    '每条广播一次 xs:message(按到达先后,status 记为 dismissed)');
  ok(xsEvents.every((e) => !('body' in e.message) && e.message.to.sessionId === B), '广播不带正文');
  eq(await xs.pendingSummary(), { total: 1, sessions: [{ sessionId: C, projectPath: WORK, pending: 1 }] }, '待处理计数随之减少');
  const redeem = await xs.xsChatEntry({ body: { xsMessageId: b2, xsToken: token }, sessionId: B });
  eq(redeem?.reject?.body?.code, 'XS_CLAIM_INVALID', '被删掉的认领消息,旧凭据兑换不了');
  eq(await xs.dropXsMessagesForSession(B), 0, '再清一次没有可删的');
  eq(await xs.dropXsMessagesForSession('not-an-id'), 0, 'id 形状不对 → 什么都不做');

  // ③ 总开关关着时照样清
  setEnabled(false);
  wsMsgs.length = 0;
  eq((await del(C)).status, 200, '关着时删会话');
  eq((await store.listXsMessages()).map((m) => m.id), [b3], '关着时也清掉以它为目标的未结束消息');
  eq(wsMsgs.filter((e) => e.type === 'xs:message').map((e) => [e.message.id, e.message.status]), [[c1, 'dismissed']], '照样广播');
} finally {
  server.close();
}
console.log(`check-r151b-xs-session-delete: ${passed} 项通过`);
process.exit(0);
