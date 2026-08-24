#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'cgui-r33-binding-route-'));
process.env.HOME = home;
const projectHash = '-work-project';
const sessionId = '11111111-1111-1111-1111-111111111111';
const projectDir = join(home, '.claude', 'projects', projectHash);
await mkdir(projectDir, { recursive: true });
await writeFile(join(projectDir, `${sessionId}.jsonl`), [
  JSON.stringify({ type: 'system', subtype: 'init', cwd: '/work/project', session_id: sessionId, timestamp: '2026-01-01T00:00:00.000Z' }),
  JSON.stringify({ type: 'user', uuid: 'user-1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'hello' } }),
  JSON.stringify({ type: 'assistant', uuid: 'assistant-1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
].join('\n') + '\n');

const express = (await import('express')).default;
const sessionsRoutes = (await import(`../../server/routes/sessions.js?r33-binding-route=${Date.now()}`)).default;
const { mergeDraftBindingsBestEffort } = await import('../../server/services/draft-session-bindings.js');
const app = express();
app.use(express.json());
app.use('/api', sessionsRoutes);
const server = await new Promise((resolve, reject) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  instance.once('error', reject);
});

const bindingDir = join(home, '.claude-gui');
const bindingFile = join(bindingDir, 'draft-session-bindings.json');
const getSessions = async () => {
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(projectHash)}/sessions`);
  const data = await response.json();
  return { response, data };
};

let failure = null;
try {
  // 缺失恢复索引：核心 listSessions 照常 200。
  let result = await getSessions();
  assert.equal(result.response.status, 200);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].sessionId, sessionId);
  assert.equal(result.data[0].draftId, undefined);

  // 坏 JSON：安全隔离为 corrupt 文件，route 仍返回原 sessions。
  await mkdir(bindingDir, { recursive: true });
  await writeFile(bindingFile, '{ definitely-not-json', 'utf8');
  result = await getSessions();
  assert.equal(result.response.status, 200);
  assert.equal(result.data[0].sessionId, sessionId);
  assert.equal(result.data[0].draftId, undefined);
  assert.ok((await readdir(bindingDir)).some((name) => name.startsWith('draft-session-bindings.json.corrupt-')),
    'malformed 索引已隔离，不会每次请求重复解析失败');

  // EACCES 是可选索引自身错误，不得误报项目 403。另以注入错误固定跨平台语义；
  // macOS 上再让真实 route 读取 000 文件验证整条 HTTP 链。
  const core = [{ sessionId }];
  let diagnostic = '';
  assert.equal(await mergeDraftBindingsBestEffort(core, projectHash, {
    mergeImpl: async () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; },
    diagnose: (message) => { diagnostic = message; },
  }), core);
  assert.match(diagnostic, /EACCES/);
  await writeFile(bindingFile, JSON.stringify({}), 'utf8');
  if (process.platform !== 'win32') {
    await chmod(bindingFile, 0o000);
    result = await getSessions();
    await chmod(bindingFile, 0o600);
    assert.equal(result.response.status, 200);
    assert.equal(result.data[0].sessionId, sessionId);
  }

  // 正常映射仍水合 draftId。
  await writeFile(bindingFile, JSON.stringify({
    'd123-1': { sessionId, projectHash, at: 123 },
  }), 'utf8');
  result = await getSessions();
  assert.equal(result.response.status, 200);
  assert.equal(result.data[0].draftId, 'd123-1');
} catch (error) {
  failure = error;
} finally {
  try { await chmod(bindingFile, 0o600); } catch {}
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
if (failure) throw failure;

console.log('✓ check-r33-draft-binding-route: missing/malformed/EACCES均200，正常映射水合全过');
