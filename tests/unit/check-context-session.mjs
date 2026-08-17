#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  contextCanonicalKey,
  contextErrorMessage,
  isValidContextResponse,
  shouldReplaceContextCache,
} from '../../client/src/utils/contextCache.js';
import {
  contextHintsMatch,
  validateContextRequest,
  validContextPayload,
} from '../../server/routes/chat.js';

const validPayload = {
  source: 'sdk',
  sampledAt: '2026-08-14T01:02:03.000Z',
  model: 'synthetic-model',
  totalTokens: 120,
  windowTokens: 1000,
  pct: 12,
  categories: [{ name: 'Synthetic', tokens: 120, pct: 12 }],
  mcpServers: [{ server: 'fixture', tokens: 20 }],
};

assert.notEqual(
  contextCanonicalKey('session-a', 'project-a', '/tmp/a', 'model-a'),
  contextCanonicalKey('session-a', 'project-a', '/tmp/b', 'model-a'),
  'cwd 必须参与精确上下文缓存隔离',
);
assert.notEqual(
  contextCanonicalKey('session-a', 'project-a', '/tmp/a', 'model-a'),
  contextCanonicalKey('session-a', 'project-a', '/tmp/a', 'model-b'),
  'model 必须参与精确上下文缓存隔离',
);
assert.equal(isValidContextResponse(validPayload), true, '完整结构化响应应通过客户端校验');
assert.equal(validContextPayload(validPayload), true, '完整结构化响应应通过服务端校验');
assert.equal(isValidContextResponse({ ...validPayload, raw: 'private transcript' }), false,
  '客户端必须拒绝携带 raw 会话正文的响应');
assert.equal(validContextPayload({ ...validPayload, windowTokens: 0 }), false,
  '服务端必须拒绝无效窗口数据');

const older = { ...validPayload, sampledAt: '2026-08-14T01:00:00.000Z', requestEpoch: 8 };
assert.equal(shouldReplaceContextCache(older, validPayload, 7), true, '较新 sampledAt 必须替换缓存');
assert.equal(shouldReplaceContextCache(validPayload, older, 9), false, '旧响应不能覆盖新缓存');
assert.equal(shouldReplaceContextCache({ ...validPayload, requestEpoch: 8 }, validPayload, 9), true,
  '同一 sampledAt 时请求代次必须打破并发平局');

const req = {
  params: { sessionId: 'session-fixture' },
  query: { projectHash: 'project-fixture', cwd: '/tmp/context-fixture', model: 'synthetic-model' },
};
assert.deepEqual(validateContextRequest(req), {
  sessionId: 'session-fixture',
  projectHash: 'project-fixture',
  cwd: '/tmp/context-fixture',
  model: 'synthetic-model',
});
assert.equal(validateContextRequest({ ...req, query: { ...req.query, cwd: ['/tmp/a', '/tmp/b'] } }), null,
  '重复 query 参数必须被拒绝');
assert.equal(validateContextRequest({ ...req, params: { sessionId: '../escape' } }), null,
  'sessionId 不能用于路径穿越');
const trustedMeta = {
  sessionId: 'session-fixture', projectHash: 'project-fixture', cwd: '/tmp/context-fixture', model: 'synthetic-model',
};
assert.equal(contextHintsMatch(validateContextRequest(req), trustedMeta), true, '一致的会话提示应通过');
assert.equal(contextHintsMatch(validateContextRequest({ ...req, query: { ...req.query, cwd: '/tmp/other' } }), trustedMeta), false,
  '客户端 cwd 不能覆盖服务端可信元数据');
// ④判官必修-4:model 不参与 409 判定(变异哨兵:把 model 判等加回 contextHintsMatch,
// 下面四条必须变红——已实际验证过一次)。
assert.equal(validateContextRequest({ ...req, query: { ...req.query, model: 'claude-sonnet-4-6[1m]' } }) !== null, true,
  '[1m] 后缀 model 必须过参数校验(MODEL_ARG_RE 含 [])');
assert.equal(contextHintsMatch(
  validateContextRequest({ ...req, query: { ...req.query, model: 'claude-sonnet-4-6[1m]' } }),
  { ...trustedMeta, model: 'claude-sonnet-4-6' },
), true, '1M 会话:client 带 [1m]、jsonl 裸 id,不得 409(徽章永久失效的主根因)');
assert.equal(contextHintsMatch(validateContextRequest(req), { ...trustedMeta, model: null }), true,
  '新会话 meta.model 为空:信任客户端,不得 409');
assert.equal(contextHintsMatch(
  validateContextRequest({ ...req, query: { ...req.query, model: 'switched-but-not-sent' } }), trustedMeta,
), true, '切模型后未发送:model 不一致不再 409');
assert.equal(contextHintsMatch(
  validateContextRequest({ ...req, query: { ...req.query, projectHash: 'other-project' } }), trustedMeta,
), false, 'projectHash 归属校验必须保留(删掉该判等本断言变红)');

assert.equal(contextErrorMessage('context-session-mismatch'), '上下文请求与会话不匹配');
assert.equal(contextErrorMessage('unknown'), '上下文计算失败', '未知内部错误不能透传异常正文');

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
const contextComponent = app.slice(app.indexOf('function ContextBreakdownButton'), app.indexOf('function LoginScreen'));

assert.match(contextComponent, /requestRef\.current\?\.canonicalKey === canonicalKey/, '同 canonical key 的在途请求必须 no-op');
assert.match(contextComponent, /new AbortController\(\)/, '组件必须为每次精确请求创建 AbortController');
assert.match(contextComponent, /current\.canonicalKey !== canonicalKey \|\| current\.requestEpoch !== requestEpoch/,
  '旧 key 或旧代次的响应不能串入当前会话');
assert.match(store, /cgui:provider-change[\s\S]{0,120}clearContextExactCache/, 'provider 切换必须清空精确缓存');
assert.doesNotMatch(server.slice(server.indexOf("router.get('/context/:sessionId'")), /activeProcesses\.set|shared.*registry/i,
  '精确计算不得创建服务端共享 Query registry');
assert.match(server, /claudeSpawn\(args, \{ cwd, stdio: \['ignore', 'pipe', 'pipe'\], env: cleanChildEnv\(\), shell: false \}\)/,
  '历史会话 CLI 必须使用 argv、可信 cwd 且 shell:false');

console.log('PASS check-context-session');
