#!/usr/bin/env node
// r26-H4① 单测:PUT custom-providers 改 baseURL 的同源闸 —— quotaKey 随端点变更清除。
// 隔离 HOME(mkdtemp),回环 baseURL 过 SSRF 闸且永不真连。端口取 OS 临时口(listen(0),真实端口从 server.address() 读回)。
// 哨兵:①改 baseURL 未给新 quotaKey → 落盘 quotaKey 消失 + 响应 quotaKeyCleared:true;
// ②baseURL 不变 → quotaKey 保留且无标记;③改 baseURL 同时显式给新 quotaKey → 新值保留
// (用户同一次保存里显式重新配对,不算"旧 key 错配端点");④GET 永不回传明文(顺带钉)。
// ⑤quotaURL 换到第三方 host(既不是旧额度 host、也不是 baseURL host)且未给新 quotaKey
// → 同样清 + 打标(同一根因的**持久化**版本:留着 = 往后每次探测都把它发去那个 host);
// 地址不变 / 换到 baseURL 同 host / 显式重新配对 / 清空地址 → 一律不清。
// ⑥旧 quotaKey 仍在时改 baseURL 并同次显式给新 quotaKey → 存新值、不打标(③ 执行时旧 key 已被 ① 清掉,锁不住这一支)。
// ⑦旧 quotaKey 在时额度地址换到**旧额度地址同 host**、只改路径、未给新 key → 保留、不打标(⑤(b) 只测了 baseURL 同 host)。
// ⑧旧 quotaKey 在时清空额度地址、未给新 key → quotaKey 保留、不打标、四个地址类键一起删(密钥去留属合同空白,主会话裁定保留)。
// Run: node tests/unit/check-quota-key-origin-guard.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let n = 0;
let sec = ''; // 当前哨兵/分支编号,只用于逐条打印标签,不参与任何判据
const ok = (v, m) => { assert.ok(v, m); n += 1; console.log(`✅ ${sec}:${m}`); };

const home = await mkdtemp(join(tmpdir(), 'cgui-h4-'));
process.env.HOME = home; // 必须先于 import
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%,不同设沙箱失效

const express = (await import('express')).default;
const settingsRoutes = (await import('../../server/routes/settings.js')).default;

const FILE = join(home, '.claude-gui', 'custom-providers.json');
const disk = async () => JSON.parse(await readFile(FILE, 'utf8'));

const app = express();
app.use(express.json());
app.use('/api', settingsRoutes);
const server = await new Promise((res, rej) => {
  const s = app.listen(0, '127.0.0.1', () => res(s));
  s.once('error', rej);
});
const BASE = `http://127.0.0.1:${server.address().port}/api/custom-providers`;
const post = (body) => fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (id, body) => fetch(`${BASE}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let failure = null;
try {
  // 夹具:带 quotaKey 的 provider
  sec = '夹具(①~④ 共用)';
  const created = await (await post({
    name: 'h4-a', type: 'openai', baseURL: 'http://127.0.0.1:9',
    apiKey: 'sk-dummy-a', quotaKey: 'qk-dummy-a', models: ['m1'],
  })).json();
  ok(created.id, '夹具:创建带 quotaKey 的 provider');
  ok((await disk())[0].quotaKey === 'qk-dummy-a', '夹具:quotaKey 已落盘');

  // ② baseURL 不变 → quotaKey 保留、无标记(防误清哨兵)
  sec = '② baseURL 不变 → quotaKey 保留且无标记';
  const same = await (await put(created.id, {
    name: 'h4-a', type: 'openai', baseURL: 'http://127.0.0.1:9', models: ['m1'],
  })).json();
  ok(same.quotaKeyCleared !== true, 'baseURL 不变不得打 quotaKeyCleared 标记');
  ok((await disk())[0].quotaKey === 'qk-dummy-a', 'baseURL 不变 quotaKey 必须保留');

  // ① 改 baseURL 未给新 quotaKey → 清除 + 标记(同源闸哨兵)
  sec = '① 改 baseURL·未给新 quotaKey → 清除 + 打标';
  const changed = await (await put(created.id, {
    name: 'h4-a', type: 'openai', baseURL: 'http://127.0.0.1:10', models: ['m1'],
  })).json();
  ok(changed.quotaKeyCleared === true, '改 baseURL 必须打 quotaKeyCleared 标记(前端据此提示)');
  ok(!('quotaKey' in (await disk())[0]), '改 baseURL 后落盘 quotaKey 必须消失');

  // ③ 改 baseURL 同时显式给新 quotaKey → 新值保留(显式重新配对,不算错配)
  sec = '③ 改 baseURL·同次显式给新 quotaKey(重新配对) → 不清、新值保留';
  const repaired = await (await put(created.id, {
    name: 'h4-a', type: 'openai', baseURL: 'http://127.0.0.1:11', quotaKey: 'qk-dummy-new', models: ['m1'],
  })).json();
  ok(repaired.quotaKeyCleared !== true, '同次保存显式给新 quotaKey 不算"被清除"');
  ok((await disk())[0].quotaKey === 'qk-dummy-new', '显式给的新 quotaKey 落盘');

  // ④ GET 列表永不回传明文(既有口径顺带钉住:quotaKey 只能以 hasQuotaKey 布尔出现)
  sec = '④ GET 永不回传明文';
  const list = await (await fetch(BASE)).json();
  const row = (list.providers || list.items || list).find?.((p) => p.id === created.id) || null;
  ok(row && !('quotaKey' in row) && !('apiKey' in row), 'GET 列表绝不含明文 key');
  ok(row.hasQuotaKey === true, 'GET 以 hasQuotaKey 布尔表达');

  // ⑤ 同源闸②(持久化版本):quotaURL 换到**第三方 host** 且不给新 quotaKey → 清 + 打标。
  //    不挡的话存储密钥会被存到"往后每次探测都会发去"的新地址上(一次污染长期外发)。
  const qrow = async (id) => (await disk()).find((p) => p.id === id);
  sec = '夹具(⑤ 共用)';
  const q = await (await post({
    name: 'q-a', type: 'openai', baseURL: 'http://127.0.0.1:20', apiKey: 'sk-dummy-q',
    quotaKey: 'qk-dummy-q', quotaURL: 'http://127.0.0.1:21/bal', models: ['m1'],
  })).json();
  ok(q.id && (await qrow(q.id)).quotaKey === 'qk-dummy-q', '夹具:带 quotaURL + quotaKey 的 provider 已建');

  // (a) 额度地址一字不动 → 保留、无标记(防误清哨兵)
  sec = '⑤(a) 额度地址不变 → quotaKey 保留且无标记';
  const sameQ = await (await put(q.id, {
    name: 'q-a', type: 'openai', baseURL: 'http://127.0.0.1:20', models: ['m1'],
    quotaURL: 'http://127.0.0.1:21/bal',
  })).json();
  ok(sameQ.quotaKeyCleared !== true, '额度地址不变不得打 quotaKeyCleared 标记');
  ok((await qrow(q.id)).quotaKey === 'qk-dummy-q', '额度地址不变 quotaKey 必须保留');

  // (b) 换到 baseURL 同 host(换个 path)→ 不是跨源,保留(apiKey 本来就归那个 origin)
  sec = '⑤(b) 额度地址换到 baseURL 同 host → quotaKey 保留且无标记';
  const sameHostQ = await (await put(q.id, {
    name: 'q-a', type: 'openai', baseURL: 'http://127.0.0.1:20', models: ['m1'],
    quotaURL: 'http://127.0.0.1:20/balance',
  })).json();
  ok(sameHostQ.quotaKeyCleared !== true, '换到 baseURL 同 host 不得打标');
  ok((await qrow(q.id)).quotaKey === 'qk-dummy-q', '同 host 时 quotaKey 保留');

  // (c) 换到第三方 host 且不给新 quotaKey → 清 + 标记(本条的哨兵)
  sec = '⑤(c) 额度地址换到第三方 host·未给新 quotaKey → 清除 + 打标';
  const thirdQ = await (await put(q.id, {
    name: 'q-a', type: 'openai', baseURL: 'http://127.0.0.1:20', models: ['m1'],
    quotaURL: 'http://127.0.0.1:22/bal',
  })).json();
  ok(thirdQ.quotaKeyCleared === true, '额度地址换到第三方 host 必须打 quotaKeyCleared 标记');
  ok(!('quotaKey' in (await qrow(q.id))), '换到第三方 host 后落盘 quotaKey 必须消失');

  // (d) 同次保存显式给新 quotaKey = 用户重新配对 → 存新值、无标记
  sec = '⑤(d) 额度地址换到第三方 host·同次显式给新 quotaKey(重新配对) → 不清、新值保留';
  const repairedQ = await (await put(q.id, {
    name: 'q-a', type: 'openai', baseURL: 'http://127.0.0.1:20', models: ['m1'],
    quotaURL: 'http://127.0.0.1:23/bal', quotaKey: 'qk-dummy-q2',
  })).json();
  ok(repairedQ.quotaKeyCleared !== true, '同次保存显式给新 quotaKey 不算"被清除"');
  ok((await qrow(q.id)).quotaKey === 'qk-dummy-q2', '显式给的新 quotaKey 落盘');

  // (e) 清空额度地址(quotaURL:'')→ 四键全删,不误报"密钥被清除"(地址没了无从谈起)
  sec = '⑤(e) 清空额度地址 → 不打"已清除"标记';
  const cleared = await (await put(q.id, {
    name: 'q-a', type: 'openai', baseURL: 'http://127.0.0.1:20', models: ['m1'], quotaURL: '',
  })).json();
  ok(cleared.quotaKeyCleared !== true, '清空额度地址不得打"密钥已清除"标记');

  // (f) 旧条目根本没配过额度地址(有 quotaKey、旧 host = 空)→ 首次登记也按跨源处理:
  //     不清的话"先 PUT 一个攻击者地址、下一次探测就把密钥发过去"照样成立。
  sec = '夹具(⑤f)';
  const fresh = await (await post({
    name: 'q-b', type: 'openai', baseURL: 'http://127.0.0.1:30', apiKey: 'sk-dummy-f',
    quotaKey: 'qk-dummy-f', models: ['m1'],
  })).json();
  ok(!('quotaURL' in (await qrow(fresh.id))), '夹具:该 provider 没有额度地址');
  sec = '⑤(f) 首次登记额度地址到第三方 host·未给新 quotaKey → 清除 + 打标';
  const firstQ = await (await put(fresh.id, {
    name: 'q-b', type: 'openai', baseURL: 'http://127.0.0.1:30', models: ['m1'],
    quotaURL: 'http://127.0.0.1:31/bal',
  })).json();
  ok(firstQ.quotaKeyCleared === true, '首次把额度地址配到第三方 host 也要清(旧地址为空 = 无从判同源)');
  ok(!('quotaKey' in (await qrow(fresh.id))), '首次登记第三方 host 后落盘 quotaKey 消失');
  // (g) 反面对照:同一条路径,地址配在 baseURL 同 host → 保留
  sec = '⑤(g) 首次登记额度地址到 baseURL 同 host → quotaKey 保留且无标记';
  const fresh2 = await (await post({
    name: 'q-c', type: 'openai', baseURL: 'http://127.0.0.1:32', apiKey: 'sk-dummy-g',
    quotaKey: 'qk-dummy-g', models: ['m1'],
  })).json();
  const sameHostFirst = await (await put(fresh2.id, {
    name: 'q-c', type: 'openai', baseURL: 'http://127.0.0.1:32', models: ['m1'],
    quotaURL: 'http://127.0.0.1:32/bal',
  })).json();
  ok(sameHostFirst.quotaKeyCleared !== true, '首次登记但地址与 baseURL 同 host → 不清');
  ok((await qrow(fresh2.id)).quotaKey === 'qk-dummy-g', '同 host 首次登记保留 quotaKey');

  // (h) ③/⑤(d) 执行时旧 key 已被前一步清掉,只证明了"原本无 key 时新 key 能存"。这里自建
  //     "旧 key 确实在"的前置,锁住判据是"本次请求带没带新 key"而非"原来有没有旧 key"
  //     (判据若被改错,用户"换地址同时换密钥"会被误清 = 静默丢配置)。
  sec = '夹具(⑤h)';
  const hq = await (await post({
    name: 'q-h', type: 'openai', baseURL: 'http://127.0.0.1:40', apiKey: 'sk-dummy-h',
    quotaKey: 'qk-dummy-h-old', quotaURL: 'http://127.0.0.1:41/bal', models: ['m1'],
  })).json();
  const hqPre = hq.id ? await qrow(hq.id) : null;
  ok(hqPre?.quotaKey === 'qk-dummy-h-old' && hqPre.quotaURL === 'http://127.0.0.1:41/bal',
    '夹具:旧 quotaKey 与旧额度地址均已落盘(前置:旧密钥确实在)');
  sec = '⑤(h) 旧密钥在 + 额度地址换到第三方 host + 同次显式给新 quotaKey → 存新值、不打标';
  const hqSwap = await (await put(hq.id, {
    name: 'q-h', type: 'openai', baseURL: 'http://127.0.0.1:40', models: ['m1'],
    quotaURL: 'http://127.0.0.1:42/bal', quotaKey: 'qk-dummy-h-new',
  })).json();
  const hqAfter = await qrow(hq.id);
  ok(hqAfter?.quotaKey === 'qk-dummy-h-new', '落盘的是本次新给的 quotaKey(不是旧值、也没被清空)');
  ok(hqSwap.quotaKeyCleared !== true, '旧 key 在时同次显式给新 quotaKey 不得打 quotaKeyCleared 标记');
  ok(hqAfter?.quotaURL === 'http://127.0.0.1:42/bal', '额度地址确实换成了新的第三方地址');

  // ⑥ 主接口地址那道闸的同一支(与 ⑤(h) 对称):③ 执行时旧 key 已被 ① 清掉,只证明了"原本无 key
  //    时新 key 能存"。这里自建"旧 key 确实在"的前置,锁住判据是"本次请求带没带新 key"而非
  //    "原来有没有旧 key"(判据若被改错,用户"换主接口地址同时换密钥"会被误清 = 静默丢配置)。
  sec = '夹具(⑥)';
  const hb = await (await post({
    name: 'h4-b', type: 'openai', baseURL: 'http://127.0.0.1:50', apiKey: 'sk-dummy-b',
    quotaKey: 'qk-dummy-b-old', models: ['m1'],
  })).json();
  const hbPre = hb.id ? await qrow(hb.id) : null;
  ok(hbPre?.quotaKey === 'qk-dummy-b-old' && hbPre.baseURL === 'http://127.0.0.1:50',
    '夹具:旧 quotaKey 与旧主接口地址均已落盘(前置:旧密钥确实在)');
  sec = '⑥ 旧密钥在 + 换主接口地址 + 同次显式给新 quotaKey → 存新值、不打标';
  const hbSwap = await (await put(hb.id, {
    name: 'h4-b', type: 'openai', baseURL: 'http://127.0.0.1:51', models: ['m1'],
    quotaKey: 'qk-dummy-b-new',
  })).json();
  const hbAfter = await qrow(hb.id);
  ok(hbAfter?.quotaKey === 'qk-dummy-b-new', '落盘的是本次新给的 quotaKey(不是旧值、也没被清空)');
  ok(hbSwap.quotaKeyCleared !== true, '旧 key 在时同次显式给新 quotaKey 不得打 quotaKeyCleared 标记');
  ok(hbAfter?.baseURL === 'http://127.0.0.1:51', '主接口地址确实换成了新的');

  // ⑦ 额度地址那道闸的同源放行依据之一:新地址与**旧额度地址同 host**、只改 path → 仍同源,不许清。
  //    ⑤(b) 只覆盖了"换到 baseURL 同 host";这里 baseURL 刻意用另一个端口,排除"靠 baseURL 同源放行",
  //    锁住"与旧额度地址同 host"这条依据本身(判据若被改成"地址字符串变了就算换源" = 误清 = 静默丢配置)。
  sec = '夹具(⑦)';
  const sp = await (await post({
    name: 'q-p', type: 'openai', baseURL: 'http://127.0.0.1:60', apiKey: 'sk-dummy-p',
    quotaKey: 'qk-dummy-p-old', quotaURL: 'http://127.0.0.1:61/bal', models: ['m1'],
  })).json();
  const spPre = sp.id ? await qrow(sp.id) : null;
  ok(spPre?.quotaKey === 'qk-dummy-p-old' && spPre.quotaURL === 'http://127.0.0.1:61/bal',
    '夹具:旧 quotaKey 与旧额度地址均已落盘(前置:旧密钥确实在)');
  sec = '⑦ 旧密钥在 + 额度地址换到旧额度地址同 host·只改路径·未给新 quotaKey → 保留、不打标';
  const spMove = await (await put(sp.id, {
    name: 'q-p', type: 'openai', baseURL: 'http://127.0.0.1:60', models: ['m1'],
    quotaURL: 'http://127.0.0.1:61/api/user/balance',
  })).json();
  const spAfter = await qrow(sp.id);
  ok(spAfter?.quotaKey === 'qk-dummy-p-old', '落盘 quotaKey 保持原值(同 host 只改路径仍同源,不得误清)');
  ok(spMove.quotaKeyCleared !== true, '同 host 只改路径不得打 quotaKeyCleared 标记');
  ok(spAfter?.quotaURL === 'http://127.0.0.1:61/api/user/balance', '额度地址确实改成了新路径');

  // ⑧ 清空额度地址(quotaURL:'')时密钥的去留。合同原文只规定四个地址类键一起删除、没规定 quotaKey
  //    (合同空白),预期由主会话裁定为"保留":地址没了,密钥没被绑到任何新地址上,不构成外发;误清 =
  //    静默丢用户配置。⑤(e) 只断言了"不打标",没断言密钥还在不在;这里自建"旧 key + 四键齐全"的前置。
  sec = '夹具(⑧)';
  const cq = await (await post({
    name: 'q-e', type: 'openai', baseURL: 'http://127.0.0.1:70', apiKey: 'sk-dummy-e',
    quotaKey: 'qk-dummy-e-old', quotaURL: 'http://127.0.0.1:71/bal',
    quotaPath: 'data.balance', quotaAuth: 'raw', quotaCurrency: 'USD', models: ['m1'],
  })).json();
  const cqPre = cq.id ? await qrow(cq.id) : null;
  ok(cqPre?.quotaKey === 'qk-dummy-e-old', '夹具:旧 quotaKey 已落盘(前置:旧密钥确实在)');
  ok(cqPre?.quotaURL === 'http://127.0.0.1:71/bal' && cqPre.quotaPath === 'data.balance'
    && cqPre.quotaAuth === 'raw' && cqPre.quotaCurrency === 'USD',
  '夹具:四个地址类键(地址/路径/认证方式/币种)均已落盘(前置:否则"一起消失"会空过)');
  sec = '⑧ 旧密钥在 + 清空额度地址·未给新 quotaKey → 密钥保留、不打标、四个地址类键消失';
  const cqClear = await (await put(cq.id, {
    name: 'q-e', type: 'openai', baseURL: 'http://127.0.0.1:70', models: ['m1'], quotaURL: '',
  })).json();
  const cqAfter = await qrow(cq.id);
  ok(cqAfter?.quotaKey === 'qk-dummy-e-old', '落盘 quotaKey 保持原值(清空地址不得连带清除密钥)');
  ok(cqClear.quotaKeyCleared !== true, '清空额度地址不得打 quotaKeyCleared 标记');
  const left = ['quotaURL', 'quotaPath', 'quotaAuth', 'quotaCurrency'].filter((k) => !cqAfter || k in cqAfter);
  ok(left.length === 0, `四个地址类键从落盘条目一起消失(残留:${left.join('/') || '无'})`);
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}
if (failure) throw failure;
console.log(`PASS check-quota-key-origin-guard (${n} assertions)`);
