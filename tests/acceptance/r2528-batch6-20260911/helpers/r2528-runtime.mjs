// R25–R28 (batch 6) suite helper layer.
//
// Contract source: .devflow/INTERFACE.md「官方辅助能力、历史与外部项目（R25–R28）」+
//「公共规则、身份与错误」+ 补充边界矩阵 history/official-query 行.
//
// Black-box only: public UI (role/text), public HTTP (/api/*). No store access, no private
// JSONL reads, no injection. Fixtures are prepared through the same public entries a user has
// (sidebar search, composer) or through the public acceptance API with an operator guard.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import * as fb from '../../first-batch-20260910/helpers/runtime.mjs';

export const EnvironmentBlocked = fb.EnvironmentBlocked;
export const uniqueId = fb.uniqueId;
export const dismissTransientOverlays = fb.dismissTransientOverlays;
export const clickThroughOverlays = fb.clickThroughOverlays;

/** Extra guard on top of the first-batch navigation: same reload-and-retry tolerance as SB-*. */
export async function openFixtureSession(page, section, options) {
  try {
    return await fb.openFixtureSession(page, section, options);
  } catch (error) {
    await page.goto('/').catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await dismissTransientOverlays(page).catch(() => {});
    return await fb.openFixtureSession(page, section, options);
  }
}

export const LIVE_CLI_FLAG = 'R2528_ALLOW_LIVE_CLI';
export const MODEL_FLAG = 'R2528_ALLOW_MODEL';
export const EXTERNAL_FLAG = 'R2528_ALLOW_EXTERNAL';

/**
 * Cases that start a real local CLI turn (needed to materialise a session with stored user
 * messages) stay out until the operator confirms the instance may run one. On the documented
 * isolated instance the provider endpoint is a dead local stub, so such a turn costs no model
 * usage; the guard exists so a run against a *live* provider is always an explicit decision.
 */
export function requireLiveCli(reason) {
  if (process.env[LIVE_CLI_FLAG] !== '1') {
    throw new EnvironmentBlocked(
      `${LIVE_CLI_FLAG}=1 is required: ${reason} (see README "环境守卫")`,
    );
  }
}

export function requireModel(reason) {
  if (process.env[MODEL_FLAG] !== '1') {
    throw new EnvironmentBlocked(`${MODEL_FLAG}=1 is required: ${reason} (see README "环境守卫")`);
  }
}

export function requireExternal(reason) {
  if (process.env[EXTERNAL_FLAG] !== '1') {
    throw new EnvironmentBlocked(`${EXTERNAL_FLAG}=1 is required: ${reason} (see README "环境守卫")`);
  }
}

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function suitePath(...parts) {
  return path.join(suiteDir, ...parts);
}

/**
 * Same base environment rules as the locked suites (loopback only, user instances refused),
 * plus this suite's own fixture manifest. `dataRoot` may live under any acceptance suite's
 * .artifacts because the documented isolated instance is shared; it must never point outside
 * the worktree's tests/acceptance tree.
 */
export function getRuntime({ requireManifest = false } = {}) {
  const base = fb.getRuntime({ requireManifest: false }); // throws for bad BASE_URL / protected ports
  const manifestPath = path.resolve(
    process.env.R2528_FIXTURES || suitePath('fixture-manifest.local.json'),
  );
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    rejectSecretFields(manifest);
    if (!manifest.dataRoot) {
      throw new EnvironmentBlocked('fixture manifest must declare dataRoot for the isolated server');
    }
    const dataRoot = path.resolve(manifest.dataRoot);
    const allowedRoot = path.join(base.worktree, 'tests', 'acceptance');
    if (dataRoot !== allowedRoot && !dataRoot.startsWith(`${allowedRoot}${path.sep}`)) {
      throw new EnvironmentBlocked('fixture dataRoot must stay inside tests/acceptance of the worktree');
    }
  } else if (requireManifest) {
    throw new EnvironmentBlocked(`create ${manifestPath} from fixture-manifest.example.json`);
  }
  return { baseURL: base.baseURL, worktree: base.worktree, manifest, manifestPath };
}

function rejectSecretFields(value, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (/(secret|password|cookie|authorization|api.?key|resume.?token|access.?token)/i.test(key)) {
      throw new EnvironmentBlocked(`fixture manifest must not contain credential field ${at}`);
    }
    rejectSecretFields(child, at);
  }
}

export function fixtureSection(name) {
  const { manifest } = getRuntime({ requireManifest: true });
  const section = manifest?.[name];
  if (!section) throw new EnvironmentBlocked(`fixture manifest section ${name} is required (see README)`);
  return section;
}

export function requireField(section, key) {
  const value = section?.[key];
  if (typeof value !== 'string' || !value) {
    throw new EnvironmentBlocked(`fixture field ${key} is required and must be a non-empty string`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// HTTP probes: envelope, history operations, official queries
// ---------------------------------------------------------------------------

export async function jsonBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { __nonJsonBody__: text.slice(0, 300) }; }
}

/**
 * 「公共规则、身份与错误」envelope: `{ok:false,code,error}` with a stable code, a readable short
 * sentence, no credentials, no private text, no stack trace.
 */
export function expectJsonError(result, { status, code = null, mustNotContain = [] }) {
  const label = code || `HTTP ${status}`;
  expect(result.status, `HTTP status for ${label}`).toBe(status);
  expect(result.body, `JSON body for ${label}`).toBeTruthy();
  expect(result.body?.ok, `ok:false envelope for ${label} (got ${JSON.stringify(result.body).slice(0, 200)})`).toBe(false);
  if (code) {
    expect(result.body?.code, `stable error code ${code}`).toBe(code);
  } else {
    expect(typeof result.body?.code, `stable error code for ${label}`).toBe('string');
    expect(result.body.code.length, `stable error code for ${label}`).toBeGreaterThan(0);
    expect(result.body.code.length, `stable error code for ${label}`).toBeLessThanOrEqual(64);
  }
  expect(typeof result.body?.error, `readable error text for ${label}`).toBe('string');
  expect(result.body.error.length, `short error text for ${label}`).toBeLessThanOrEqual(300);
  expect(result.body.error, 'no stack trace in error text').not.toMatch(/\n\s+at\s|Error:\s*\n/);
  for (const needle of mustNotContain) {
    expect(result.body.error, 'error text must not leak request content').not.toContain(needle);
  }
}

export async function getJson(request, baseURL, url) {
  const response = await request.get(`${baseURL}${url}`, { failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response), contentType: response.headers()['content-type'] || '' };
}

export async function postJson(request, baseURL, url, data) {
  const response = await request.post(`${baseURL}${url}`, { data, failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response), contentType: response.headers()['content-type'] || '' };
}

/** History operations share one address shape; the operation name is the last path segment. */
export const HISTORY_OPS = ['trim', 'compact-segment', 'trim-before-tool', 'strip-thinking', 'repair-official-compat'];

export function historyURL(sessionId, op) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/${op}`;
}

export async function postHistoryOp(request, baseURL, sessionId, op, body) {
  return await postJson(request, baseURL, historyURL(sessionId, op), body);
}

export async function getRepairCompat(request, baseURL, sessionId, projectHash) {
  return await getJson(
    request, baseURL,
    `${historyURL(sessionId, 'repair-official-compat')}?projectHash=${encodeURIComponent(projectHash)}`,
  );
}

export async function getHealth(request, baseURL) {
  const response = await request.get(`${baseURL}/api/health`);
  expect(response.status()).toBe(200);
  return await response.json();
}

export async function getModelInfo(request, baseURL) {
  const result = await getJson(request, baseURL, '/api/model');
  expect(result.status, '/api/model must answer for scope-observation cases').toBe(200);
  return result.body;
}

export async function getProviders(request, baseURL) {
  const result = await getJson(request, baseURL, '/api/providers');
  expect(result.status, '/api/providers must answer for scope-observation cases').toBe(200);
  return result.body;
}

export async function getProjects(request, baseURL) {
  const result = await getJson(request, baseURL, '/api/projects');
  expect(result.status, '/api/projects must answer for no-write observations').toBe(200);
  expect(Array.isArray(result.body), '/api/projects must return an array').toBe(true);
  return result.body;
}

export async function readMessages(request, baseURL, sessionId, projectHash) {
  return await getJson(
    request, baseURL,
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?projectHash=${encodeURIComponent(projectHash)}`,
  );
}

/** Current provider identity as the app itself publishes it (provider switch = scope observation). */
export async function currentScope(request, baseURL) {
  const [model, providers] = await Promise.all([getModelInfo(request, baseURL), getProviders(request, baseURL)]);
  const current = (providers.customProviders || []).find(p => p.isCurrent)
    || (providers.providers || []).find(p => p.isCurrent)
    || null;
  return {
    model: model?.model ?? null,
    provider: model?.provider ?? null,
    currentProviderId: current?.id ?? null,
    currentProviderName: current?.name ?? null,
  };
}

// ---------------------------------------------------------------------------
// Fixtures prepared through the public chat entry
// ---------------------------------------------------------------------------

function defaultWorkspace() {
  const { manifest, worktree } = getRuntime();
  if (manifest?.historyWorkspace?.path) return manifest.historyWorkspace.path;
  const dataRoot = manifest?.dataRoot || path.join(worktree, 'tests', 'acceptance', 'r2528-batch6-20260911', '.artifacts', 'runtime-data');
  return path.join(dataRoot, 'fixture-workspace-r2528');
}

export function fixtureWorkspacePath() {
  const workspace = defaultWorkspace();
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

/**
 * Creates one fresh session with `messages` stored user messages through the public composer API.
 * Each message is one POST /api/chat with a unique marker; the session identity is read back from
 * the app's own search endpoint. The turn itself may end as a local failure notice (the isolated
 * instance points at a dead stub provider) — what the fixture needs is the stored user message.
 */
export async function createFixtureSession(request, baseURL, { messages = 2, label = 'R2528_FIX' } = {}) {
  requireLiveCli('creating a history fixture session starts a real local CLI turn through POST /api/chat');
  const cwd = fixtureWorkspacePath();
  const markers = [];
  let sessionId = null;
  let projectHash = null;
  for (let index = 0; index < messages; index += 1) {
    const marker = `${label}_${index + 1}_${uniqueId('m').slice(-10)}`;
    markers.push(marker);
    const payload = { prompt: `${marker} 请只回复 OK`, cwd };
    if (sessionId) payload.sessionId = sessionId;
    const result = await postJson(request, baseURL, '/api/chat', payload);
    expect(result.status, `POST /api/chat must accept the fixture message (body ${JSON.stringify(result.body).slice(0, 200)})`).toBe(200);
    if (!sessionId) {
      const deadline = Date.now() + 15_000;
      let hit = null;
      do {
        const search = await getJson(request, baseURL, `/api/search?q=${encodeURIComponent(marker)}`);
        hit = (search.body?.hits || []).find(item => item.sessionId);
        if (!hit) await new Promise(resolve => setTimeout(resolve, 500));
      } while (!hit && Date.now() < deadline);
      if (!hit) {
        throw new EnvironmentBlocked(
          `the fixture message was accepted but no session became discoverable through /api/search within 15s ` +
          `(marker ${marker}); checklist: is /api/search working, is the workspace under the instance data root?`,
        );
      }
      sessionId = hit.sessionId;
      expect(typeof hit.projectHash, 'the fixture session must publish its projectHash').toBe('string');
      projectHash = hit.projectHash;
    }
  }
  // The turn runs asynchronously; wait until every stored marker is readable through the public
  // messages endpoint (the user message is written regardless of how the turn itself ends).
  const deadline = Date.now() + 20_000;
  let last = null;
  do {
    last = await readMessages(request, baseURL, sessionId, projectHash);
    if (last.status === 200 && markers.every(marker => messagesContain(last.body, marker))) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  const missing = markers.filter(marker => !messagesContain(last?.body, marker));
  if (missing.length) {
    throw new EnvironmentBlocked(
      `fixture session ${sessionId} never exposed ${missing.length} of ${markers.length} stored messages ` +
      `(missing: ${missing.join(', ')}); checklist: did the composer accept both turns, is the workspace writable?`,
    );
  }
  return { sessionId, projectHash, markers, workspace: cwd };
}

/** Marker list read back from the public messages endpoint (no private JSONL access). */
export function messageTexts(body) {
  return (body?.messages || []).map(message => JSON.stringify(message));
}

export function messagesContain(body, marker) {
  return messageTexts(body).some(text => text.includes(marker));
}

/** One read of a session's public history, enough to prove "the operation did not write it". */
export async function sessionSnapshot(request, baseURL, sessionId, projectHash) {
  const result = await readMessages(request, baseURL, sessionId, projectHash);
  expect(result.status, `reading fixture session ${sessionId} must answer 200`).toBe(200);
  const messages = result.body?.messages || [];
  return {
    count: messages.length,
    uuids: messages.map(message => message.uuid).filter(Boolean),
    texts: messages.map(message => JSON.stringify(message)),
    body: result.body,
  };
}

/** 反向断言：预览/被拒绝的路径不得改写会话（条数与 uuid 序列都不变）。 */
export function expectNoSessionWrite(before, after, label) {
  expect(after.count, `${label}: 会话消息条数不得变化（预览/拒绝路径零会话改写）`).toBe(before.count);
  expect(after.uuids, `${label}: 会话消息 uuid 序列不得变化`).toEqual(before.uuids);
}

/** 第一条用户消息的 uuid（未知内容的夹具会话也能拿到的锚点）。 */
export function firstUserAnchor(snapshot) {
  const uuid = (snapshot.body?.messages || []).find(message => message.type === 'user')?.uuid;
  expect(uuid, '夹具会话必须至少有一条带 uuid 的用户消息').toBeTruthy();
  return uuid;
}

/** 用消息里的夹具标记取到该消息的 uuid —— dry-run 业务参数里的锚点。 */
export function anchorFor(snapshot, marker) {
  const index = snapshot.texts.findIndex(text => text.includes(marker));
  expect(index, `fixture marker ${marker} must be present in the fixture session`).toBeGreaterThanOrEqual(0);
  const uuid = snapshot.body.messages[index]?.uuid;
  expect(uuid, '每条已存消息都必须公布 uuid').toBeTruthy();
  return uuid;
}

/** dry-run 成功信封（INTERFACE 表 + 预览段落逐字字段）。 */
export function expectPreviewEnvelope(body) {
  expect(body, 'dry-run 必须返回 JSON 信封').toBeTruthy();
  const version = body.baseVersion;
  expect(['string', 'number'].includes(typeof version) && String(version).length > 0,
    `baseVersion 必须是非空版本标识（got ${JSON.stringify(version)}）`).toBe(true);
  expect(typeof body.previewToken, 'previewToken 必须是字符串').toBe('string');
  expect(body.previewToken.length, 'previewToken 不能为空').toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(body.expiresAt)), `expiresAt 必须是可解析时间（got ${body.expiresAt}）`).toBe(false);
  expect(typeof body.changed, 'changed 必须是布尔').toBe('boolean');
  expect(body.report !== undefined && body.report !== null, 'report 必须存在').toBe(true);
  expect(typeof body.compatibility, 'compatibility 必须存在（字符串枚举）').toBe('string');
  expect(body.affectedRange !== undefined && body.affectedRange !== null, 'affectedRange 必须存在').toBe(true);
  expect(typeof body.requiresNewSession, 'requiresNewSession 必须是布尔').toBe('boolean');
}

/** 提交成功信封。 */
export function expectSubmitEnvelope(body) {
  expect(body, '提交必须返回 JSON 信封').toBeTruthy();
  expect(typeof body.changed, 'changed 必须是布尔').toBe('boolean');
  expect(['string', 'number'].includes(typeof body.baseVersion), 'baseVersion 必须存在').toBe(true);
  expect(['string', 'number'].includes(typeof body.resultVersion), 'resultVersion 必须存在').toBe(true);
  expect(typeof body.backupRef, 'backupRef 必须是不透明引用字符串').toBe('string');
  expect(body.backupRef.length, 'backupRef 不能为空').toBeGreaterThan(0);
  expect(typeof body.compatibility, 'compatibility 必须存在').toBe('string');
  expect(body.report !== undefined && body.report !== null, 'report 必须存在').toBe(true);
  expect(body.resultSessionId === null || typeof body.resultSessionId === 'string',
    `resultSessionId 必须是会话身份字符串或 null（got ${JSON.stringify(body.resultSessionId)}）`).toBe(true);
}
