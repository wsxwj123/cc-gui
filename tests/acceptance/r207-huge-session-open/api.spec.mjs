// r207 打开超大会话 —— 接口验收(黑盒)。唯一依据:.devflow/r207-huge-session-open-接口.md 的行为清单 1–5。
// 只通过 HTTP(GET /api/sessions/<id>/messages)、会话文件、后端进程的 CPU 时间(ps)判断;不 import 产品代码。
// 运行:bash tests/acceptance/r207-huge-session-open/run.sh --api-only(或整套 run.sh)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  startBackend, settleCpu, getHistory, minCpuOf, measuredHistory, firstDiff, withoutOwnerSessionId, subUsageMap, uuid,
} from './helpers/kit.mjs';
import {
  FixtureSet, newWorkspace, projectDir, writeHuge, writeAgentMain, writeSubagents, appendSubagentAssistant,
  buildK, buildKPrime, joinLines, buildQ,
} from './helpers/fixtures.mjs';

const LONG = { timeout: 1_200_000 };
const ok200 = (r, what) => assert.equal(r.status, 200, `${what} 应回 200,实际 ${r.status}:${String(r.text).slice(0, 200)}`);
const sameBody = (a, b, what) => assert.equal(firstDiff(withoutOwnerSessionId(a.body), withoutOwnerSessionId(b.body)), null, `${what}:两份返回应逐字段相同(只排除 owner.sessionId)`);

// ============================================================ 行为 1:元数据行不拖慢打开,返回不变 ============================================================
describe('行为1 元数据行不再拖慢打开', () => {
  let inst; let fx; let ws; let P; let M;
  before(async () => {
    inst = await startBackend('b1');
    fx = new FixtureSet();
    ws = newWorkspace(inst, 'huge');
    const contentSid = uuid();
    P = writeHuge(fx, inst, ws, { sid: uuid(), contentSid, turns: 1200, withMeta: false });
    M = writeHuge(fx, inst, ws, { sid: uuid(), contentSid, turns: 1200, withMeta: true });
    assert.ok(M.size - P.size >= 140e6, `夹具自检:M 应比 P 大至少 140MB,实际只大 ${((M.size - P.size) / 1e6).toFixed(1)}MB`);
    await settleCpu(inst);   // 夹具写完后等 CPU 稳定
  }, LONG);
  after(async () => { fx && fx.cleanup(); inst && await inst.stop(); }, LONG);

  it('T1a 带 120 条上限与不带上限:P、M 的返回逐字段相同', LONG, async () => {
    for (const opts of [{ limit: 120 }, {}]) {
      const label = opts.limit ? 'limit=120' : '不带 limit';
      const p = await getHistory(inst, P.sid, ws.projectHash, opts); ok200(p, `P(${label})`);
      const m = await getHistory(inst, M.sid, ws.projectHash, opts); ok200(m, `M(${label})`);
      sameBody(p, m, `行为1 ${label}`);
    }
  });

  it('T1b 打开 M(limit=120)的后端 CPU 时间(取三次最小)≤ 打开 P 的 1.2 倍 + 0.15 秒', LONG, async () => {
    const p = await minCpuOf(3, inst, P.sid, ws.projectHash, { limit: 120 });
    const m = await minCpuOf(3, inst, M.sid, ws.projectHash, { limit: 120 });
    const bound = p.min * 1.2 + 0.15;
    assert.ok(m.min <= bound, `打开 M 的 CPU 最小 ${m.min.toFixed(2)}s(三次 ${m.all.map((x) => x.toFixed(2)).join('/')})应 ≤ ${bound.toFixed(2)}s(P 最小 ${p.min.toFixed(2)}s × 1.2 + 0.15;P 三次 ${p.all.map((x) => x.toFixed(2)).join('/')})`);
  });
});

// ============================================================ 行为 2:子代理转写没变不重读 ============================================================
describe('行为2 子代理转写没变不重读,变了一个只重读一个', () => {
  let inst; let fx;
  before(async () => { inst = await startBackend('b2'); fx = new FixtureSet(); }, LONG);
  after(async () => { fx && fx.cleanup(); inst && await inst.stop(); }, LONG);

  it('T2 追加第 140 个转写后再打开:CPU ≤ 基准 1.3 倍 + 0.15 秒;该子代理用量 1200/600,其余 149 个仍 200/100', LONG, async () => {
    const ws = newWorkspace(inst, 'sub2');
    const sid = uuid();
    const { callIds } = writeAgentMain(fx, inst, ws, { sid, tag: 'S' });
    const { files } = writeSubagents(fx, inst, ws, { sid, callIds, tag: 'S' });
    assert.equal(callIds.length, 150); assert.equal(files.length, 150);
    await settleCpu(inst);
    const first = await measuredHistory(inst, sid, ws.projectHash); ok200(first, '第一次打开 S');
    const base = await measuredHistory(inst, sid, ws.projectHash); ok200(base, '第二次打开 S(基准)');
    const target = 139;   // 第 140 次调用(从 1 数)
    appendSubagentAssistant(files[target], { sid, msgId: 'msg_S_appended_140', input: 1000, output: 500 });
    const after1 = await measuredHistory(inst, sid, ws.projectHash); ok200(after1, '追加后打开 S');
    const usage = subUsageMap(after1.body);
    assert.equal(usage.size, 150, `返回里应有 150 个子代理用量,实际 ${usage.size}`);
    callIds.forEach((id, i) => {
      const u = usage.get(id);
      const want = i === target ? [1200, 600] : [200, 100];
      assert.deepEqual([u && u.input_tokens, u && u.output_tokens], want, `第 ${i + 1} 次调用(${id})的子代理用量应为 input ${want[0]} / output ${want[1]}`);
    });
    const bound = base.cpu * 1.3 + 0.15;
    assert.ok(after1.cpu <= bound, `追加后打开的 CPU ${after1.cpu.toFixed(2)}s 应 ≤ ${bound.toFixed(2)}s(基准 ${base.cpu.toFixed(2)}s × 1.3 + 0.15;第一次 ${first.cpu.toFixed(2)}s)`);
  });
});

// ============================================================ 行为 3:第一次打开带大量子代理的会话 ============================================================
describe('行为3 第一次打开带大量子代理的会话,只为用量多花很少', () => {
  let inst; let fx;
  before(async () => { inst = await startBackend('b3'); fx = new FixtureSet(); }, LONG);
  after(async () => { fx && fx.cleanup(); inst && await inst.stop(); }, LONG);

  it('T3 首次打开 S2(150 个转写)的 CPU ≤ 首次打开 S0(无转写)的 1.3 倍 + 0.25 秒;S2 的 150 个子代理用量都是 200/100', LONG, async () => {
    const ws = newWorkspace(inst, 'sub3');
    const s0 = uuid(); const s2 = uuid();
    writeAgentMain(fx, inst, ws, { sid: s0, tag: 'Z0' });                       // S0:没有 subagents 目录
    const main2 = writeAgentMain(fx, inst, ws, { sid: s2, tag: 'Z2' });          // S2:换一批 id + 150 个转写
    writeSubagents(fx, inst, ws, { sid: s2, callIds: main2.callIds, tag: 'Z2' });
    await settleCpu(inst);   // 两份都在后端启动预热之后才写,等 CPU 稳定;此后各自都是该后端第一次读
    const r0 = await measuredHistory(inst, s0, ws.projectHash); ok200(r0, '首次打开 S0');
    const r2 = await measuredHistory(inst, s2, ws.projectHash); ok200(r2, '首次打开 S2');
    const usage = subUsageMap(r2.body);
    assert.equal(usage.size, 150, `S2 返回里应有 150 个子代理用量,实际 ${usage.size}`);
    main2.callIds.forEach((id, i) => {
      const u = usage.get(id);
      assert.deepEqual([u && u.input_tokens, u && u.output_tokens], [200, 100], `S2 第 ${i + 1} 次调用(${id})的子代理用量应为 input 200 / output 100`);
    });
    const bound = r0.cpu * 1.3 + 0.25;
    assert.ok(r2.cpu <= bound, `首次打开 S2 的 CPU ${r2.cpu.toFixed(2)}s 应 ≤ ${bound.toFixed(2)}s(S0 ${r0.cpu.toFixed(2)}s × 1.3 + 0.25)`);
  });
});

// ============================================================ 行为 4、5:相邻回归(修复前后都应通过) ============================================================
describe('行为4/5 记录形态与分页不变', () => {
  let inst; let fx; let ws;
  before(async () => { inst = await startBackend('b45'); fx = new FixtureSet(); ws = newWorkspace(inst, 'small'); }, LONG);
  after(async () => { fx && fx.cleanup(); inst && await inst.stop(); }, LONG);

  it('T4 各种记录形态:K 与插了元数据行的 K′ 返回相同,且 K 里有 6 条用户提问、1 条压缩、1 条任务通知、1 条目标、1 条换模型', LONG, async () => {
    const contentSid = uuid(); const kSid = uuid(); const kpSid = uuid();
    const dir = projectDir(inst, ws.projectHash);
    const k = buildK(contentSid, ws.cwd);
    assert.ok(k[k.length - 1].eol === '' && k.some((x) => x.eol === '\r\n'), '夹具自检:最后一行无换行、中间有 \\r\\n');
    fx.mkdir(dir);
    fx.write(path.join(dir, `${kSid}.jsonl`), joinLines(k));
    fx.write(path.join(dir, `${kpSid}.jsonl`), joinLines(buildKPrime(k, contentSid)));
    for (const opts of [{ limit: 120 }, {}]) {
      const label = opts.limit ? 'limit=120' : '不带 limit';
      const a = await getHistory(inst, kSid, ws.projectHash, opts); ok200(a, `K(${label})`);
      const b = await getHistory(inst, kpSid, ws.projectHash, opts); ok200(b, `K′(${label})`);
      sameBody(a, b, `行为4 ${label}`);
    }
    const full = await getHistory(inst, kSid, ws.projectHash);
    const count = {};
    for (const m of full.body.messages) count[m.type] = (count[m.type] || 0) + 1;
    assert.equal(count.user, 6, `K 应有 6 条用户提问气泡(含并入消息),实际 ${count.user};各类型 ${JSON.stringify(count)}`);
    assert.equal(count.compact, 1, `K 应有 1 条压缩分隔,各类型 ${JSON.stringify(count)}`);
    assert.equal(count['task-notice'], 1, `K 应有 1 条任务通知,各类型 ${JSON.stringify(count)}`);
    assert.equal(count.goal, 1, `K 应有 1 条目标提示,各类型 ${JSON.stringify(count)}`);
    assert.equal(count['model-fallback'], 1, `K 应有 1 条换模型说明,各类型 ${JSON.stringify(count)}`);
    assert.ok(full.body.messages.some((m) => m.type === 'user' && m.text === '并入的消息'), '并入消息那条应作为用户提问显示');
  });

  it('T5 分页:300 条消息,limit=120 → 最后 120 条;before=180 → 第 60–179 条;不带 limit → 300 条', LONG, async () => {
    const sid = uuid();
    const dir = fx.mkdir(projectDir(inst, ws.projectHash));
    fx.write(path.join(dir, `${sid}.jsonl`), buildQ(sid, ws.cwd));
    const tag = (k) => `Q207-MSG-${String(k).padStart(3, '0')}-`;
    const checkRange = (r, from, to, what) => {
      assert.equal(r.body.messages.length, to - from, `${what}:应有 ${to - from} 条,实际 ${r.body.messages.length}`);
      r.body.messages.forEach((m, i) => assert.ok(JSON.stringify(m).includes(tag(from + i)), `${what}:第 ${i} 条应是消息 ${from + i}`));
    };
    const a = await getHistory(inst, sid, ws.projectHash, { limit: 120 }); ok200(a, 'limit=120');
    checkRange(a, 180, 300, 'limit=120');
    assert.equal(a.body.hasMore, true, 'limit=120 的 hasMore'); assert.equal(a.body.total, 300, 'limit=120 的 total'); assert.equal(a.body.beforeCursor, 180, 'limit=120 的 beforeCursor');
    const b = await getHistory(inst, sid, ws.projectHash, { limit: 120, before: 180 }); ok200(b, 'limit=120&before=180');
    checkRange(b, 60, 180, 'before=180');
    assert.equal(b.body.beforeCursor, 60, 'before=180 的 beforeCursor');
    const c = await getHistory(inst, sid, ws.projectHash); ok200(c, '不带 limit');
    checkRange(c, 0, 300, '不带 limit');
    assert.equal(c.body.hasMore, false, '不带 limit 的 hasMore'); assert.equal(c.body.total, 300, '不带 limit 的 total');
  });
});
