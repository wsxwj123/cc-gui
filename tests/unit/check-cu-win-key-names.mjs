#!/usr/bin/env node
// r142-附5 —— **工具描述里承诺过的键名,校验层必须认**(0.2.412 delta 审查 D-1 的回归)。
//
// 事故:Windows 的 `key` 描述与 docs 承诺"标着 Delete 的那个键用 `vk_delete` 或 `del`",helper 的
// VK_TABLE 也加了这两项 —— 但 mcp-server 的校验层 `WIN_VK` 没加 ⇒ `parseKeySpecWin` 走到
// `if (vk === undefined) return {ok:false}` ⇒ 模型照描述调用只会拿到 `CU_UNSUPPORTED_KEY`,
// helper 那两行是死代码。这是"声明 / 实现 / 守门"三者不一致的典型形态,所以本用例的判据是
// **从描述里抽键名,再要求 parseKeySpec 认** —— 以后再加键名时重犯同样会被抓住。
//
// 抽取规则(与描述的写法对齐,避免脆弱的全文匹配):
//   ① 斜杠枚举组:`a/b/c`(如 `return/enter`、`ctrl/control`);
//   ② `用 X 或 Y`(如 `用 vk_delete 或 del`);
//   ③ 丢掉通配写法留下的尾巴(如 `arrow_*` 会抽到 `arrow_`,以 `_` 结尾的直接忽略)。
// 判据:每个抽出来的名字,必须**要么**能独立当键(`parseKeySpec(name)` 通过、且给出数字 keycode/vk),
// **要么**能当修饰符(`name+a` 通过)—— 两者都不是就是这个键名承诺没有兑现。
//
// 口径说明(为什么这么写、语义没放宽):新增断言只覆盖"描述 ⇄ 校验层"的一致性,不改任何既有用例;
// mac 的描述是冻结基线(T5-02),这里只对它做同样的自检,不产生新的行为要求。
//
// 跑法:node tests/unit/check-cu-win-key-names.mjs
import assert from 'node:assert/strict';
import { makeReport } from './q8-helpers/report.mjs';

const report = makeReport('check-cu-win-key-names');
const mcp = await import('../../server/computer-use/mcp-server.js');

/** 从工具描述里抽出"承诺过的键名/修饰符名"。 */
function promisedNames(description) {
  const names = new Set();
  for (const g of String(description).matchAll(/([a-z_][a-z0-9_]*)(?:\/([a-z_][a-z0-9_]*))+/g)) {
    for (const part of g[0].split('/')) names.add(part);
  }
  for (const g of String(description).matchAll(/用\s*([a-z_][a-z0-9_]*)\s*或\s*([a-z_][a-z0-9_]*)/g)) {
    names.add(g[1]);
    names.add(g[2]);
  }
  // `arrow_*` 这种通配写法会抽到 `arrow_`,它不是键名
  return [...names].filter((n) => !n.endsWith('_'));
}

function keyReceipt(platformName) {
  const tool = mcp.buildTools(platformName).find((t) => t.name === 'key');
  return tool ? tool.description : '';
}

const WIN_NAMES = promisedNames(keyReceipt('win32'));
const MAC_NAMES = promisedNames(keyReceipt('darwin'));

/** 这个键名在本平台能不能用(独立成键,或作为修饰符)。 */
function usable(platformName, name) {
  const alone = mcp.parseKeySpec(name, platformName);
  if (alone.ok) return { ok: true, how: 'key', vk: alone.vk, keycode: alone.keycode };
  const asMod = mcp.parseKeySpec(`${name}+a`, platformName);
  if (asMod.ok) return { ok: true, how: 'modifier' };
  return { ok: false };
}

// ── KN-01 win32:描述承诺的每个键名都必须被 parseKeySpec 认(修前红:vk_delete/del)──
await report.check('KN-01', 'Windows 的 key 描述里承诺过的键名/修饰符名,parseKeySpec(...,"win32") 必须全部认', 'red', () => {
  assert.ok(WIN_NAMES.length >= 8, `从 win32 描述里只抽到 ${WIN_NAMES.length} 个键名(${JSON.stringify(WIN_NAMES)})——抽取规则或描述写法变了?`);
  const bad = WIN_NAMES.filter((n) => !usable('win32', n).ok);
  assert.deepEqual(bad, [], `描述承诺了这些键名,校验层却不认(模型照描述调用会拿到 CU_UNSUPPORTED_KEY):${JSON.stringify(bad)}`);
});

// ── KN-02 描述里承诺的独立键必须带出数字 vk(否则 helper 投递不了)──
await report.check('KN-02', '被承诺的独立键必须给出数字 vk(VK 表里真有它;修饰符除外)', 'red', () => {
  const problems = [];
  for (const name of WIN_NAMES) {
    const u = usable('win32', name);
    if (u.how === 'key' && typeof u.vk !== 'number') problems.push(`${name} 没有 vk`);
  }
  assert.deepEqual(problems, [], problems.join('; '));
});

// ── KN-03 Delete 键的契约:delete=退格(两端同义)、vk_delete/del=VK_DELETE 0x2E ──
await report.check('KN-03', 'delete/backspace 同义(0x08)不变;vk_delete 与 del 都映射 VK_DELETE(0x2e),可与修饰符组合', 'red', () => {
  assert.equal(mcp.parseKeySpec('delete', 'win32').vk, 0x08, 'delete 是 backspace 的别名(契约,check-cu-keys 锁死)');
  assert.equal(mcp.parseKeySpec('backspace', 'win32').vk, 0x08);
  for (const name of ['vk_delete', 'del']) {
    const spec = mcp.parseKeySpec(name, 'win32');
    assert.equal(spec.ok, true, `${name} 必须被接受(描述与 docs 都承诺过)`);
    assert.equal(spec.vk, 0x2e, `${name} 应映射 VK_DELETE(0x2e),实际 0x${Number(spec.vk).toString(16)}`);
    assert.equal(mcp.parseKeySpec(`ctrl+${name}`, 'win32').ok, true, `ctrl+${name} 必须可用`);
  }
  assert.ok(WIN_NAMES.includes('vk_delete') && WIN_NAMES.includes('del'),
    '描述里必须继续承诺 Delete 键的用法(Windows 用户要按得出 Delete;若决定撤掉这条能力,请连带改本用例与 docs)');
});

// ── KN-04 mac 回归:mac 描述里的键名依旧全部可用,且 win-only 的键名不泄漏到 mac ──
await report.check('KN-04', 'macOS 描述承诺的键名在 darwin 上仍然全部可用;vk_delete/del 是 Windows 专属,不在 mac 表里', 'green', () => {
  assert.ok(MAC_NAMES.length >= 8, `从 darwin 描述里只抽到 ${MAC_NAMES.length} 个键名(${JSON.stringify(MAC_NAMES)})`);
  const bad = MAC_NAMES.filter((n) => !usable('darwin', n).ok);
  assert.deepEqual(bad, [], `mac 描述承诺了这些键名,darwin 的 parseKeySpec 却不认:${JSON.stringify(bad)}`);
  assert.equal(mcp.parseKeySpec('vk_delete', 'darwin').ok, false, 'vk_delete 是 Windows 专属键名,不该出现在 mac 表里');
  assert.equal(mcp.parseKeySpec('del', 'darwin').ok, false, 'del 同上');
});

process.exit(report.finish());
