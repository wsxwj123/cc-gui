// 单测:r10-10 官方登录态预检——服务端 warning 注入(withOauthWarning)+ 前端匹配函数
// (matchOfficialLoginError)。均 import 真函数。
// 变异哨兵(实际验证过红):
//   S1 withOauthWarning 恒不加 warning → t1 红
//   S2 matchOfficialLoginError 删 Not logged in 备选支 → t2 红
import assert from 'node:assert/strict';
import { matchOfficialLoginError, OFFICIAL_LOGIN_HINT } from '../../client/src/utils/officialAuth.js';

// t1 warning 注入:token 空 → 附 warning;非空 → 原样且不泄漏 token
{
  const { withOauthWarning } = await import('../../server/routes/settings.js');
  const base = { ok: true, name: 'Claude 官方', via: 'official' };
  const missing = withOauthWarning(base, '');
  assert.equal(missing.warning, 'oauth-missing', 't1: 空 token 应附 warning');
  assert.equal(missing.ok, true, 't1: 原字段保留');
  const fine = withOauthWarning(base, 'tok-value');
  assert.equal(fine.warning, undefined, 't1: 有 token 不附 warning');
  assert.ok(!JSON.stringify(fine).includes('tok-value'), 't1: token 值绝不进响应');
}

// t2 登录错误匹配:三种已知文案命中,无关错误不命中
{
  assert.equal(matchOfficialLoginError('OAuth session expired. Please run /login'), true);
  assert.equal(matchOfficialLoginError('Not logged in'), true);
  assert.equal(matchOfficialLoginError('API Error: Please run /login to authenticate'), true);
  assert.equal(matchOfficialLoginError('Invalid signature in thinking block'), false, 't2: 无关错误不命中');
  assert.equal(matchOfficialLoginError(''), false);
  assert.equal(matchOfficialLoginError(null), false);
}

// t3 指引文案存在且为客观陈述(含具体动作)
assert.ok(/claude \/login/.test(OFFICIAL_LOGIN_HINT), 't3: 指引须含 claude /login 命令');

console.log('check-official-auth: all passed');
process.exit(0); // settings.js 顶层可能有副作用,显式退出
