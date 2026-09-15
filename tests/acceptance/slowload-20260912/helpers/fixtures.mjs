// 夹具:全部落在本套件的 .artifacts/runtime-data 下,**绝不碰真实 ~/.claude/projects**。
//
// 规模照 .devflow/INTERFACE-20260912-slowload.md §F.0 的配方来(否则计时类用例没有意义):
// 大项目 ≥200 个 jsonl、其中 1 个 ≥20 MB(用一条超长 text 撑体积,不真造几万条记录);
// 另两个项目各 20 / 5 个;一个空项目目录。外加子代理(扁平 + workflows 深两层)、归档标记、
// compact_boundary、标题行、sidecar —— 让「响应体对拍」有足够多的字段面。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const projectsRoot = () => path.join(homeDir(), '.claude', 'projects');
/** 索引目录的**根**。每次跑用里面一个全新子目录(见 runtime.mjs 的 activeIndexDir)——
 *  这样「冷进程 · 无索引」那一档每次都是真的没有索引,不用去删上一轮留下的东西。 */
export const indexDir = () => path.join(dataRoot(), 'index');
export const projectDir = (hash) => path.join(projectsRoot(), hash);
export const workspaceDir = (name) => path.join(dataRoot(), 'fixture-workspace', name);
export const manifestPath = () => suitePath('fixture-manifest.local.json');

export const HASH_BIG = '-slowload-20260912-big';
export const HASH_MID = '-slowload-20260912-mid';
export const HASH_SMALL = '-slowload-20260912-small';
export const HASH_EMPTY = '-slowload-20260912-empty';
export const HASH_SIDECAR_MISS = '-slowload-20260912-nosidecar';

/** 大项目里的「活跃会话」:≥40 行(增量闸门要 headFull)、最后一条是整轮收尾。 */
export const SID_ACTIVE = '51000001-0000-4000-8000-000000000001';
/** 大项目里的 20 MB 会话。 */
export const SID_BIGFILE = '51000002-0000-4000-8000-000000000002';
/** 带子代理的那条。 */
export const SID_SUBAGENT = '51000003-0000-4000-8000-000000000003';
/** 被归档的那条。 */
export const SID_ARCHIVED = '51000004-0000-4000-8000-000000000004';
/** 中项目里用来做正/反用例的那条(小,改写成本低)。 */
export const SID_MID = '52000001-0000-4000-8000-000000000001';

const ISO = (min) => new Date(Date.UTC(2026, 8, 12, 8, min % 60, 0)).toISOString();
const uuid = (n) => `5fed0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const userRec = ({ sid, n, text, cwd, minute }) => ({
  parentUuid: null, isSidechain: false, type: 'user', userType: 'external', entrypoint: 'cli',
  message: { role: 'user', content: [{ type: 'text', text }] },
  uuid: uuid(n), timestamp: ISO(minute), cwd, sessionId: sid, version: '2.1.267', gitBranch: 'HEAD',
});
const asstRec = ({ sid, n, text, cwd, minute, model = 'claude-sonnet-4-5' }) => ({
  parentUuid: null, isSidechain: false, type: 'assistant', userType: 'external', entrypoint: 'cli',
  message: {
    id: `msg_slowload_${n}`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 34 },
  },
  requestId: `req_slowload_${n}`, uuid: uuid(100000 + n), timestamp: ISO(minute + 1), cwd, sessionId: sid,
});
const titleRec = (sid, customTitle) => ({ type: 'custom-title', customTitle, sessionId: sid });
const boundaryRec = (sid) => ({ type: 'system', subtype: 'compact_boundary', uuid: uuid(200001), sessionId: sid });

const writeJsonl = (file, records) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
};

/** 一条普通会话(3 条来往 + 标题 + boundary),给大/中/小项目共用。 */
function normalSession({ dir, sid, cwd, marker, minute = 0, withBoundary = false }) {
  const recs = [
    userRec({ sid, n: 1, text: `${marker} 第一条提问`, cwd, minute }),
    asstRec({ sid, n: 1, text: '收到', cwd, minute }),
    userRec({ sid, n: 2, text: `${marker} 第二条提问`, cwd, minute: minute + 1 }),
    asstRec({ sid, n: 2, text: '好的', cwd, minute: minute + 1 }),
    titleRec(sid, `${marker} 的标题`),
  ];
  if (withBoundary) {
    recs.push(boundaryRec(sid));
    recs.push(userRec({ sid, n: 3, text: `${marker} 压缩之后的问题`, cwd, minute: minute + 2 }));
    recs.push(asstRec({ sid, n: 3, text: '压缩之后回复', cwd, minute: minute + 2 }));
  }
  writeJsonl(path.join(dir, `${sid}.jsonl`), recs);
}

/** 活跃会话:50 行(>40,保证 headFull),末尾是普通收尾 —— G6 / R1 在它上面追加。 */
function activeSession(dir, cwd) {
  const recs = [];
  for (let i = 1; i <= 25; i += 1) {
    recs.push(userRec({ sid: SID_ACTIVE, n: 10 + i, text: `活跃会话第 ${i} 轮提问`, cwd, minute: i }));
    recs.push(asstRec({ sid: SID_ACTIVE, n: 10 + i, text: `活跃会话第 ${i} 轮回复`, cwd, minute: i }));
  }
  recs.push(titleRec(SID_ACTIVE, '活跃会话'));
  writeJsonl(path.join(dir, `${SID_ACTIVE}.jsonl`), recs);
}

/** 20 MB 会话:200 条 × ~100 KB 的 ASCII 正文(逐条真记录太慢,也没必要)。 */
function bigSession(dir, cwd) {
  const FILLER = 'Slowload fixture filler line padded to a hundred kilobytes. '
    .repeat(1600).slice(0, 100 * 1024);
  const recs = [userRec({ sid: SID_BIGFILE, n: 1, text: '这条会话体积很大(夹具)', cwd, minute: 30 })];
  for (let i = 2; i <= 200; i += 1) {
    recs.push(asstRec({ sid: SID_BIGFILE, n: i, text: `${FILLER} #${i}`, cwd, minute: 30 + (i % 30) }));
  }
  writeJsonl(path.join(dir, `${SID_BIGFILE}.jsonl`), recs);
}

/** 子代理:扁平一层 + workflows/wf_x 深两层(INTERFACE §F.0 的两种落盘形态)。 */
function subagentSession(dir, cwd) {
  const sid = SID_SUBAGENT;
  normalSession({ dir, sid, cwd, marker: '带子代理的会话', minute: 40 });
  const sub = path.join(dir, sid, 'subagents');
  writeJsonl(path.join(sub, 'agent-aaa.jsonl'), [
    userRec({ sid, n: 5, text: '子代理的首条指令', cwd, minute: 41 }),
    asstRec({ sid, n: 5, text: '子代理回复', cwd, minute: 41, model: 'claude-haiku-4-5' }),
  ]);
  fs.writeFileSync(path.join(sub, 'agent-aaa.meta.json'), JSON.stringify({ toolUseId: 'toolu_a', agentType: 'backend-developer' }));
  writeJsonl(path.join(sub, 'workflows', 'wf_x', 'agent-bbb.jsonl'), [
    userRec({ sid, n: 6, text: '工作流里的子代理指令', cwd, minute: 42 }),
    asstRec({ sid, n: 6, text: '工作流子代理回复', cwd, minute: 42 }),
  ]);
  fs.writeFileSync(path.join(sub, 'workflows', 'wf_x', 'agent-bbb.meta.json'), JSON.stringify({ agentType: 'designer' }));
}

// 会话 id 生成:8 位十六进制首段 = <项目前缀 4 位><序号 4 位>。序号从 100 起,避开
// 下面几个具名会话(…0001~0004),不然两条会话会挤进同一个文件。
const sidFor = (prefix, i) => `${prefix}${String(i).padStart(4, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`;

function buildProject({ hash, name, prefix, files, firstSid }) {
  const dir = projectDir(hash);
  const cwd = workspaceDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(dir, '.cgui-meta.json'), JSON.stringify({ cwd }));
  normalSession({ dir, sid: firstSid, cwd, marker: `${name} 首条`, minute: 1, withBoundary: true });
  for (let i = 100; i < 100 + files - 1; i += 1) {
    normalSession({ dir, sid: sidFor(prefix, i), cwd, marker: `${name} 会话 ${i}`, minute: (i * 2) % 55 });
  }
  return { dir, cwd };
}

export function ensureFixtures({ force = false } = {}) {
  const file = manifestPath();
  if (!force && fs.existsSync(file)) {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (fs.existsSync(path.join(projectDir(HASH_BIG), `${SID_BIGFILE}.jsonl`))) return m;
  }
  fs.mkdirSync(projectsRoot(), { recursive: true });
  fs.mkdirSync(path.join(homeDir(), '.claude'), { recursive: true });
  fs.mkdirSync(workspaceDir('common'), { recursive: true });

  // ── 大项目:200 个 jsonl + 3 个特殊会话 ──
  const big = buildProject({
    hash: HASH_BIG, name: 'big', prefix: '5100', files: 197, firstSid: SID_ACTIVE,
  });
  bigSession(big.dir, big.cwd);
  activeSession(big.dir, big.cwd);
  subagentSession(big.dir, big.cwd);
  normalSession({ dir: big.dir, sid: SID_ARCHIVED, cwd: big.cwd, marker: '已归档的会话', minute: 50 });
  fs.writeFileSync(path.join(big.dir, `${SID_ARCHIVED}.jsonl.archived`), '');

  // ── 中项目(20 个)+ 小项目(5 个)+ 空目录 + 无 sidecar 的目录 ──
  buildProject({ hash: HASH_MID, name: 'mid', prefix: '5200', files: 20, firstSid: SID_MID });
  buildProject({ hash: HASH_SMALL, name: 'small', prefix: '5300', files: 5, firstSid: '53000001-0000-4000-8000-000000000001' });
  fs.mkdirSync(projectDir(HASH_EMPTY), { recursive: true });
  const noSidecar = buildProject({ hash: HASH_SIDECAR_MISS, name: 'nosidecar', prefix: '5400', files: 2, firstSid: '54000001-0000-4000-8000-000000000001' });
  fs.unlinkSync(path.join(noSidecar.dir, '.cgui-meta.json')); // 无 sidecar → 走 hash 反推路径那条分支

  const count = (hash) => fs.readdirSync(projectDir(hash)).filter((n) => n.endsWith('.jsonl')).length;
  const manifest = {
    dataRoot: dataRoot(),
    home: homeDir(),
    indexDir: indexDir(),
    projects: {
      big: { hash: HASH_BIG, files: count(HASH_BIG) },
      mid: { hash: HASH_MID, files: count(HASH_MID) },
      small: { hash: HASH_SMALL, files: count(HASH_SMALL) },
      empty: { hash: HASH_EMPTY, files: 0 },
      nosidecar: { hash: HASH_SIDECAR_MISS, files: count(HASH_SIDECAR_MISS) },
    },
    sessions: { active: SID_ACTIVE, bigfile: SID_BIGFILE, subagent: SID_SUBAGENT, archived: SID_ARCHIVED, mid: SID_MID },
    bigFileBytes: fs.statSync(path.join(big.dir, `${SID_BIGFILE}.jsonl`)).size,
  };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** 文件级恢复出厂:sessions 目录里被用例改过的文件铺回原状(幂等、不重建 20 MB)。 */
export function resetMutatedFiles() {
  const m = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  const midDir = projectDir(m.projects.mid.hash);
  normalSession({ dir: midDir, sid: SID_MID, cwd: workspaceDir('mid'), marker: 'mid 首条', minute: 1, withBoundary: true });
  return m;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures({ force: process.argv.includes('--force') }), null, 2)}\n`);
}
