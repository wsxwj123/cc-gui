#!/usr/bin/env node
// r154 面板凭证(前端侧)的单测 —— 直接 import 真实实现 client/src/utils/cuGrantToken.js,不复刻逻辑。
//
// 为什么要有它:验收用例 U1–U3 只看端到端红/绿,覆盖不到:① 非字符串 / 空串不得清掉已有凭证
// (否则一条坏帧就让面板在服务重启前一直"尚未连上后台");② 凭证只放内存;③ CuGrants.jsx 里
// 授权写调用只有 postGrant 一处 —— 将来有人在别处另起一个 POST /grants,会绕开凭证与提示逻辑。
//
// 运行:node tests/unit/check-r154-grant-token-client.mjs(不起进程、不读写 ~/.claude-gui)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.join(HERE, '..', '..', 'client', 'src');
const TOKEN_MODULE = path.join(CLIENT_SRC, 'utils', 'cuGrantToken.js');
const { setCuGrantToken, getCuGrantToken } = await import(pathToFileURL(TOKEN_MODULE).href);

let n = 0;
const ok = (label) => { n += 1; console.log(`  ✓ ${label}`); };

// ── A. 存取 ────────────────────────────────────────────────────────────────
{
  assert.equal(getCuGrantToken(), '', '未收到帧前应为空串(调用方据此判"尚未连上")');
  ok('初始为空串');

  const t1 = 'a'.repeat(64);
  setCuGrantToken(t1);
  assert.equal(getCuGrantToken(), t1);
  ok('set 后 get 取回同值');

  for (const bad of [undefined, null, '', 123, {}, ['x'], true]) {
    setCuGrantToken(bad);
    assert.equal(getCuGrantToken(), t1, `非字符串 / 空串 ${JSON.stringify(bad)} 不得覆盖或清掉已有凭证`);
  }
  ok('非字符串 / 空串被忽略,已有值保留');

  const t2 = 'b'.repeat(64);
  setCuGrantToken(t2);
  assert.equal(getCuGrantToken(), t2, '重连收到新值应直接覆盖');
  ok('新值覆盖旧值(重连场景)');
}

// ── B. 只放内存 ──────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(TOKEN_MODULE, 'utf8').replace(/\/\/.*$/gm, ''); // 去掉注释再查
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), 'cuGrantToken.js 不得写任何持久存储');
  ok('cuGrantToken.js 不碰持久存储');
}

// ── C. CuGrants.jsx:授权写调用唯一出口 = postGrant ─────────────────────────────
{
  const src = fs.readFileSync(path.join(CLIENT_SRC, 'components', 'CuGrants.jsx'), 'utf8');
  const postRe = /fetch\(\s*'\/api\/computer-use\/grants'\s*,\s*\{\s*method:\s*'POST'/g;
  const hits = [...src.matchAll(postRe)];
  assert.equal(hits.length, 1, `CuGrants.jsx 里 POST /api/computer-use/grants 应只有 1 处,实际 ${hits.length}`);
  ok('POST /grants 只有一处');

  const start = src.indexOf('const postGrant = async');
  assert.ok(start >= 0, '找不到 postGrant');
  const end = src.indexOf('\n  };', start);
  assert.ok(hits[0].index > start && hits[0].index < end, '这一处 POST 必须在 postGrant 函数体内');
  ok('唯一的 POST 在 postGrant 内');

  const body = src.slice(start, end);
  assert.ok(body.includes('getCuGrantToken()'), 'postGrant 必须读取面板凭证');
  assert.ok(body.includes("'X-CGUI-Grant-Token'"), 'postGrant 必须把凭证放进 X-CGUI-Grant-Token 请求头');
  assert.ok(body.includes("'CU_GRANT_FORBIDDEN'"), 'postGrant 必须对 CU_GRANT_FORBIDDEN 补刷新/重启提示');
  ok('postGrant 带凭证请求头并处理 CU_GRANT_FORBIDDEN');
}

// ── D. useWebSocket.js 接收帧 ────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(CLIENT_SRC, 'hooks', 'useWebSocket.js'), 'utf8');
  assert.ok(/case 'cu:grant-token':\s*(\/\/[^\n]*\n\s*)*setCuGrantToken\(data\.token\);/.test(src),
    "useWebSocket.js 的 switch 里应有 case 'cu:grant-token' → setCuGrantToken(data.token)");
  ok("useWebSocket.js 处理 cu:grant-token 帧");
}

console.log(`check-r154-grant-token-client: ${n} 项通过`);
