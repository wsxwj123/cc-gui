#!/usr/bin/env node
// r26-J3【单测】:/api/image/generate 兜底 catch 的 redactKey 必须拿到真实 apiKey。
// 修前:redactKey(err.message, null) —— 字面替换分支失效,只剩 Bearer/api_key 形态兜底;
// key 以其他形态出现在异常消息里(如 URL userinfo、上游自定义字段)就明文回显。
//
// 兜底 catch 是有意的"防意外"路径,正常夹具无法稳定触发其中"消息含 key"的形态,
// 故按本仓 JSX/难达路径的既有测试口径:源码钉 + 同形参考实现的行为断言。
// 哨兵:①catch 块把 apiKeyForRedact(非 null)传给 redactKey;
// ②apiKeyForRedact 在 provider 查到后即赋值(顺序钉:赋值必须在可能抛错的调用之前);
// ③同形参考:含 key 的错误消息经 redactKey(msg, key) 后无明文,而 (msg, null) 形态漏
//   (证明该测试能咬住"传 null"的回归)。
// Run: node tests/unit/check-r26-j3-catch-redact-key.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redactKey } from '../../server/utils/image-protocols.js';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

const src = readFileSync(new URL('../../server/routes/image.js', import.meta.url), 'utf8');

// ① 兜底 catch 传真实 key 变量,不再是 null
{
  const routeIdx = src.indexOf("router.post('/image/generate'");
  const catchIdx = src.indexOf('} catch (err) {', routeIdx);
  const catchBlock = src.slice(catchIdx, catchIdx + 400);
  ok(/redactKey\(err\.message, apiKeyForRedact\)/.test(catchBlock),
    'J3: 兜底 catch 必须 redactKey(err.message, apiKeyForRedact)');
  ok(!/redactKey\(err\.message, null\)/.test(catchBlock),
    'J3: 兜底 catch 不得再传 null(字面替换分支失效)');
}

// ② key 在 provider 查到后即提出到外层作用域(在后续一切可能抛错的调用之前)
{
  ok(/let apiKeyForRedact = ''/.test(src), 'J3: 外层作用域声明 apiKeyForRedact');
  const assignIdx = src.indexOf("apiKeyForRedact = provider.apiKey || ''");
  const firstRiskyIdx = src.indexOf('checkSavePath(provider.savePath)');
  ok(assignIdx > -1 && firstRiskyIdx > -1 && assignIdx < firstRiskyIdx,
    'J3: key 必须在首个可能抛错的调用之前赋值');
  // 404 分支(provider 不存在)在赋值之前 → key 仍是 '',不误剥(顺序正确性顺带钉)
  ok(src.indexOf("res.status(404).json({ error: '未找到该生图 provider' })") < assignIdx,
    'J3: 404 早退在赋值之前(此时还没有 key 可剥)');
}

// ③ 行为矩阵(同形参考 = 真 redactKey):传 key 剥得掉"非 Bearer 形态"的 key;传 null 漏
{
  const KEY = 'sk-cgui-j3-secret-abcdef123456';
  // 既非 Bearer 前缀、也非 api_key 字段形态的回显(如上游把 key 原样塞进错误文本)
  const msg = `upstream 500: request with credential ${KEY} failed at gateway`;
  const withKey = redactKey(msg, KEY);
  ok(!withKey.includes(KEY), 'J3: 传真实 key → 任意形态回显都被字面剥掉');
  ok(withKey.includes('***'), 'J3: 剥掉后留掩码');
  const withNull = redactKey(msg, null);
  ok(withNull.includes(KEY), 'J3: 自检 —— 传 null 时该形态漏剥(证明①②钉的是真 bug)');
}

console.log(`PASS check-r26-j3-catch-redact-key (${n} assertions)`);
