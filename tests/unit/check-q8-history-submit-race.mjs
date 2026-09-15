#!/usr/bin/env node
// Q8 审查项 11(历史变换提交无会话级互斥):
//   同一会话上两个不同的预览(trim + strip-thinking)并发提交,双闸都放行,后写覆盖前写,且【双方都报成功】。
//   a. 两次提交不得都 ok:true(修前应红)
//   b. 落败的那次必须是 409 SESSION_CHANGED(修前应红)
//   c. 每个报 ok 的提交,其 resultVersion 必须等于最终落盘内容的版本(报了成功就必须真落盘)(修前应红)
// 测法:HOME 指到假目录里造一份会话 jsonl;把 writeJsonlAtomic 的临时文件写入拖慢 400ms 把并发窗口钉死;
//       路由挂在 127.0.0.1 的 6700–6999 空闲端口上(硬拒 6677/6689/6710)。
// 跑法:node tests/unit/check-q8-history-submit-race.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport, sleep } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = join(HERE, 'q8-helpers', '.artifacts', 'history-race');
fs.rmSync(base, { recursive: true, force: true });
const home = join(base, 'home');
const PROJECT = 'q8-proj';
const SID = 'q8-sid-race';
const projDir = join(home, '.claude', 'projects', PROJECT);
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(join(home, '.claude-gui'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

// 把原子写的临时文件写入拖慢:两条提交都能在任何一方 rename 之前通过第二道闸(MB 级会话的真实窗口)
const realWriteFile = fs.promises.writeFile;
fs.promises.writeFile = async function slowTmp(p, ...rest) {
  if (String(p).includes('.tmp-trim-')) await sleep(400);
  return realWriteFile.call(this, p, ...rest);
};
syncBuiltinESMExports();

const express = (await import('express')).default;
const history = await import('../../server/routes/session-history.js');
const report = makeReport('check-q8-history-submit-race');

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const at = (n) => `2026-09-14T00:00:0${n}.000Z`;
const line = (o) => JSON.stringify(o);
const RAW = [
  line({ type: 'user', uuid: U1, timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: '第一条' }] } }),
  line({ type: 'assistant', uuid: 'a1', parentUuid: U1, timestamp: at(2), message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想一想', signature: 'sig' }, { type: 'text', text: '回答一' }] } }),
  line({ type: 'user', uuid: U2, timestamp: at(3), message: { role: 'user', content: [{ type: 'text', text: '第二条' }] } }),
  line({ type: 'assistant', uuid: 'a2', parentUuid: U2, timestamp: at(4), message: { role: 'assistant', content: [{ type: 'text', text: '回答二' }] } }),
].join('\n') + '\n';
const file = join(projDir, `${SID}.jsonl`);
fs.writeFileSync(file, RAW);

async function listen(app) {
  for (let port = 6720; port <= 6999; port += 1) {
    if ([6677, 6689, 6710].includes(port)) continue;
    const ok = await new Promise((resolve) => {
      const srv = app.listen(port, '127.0.0.1');
      srv.once('listening', () => resolve(srv));
      srv.once('error', () => resolve(null));
    });
    if (ok) return { server: ok, port };
  }
  throw new Error('6720–6999 没有空闲端口');
}
const app = express();
app.use(express.json());
app.use('/api', history.default);
const { server, port } = await listen(app);
const post = async (op, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${SID}/${op}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectHash: PROJECT, ...body }),
  });
  return { status: res.status, body: await res.json() };
};

try {
  const pa = await post('trim', { dryRun: true, uuid: U2 });
  const pb = await post('strip-thinking', { dryRun: true });
  assert.equal(pa.status, 200, `trim 预览失败: ${JSON.stringify(pa.body)}`);
  assert.equal(pb.status, 200, `strip-thinking 预览失败: ${JSON.stringify(pb.body)}`);
  assert.equal(pa.body.baseVersion, pb.body.baseVersion, '两个预览基于同一份内容');

  const [ra, rb] = await Promise.all([
    post('trim', { dryRun: false, uuid: U2, previewToken: pa.body.previewToken, baseVersion: pa.body.baseVersion }),
    post('strip-thinking', { dryRun: false, previewToken: pb.body.previewToken, baseVersion: pb.body.baseVersion }),
  ]);
  const results = [{ name: 'trim', ...ra }, { name: 'strip-thinking', ...rb }];
  const oks = results.filter((r) => r.status === 200 && r.body.ok === true);
  const finalVersion = history.versionOf(fs.readFileSync(file, 'utf8'));
  const brief = results.map((r) => `${r.name}:${r.status}/${r.body.code || 'ok'}${r.body.resultVersion ? `/${r.body.resultVersion}` : ''}`).join(' ; ');

  await report.check('Q8-11a', '同会话两个不同预览并发提交:不得双双报成功', 'red', async () => {
    assert.equal(oks.length, 1, `报成功的提交数=${oks.length}(${brief});最终文件版本 ${finalVersion}`);
  });

  await report.check('Q8-11b', '落败的那次提交必须是 409 SESSION_CHANGED(要求重新预览)', 'red', async () => {
    const losers = results.filter((r) => !(r.status === 200 && r.body.ok === true));
    assert.equal(losers.length, 1, `应恰有一个落败(${brief})`);
    assert.equal(losers[0].status, 409, `落败方状态码 ${losers[0].status}`);
    assert.equal(losers[0].body.code, 'SESSION_CHANGED', `落败方 code ${losers[0].body.code}`);
  });

  await report.check('Q8-11c', '凡报 ok 的提交,其 resultVersion 必须等于最终落盘内容的版本(报成功就必须真落盘)', 'red', async () => {
    const ghosts = oks.filter((r) => r.body.resultVersion !== finalVersion);
    assert.deepEqual(ghosts.map((r) => r.name), [], `这些提交报了成功但结果没在盘上: ${ghosts.map((r) => `${r.name}(${r.body.resultVersion})`).join(',')};最终版本 ${finalVersion}`);
  });
} finally {
  server.close();
}

process.exit(report.finish());
