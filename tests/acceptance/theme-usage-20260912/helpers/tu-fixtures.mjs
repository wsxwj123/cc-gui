// TU 套件的会话夹具：在本套件自己的隔离数据根里现造一份最小会话。
//
// 为什么是"现造"而不是"拷一份真转写"：本套件的被测面是**主题/用量面板的呈现**，
// 不需要真实模型用量、时区、时段价这些带历史包袱的数据（那是 PA 套件的事）。
// 一份自造会话就能把「用量」面板与「终端」面板点出来，且跑多少次都长一个样。
//
// 只写本套件 .artifacts 下的数据；不读用户 profile、不写别处。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PROJECT_NAME = 'fixture-workspace';
export const SESSION_MARKER = 'TU_FIXTURE_SESSION_20260912';
export const SESSION_ID = 'b7000001-0000-4000-8000-0000000000a1';
export const SECOND_SESSION_ID = 'b7000002-0000-4000-8000-0000000000a2';

export function suitePath(...parts) {
  return path.join(suiteDir, ...parts);
}

export function manifestPath() {
  return suitePath('fixture-manifest.local.json');
}

export function dataRoot() {
  return suitePath('.artifacts', 'runtime-data');
}

/** 与 CLI 同规则：cwd 里非字母数字一律换成 `-`（目录名即项目 hash）。 */
export function projectHashFor(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function workspaceDir() {
  return path.join(dataRoot(), PROJECT_NAME);
}

export function projectsRoot() {
  return path.join(dataRoot(), 'home', '.claude', 'projects');
}

function uuid(n) {
  return `b7000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function userRecord({ sessionId, cwd, text, at }) {
  return {
    parentUuid: null,
    isSidechain: false,
    promptId: uuid(90),
    type: 'user',
    message: { role: 'user', content: text },
    uuid: uuid(91),
    timestamp: at,
    permissionMode: 'default',
    promptSource: 'sdk',
    userType: 'external',
    entrypoint: 'sdk-ts',
    cwd,
    sessionId,
    version: '2.1.267',
    gitBranch: 'codex/fix-batch-first-20260910',
  };
}

function assistantRecord({ sessionId, cwd, text, at }) {
  return {
    parentUuid: uuid(91),
    isSidechain: false,
    message: {
      id: 'msg_tu_fixture_0001',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 340,
        cache_read_input_tokens: 5120,
        output_tokens: 46,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: '',
        iterations: [],
        speed: 'standard',
      },
      stop_details: null,
    },
    apiBlockIndex: 0,
    type: 'assistant',
    uuid: uuid(92),
    timestamp: at,
    effort: 'high',
    perTurnEffort: null,
    userType: 'external',
    entrypoint: 'sdk-ts',
    cwd,
    sessionId,
    version: '2.1.267',
    gitBranch: 'codex/fix-batch-first-20260910',
  };
}

/**
 * 现造会话 + 清单一并落盘（幂等）。
 * 清单只记"跑用例需要的定位值"，不含 cookie/key/token/真实会话正文。
 */
export function ensureFixtureManifest({ force = false } = {}) {
  const cwd = workspaceDir();
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(dataRoot(), 'home', '.claude'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot(), 'home', '.claude-gui'), { recursive: true });

  const hash = projectHashFor(cwd);
  const dir = path.join(projectsRoot(), hash);
  fs.mkdirSync(dir, { recursive: true });

  const sessions = [
    {
      sessionId: SESSION_ID,
      marker: SESSION_MARKER,
      user: `${SESSION_MARKER} 主题与用量面板验收夹具（不要把这段文字挪作它用）`,
      reply: '已收到夹具会话。',
    },
  ];
  for (const s of sessions) {
    const file = path.join(dir, `${s.sessionId}.jsonl`);
    if (force || !fs.existsSync(file)) {
      const at = '2026-09-12T02:00:00.000Z';
      const lines = [
        userRecord({ sessionId: s.sessionId, cwd, text: s.user, at }),
        assistantRecord({ sessionId: s.sessionId, cwd, text: s.reply, at: '2026-09-12T02:00:05.000Z' }),
      ];
      fs.writeFileSync(file, `${lines.map(x => JSON.stringify(x)).join('\n')}\n`);
    }
  }

  const manifest = {
    dataRoot: dataRoot(),
    buildLabel: 'batch worktree codex/fix-batch-first-20260910（本套件自造夹具）',
    platform: 'chromium',
    observedAt: new Date().toISOString(),
    session: {
      projectName: PROJECT_NAME,
      projectHash: hash,
      sessionId: SESSION_ID,
      searchMarker: SESSION_MARKER,
      workspace: cwd,
    },
  };
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = ensureFixtureManifest({ force: process.argv.includes('--force') });
  process.stdout.write(`[TU] 夹具就绪：${manifest.session.sessionId} @ ${manifest.session.workspace}\n`);
}
