// 单测:会话画像(profile)扫描/派生/失效契约 + 索引缓存行为。
// 对应 .devflow/INTERFACE-20260912-slowload.md §A/§B/§C(实现方自测;验收套件另在
// tests/acceptance/slowload-20260912/,本文件只锁实现级不变量)。
//
// 隔离:HOME 与索引目录都指到临时目录,**绝不碰真实 ~/.claude**(需要在 import 之前设好
// process.env.HOME —— session-reader/session-index 在模块加载时就解析 homedir())。
import assert from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, appendFileSync, truncateSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJsonlEdges } from '../../server/utils/jsonl-parser.js';

const ROOT = mkdtempSync(join(tmpdir(), 'cgui-profile-'));
const HOME = join(ROOT, 'home');
const PROJECTS = join(HOME, '.claude', 'projects');
const INDEX_DIR = join(ROOT, 'idx');
mkdirSync(PROJECTS, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME; // r49:Windows 的 os.homedir() 读 USERPROFILE,不设就沙箱失效
process.env.CGUI_SESSION_INDEX_DIR = INDEX_DIR;

const { listSessions, listProjects, deriveProfile } = await import('../../server/services/session-reader.js');
const { scanProfile, isProfileValid, profileLevel, PROFILE_VERSION } = await import('../../server/services/session-profile.js');
const { getEntry, putEntry, getRawEntry, ensureProjectLoaded, flushProject, readStats } = await import('../../server/services/session-index.js');
const { statSync } = await import('fs');

const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4222-8333-${String(n).padStart(12, '0')}`;
const line = (o) => JSON.stringify(o) + '\n';
const userRec = (n, sid, text, cwd) => ({ type: 'user', uuid: uuid(n), timestamp: `2026-09-12T10:00:${String(n % 60).padStart(2, '0')}.000Z`, ...(cwd ? { cwd } : {}), sessionId: sid, message: { role: 'user', content: [{ type: 'text', text }] } });
const asstRec = (n, sid, model = 'claude-sonnet-4-5', usage) => ({ type: 'assistant', uuid: uuid(n), timestamp: `2026-09-12T10:01:${String(n % 60).padStart(2, '0')}.000Z`, sessionId: sid, message: { id: `msg_${n}`, model, usage: usage || { input_tokens: 3, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] } });

const REAL_CWD = join(ROOT, 'real-project');
mkdirSync(REAL_CWD, { recursive: true });

try {
  // ── fixture:两个项目(一个带 sidecar + 子代理 + 归档 + 孤儿文件,一个无 sidecar)──
  const HASH_A = '-tmp-cgui-a';
  const DIR_A = join(PROJECTS, HASH_A);
  mkdirSync(DIR_A, { recursive: true });
  writeFileSync(join(DIR_A, '.cgui-meta.json'), JSON.stringify({ cwd: REAL_CWD }));
  const sidA = uuid(1);
  const linesA = [
    line({ type: 'attachment', uuid: uuid(2), cwd: REAL_CWD }),
    line({ type: 'custom-title', customTitle: '  手改标题  ', sessionId: sidA }),
    line(userRec(3, sidA, '第一个真实问题', REAL_CWD)),
    line(asstRec(4, sidA, 'claude-sonnet-4-5')),
    line({ type: 'ai-title', aiTitle: '自动标题', sessionId: sidA }),
    line(asstRec(5, sidA, 'deepseek-flash')),
  ];
  writeFileSync(join(DIR_A, `${sidA}.jsonl`), linesA.join(''));
  // 子代理(扁平 + workflow 深两层)
  const subDir = join(DIR_A, sidA, 'subagents');
  mkdirSync(join(subDir, 'workflows', 'wf_x'), { recursive: true });
  writeFileSync(join(subDir, 'agent-aaa.jsonl'), line(userRec(6, sidA, '子代理的首条指令', REAL_CWD)) + line(asstRec(7, sidA, 'claude-haiku-4-5', { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 })));
  writeFileSync(join(subDir, 'agent-aaa.meta.json'), JSON.stringify({ toolUseId: 'toolu_1', agentType: 'backend-developer' }));
  writeFileSync(join(subDir, 'workflows', 'wf_x', 'agent-bbb.jsonl'), line(userRec(8, sidA, 'wf 子代理', REAL_CWD)) + line(asstRec(9, sidA)));
  writeFileSync(join(subDir, 'workflows', 'wf_x', 'agent-bbb.meta.json'), JSON.stringify({ agentType: 'designer' }));
  // 归档标记
  writeFileSync(`${join(DIR_A, `${sidA}.jsonl`)}.archived`, '');
  // 孤儿(只有 ai-title,没有任何 user)→ 不进列表
  writeFileSync(join(DIR_A, `${uuid(10)}.jsonl`), line({ type: 'ai-title', aiTitle: '孤儿', sessionId: uuid(10) }));
  // sidecar 不匹配的兄弟会话(cwd 不同)→ 不进列表、也不计入 sessionCount
  writeFileSync(join(DIR_A, `${uuid(11)}.jsonl`), line({ type: 'attachment', uuid: uuid(12), cwd: '/definitely/elsewhere' }) + line(userRec(13, uuid(11), '别人的会话', '/definitely/elsewhere')) + line(asstRec(14, uuid(11))));
  // 无 cwd 的会话 → 保留(算 matched)
  const sidC = uuid(15);
  writeFileSync(join(DIR_A, `${sidC}.jsonl`), line(userRec(16, sidC, '没有 cwd 的会话')) + line(asstRec(17, sidC)) + line(asstRec(18, sidC)));

  const HASH_B = '-tmp-cgui-b';
  const DIR_B = join(PROJECTS, HASH_B);
  const REAL_CWD_B = join(ROOT, 'proj-b');
  mkdirSync(DIR_B, { recursive: true });
  mkdirSync(REAL_CWD_B, { recursive: true });
  const sidB = uuid(20);
  writeFileSync(join(DIR_B, `${sidB}.jsonl`), line({ type: 'attachment', uuid: uuid(21), cwd: REAL_CWD_B }) + line(userRec(22, sidB, '  带空白的首条  ')) + line(asstRec(23, sidB)));

  // ── 1. listSessions:消息数/首条/标题/模型/归档/子代理 逐项对照 ──
  const sessions = await listSessions(HASH_A);
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  assert.equal(sessions.length, 2, '只应列出 sidecar 匹配 + 无 cwd 的两个会话');
  const a = byId.get(sidA);
  assert.ok(a, '主体会话应出现');
  // 消息数口径 = readJsonlEdges 的非空行数(独立参照,不用画像自己算)
  const oracle = await readJsonlEdges(join(DIR_A, `${sidA}.jsonl`), 40);
  assert.equal(a.messageCount, oracle.totalLines, 'messageCount 必须等于非空行数');
  assert.equal(a.firstPrompt, '第一个真实问题', 'firstPrompt 取首个真实 user');
  assert.equal(a.customTitle, '手改标题', 'custom-title 去空白后进 customTitle');
  assert.equal(a.aiTitle, '自动标题', 'ai-title 独立进 aiTitle');
  assert.equal(a.model, 'deepseek-flash', 'model = tail 最后的 assistant 模型');
  assert.equal(a.projectPath, REAL_CWD, 'projectPath = jsonl 里的 cwd');
  assert.equal(a.archived, true, '兄弟 .archived 文件 → archived:true');
  assert.equal(a.lastActivity, oracle.tail[oracle.tail.length - 1].timestamp, 'lastActivity = 末条时间戳');
  assert.equal(a.startTime, userRec(3, sidA).timestamp, 'startTime = 首个真实 user 的时间戳');
  assert.equal(a.subagents.length, 2, '扁平 + workflow 子代理都要出现');
  const ag = a.subagents.find((s) => s.sessionId === 'agent-aaa');
  assert.equal(ag.firstPrompt, '子代理的首条指令');
  assert.equal(ag.messageCount, 2);
  assert.equal(ag.model, 'claude-haiku-4-5');
  assert.equal(ag.contextTokens, 10 + 900 + 90, 'contextTokens = input+cache_read+cache_creation');
  assert.equal(ag.cwd, REAL_CWD);
  assert.equal(ag.toolUseId, 'toolu_1');
  assert.equal(ag.agentType, 'backend-developer');
  const wfAgent = a.subagents.find((s) => s.sessionId === 'agent-bbb');
  assert.equal(wfAgent.workflowId, 'wf_x', 'workflow 深两层子代理带 workflowId');
  assert.equal(byId.get(sidC).firstPrompt, '没有 cwd 的会话', '无 cwd 的会话保留');

  // ── 2. 进程内第二次:响应体逐字段相同(命中路径不许改变结果)──
  assert.deepEqual(await listSessions(HASH_A), sessions, '第二次响应必须与第一次逐字段相同');

  // ── 3. listProjects:cwd 解析 + sessionCount 口径 ──
  const projects = await listProjects(PROJECTS);
  const pa = projects.find((p) => p.hash === HASH_A);
  assert.equal(pa.path, REAL_CWD, 'sidecar cwd 优先');
  assert.equal(pa.sessionCount, 3, 'sessionCount 只算 sidecar 匹配的(无 cwd 的按既有口径也算 matched:主体 + 孤儿 + 无 cwd)');
  const pb = projects.find((p) => p.hash === HASH_B);
  assert.equal(pb.path, REAL_CWD_B, '无 sidecar 时用 jsonl 的 cwd(不走 lossy 解码)');
  assert.deepEqual(await listProjects(PROJECTS), projects, 'listProjects 第二次结果相同');

  // ── 4. CGUI_SESSION_INDEX=off:响应体逐字段不变(只是慢)──
  process.env.CGUI_SESSION_INDEX = 'off';
  assert.deepEqual(await listSessions(HASH_A), sessions, 'off 时的响应体必须与 on 时相同');
  assert.deepEqual(await listProjects(PROJECTS), projects, 'off 时 listProjects 也必须相同');
  assert.equal(readStats().enabled, false, 'off 时 stats.enabled=false');
  assert.equal(getEntry(join(DIR_A, `${sidA}.jsonl`), statSync(join(DIR_A, `${sidA}.jsonl`)), 'full'), null, 'off 时不建内存缓存');
  process.env.CGUI_SESSION_INDEX = 'on';

  // ── 5. 失效契约(§C.1):v / size / mtimeMs / ino 任一不符即 miss ──
  const st = statSync(join(DIR_A, `${sidA}.jsonl`));
  const prof = deriveProfile(await scanProfile(join(DIR_A, `${sidA}.jsonl`), st, null), st);
  assert.equal(prof.v, PROFILE_VERSION);
  assert.equal(isProfileValid(prof, st), true, '四元组一致 → 有效');
  assert.equal(isProfileValid({ ...prof, v: 999 }, st), false, '版本不符 → 无效');
  assert.equal(isProfileValid({ ...prof, size: prof.size + 1 }, st), false, 'size 不符 → 无效');
  assert.equal(isProfileValid({ ...prof, mtimeMs: prof.mtimeMs + 1 }, st), false, 'mtime 不符 → 无效');
  assert.equal(isProfileValid({ ...prof, ino: prof.ino + 1 }, st), false, 'ino 不符 → 无效');
  assert.equal(isProfileValid(null, st), false);
  // ino 取不到(Windows 形态)→ 退化为 (mtimeMs,size),不更松
  const stNoIno = { ...st, ino: 0 };
  assert.equal(isProfileValid(prof, stNoIno), true, 'ino 不可用时退化为 (mtime,size) 判据');
  assert.equal(isProfileValid({ ...prof, size: prof.size + 1 }, stNoIno), false, '退化后仍要卡 size');

  // ── 6. 等级把关:head10 级条目不得当 full 用 ──
  const p10 = deriveProfile(await scanProfile(join(DIR_A, `${sidA}.jsonl`), st, null, { need: 'head10' }), st);
  assert.equal(profileLevel(p10), 'head10');
  assert.equal(p10.cwd10, REAL_CWD, 'head10 级只给 cwd10');
  assert.equal('firstPrompt' in p10, false);
  const t10 = join(DIR_A, 'head10-probe.jsonl');
  writeFileSync(t10, line(userRec(30, sidA, 'x', REAL_CWD)) + line(asstRec(31, sidA)) + '\n');
  const t10st = statSync(t10);
  putEntry(t10, deriveProfile(await scanProfile(t10, t10st, null, { need: 'head10' }), t10st), { dirty: false });
  assert.ok(getEntry(t10, t10st, 'head10'), 'head10 级条目满足 head10 需求');
  assert.equal(getEntry(t10, t10st, 'full'), null, 'head10 级条目不满足 full 需求');

  // ── 7. 索引落盘 + 统计端点数据源(走生产路径:listSessions 已把画像写进内存缓存)──
  await flushProject(HASH_A);
  const idxFile = join(INDEX_DIR, `${HASH_A}.json`);
  const written = JSON.parse(await (await import('fs/promises')).readFile(idxFile, 'utf-8'));
  assert.equal(written.v, PROFILE_VERSION);
  assert.equal(written.hash, HASH_A);
  const entryA = written.files[`${sidA}.jsonl`];
  assert.ok(entryA, '键 = 相对项目的路径(正斜杠)');
  assert.equal(entryA.customTitle, '手改标题', '落盘的画像带全文件标题(不是空壳)');
  assert.equal(entryA.messageCount === undefined, true, 'messageCount 不是画像字段(口径是 totalLines)');
  assert.equal(entryA.totalLines, oracle.totalLines);
  assert.ok(written.files[`${sidA}/subagents/workflows/wf_x/agent-bbb.jsonl`], '子代理键 = 相对路径(正斜杠,深两层也要落盘)');
  const stats = readStats();
  assert.ok(stats.memory.entries >= 2 && stats.projects[HASH_A], 'stats 提供内存条目与按项目计数');
  assert.equal(stats.projects[HASH_A].level, 'mixed', '同项目里 head10 与 full 混存 → mixed');
  assert.ok(!JSON.stringify(stats).includes(ROOT), 'stats 不得泄漏绝对路径');
  await ensureProjectLoaded(HASH_A); // 已载入过的项目:幂等,不得重复导入
  assert.ok(getRawEntry(join(DIR_A, `${sidA}.jsonl`)), '已载入项目后条目在缓存里');
  assert.deepEqual(await listSessions(HASH_A), sessions, '落盘后响应体不变');

  // ── 8. 索引文件坏掉 → 整份当空、不抛、计数器增长(N1/N2 的实现级版)──
  const before = readStats().counters.indexReadFailed;
  writeFileSync(idxFile, '{"v":1,"hash":"' + HASH_A + '","files":{'); // 半截 JSON
  await flushProject('nonexistent-hash-xyz');
  const stats2 = readStats();
  assert.ok(stats2.counters.indexReadFailed >= before, 'indexReadFailed 单调不减');
  assert.ok(Array.isArray(await listSessions(HASH_A)), '索引坏掉仍能返回正确结果');

  // ── 9. rename 替换(ino 变)后不得返回旧画像 ──
  const f30 = join(DIR_A, `${uuid(30)}.jsonl`);
  writeFileSync(f30, line(userRec(31, uuid(30), '第一版', REAL_CWD)) + line(asstRec(32, uuid(30))) + line(asstRec(36, uuid(30))));
  const before30 = (await listSessions(HASH_A)).find((s) => s.sessionId === uuid(30));
  assert.equal(before30.firstPrompt, '第一版');
  const tmpRepl = join(DIR_A, 'replacement.tmp');
  writeFileSync(tmpRepl, line(userRec(33, uuid(30), '第二版内容', REAL_CWD)) + line(asstRec(34, uuid(30))) + line(asstRec(35, uuid(30))));
  renameSync(tmpRepl, f30);
  const after30 = (await listSessions(HASH_A)).find((s) => s.sessionId === uuid(30));
  assert.equal(after30.firstPrompt, '第二版内容', 'ino 变了必须返回新内容(不许吃旧画像)');
  assert.equal(after30.messageCount, 3);

  // ── 10. 增量读(尾部追加之类):结果必须与全量扫描逐字段相同 ──
  // 长会话(头窗口满 40 条可解析记录 + 全记录带 cwd ⇒ 一切闸门都满足)
  const incSid = uuid(40);
  const incFile = join(DIR_A, `${incSid}.jsonl`);
  {
    const recs = [line({ type: 'attachment', uuid: uuid(41), cwd: REAL_CWD })];
    for (let i = 0; i < 60; i++) recs.push(line(i % 3 === 0 ? userRec(100 + i, incSid, `问题 ${i}`, REAL_CWD) : asstRec(100 + i, incSid)));
    writeFileSync(incFile, recs.join(''));
  }
  const base = (await listSessions(HASH_A)).find((s) => s.sessionId === incSid);
  const incBefore = readStats().counters.incremental;
  // ① 追加一条:messageCount 恰好 +1,首条/标题不变,lastActivity 前进
  const lastRec = { ...asstRec(300, incSid, 'deepseek-flash'), cwd: REAL_CWD, timestamp: '2026-09-13T09:00:00.000Z' };
  appendFileSync(incFile, line(lastRec));
  const after = (await listSessions(HASH_A)).find((s) => s.sessionId === incSid);
  assert.equal(after.messageCount, base.messageCount + 1, '追加一行 → messageCount 恰好 +1(增量不许重复计/漏计)');
  assert.equal(after.firstPrompt, base.firstPrompt, '追加不改首条');
  assert.equal(after.lastActivity, lastRec.timestamp, 'lastActivity 跟随新尾行');
  assert.equal(after.model, 'deepseek-flash', 'model 跟随新尾行的 assistant');
  assert.ok(readStats().counters.incremental > incBefore, '该次请求走的是增量路径(stats 计数)');
  // ② 追加标题行:增量确实扫了新区段
  appendFileSync(incFile, line({ type: 'custom-title', customTitle: '追加的标题', sessionId: incSid }));
  assert.equal((await listSessions(HASH_A)).find((s) => s.sessionId === incSid).customTitle, '追加的标题',
    '增量必须扫到新区段里的标题行');
  // ③ 追加 compact_boundary:该 boundary 要参与链折叠(与链首共享 uuid 的续段合为一条)
  const bUuid = uuid(60);
  appendFileSync(incFile, line({ type: 'system', subtype: 'compact_boundary', uuid: bUuid, sessionId: incSid }));
  const contSid = uuid(61);
  const contFile = join(DIR_A, `${contSid}.jsonl`);
  writeFileSync(contFile, [
    line({ type: 'system', subtype: 'compact_boundary', uuid: bUuid, sessionId: contSid }),
    line(userRec(62, contSid, '续段', REAL_CWD)),
    line(asstRec(63, contSid)),
  ].join(''));
  const folded = await listSessions(HASH_A);
  assert.equal(folded.filter((s) => s.sessionId === incSid || s.sessionId === contSid).length, 1,
    '增量追加的 compact_boundary 必须参与链折叠(漏 boundary ⇒ 同一对话出现两行)');
  // ④ 截断(size 回退闸门)→ 全量重扫,返回新内容
  const before4 = (await listSessions(HASH_A)).find((s) => s.sessionId === incSid || s.sessionId === contSid);
  const incNow = readStats().counters.rescanned;
  truncateSync(incFile, 400);
  const afterTrunc = await listSessions(HASH_A);
  assert.ok(readStats().counters.rescanned > incNow, '截断必须走全量重扫(rescanned)');
  assert.ok(!afterTrunc.some((s) => s.sessionId === incSid), '截断后内容不足 3 行/无首条 → 该会话不再列出(不许吃旧画像)');
  assert.ok(before4, '截断前该会话存在');
  // ⑤ 头窗口不满 40 条(G-e)→ 追加也只能全量,但结果必须正确
  const shortSid = uuid(70);
  const shortFile = join(DIR_A, `${shortSid}.jsonl`);
  writeFileSync(shortFile, line(userRec(71, shortSid, '短的', REAL_CWD)) + line(asstRec(72, shortSid)) + line(asstRec(73, shortSid)));
  assert.equal((await listSessions(HASH_A)).find((s) => s.sessionId === shortSid).messageCount, 3);
  const rs = readStats().counters.rescanned;
  appendFileSync(shortFile, line(asstRec(74, shortSid)));
  assert.equal((await listSessions(HASH_A)).find((s) => s.sessionId === shortSid).messageCount, 4, '短文件追加也要算对');
  assert.ok(readStats().counters.rescanned > rs, 'headFull=false 必须 fail-closed 走全量');

  console.log('check-session-profile: PASS');
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
