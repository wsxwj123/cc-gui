// r151l 历史消息分页 —— 接口验收。依据 .devflow/r151l-history-pagination-接口.md 行为 1–4、6。
// A1–A5 在未修复代码上应因结果断言而红(分页字段缺失 / limit 未生效 / 非法参数未拒绝);
// A6 是"不传 limit 的全量旧行为"回归,修复前应绿。
// 每个用例一个一次性实例(自己的临时 HOME、自挑端口、自己 stop),大历史直接写 jsonl 构造。
import { test, expect } from '@playwright/test';
import { startInstance } from './helpers/instance.mjs';
import { seedHistory, uniq } from './helpers/fixtures.mjs';
import { getHistory, historyFacts, messageTexts, usageFor } from './helpers/history.mjs';

test.describe.configure({ timeout: 180_000 });

/** 起一次性实例 + 落一份历史,跑完一定停实例。 */
async function withSeededHistory(tag, opts, fn) {
  const inst = await startInstance(`r151l-${tag}-${uniq('')}`);
  try {
    const S = seedHistory(`${tag}-${uniq('')}`, { home: inst.home, ...opts });
    return await fn(inst, S);
  } finally {
    await inst.stop();
  }
}

test('A1 行为1 构造 300 条历史:不带 limit 的全量应答 300 条、hasMore=false、beforeCursor=0、total=300', async () => {
  await withSeededHistory('a1', { count: 300 }, async (inst, S) => {
    const r = await getHistory(inst.base, S.sid, S.projectHash);
    expect(r.status, `全量请求应 200(应答原文:${r.text.slice(0, 300)})`).toBe(200);
    expect(historyFacts(r), `全量应答(原文:${r.text.slice(0, 500)})`).toEqual({
      status: 200,
      count: 300,
      first: S.firstText,
      last: S.lastText,
      hasMore: false,
      beforeCursor: 0,
      total: 300,
    });
  });
});

test('A2 行为1 limit=120:返回最后 120 条(180..299)、hasMore=true、beforeCursor=180、total=300', async () => {
  await withSeededHistory('a2', { count: 300 }, async (inst, S) => {
    const r = await getHistory(inst.base, S.sid, S.projectHash, { limit: 120 });
    expect(r.status, `limit=120 应 200(应答原文:${r.text.slice(0, 300)})`).toBe(200);
    expect(historyFacts(r), `limit=120 应答(原文:${r.text.slice(0, 500)})`).toEqual({
      status: 200,
      count: 120,
      first: S.texts[180],
      last: S.texts[299],
      hasMore: true,
      beforeCursor: 180,
      total: 300,
    });
  });
});

test('A3 行为1 游标翻页:limit=120&before=180 → 60..179(hasMore=true,beforeCursor=60);再 limit=120&before=60 → 0..59(hasMore=false,beforeCursor=0)', async () => {
  await withSeededHistory('a3', { count: 300 }, async (inst, S) => {
    const p1 = await getHistory(inst.base, S.sid, S.projectHash, { limit: 120, before: 180 });
    expect(historyFacts(p1), `第一页应答(原文:${p1.text.slice(0, 500)})`).toEqual({
      status: 200,
      count: 120,
      first: S.texts[60],
      last: S.texts[179],
      hasMore: true,
      beforeCursor: 60,
      total: 300,
    });
    const p2 = await getHistory(inst.base, S.sid, S.projectHash, { limit: 120, before: 60 });
    expect(historyFacts(p2), `第二页应答(原文:${p2.text.slice(0, 500)})`).toEqual({
      status: 200,
      count: 60,
      first: S.texts[0],
      last: S.texts[59],
      hasMore: false,
      beforeCursor: 0,
      total: 300,
    });
  });
});

test('A4 行为2 同一会话带 limit 与不带 limit 的 usageTotals 逐值相等(字段必须存在;分页必须真的生效)', async () => {
  await withSeededHistory('a4', { count: 300 }, async (inst, S) => {
    const full = await getHistory(inst.base, S.sid, S.projectHash);
    const limited = await getHistory(inst.base, S.sid, S.projectHash, { limit: 120 });
    expect(full.status, `全量请求应 200(原文:${full.text.slice(0, 300)})`).toBe(200);
    expect(limited.status, `limit=120 应 200(原文:${limited.text.slice(0, 300)})`).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(full.body || {}, 'usageTotals'), `全量应答必须带 usageTotals(原文:${full.text.slice(0, 300)})`).toBe(true);
    expect(limited.body?.usageTotals, `分页应答的 usageTotals 必须与全量逐值相同(全量:${JSON.stringify(full.body?.usageTotals)};分页:${JSON.stringify(limited.body?.usageTotals)})`)
      .toEqual(full.body?.usageTotals);
    // 先确认这是"分页应答"再谈用量口径,否则 limit 被忽略时这条用例会假绿。
    expect({
      count: messageTexts(limited.body).length,
      hasMore: limited.body?.hasMore,
      beforeCursor: limited.body?.beforeCursor,
      total: limited.body?.total,
    }, `limit=120 的分页形状(原文:${limited.text.slice(0, 500)})`).toEqual({
      count: 120,
      hasMore: true,
      beforeCursor: 180,
      total: 300,
    });
  });
});

test('A5 行为4 非法 limit(0/-1/1.5/3000/abc)与 before(-1/2.5/abc)→ 400 + HISTORY_INVALID_INPUT,且不返回消息', async () => {
  await withSeededHistory('a5', { count: 300 }, async (inst, S) => {
    const cases = [
      ['limit=0', { limit: 0 }],
      ['limit=-1', { limit: -1 }],
      ['limit=1.5', { limit: 1.5 }],
      ['limit=3000', { limit: 3000 }],
      ['limit=abc', { limit: 'abc' }],
      ['before=-1', { before: -1 }],
      ['before=2.5', { before: 2.5 }],
      ['before=abc', { before: 'abc' }],
    ];
    const got = [];
    const raws = [];
    for (const [name, params] of cases) {
      const r = await getHistory(inst.base, S.sid, S.projectHash, params);
      raws.push(`${name} → HTTP ${r.status} ${r.text.slice(0, 220)}`);
      got.push({
        name,
        status: r.status,
        code: r.body?.code ?? null,
        messageCount: Array.isArray(r.body?.messages) ? r.body.messages.length : 0,
      });
    }
    expect(got, `非法参数应答(原文):\n${raws.join('\n')}`).toEqual(cases.map(([name]) => ({
      name,
      status: 400,
      code: 'HISTORY_INVALID_INPUT',
      messageCount: 0,
    })));
  });
});

test('A6 (旧行为)行为3 不传 limit:除新增三字段外,messages 长度/首尾/usageTotals 与全量逻辑一致', async () => {
  await withSeededHistory('a6', { count: 300 }, async (inst, S) => {
    const r = await getHistory(inst.base, S.sid, S.projectHash);
    expect(r.status, `全量请求应 200(原文:${r.text.slice(0, 300)})`).toBe(200);
    const texts = messageTexts(r.body);
    expect({
      count: texts.length,
      first: texts[0] ?? null,
      last: texts[texts.length - 1] ?? null,
      usageTotals: r.body?.usageTotals,
    }, `全量应答(原文:${r.text.slice(0, 500)})`).toEqual({
      count: 300,
      first: S.firstText,
      last: S.lastText,
      usageTotals: usageFor(300),
    });
    // owner/view 语义不变(接口文件 §1/§3)。
    expect(r.body?.owner?.sessionId, 'owner.sessionId 应是请求的会话').toBe(S.sid);
    expect(r.body?.view?.kind, '普通会话的 view.kind 应是 session').toBe('session');
  });
});
