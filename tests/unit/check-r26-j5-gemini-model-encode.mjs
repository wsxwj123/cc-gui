#!/usr/bin/env node
// r26-J5【单测】:Gemini 生图的 model 进 URL path 前必须 encodeURIComponent。
// 修前:`${base}/models/${bare}:generateContent` 直接拼 —— model 含 '/' 或空格会把
// 请求路径拼歪(路径注入:'a/b' 变成两段路径,'a b' 产生非法 URL)。
// 哨兵:①'foo/bar baz' → URL 含 'foo%2Fbar%20baz:generateContent';②':' 不动
// (只编码 model 段,':generateContent' 保持字面);③正常型号名不受影响(回归);
// ④'models/' 前缀剥离与编码的组合顺序不错(先剥后编)。
// Run: node tests/unit/check-r26-j5-gemini-model-encode.mjs
import assert from 'node:assert/strict';
import { buildImageRequest } from '../../server/utils/image-protocols.js';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const CFG = { protocol: 'gemini', baseURL: 'https://relay.example.com/v1beta', apiKey: 'sk-dummy', model: '' };

// ① 注入形态被编码
{
  const r = buildImageRequest({ ...CFG, model: 'foo/bar baz' }, 'p');
  assert.equal(r.url, 'https://relay.example.com/v1beta/models/foo%2Fbar%20baz:generateContent',
    'J5: 斜杠/空格必须编码(实际 ' + r.url + ')');
  n += 1;
  // 编码产物再解析,path 段确实是单段
  const u = new URL(r.url);
  assert.ok(!u.pathname.slice(1, u.pathname.indexOf(':generateContent')).slice('/v1beta/models/'.length).includes('/'),
    'J5: model 段解码前不含裸斜杠(路径段数不被注入改变)');
  n += 1;
}
// ② ':generateContent' 字面保留(编码只作用于 model,不把冒号也编了)
{
  const r = buildImageRequest({ ...CFG, model: 'gemini-3-pro-image' }, 'p');
  assert.ok(r.url.endsWith(':generateContent'), 'J5: :generateContent 保持字面');
  n += 1;
}
// ③ 正常型号名不受影响(回归哨兵)
{
  const r = buildImageRequest({ ...CFG, model: 'gemini-3-pro-image' }, 'p');
  assert.equal(r.url, 'https://relay.example.com/v1beta/models/gemini-3-pro-image:generateContent',
    'J5: 正常型号名 URL 不变');
  const g = buildImageRequest({ ...CFG, model: 'models/gemini-3-pro-image' }, 'p');
  assert.equal(g.url, r.url, 'J5: models/ 前缀先剥后编,URL 与不带前缀一致');
  n += 2;
}
// ④ 点号/下划线/连字符等合法字符不被过度编码
{
  const r = buildImageRequest({ ...CFG, model: 'gemini-2.5_flash-image' }, 'p');
  assert.ok(r.url.includes('gemini-2.5_flash-image'), 'J5: 合法字符不过度编码');
  n += 1;
}

console.log(`PASS check-r26-j5-gemini-model-encode (${n} assertions)`);
