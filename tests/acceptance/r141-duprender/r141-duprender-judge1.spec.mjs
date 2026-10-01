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
import { NAV, R141D, DUP_MARK, DUP_PROMPT_MARK, QUIET_MARK, dup, countTranscriptLines, readTranscript, WORKTREE } from './helpers/fixtures.mjs';
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

test('R141-J1 [判据①-exclusive] 普通回合 + sameuuid + 历史更短 ⇒ 只有 uuid 能认出副本', async ({ page }) => {
  const base = Number(process.env.R141D_BASE || 0);
  const S = R141D[base + 5];
  const sid = S.sid;
  const prompt = `${DUP_PROMPT_MARK} j1 第1轮:只有 uuid 能认出这条副本。`;
  const quietPrompt = `${QUIET_MARK} j1 抢 token 用的空回合。`;
  const localFull = dup.full(sid);          // 本地副本的正文(三块 \n 拼)
  try {
    clearR141Ctl(CTL, sid);
    await switchTo(page, S.mark);
    // 判据① 有数据(sameuuid)+ 判据② 必不相等(历史正文被改短)+ 判据③ 必不成立(历史更短)
    sameUuid(CTL, sid);
    trimHist(CTL, sid);
    holdTranscript(CTL, sid);        // 孪生落后:assistant 记录推迟到 .land
    holdUserTranscript(CTL, sid);    // I3:user 记录不落盘 ⇒ 不会触发 :4182 整清(假绿)

    // ① 起流(普通回合,非 reattach ⇒ A4 的 uuid 收集是完整的)
    clearPhase(CTL, sid);
    await sendPrompt(page, prompt);
    await expect.poll(() => phaseOf(CTL, sid), { timeout: 30_000, intervals: [100] }).toBe('chunk1');
    releaseChunk2(CTL, sid);
    releaseTurnEnd(CTL, sid);
    // ② 等本地定稿副本 C 出现,立刻发空回合 M2 抢 turn token(:7098 break ⇒ C 不被自己的收尾清掉)
    await expect.poll(() => localCopyCount(page), { timeout: 20_000, intervals: [40] }).toBeGreaterThan(0);
    const snapC = await turnNodes(page);
    await sendPrompt(page, quietPrompt);
    await waitForPhase(CTL, sid, 'quiet', 20_000);
    // ③ 放行 assistant 记录(历史那份是【更短】的版本)→ M2 空回合收尾会拉历史 ⇒ 孪生进 store
    releaseLand(CTL, sid);
    await waitForPhase(CTL, sid, 'quiet-done', 20_000);
    await page.waitForTimeout(4_000);

    const nodes = await turnNodes(page);
    const copies = nodes.filter((n) => n.text.includes(DUP_MARK));
    const nJson = countTranscriptLines(sid, 'assistant', DUP_MARK);
    const histRecords = readTranscript(sid).filter((l) => l.type === 'assistant' && (l.message?.content || []).some((b) => (b.text || '').includes(DUP_MARK)));
    const histText = histRecords.map((l) => (l.message?.content || []).map((b) => b.text || '').join('')).join('');
    const judge2Equal = strip(histText) === strip(localFull);
    const judge3Ok = strip(histText).length >= strip(localFull).length;
    const hasFix = hasJudge1Data();
    dump('r141-j1', { sid, hasFix, nodes, snapC, nJson, histText, localFull, judge2Equal, judge3Ok, copies });

    // ── 恒断言:前置(与产品行为无关,修前修后都必须成立)────────────────────
    expect(copies.length, `J1:前置——副本与孪生必须同屏在场(I1+I2)。copies=${JSON.stringify(copies)}`).toBeGreaterThan(0);
    expect(judge2Equal, `J1:前置——判据② 必须【不】命中(历史正文被改短),否则本用例证明不了①。`
      + `hist=${JSON.stringify(histText)} local=${JSON.stringify(localFull)}`).toBe(false);
    expect(judge3Ok, `J1:前置——判据③ 的覆盖下限必须不成立(历史那份更短),否则可能是③ 命中。`
      + `len(hist)=${strip(histText).length} len(local)=${strip(localFull).length}`).toBe(false);
    expect(nJson, `J1:jsonl 里这一轮的 assistant 记录数应当 = 1(第一块那条)`).toBe(1);

    // ── 行为断言:按 A3/A4 是否落地自动收紧 ────────────────────────────────
    if (hasFix) {
      expect(copies.length, `J1[判据① 生效]:同一条回复只能画一遍。实际 ${copies.length} 条 ${JSON.stringify(copies)}`).toBe(1);
      expect(copies[0].local, 'J1[判据① 生效]:活下来的应当是历史那条(修法只藏派生的本地副本)').toBe(false);
      expect(await localCopyCount(page), 'J1[判据① 生效]:本地定稿副本必须已被判据① 藏掉').toBe(0);
    } else {
      // 判据① 无数据来源(A3/A4 未落地)⇒ 不硬凑断言,只如实记录修前实测条数
      console.log(`[r141-j1] A3/A4 未落地:判据① 无数据。修前实测 ${copies.length} 条`
        + `(本地 ${copies.filter((c) => c.local).length} / 历史 ${copies.filter((c) => !c.local).length});`
        + `② 不命中=${!judge2Equal} ③ 不成立=${!judge3Ok} ⇒ 落修后本用例自动收紧为"恰好 1 条"`);
    }
  } finally {
    releaseChunk2(CTL, sid); releaseTurnEnd(CTL, sid); releaseLand(CTL, sid); clearR141Ctl(CTL, sid);
  }
});
