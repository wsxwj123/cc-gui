#!/usr/bin/env node
// r141 口径审计(离线,不起实例):给定夹具会话,用【服务端自己的解析器】+ **产品自己的谓词**
// (client/src/utils/turnIdentity.js)算一遍"本地定稿副本会不会被接管、被哪一条判据接管"。
//
// 为什么必须用它:验收用例里手搓的"历史正文"极易与客户端**实际比较的那个 turn** 不同口径
// (裁判实测:手搓口径 11 字 vs 客户端实际 114 字 —— 夹具预置的旧回复被并进了同一回合),
// 于是"判据③ 不成立"是假的、用例自称 ①-exclusive 就名不副实。这把工具把口径钉在实现上。
//
// 用法:
//   node helpers/turn-identity-audit.mjs --sid <sid> --root <夹具数据根(含 home/.claude)>
//        [--local-text "<正文>"]        # 缺省用 fixtures 的 dup 三块(与本套件用例同源)
//        [--blocks-json '<json>']       # 缺省 = 三块 text
//        [--src-uuids a,b,c]            # 缺省 = 空(① 无数据)
//        [--round-start <ms|ISO>] [--local-ts <ms|ISO>]
//        [--json]                       # 只输出机器可读的一行结果
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREE = path.resolve(SUITE, '..', '..', '..');
const argOf = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (n) => process.argv.includes(n);

const sid = argOf('--sid');
if (!sid) { console.error('需要 --sid <sessionId>'); process.exit(2); }
const root = argOf('--root') || path.join(SUITE, '.artifacts', 'manual-1');
const home = path.join(root, 'home');
// ⚠️ 必须在 import session-reader 之前改 HOME:它的 projects 根是**模块加载时**算出来的。
process.env.HOME = home;
const { dup } = await import(path.join(SUITE, 'helpers', 'fixtures.mjs'));
const { getSessionMessages } = await import(path.join(WORKTREE, 'server', 'services', 'session-reader.js'));
const { makeTurnIdentityIndex, localTurnTakenOver, turnFingerprint, blocksText, TAKEOVER_TS_EPS_MS } =
  await import(path.join(WORKTREE, 'client', 'src', 'utils', 'turnIdentity.js'));

// 夹具项目 hash:由 fixtures 的 workspace 路径编码得出(与 server 的 encodeProjectDir 同口径)
const ws = path.join(SUITE, '.artifacts', 'runtime-data', 'fixture-workspace');
const projectHash = fs.realpathSync(ws).replace(/[^A-Za-z0-9]/g, '-');
const res = await getSessionMessages(sid, projectHash);
if (res?.notFound) { console.error(`会话 ${sid} 未找到(projectHash=${projectHash}, HOME=${home})`); process.exit(3); }
const messages = res.messages || [];

const text = argOf('--local-text') || dup.full(sid);
const blocks = (() => {
  const raw = argOf('--blocks-json');
  if (raw) return JSON.parse(raw);
  return [dup.chunk1(sid), dup.chunk2(sid), dup.final(sid)].map((t) => ({ type: 'text', content: t }));
})();
const srcUuids = (argOf('--src-uuids') || '').split(',').map((s) => s.trim()).filter(Boolean);
const toMs = (v) => (v === undefined ? undefined : (Number.isFinite(Number(v)) ? Number(v) : Date.parse(v)));
// roundStartTs 缺省取"本地时间戳前 120s"的保守下界:窗口越宽 ③ 越容易命中 ⇒ 用它判"③ 不成立"更强
const localTs = toMs(argOf('--local-ts')) ?? Date.now();
const roundStart = toMs(argOf('--round-start')) ?? (localTs - 120_000);

const local = {
  type: 'turn', uuid: 'chat-assistant-audit', timestamp: new Date(localTs).toISOString(),
  text: [text], blocks, srcUuids, roundStartTs: roundStart,
};
const idx = makeTurnIdentityIndex(messages);
const fpLocal = turnFingerprint(local);

// ── 逐条判据的显式分解(与实现同口径:同一个 blocksText / 同一组比较) ──────────────
const j1 = (() => {
  const src = Array.isArray(local.srcUuids) ? local.srcUuids : null;
  if (!src || !src.length) return { hit: false, why: 'srcUuids 为空 —— ① 没有数据(死判据)' };
  const hitU = src.filter((u) => idx.turnUuids.has(String(u)));
  return { hit: hitU.length > 0, why: hitU.length ? `srcUuids ∩ 历史 uuid = ${hitU.length} 个` : 'srcUuids 与历史 uuid 无交集' };
})();
const j2 = fpLocal
  ? { hit: idx.fingerprints.has(fpLocal), why: `本地指纹 ${fpLocal.length} 字;历史指纹集里${idx.fingerprints.has(fpLocal) ? '有' : '没有'}同值` }
  : { hit: false, why: '本地指纹为空 ⇒ 实现直接 return false(② 也不成立,③ 更不会跑)' };
const j3 = (() => {
  const start = Number.isFinite(local.roundStartTs) ? local.roundStartTs : null;
  if (start === null || !Number.isFinite(localTs)) return { hit: false, why: 'roundStartTs / local.ts 缺失 ⇒ ③ 不参与' };
  const cand = idx.turns.filter((t) => t.ts >= start && t.ts <= localTs + TAKEOVER_TS_EPS_MS);
  const ok = cand.filter((t) => t.len >= fpLocal.length);
  return { hit: ok.length > 0, why: `窗口内候选 ${cand.length} 个,其中 len>=${fpLocal.length} 的 ${ok.length} 个` };
})();
const anyHit = localTurnTakenOver(local, idx);
const breakdown = j1.hit || j2.hit || j3.hit;
const out = {
  sid, projectHash, localFp: fpLocal.length, localTextLen: text.length,
  turns: messages.filter((m) => m.type === 'turn').map((m) => ({
    uuid: m.uuid, ts: m.timestamp, fp: turnFingerprint(m).length, head: blocksText(m).replace(/\s+/g, ' ').slice(0, 40),
  })),
  j1, j2, j3, anyHit, breakdownConsistent: anyHit === breakdown,
};
if (has('--json')) { console.log(JSON.stringify(out)); process.exit(0); }
console.log(`会话 ${sid}  projectHash=${projectHash}`);
console.log(`本地副本:正文 ${text.length} 字 / 指纹 ${fpLocal.length} 字 / srcUuids ${srcUuids.length} 个 / roundStartTs=${new Date(roundStart).toISOString()}`);
console.log('历史 turn:');
for (const t of out.turns) console.log(`  uuid=${t.uuid}  ts=${t.ts}  指纹=${t.fp} 字  「${t.head}…」`);
console.log(`判据① ${j1.hit ? '命中' : '不命中'} —— ${j1.why}`);
console.log(`判据② ${j2.hit ? '命中' : '不命中'} —— ${j2.why}`);
console.log(`判据③ ${j3.hit ? '命中' : '不命中'} —— ${j3.why}`);
console.log(`实现判定 localTurnTakenOver = ${anyHit}(与分解${out.breakdownConsistent ? '一致' : '**不一致**,工具口径已漂移,须修工具**'})`);
if (!out.breakdownConsistent) process.exit(4);
