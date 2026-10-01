// r141 渲染去重验收 —— **不变量版**(黑盒)。方案契约:.devflow/PLAN-r141-duprender.md §5.1 / §5.2。
// 只由 run.sh 调起:tests/acceptance/r141-duprender/run.sh r141-duprender-invariants.spec.mjs
//
// ── 为什么另起一条 spec(与 r141-duprender.spec.mjs 的关系)─────────────────────────
// 那条 spec 是"数气泡"的黑盒版:它把**任何** chat-* 本地条目都当红。实测(见 TEST-PLAN)
// 它在 `away` 时序上确实红,但红的是 `chat-stopped-*`(切走 abort 时推的半截回复),
// 而本轮修法只给 `App.jsx:6793` 那条【定稿副本】盖身份(srcUuids / roundStartTs)——
// 修不了半截回复那条,属于另一个成因。所以本 spec 把断言收紧到方案 §5.2 的原文口径:
// **"一条 `chat-assistant-*` + 一条真 uuid + 两者正文相同"**,并把它建立在三条不变量上:
//
//   I1  本地定稿副本 C(= chat-assistant-<ms>)在 chatMessages 里且可见;
//   I2  孪生 turn T 在【已渲染历史】(finalizedMessages)里;
//   I3  从 T 落进 store 起到断言为止,chatMessages 里**没有已落盘的 user 条目**
//       (否则 :4146/:4180 取到它、known.has 命中 ⇒ :4151/:4182 整清 ⇒ C 被删 ⇒ 假绿)。
//
// ── 造场景的四段(§5.1)+ 两个夹具开关 ─────────────────────────────────────────────
//   ① 起流:会话 S 里正常发一句,CLI 出第一块后被 <sid>.chunk 憋住(进程非 idle);
//   ② 造"pid 有→无"那一拍 + 拿 C:切走(abort,写 r68 直播快照)→ 切回 S(进程还在跑、
//      本端没起流 ⇒ poll 命中 ⇒ backgroundPid ⇒ 自动 reattach;**有快照 = 种回形态**)⇒
//      放行 .chunk/.done ⇒ 收尾推 C(seeded ⇒ `:6793` 会推);
//   ③ 抢 token:紧接着发 M2 —— 此刻 streamingRef 已 false 而 finalize 轮询还在飞,
//      所以 M2 **不入队**、直接 `++streamTurnTokenRef` ⇒ 老 finally 在 `:7098` break,
//      C 不会被自己的收尾清掉(§5.1 ③);
//   ④ 让 T 进 store:放行 <sid>.land 写 assistant 记录 ⇒ M2 是**空回合**,
//      它的 finalize 走 `!producedReply` 分支(:7114-7129:保留全部 turn 类本地条目 + 拉历史)
//      ⇒ T 进 store、C 留在 chatMessages ⇒ 同屏两条同正文的气泡 = **红**。
//
// ── 三条夹具约束的落地与显式表态(§5.0)─────────────────────────────────────────
//   C1  `writeTranscript()` 绝不 await:helpers/fake-claude.mjs 的 gatedAppend 同步入队,
//       放行靠独立 setInterval;SSE 侧(say 的 out)完全不受闸门影响 —— 不然 result 发不出、
//       服务端不发 done,`:6793` 的副本压根不推,①段自灭。
//   C2  **user 记录是否同受闸门 —— 本 spec 显式选择"不同闸"**(user 即时写盘,assistant
//       受 <sid>.hold/<sid>.land 闸门)。理由:方案默认(同闸)下,切回时 `:4194` 的用户气泡
//       暂存会把这轮的本地 user 气泡**补回** chatMessages(因为历史里还没有那条 user),
//       而 T 一落盘 `known.has(lastUser)` 就命中 ⇒ `:4182` 整清 ⇒ C 被删 = 假绿,I3 破。
//       "不同闸"复刻的是真机更常见的那半窗(CLI 已把用户消息写进 jsonl、回复还没写完),
//       并且切回时暂存对账会因 `known.has` 命中而**撤掉**本地 user 气泡 ⇒ chatMessages 里
//       没有 user 条目 ⇒ I3 天然成立。另一个开关 <sid>.hold-user 留在夹具里,给需要"同闸"
//       形态的用例用。
//   C3  记录 timestamp 按【消息产生时刻】戳:被闸住的记录在产生那一刻就构造好(base() 已
//       含 timestamp),放行时原样写盘 —— 夹具不按写盘时刻重戳。
//
// ── 阴性对照(§5.3 第 2 条)──────────────────────────────────────────────────────
//   在 ④ 之前(T 尚未落盘)先断言一次:此刻屏上**必须有**那条本地定稿副本,且**只有一条**
//   —— 证明闸门不是"见到本地副本就藏"(R68/R37 空窗形态)。这是序列内的阴性对照,不另开用例。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { NAV, R141D, DUP_MARK, DUP_PROMPT_MARK, QUIET_MARK, dup, countTranscriptLines } from './helpers/fixtures.mjs';
import {
  boot, clearR141Ctl, clearSlowStart, clearSlowStartFor, copiesOf, holdTranscript, localCopyCount,
  openSessionBySearch, releaseAllRuns, releaseChunk2, releaseLand, releaseTurnEnd, runPid,
  sendPrompt, sessionRow, switchTo, turnNodes, userCopiesOf, waitForPhase,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;
const DUMP_DIR = path.join(process.env.R118_DATA_ROOT || '.', 'logs');
const dump = (name, obj) => {
  try { fs.mkdirSync(DUMP_DIR, { recursive: true }); fs.writeFileSync(path.join(DUMP_DIR, `${name}.json`), JSON.stringify(obj, null, 2)); } catch { /* 忽略 */ }
};

/** 观察点:逐拍记录 DOM 上的可见条目(方案 §5.1 的 A–D)。 */
async function snap(page, sid, at, extra = {}) {
  const nodes = await turnNodes(page);
  const rec = {
    at, t: Date.now(),
    nodes,
    localTurns: nodes.filter((n) => /^chat-assistant-/.test(String(n.uuid || ''))),
    localUsers: nodes.filter((n) => /^chat-user-/.test(String(n.uuid || ''))),
    stops: await page.getByRole('button', { name: /^停止/ }).count(),
    jsonlAssistantC1: countTranscriptLines(sid, 'assistant', DUP_MARK),
    jsonlMentionsC1: countTranscriptLines(sid, null, DUP_MARK),
    ...extra,
  };
  return rec;
}

/** 三段放行:chunk2 → done(收尾)。 */
async function releaseRest(ctl, sid) {
  releaseChunk2(ctl, sid);
  await waitForPhase(ctl, sid, 'chunk2', 40_000);
  releaseTurnEnd(ctl, sid);
}

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openSessionBySearch(page, NAV.mark);
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  clearSlowStart(CTL);
  for (const { sid } of R141D) { clearSlowStartFor(CTL, sid); clearR141Ctl(CTL, sid); }
  releaseAllRuns(CTL);
});

/** 一条完整的不变量时序。返回 {ok, obs, error} —— 不抛,让 3 条各自跑完(要 3/3 的证据)。 */
async function invariantRun(page, S, tag) {
  const sid = S.sid;
  const obs = [];
  const prompt = `${DUP_PROMPT_MARK} ${tag} 第1轮:这条回复只该被画一遍。`;
  const quietPrompt = `${QUIET_MARK} ${tag} 抢 token 用的空回合。`;
  const c1 = dup.chunk1(sid);
  try {
    clearR141Ctl(CTL, sid);
    await switchTo(page, S.mark);
    await page.waitForTimeout(700);

    // 闸门:assistant 记录推迟到 <sid>.land(user 记录不同闸 —— C2 显式表态)
    holdTranscript(CTL, sid);
    expect(countTranscriptLines(sid, 'assistant', DUP_MARK), `${tag}:前置——本轮还没有 assistant 记录`).toBe(0);

    // ① 起流(正常发送)
    await sendPrompt(page, prompt);
    await expect.poll(() => runPid(CTL, sid), { timeout: 25_000, intervals: [100] }).not.toBeNull();
    await expect(page.getByText(c1, { exact: false }).first(), `${tag}:①段直播气泡应吐出第一块`).toBeVisible({ timeout: 30_000 });
    obs.push(await snap(page, sid, 'A:起流(直播中,已憋在第一块)'));

    // ② 造那一拍:切走(abort,写快照)→ 等 → 切回(进程非 idle + 本端无流 ⇒ poll 命中 ⇒ seeded reattach)
    await switchTo(page, NAV.mark);
    await page.waitForTimeout(1_400);
    obs.push(await snap(page, sid, 'B0:切走后(直播气泡已清,C 还不存在)'));
    expect(countTranscriptLines(sid, 'user', prompt), `${tag}:user 记录应已即时落盘(C2=不同闸)`).toBe(1);

    await switchTo(page, S.mark);
    // 历史里没有 c1(被闸住)⇒ c1 只可能来自"种回流"的直播气泡
    await expect(page.getByText(c1, { exact: false }).first(), `${tag}:②段切回后应起 seeded reattach(种回第一块)`).toBeVisible({ timeout: 30_000 });
    obs.push(await snap(page, sid, 'B1:切回后 reattach 已种回'));

    // ③ 放行收尾 → 推本地定稿副本 C
    await releaseRest(CTL, sid);
    await expect.poll(() => localCopyCount(page), { timeout: 20_000, intervals: [40] }).toBeGreaterThan(0);
    const snapC = await snap(page, sid, 'C:副本 C 已推(孪生 T 还没落盘)');
    obs.push(snapC);

    // ── 阴性对照(§5.3):T 还没落盘 ⇒ C 必须在屏上且只有一条(不许"见到本地副本就藏")──
    const cCopies = snapC.nodes.filter((n) => n.text.includes(DUP_MARK));
    expect(cCopies.length, `${tag}:阴性对照——T 尚未落盘时,本地副本必须可见且只有一条。DOM=${JSON.stringify(cCopies)}`).toBe(1);
    expect(cCopies[0].local, `${tag}:阴性对照——此刻唯一那条应当就是本地定稿副本(chat-assistant-*)`).toBe(true);

    // ③ 抢 token:此刻 streamingRef 已 false、finalize 轮询在飞 ⇒ 这条不会被入队,直接换 generation
    await sendPrompt(page, quietPrompt);
    await expect.poll(() => runPid(CTL, sid), { timeout: 15_000, intervals: [100] }).not.toBeNull();
    await waitForPhase(CTL, sid, 'quiet', 20_000);   // M2 已进空回合分支,正等 .land
    obs.push(await snap(page, sid, 'C2:M2 已起(抢 token 完成),等放行落盘'));

    // ④ 让 T 落盘 → M2 空回合收尾会拉历史 ⇒ T 进 store
    releaseLand(CTL, sid);
    await waitForPhase(CTL, sid, 'quiet-done', 20_000);
    await page.waitForTimeout(4_000);              // 等空回合 finalize 的 fetch 提交 + React 提交
    const snapD = await snap(page, sid, 'D:断言点');
    obs.push(snapD);

    const nJson = countTranscriptLines(sid, 'assistant', DUP_MARK);
    const copies = snapD.nodes.filter((n) => n.text.includes(DUP_MARK));
    const nUi = copies.length;
    const local = copies.filter((c) => c.local);
    const real = copies.filter((c) => !c.local);
    const verdict = nJson <= 1 && nUi > 1
      ? `①纯渲染重复:jsonl 里只有 ${nJson} 条同正文 assistant 记录,界面画了 ${nUi} 条`
      : (nUi <= 1 ? `绿:界面 ${nUi} 条 / jsonl ${nJson} 条` : `②jsonl ${nJson} 条 ⇒ 数据重复(另一个 bug)`);
    dump(`r141-inv-${tag}`, { sid, prompt, obs });
    return {
      ok: nUi === 1 && nJson === 1,
      verdict, nUi, nJson, local, real, obs,
      msg: `${tag}:界面画了 ${nUi} 遍(应恰好 1 遍)。${verdict}。`
        + `本地副本 ${local.length} 个(${JSON.stringify(local.map((c) => c.uuid))})、真 uuid ${real.length} 个`
        + `。DOM ${JSON.stringify(copies)}`,
    };
  } catch (error) {
    dump(`r141-inv-${tag}-fail`, { sid, obs, error: String(error && error.message) });
    return { ok: false, verdict: `异常:${String(error && error.message).split('\n')[0]}`, msg: `${tag}:时序没走通 —— ${String(error && error.message).split('\n').slice(0, 3).join(' | ')}`, obs };
  } finally {
    releaseChunk2(CTL, sid); releaseTurnEnd(CTL, sid); releaseLand(CTL, sid);
    clearR141Ctl(CTL, sid);
  }
}

test('R141-I [I1+I2+I3] 孪生落后于本地定稿副本 ⇒ 同一条回复只能画一遍(3/3)', async ({ page }) => {
  // R141D_BASE:同一条夹具池反复跑(改时序时省一次 run.sh 冷启)时把用的会话往后挪,
  // 免得撞上"上一轮跑过的会话被改过标题"。默认 0 = 用 R141D[0..2]。
  const base = Number(process.env.R141D_BASE || 0);
  const cases = [
    { tag: `dup${base + 1}`, S: R141D[base + 0] },
    { tag: `dup${base + 2}`, S: R141D[base + 1] },
    { tag: `dup${base + 3}`, S: R141D[base + 2] },
  ];
  const results = [];
  for (const c of cases) {
    await expect(sessionRow(page, c.S.mark), `侧栏里应能看到会话 ${c.S.mark}`).toBeVisible({ timeout: 20_000 });
    const r = await invariantRun(page, c.S, c.tag);
    results.push(r);
    // 每轮都留下观察点(成功也留):失败时断言消息里直接带出来
    console.log(`[r141-inv] ${c.tag} → ${r.ok ? 'PASS' : 'FAIL'} :: ${r.verdict}`);
    for (const o of r.obs || []) {
      console.log(`[r141-inv]   ${o.at} | 本地副本 ${o.localTurns.length} | 本地user ${o.localUsers.length} | 截图条目 ${o.nodes.length} | jsonl(c1) ${o.jsonlAssistantC1}`);
    }
  }
  const bad = results.filter((r) => !r.ok);
  expect(bad.map((r) => r.msg), `R141-I:${results.length} 条时序里红 ${bad.length} 条 —— ${results.map((r) => `${r.verdict}`).join(' | ')}`).toEqual([]);
});

test('R141-I+ [阳性对照] 不压闸门、不抢 token 的普通回合 ⇒ 收尾整清,恰好一条', async ({ page }) => {
  const S = R141D[Number(process.env.R141D_BASE || 0) + 3];
  const sid = S.sid;
  const prompt = `${DUP_PROMPT_MARK} ctrl 第1轮:这条回复只该被画一遍。`;
  const c1 = dup.chunk1(sid);
  try {
    clearR141Ctl(CTL, sid);
    await switchTo(page, S.mark);
    await sendPrompt(page, prompt);
    await expect(page.getByText(c1, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await releaseRest(CTL, sid);
    // 不压闸门(assistant 记录即时落盘)+ 不抢 token ⇒ finalize 的 fallback(attempt>=9 ≈1.8s)整清本地副本
    await page.waitForTimeout(6_000);
    const nodes = await turnNodes(page);
    const copies = nodes.filter((n) => n.text.includes(DUP_MARK));
    const nJson = countTranscriptLines(sid, 'assistant', DUP_MARK);
    dump('r141-inv-positive', { sid, nodes, nJson });
    expect(copies.length, `阳性对照:普通回合必须恰好一条(证明断言不是恒真)。DOM ${JSON.stringify(copies)}`).toBe(1);
    expect(copies[0].local, '阳性对照:活下来的应当是历史那条,不是本地副本').toBe(false);
    expect(nJson, '阳性对照:jsonl 里这一轮的 assistant 记录应当是 1 条(第一块那条)').toBe(1);
  } finally {
    releaseChunk2(CTL, sid); releaseTurnEnd(CTL, sid); releaseLand(CTL, sid); clearR141Ctl(CTL, sid);
  }
});
