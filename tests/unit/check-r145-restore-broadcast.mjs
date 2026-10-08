#!/usr/bin/env node
// r145 F6:单独"还原检查点"(POST /checkpoints/:sessionId/restore)之后要广播一条 file-change,让其他端
// 刷新会话;但 checkpoints.js 没有导入 homedir,那一句 join(homedir(), …) 抛 ReferenceError,被外层空 catch
// 吞掉 —— 广播从来没发出去过,接口照样 200。修好后广播照常发出。
// 端到端真跑:临时 HOME 下建一个工作目录,经 POST /checkpoints 拍真快照(影子 git),改文件,再 restore;
// 往 server/broadcast.js 的 clients 里挂一个记录型假 WS 客户端,断言收到指向 <sid>.jsonl 的 file-change。
// 需要本机 git:没有 git 时拍快照本身失败,断言如实红并给出原因(不静默跳过)。
// express 挂 checkpoints 路由,端口 6700–6999。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { isolateHome, listenInRange, makeChecker } from './r145-helpers/common.mjs';

const { home, cleanup } = isolateHome('f6');
const WORK = join(home, 'work');
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'a.txt'), 'v1\n');
const SID = 'r145-restore-sess';

const { clients } = await import('../../server/broadcast.js');
const sent = [];
const fakeWs = { readyState: 1, send(msg) { sent.push(JSON.parse(msg)); } };
clients.add(fakeWs);

const router = (await import('../../server/routes/checkpoints.js')).default;
const express = (await import('express')).default;
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api', router);
const httpServer = createServer(app);
const port = await listenInRange(httpServer);
const post = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保持 null */ }
  return { status: r.status, json, text };
};

const { check, finish } = makeChecker('check-r145-restore-broadcast');
let exitCode = 1;
try {
  console.log('F6 · 单独还原检查点后广播 file-change');
  await check('拍快照 → 改文件 → restore:文件回到快照内容,且广播了指向该会话 jsonl 的 file-change', async () => {
    const snap = await post('/api/checkpoints', { sessionId: SID, cwd: WORK, label: 'r145' });
    assert.equal(snap.status, 200, `拍快照失败:${snap.text.slice(0, 200)}`);
    assert.match(String(snap.json?.sha), /^[a-f0-9]{7,40}$/, `快照没返回 sha:${snap.text.slice(0, 200)}`);
    writeFileSync(join(WORK, 'a.txt'), 'v2\n');
    sent.length = 0;
    const r = await post(`/api/checkpoints/${SID}/restore`, { sha: snap.json.sha, cwd: WORK });
    assert.equal(r.status, 200, `restore 失败:${r.text.slice(0, 200)}`);
    assert.equal(readFileSync(join(WORK, 'a.txt'), 'utf8'), 'v1\n', '文件没有还原(前提不成立)');
    const hit = sent.filter((m) => m?.type === 'file-change' && /\/projects\//.test(m.path) && m.path.endsWith(`/${SID}.jsonl`));
    assert.equal(hit.length, 1, `应广播 1 条指向 ${SID}.jsonl 的 file-change,实际收到:${JSON.stringify(sent)}`);
    assert.ok(hit[0].path.startsWith(home.replace(/\\/g, '/')), `广播路径应在 HOME/.claude/projects 下:${hit[0].path}`);
  });
  exitCode = finish();
} finally {
  clients.delete(fakeWs);
  cleanup();
}
process.exit(exitCode);
