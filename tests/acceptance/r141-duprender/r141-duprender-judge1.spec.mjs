// r141 判据①(uuid 精确对账)覆盖 —— 方案 §3.0 判别式① / §5.4 末条 / §7 岔路 1。
// 只由 run.sh 调起:tests/acceptance/r141-duprender/run.sh r141-duprender-judge1.spec.mjs
//
// ── 为什么单独一条 spec ────────────────────────────────────────────────────────
// 主 spec(r141-duprender-invariants.spec.mjs)的红**只靠判据②③**:那条副本由 **seeded
// reattach** 推出,而方案 A4b 在 reattach 起流时复位 `roundUuidsRef`,种回流的 uuid 收集
// 不完整(N4)⇒ 判据① 在那条时序里**必然失效**。所以"判据① 有没有覆盖"必须另立一条
// **普通回合(非 reattach)** + 显式对齐 uuid 的用例。
//
// ── P-2 实测结论(真 CLI claude 2.1.286,2026-10-02 00:0x;原始报文见 TEST-PLAN §4.9)──
//   判据① **可用**:同一条 `message.id=msg_ne9y6rrq8ka` 的流侧 assistant 事件 uuid 与
//   盘侧 jsonl 记录 uuid 逐字相同(`3e737fd8-1489-41da-84f1-c5700445a980`)。
//   附:`stream_event` 包装层 6 条事件带 6 个**互不相同**的 uuid ⇒ A4e 只在 `message_start`
//   收集(方案默认)是对的,不要逐 delta 收。
//
// ── 两条用例 ────────────────────────────────────────────────────────────────
//   P2 [探针,恒跑] **判据① 的输入**:(a) uuid 真的到得了客户端(不是只写在假 CLI 日志里,
//      用页内 fetch tee 解析 SSE);(b) `sameuuid` 开 ⇒ 流侧事件 uuid == jsonl 记录 uuid;
//      (c) `sameuuid` 关(默认夹具形态)⇒ 两侧不同。三条都是**输入断言**,与产品行为无关
//      ⇒ 修前修后都必须绿(它守的是"判据① 有数据可判")。
//   J1 [判据①-exclusive] 构造"只有 ① 能解释隐藏"的场景:**普通回合** + `sameuuid`(①有数据)
//      + `trimhist`(历史那份更短 ⇒ **判据③ 覆盖下限必然不成立**、**判据② 指纹必然不等**),
//      时序用与主 spec 同一套"孪生落后"(hold + M2 抢 token)。
//      当前 A3/A4 未落地(`App.jsx` 里没有 `srcUuids`)⇒ 判据① 无数据来源,**不硬凑断言**:
//      本用例恒跑时序 + 恒断言前置(I1/I2 在场、②③ 已排除),**行为断言按 A3/A4 是否落地
//      自动收紧**(落地后:恰好 1 条且非本地),修前把实测条数记进报文与 dump。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import path0 from 'node:path';
import { NAV, R141D, DUP_MARK, DUP_PROMPT_MARK, LONG_MARK, LONG_PROMPT_MARK, QUIET_MARK,
  dup, dupLong, countTranscriptLines, encodeProjectDir, fixtureCwd, readTranscript, WORKTREE } from './helpers/fixtures.mjs';
import {
  boot, clearPhase, clearR141Ctl, clearSlowStart, clearSlowStartFor, dumpSseProbe, holdTranscript, holdUserTranscript,
  localCopyCount, openSessionBySearch, phaseOf, readStreamLog, releaseAllRuns, releaseChunk2, releaseLand, releaseTurnEnd,
  runPid, sameUuid, sendPrompt, sessionRow, startSseProbe, switchTo, trimHist, turnNodes, waitForPhase,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;
const DUMP_DIR = path.join(process.env.R118_DATA_ROOT || '.', 'logs');
const dump = (name, obj) => {
  try { fs.mkdirSync(DUMP_DIR, { recursive: true }); fs.writeFileSync(path.join(DUMP_DIR, `${name}.json`), JSON.stringify(obj, null, 2)); } catch { /* 忽略 */ }
};
/** A3/A4 是否已落地(判据① 有没有数据来源)。按源码特征判,不按版本号。 */
const hasJudge1Data = () => {
  try { return fs.readFileSync(path.join(WORKTREE, 'client', 'src', 'App.jsx'), 'utf8').includes('srcUuids'); } catch { return false; }
};
const strip = (s) => String(s || '').replace(/\s+/g, '');

/**
 * 判据口径必须钉在实现上(裁判实测的教训):手搓"历史正文"极易与客户端**实际比较的那个 turn**
 * 不同口径 —— 夹具里本轮 assistant 记录会与**预置旧回复并进同一个 turn**(user 记录被 hold-user
 * 闸住 ⇒ 没有回合边界),于是"③ 不成立"是假的、用例自称 ①-exclusive 名不副实。
 * 这里改用【服务端自己的解析器】+【产品自己的谓词】在同一次运行里实算,口径不可能漂。
 */
async function loadProduct() {
  const prevHome = process.env.HOME;
  // session-reader 的 projects 根在**模块加载时**读 HOME ⇒ 必须先改再 import。
  process.env.HOME = path0.join(process.env.R118_DATA_ROOT || '', 'home');
  let parser = null; let ti = null;
  try {
    try { parser = await import('../../../server/services/session-reader.js'); } catch { /* 老树 */ }
    try { ti = await import('../../../client/src/utils/turnIdentity.js'); } catch { /* r141 修法未落地 */ }
  } finally { process.env.HOME = prevHome; }
  return { parser, ti };
}
/** 夹具会话被服务端解析出来的消息列表(与 app 调 /api/sessions/:sid/messages 同源)。 */
async function parseFixtureHistory(parser, sid) {
  const prevHome = process.env.HOME;
  process.env.HOME = path0.join(process.env.R118_DATA_ROOT || '', 'home');
  try {
    const res = await parser.getSessionMessages(sid, encodeProjectDir(fixtureCwd()));
    return res?.messages || [];
  } finally { process.env.HOME = prevHome; }
}

test.beforeEach(async ({ page }) => {
  await startSseProbe(page, 'p2');   // 必须在 goto 之前
  await boot(page);
  await openSessionBySearch(page, NAV.mark);
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  clearSlowStart(CTL);
  for (const { sid } of R141D) { clearSlowStartFor(CTL, sid); clearR141Ctl(CTL, sid); }
  releaseAllRuns(CTL);
});

/**
 * 一轮"普通回合":发 → 一次性放行三段 → 等这一轮的 assistant 记录真落盘(不做抢 token/切会话)。
 * **为什么要用"落盘"当完成信号、而不是 `<sid>.phase`**:实测踩到过 phase 停在 chunk1 的假卡
 * (P-2 首版 40s 超时;同一个 sid 的控制文件由 app 的多个辅助 CLI 调用共用,相位/闸门只在
 * 交互式回合里才有意义)。落盘信号是端到端事实,不受相位文件串扰影响。
 */
const countFinalRecords = (sid) => readTranscript(sid).filter((l) => l.type === 'assistant'
  && JSON.stringify(l.message || {}).includes('DUPFINAL')).length;
/**
 * 一轮"普通回合":发 → **等本轮专属相位 `chunk1`** → 一次性放行三段 → 等第三块落盘。
 *
 * 两个坑都是实测踩出来的(别再踩回去):
 *  ① **不能拿"屏上有 c1"当"本轮已起"**:同一会话第二轮的 c1 与第一轮逐字相同(夹具正文只依赖 sid),
 *     于是等待立刻返回 ⇒ 在回合**启动前**就把 `.chunk/.done` 写好了;而 `round()` 启动时会
 *     `unlink` 这三个文件 ⇒ 回合永远等不到放行 ⇒ 卡死到超时。相位文件是**本轮专属**信号,
 *     发送前先 `clearPhase` 抹掉上一轮的,`phase==='chunk1'` 就一定是本轮写的。
 *  ② **不能拿"存在 DUPFINAL 记录"当"本轮完成"**:上一轮的记录已经在盘上 ⇒ 提前返回只拿到半轮。
 *     必须用**计数增长**。
 */
async function plainTurn(page, sid, prompt) {
  const before = countFinalRecords(sid);
  clearPhase(CTL, sid);
  await sendPrompt(page, prompt);
  await expect.poll(() => phaseOf(CTL, sid), { timeout: 30_000, intervals: [100] }).toBe('chunk1');
  releaseChunk2(CTL, sid);
  releaseTurnEnd(CTL, sid);
  await expect.poll(() => countFinalRecords(sid), { timeout: 60_000, intervals: [200] }).toBeGreaterThan(before);
  await page.waitForTimeout(4_000);
}

test('R141-P2 [探针] 判据① 的输入:uuid 到得了客户端,且 sameuuid 开/关两侧对得上/对不上', async ({ page }) => {
  const base = Number(process.env.R141D_BASE || 0);
  const S = R141D[base + 4];
  const sid = S.sid;
  const ev = [];
  try {
    clearR141Ctl(CTL, sid);
    await switchTo(page, S.mark);

    // ── 对照 B(默认形态):两侧各一个随机 uuid ⇒ 判据① 不成立 ──────────────
    await plainTurn(page, sid, `${DUP_PROMPT_MARK} p2b 第1轮:两侧 uuid 默认不同。`);
    const probeB = await dumpSseProbe(page);
    const logAllB = readStreamLog(CTL, sid);
    const jsonAllB = readTranscript(sid).filter((l) => l.type === 'assistant');
    const uuidsB = new Set(jsonAllB.map((l) => l.uuid));
    // 对照 B 的判据落在【假 CLI 日志 vs 盘侧】(确定性,不依赖页内探针抓全):
    expect(logAllB.length, `P2[对照 B]:假 CLI 应当记下本轮 3 条流侧记录,实际 ${logAllB.length}`).toBe(3);
    const sameB = logAllB.filter((e) => e.uuid === e.fileUuid);
    ev.push({ arm: 'B(默认,各有各的 uuid)', probeSeen: probeB.seen, sse: (probeB.sse || []).length, streamLog: logAllB.length, jsonlRecords: jsonAllB.length, logAligned: sameB.length });
    expect(sameB.length, `P2[对照 B]:默认夹具两侧应【不同】uuid,却有 ${sameB.length} 条对齐(${JSON.stringify(sameB)})`).toBe(0);
    // 页内探针在对照 B 只作旁证:抓到就顺带断言"没命中任何 jsonl uuid"(抓不到不算失败 ——
    // 该轮是页面首个 /api/chat,tee 的克隆流可能被 app 的收尾 abort 提前掐断,实测只拿到 1/3;
    // 判据① 的"到得了客户端"由对照 A 的 3/3 负责证明)。
    const sseB = (probeB.sse || []).filter((e) => (e.text || '').includes(dup.chunk1(sid)));
    const hitB = sseB.filter((e) => uuidsB.has(e.uuid));
    expect(hitB.length, `P2[对照 B]:页内探针抓到的 ${sseB.length} 条里,不该有命中 jsonl uuid 的(${JSON.stringify(hitB)})`).toBe(0);

    // ── 对照 A(sameuuid):两侧同一个 uuid ⇒ 判据① 成立 ─────────────────────
    sameUuid(CTL, sid);
    const logLenBefore = readStreamLog(CTL, sid).length;      // 用长度差隔离"本轮新增",别用 slice(-N)
    const sseLenBefore = (probeB.sse || []).length;
    await plainTurn(page, sid, `${DUP_PROMPT_MARK} p2a 第2轮:两侧 uuid 故意对齐。`);
    const probeA = await dumpSseProbe(page);
    const sseA = (probeA.sse || []).slice(sseLenBefore);       // 本轮的 assistant 事件
    const logA = readStreamLog(CTL, sid).slice(logLenBefore);  // 本轮的 3 条流侧记录(chunk1/2/3)
    const uuidsA = new Set(readTranscript(sid).filter((l) => l.type === 'assistant').map((l) => l.uuid));
    const hitA = sseA.filter((e) => uuidsA.has(e.uuid));
    ev.push({ arm: 'A(sameuuid,两侧对齐)', sse: sseA.length, streamLog: logA.length, matched: hitA.length });
    dump('r141-p2-probe', { sid, ev, sseB, sseA, logB: logAllB.map((x) => x.uuid), logA: logA.map((x) => x.uuid), uuidsB: [...uuidsB], uuidsA: [...uuidsA] });
    expect(logA.length, `P2[对照 A]:这一轮应当有 3 条流侧记录(chunk1/2/3),实际 ${logA.length};log=${JSON.stringify(logA)}`).toBe(3);
    expect(sseA.length, `P2[对照 A]:页内探针应当看到本轮 3 条 assistant 事件,实际 ${sseA.length}。ev=${JSON.stringify(ev)}`).toBe(3);
    expect(hitA.length, `P2[对照 A]:sameuuid 打开后流侧 uuid 应逐条命中 jsonl 记录 uuid;命中 ${hitA.length}/${sseA.length}。`
      + `流侧=${JSON.stringify(sseA.map((e) => e.uuid))} 盘侧=${JSON.stringify([...uuidsA])} ev=${JSON.stringify(ev)}`).toBe(sseA.length);
    expect(logA.every((e) => e.uuid === e.fileUuid),
      `P2[对照 A]:假 CLI 流侧日志里 uuid 应等于 fileUuid(log=${JSON.stringify(logA)})`).toBe(true);
  } finally {
    releaseChunk2(CTL, sid); releaseTurnEnd(CTL, sid); releaseLand(CTL, sid); clearR141Ctl(CTL, sid);
  }
});

test('R141-J1 [判据①-exclusive] 长正文 + sameuuid + 历史更短 ⇒ 只有 uuid 能认出副本', async ({ page }) => {
  const base = Number(process.env.R141D_BASE || 0);
  const S = R141D[base + 5];
  const sid = S.sid;
  const prompt = `${LONG_PROMPT_MARK} j1 第1轮:只有 uuid 能认出这条副本。`;
  const quietPrompt = `${QUIET_MARK} j1 抢 token 用的空回合。`;
  const { parser, ti } = await loadProduct();
  try {
    clearR141Ctl(CTL, sid);
    await switchTo(page, S.mark);
    await page.waitForTimeout(700);

    // ── 为什么这条用例走【C1 那条时序】(切走→切回→种回流),而不是普通回合 ──────────────
    // ① 要"有数据",历史孪生就必须**自成一回合**(turn.uuid = 本轮第一条 assistant 记录的
    // uuid)。而 user 记录若被 hold 住,本轮记录会**并进夹具预置的那条 turn** —— 实测:那条
    // turn 的 uuid 是预置记录的 `${sid}-a1`,与本轮流侧 uuid 永远没有交集 ⇒ 判据① **永远无
    // 数据**,用例就只是"自称 ①-exclusive"(裁判 M2b 抓到的正是这一层)。
    // 让 user 记录**即时落盘**(= C2 的"不同闸")才有回合边界;而本 spec 的 I3 由"切走暂存 →
    // 切回对账撤除本地 user 气泡"这条路径保证(观察点 A/B0/B1 会逐拍记下来)。
    // 种回流不重置 roundUuidsRef(实现是 A4b′:`if (!reattachPid)` 复位)⇒ ① 在种回路径上
    // 依然有数据 —— 这条用例顺带把 A4b′ 这个选择也钉住了。
    holdTranscript(CTL, sid);        // 孪生落后:assistant 记录推迟到 .land
    sameUuid(CTL, sid);              // ① 有数据(两侧同一 uuid);不开就是对照组
    trimHist(CTL, sid);              // 历史只写 60% ⇒ ③ 的长度下限必不成立、② 必不等

    // ① 起流(普通回合)
    await sendPrompt(page, prompt);
    await expect.poll(() => runPid(CTL, sid), { timeout: 25_000, intervals: [100] }).not.toBeNull();
    await expect(page.getByText(dupLong.chunk1(sid), { exact: false }).first(), 'J1:①段直播气泡应吐出第一块').toBeVisible({ timeout: 30_000 });

    // ② 切走(abort ⇒ 写 r68 快照)→ 等 user 记录即时落盘 → 切回(⇒ poll 命中 ⇒ seeded reattach)
    await switchTo(page, NAV.mark);
    await page.waitForTimeout(1_400);
    expect(countTranscriptLines(sid, 'user', prompt), 'J1:user 记录应已即时落盘(不同闸)—— 有它才有回合边界').toBe(1);
    await switchTo(page, S.mark);
    await expect(page.getByText(dupLong.chunk1(sid), { exact: false }).first(), 'J1:②段切回后应起 seeded reattach(种回第一块)').toBeVisible({ timeout: 30_000 });

    // ③ 一次性放行三段 → 收尾推本地定稿副本 C → 立刻发空回合 M2 抢 turn token
    releaseChunk2(CTL, sid);
    releaseTurnEnd(CTL, sid);
    await expect.poll(() => localCopyCount(page), { timeout: 20_000, intervals: [40] }).toBeGreaterThan(0);
    await sendPrompt(page, quietPrompt);
    await waitForPhase(CTL, sid, 'quiet', 20_000);
    // ④ 放行 assistant 记录(历史那份是【更短】的版本)→ M2 空回合收尾拉历史 ⇒ 孪生进 store
    releaseLand(CTL, sid);
    await waitForPhase(CTL, sid, 'quiet-done', 20_000);
    await page.waitForTimeout(4_000);

    const nodes = await turnNodes(page);
    const copies = nodes.filter((n) => n.text.includes(LONG_MARK));
    const nJson = countTranscriptLines(sid, 'assistant', LONG_MARK);
    const localCopyNum = await localCopyCount(page);

    // ── 行为断言:同一条回复只能画一遍,且活下来的必须是历史那条 ─────────────────────
    expect(copies.length, `J1[判据① 生效]:同一条回复只能画一遍。实际 ${copies.length} 条 ${JSON.stringify(copies)}`
      + `(② 不命中 / ③ 长度下限不成立 ⇒ 只有 ① 能解释)`).toBe(1);
    expect(copies[0].local, 'J1[判据① 生效]:活下来的应当是历史那条(修法只藏派生的本地副本)').toBe(false);
    expect(localCopyNum, 'J1[判据① 生效]:本地定稿副本必须已被判据① 藏掉').toBe(0);

    // ── 前置:全部用【服务端解析器的真实历史】+【产品自己的谓词】实算(不许手搓口径)──────
    const messages = parser ? await parseFixtureHistory(parser, sid) : [];
    const streamUuids = readStreamLog(CTL, sid).map((e) => e.uuid).filter(Boolean);
    const nowMs = Date.now();
    const localEntry = {
      type: 'turn', uuid: 'chat-assistant-<local>', timestamp: new Date(nowMs).toISOString(),
      text: [dupLong.full(sid)], blocks: dupLong.blocks(sid),
      srcUuids: streamUuids, roundStartTs: nowMs - 300_000,   // 保守:窗口更宽 ⇒ 判"③ 不成立"更强
    };
    const idx = ti ? ti.makeTurnIdentityIndex(messages) : null;
    const fpLocal = ti ? ti.turnFingerprint(localEntry) : strip(dupLong.full(sid));
    const histTurns = messages.filter((m) => m.type === 'turn');
    const histFps = histTurns.map((m) => (ti ? ti.turnFingerprint(m) : strip(String(m.text || ''))));
    const maxHistFp = Math.max(0, ...histFps.map((f) => f.length));
    const j2Hit = !!idx && idx.fingerprints.has(fpLocal);
    const turnUuids = new Set(histTurns.map((m) => String(m.uuid)));
    const uuidHits = streamUuids.filter((u) => turnUuids.has(u));
    const j3Candidates = idx ? idx.turns.filter((t) => t.ts >= localEntry.roundStartTs && t.ts <= nowMs + 2000) : [];
    const j3Hit = j3Candidates.some((t) => t.len >= fpLocal.length);
    const implSays = ti ? ti.localTurnTakenOver(localEntry, idx) : null;
    dump('r141-j1', { sid, hasProductTI: !!ti, nodes, nJson, copies, localCopyNum, streamUuids,
      localFp: fpLocal.length, histFps, maxHistFp, j2Hit, uuidHits: uuidHits.length, j3Hit,
      j3Candidates: j3Candidates.length, implSays,
      histTurns: histTurns.map((m) => ({ uuid: m.uuid, ts: m.timestamp, fp: (ti ? ti.turnFingerprint(m) : '').length })) });
    expect(histTurns.length, `J1:前置——服务端解析出的历史里必须有 turn(实际 ${histTurns.length})`).toBeGreaterThan(0);
    // ③ 的**长度下限**:历史最长指纹 < 本地指纹 ⇒ 无论时间窗怎么取,③ 都不可能命中
    expect(maxHistFp, `J1:前置——判据③ 的覆盖下限必须不成立:历史最长指纹 ${maxHistFp} 字 < 本地 ${fpLocal.length} 字`
      + `(histFps=${JSON.stringify(histFps)};histTurns=${JSON.stringify(histTurns.map((m) => m.uuid))})`).toBeLessThan(fpLocal.length);
    expect(j3Hit, `J1:前置——判据③ 不得命中(窗口内候选 ${j3Candidates.length} 个)`).toBe(false);
    expect(j2Hit, `J1:前置——判据② 不得命中(本地指纹 ${fpLocal.length} 字)`).toBe(false);
    expect(uuidHits.length, `J1:前置——判据① 必须有数据:流侧 uuid ${JSON.stringify(streamUuids)} 与历史 turn uuid `
      + `${JSON.stringify([...turnUuids])} 无交集。histTurns=${JSON.stringify(histTurns.map((m) => m.uuid))}`).toBeGreaterThan(0);
    if (ti) {
      expect(implSays, 'J1:前置——修法的 localTurnTakenOver 对这条本地副本必须判 true(①②③ 里只有 ① 有数据)').toBe(true);
    }
    expect(nJson, 'J1:jsonl 里这一轮的 assistant 记录数应当 = 1(第一块那条)').toBe(1);

  } finally {
    releaseChunk2(CTL, sid); releaseTurnEnd(CTL, sid); releaseLand(CTL, sid); clearR141Ctl(CTL, sid);
  }
});
