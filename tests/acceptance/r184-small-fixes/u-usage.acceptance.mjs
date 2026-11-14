// r184 · U 组:用量统计跳过不是普通文件的 .jsonl(命名管道),指向普通文件的符号链接照旧统计。
// 每条用例独立家目录 + 独立后端实例,只取第一次 GET /api/usage(用量有内存与磁盘缓存)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpRoot, buildHome, projectDir, writeSession, userLine, assistantLine, startBackend } from './helpers/common.mjs';

const skip = process.platform === 'win32' ? 'Windows 上没有命名管道 / 符号链接的前提,仅 macOS / Linux 跑' : false;

function seedNormalSession(home, dirName, sid, msgId, outputTokens) {
  writeSession(path.join(projectDir(home, dirName), `${sid}.jsonl`), [
    userLine(sid, '你好'),
    assistantLine(sid, msgId, outputTokens),
  ]);
}

test('U1【复现】工作区里有命名管道 pipe.jsonl:GET /api/usage 10 秒内返回 200,sessionCount 为 1、output 为 111', { skip, timeout: 60_000 }, async () => {
  const root = tmpRoot('u1');
  const home = buildHome(root);
  seedNormalSession(home, '-r184-ws-u1', 'sess-u1', 'msg_u1_a', 111);
  const mk = spawnSync('mkfifo', [path.join(projectDir(home, '-r184-ws-u1'), 'pipe.jsonl')], { encoding: 'utf8' });
  assert.equal(mk.status, 0, `夹具:mkfifo 应成功,stderr:${mk.stderr}`);
  const backend = await startBackend({ root, home, label: 'u1-backend' });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('usage-timeout')), 10_000);
  try {
    let res;
    try {
      res = await fetch(`${backend.base}/api/usage`, { signal: ctl.signal });
    } catch (e) {
      assert.fail(`GET /api/usage 应在 10 秒内返回,实际被取消或失败:${e?.cause?.message ?? e?.message}(命名管道把统计卡住了)`);
    }
    assert.equal(res.status, 200, `应返回 200,实际 ${res.status}`);
    const body = await res.json();
    assert.equal(body.total?.sessionCount, 1, `total.sessionCount 应为 1,实际:${JSON.stringify(body.total)}`);
    assert.equal(body.total?.output, 111, `total.output 应为 111,实际:${JSON.stringify(body.total)}`);
  } finally {
    clearTimeout(timer);
    ctl.abort();
    await backend.stop();
  }
});

test('U2【守卫】工作区里有指向会话目录之外普通文件的符号链接 link.jsonl:sessionCount 为 2、output 为 333', { skip, timeout: 60_000 }, async () => {
  const root = tmpRoot('u2');
  const home = buildHome(root);
  seedNormalSession(home, '-r184-ws-u2', 'sess-u2-a', 'msg_u2_a', 111);
  const outside = path.join(root, 'outside', 'sess-u2-b.jsonl');
  writeSession(outside, [userLine('sess-u2-b', '你好'), assistantLine('sess-u2-b', 'msg_u2_b', 222)]);
  fs.symlinkSync(outside, path.join(projectDir(home, '-r184-ws-u2'), 'link.jsonl'));
  const backend = await startBackend({ root, home, label: 'u2-backend' });
  try {
    const res = await fetch(`${backend.base}/api/usage`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(res.status, 200, `应返回 200,实际 ${res.status}`);
    const body = await res.json();
    assert.equal(body.total?.sessionCount, 2, `total.sessionCount 应为 2,实际:${JSON.stringify(body.total)}`);
    assert.equal(body.total?.output, 333, `total.output 应为 333,实际:${JSON.stringify(body.total)}`);
  } finally {
    await backend.stop();
  }
});
