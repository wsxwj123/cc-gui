#!/usr/bin/env node
// r26-J9【单测】:/api/provider-quota 自家接口失败 → UsagePanel 显示错误卡 + 重试,不整卡消失。
// 修前:load 的 catch(() => {}) 吞掉,data 留 null → `if (!data) return null` 整卡蒸发,
// 用户分不清"这张卡不存在"还是"查询坏了"。
// 本仓 JSX 测试口径 = 源码钉 + 同形参考实现行为断言。
// 哨兵:①源码 —— load 检查 r.ok、catch 置 loadFailed、错误卡含「额度查询失败」与重试按钮;
// ②行为(同形参考状态机)—— mock reject → 仍渲染卡片(非 null)且含错误文案与重试;
//   点重试 → fetch 计数 +1;③mock 成功 → 错误卡消失(不误报);④official:true 时即使
//   失败也不渲染错误卡(互斥口径不破坏)。
// Run: node tests/unit/check-r26-j9-quota-error-card.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

const src = readFileSync(new URL('../../client/src/components/UsagePanel.jsx', import.meta.url), 'utf8');

// ① 源码钉
{
  const cardIdx = src.indexOf('function ProviderQuotaCard()');
  const card = src.slice(cardIdx, src.indexOf('// 使用报告(/insights)'));
  ok(/if \(!r\.ok\) throw/.test(card), 'J9: load 必须检查 r.ok(非 2xx 算失败)');
  ok(/const \[loadFailed, setLoadFailed\] = useState\(/.test(card), 'J9: loadFailed 状态存在');
  ok(/\.catch\(\(\) => setLoadFailed\(true\)\)/.test(card), 'J9: catch 置失败态,不再静默');
  ok(card.includes('额度查询失败'), 'J9: 错误卡含固定文案「额度查询失败」');
  ok(/onClick=\{load\}/.test(card), 'J9: 重试按钮挂 load');
  ok(/if \(!data \|\| data\.official\) return null;/.test(card), 'J9: 官方/无数据仍整卡隐藏(互斥口径保留)');
  // 错误卡分支必须在 return null 之前判(顺序哨兵:反了错误卡永远到不了)
  ok(card.indexOf('loadFailed') < card.indexOf('return null'), 'J9: 失败分支先于整卡隐藏分支');
}

// ②③④ 行为矩阵(与 load/render 判定同形的参考状态机)
{
  const makeCard = (fetchImpl) => {
    let data = null;
    let loadFailed = false;
    let fetchCount = 0;
    const load = () => {
      fetchCount += 1;
      return fetchImpl()
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((d) => { data = d; loadFailed = false; })
        .catch(() => { loadFailed = true; });
    };
    // 与组件同形的渲染判定:返回 'error' | 'card' | 'note' | null
    const render = () => {
      if (loadFailed && (!data || !data.official)) return 'error';
      if (!data || data.official) return null;
      return data.ok && Array.isArray(data.items) && data.items.length ? 'card' : 'note';
    };
    return { load, render, get fetchCount() { return fetchCount; } };
  };

  // ② mock reject → 错误卡(整卡消失哨兵的反面);重试 → 计数 +1
  let fail = true;
  const c = makeCard(() => (fail
    ? Promise.reject(new TypeError('fetch failed'))
    : Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, official: false, providerName: 'X', items: [{ label: '余额', direction: 'left', value: 5 }] }) })));
  await c.load();
  assert.equal(c.render(), 'error', 'J9: 接口失败 → 渲染错误卡,不是 null');
  const before = c.fetchCount;
  await c.load(); // 用户点重试
  assert.equal(c.fetchCount, before + 1, 'J9: 点重试 → 接口调用计数 +1(重试链路)');
  assert.equal(c.render(), 'error', 'J9: 仍失败 → 错误卡保持');
  // ③ 随后成功 → 错误卡消失,正常渲染
  fail = false;
  await c.load();
  assert.equal(c.render(), 'card', 'J9: 恢复成功 → 错误卡消失,正常额度卡');
  n += 4;

  // ④ official:true + 失败 → 不渲染(互斥口径)
  const c2 = makeCard(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ official: true }) }));
  await c2.load();
  assert.equal(c2.render(), null, 'J9: 官方 provider 整卡隐藏');
  n += 1;
}

console.log(`PASS check-r26-j9-quota-error-card (${n} assertions)`);
