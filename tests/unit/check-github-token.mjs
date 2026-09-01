#!/usr/bin/env node
// r67 GitHub 令牌解析层自检(技能市场限流修复)。钉四件事:
// ① 解析顺序 env(GH_TOKEN 优先) → PAT 文件;文件优先于 gh 登录态(与本机 gh 状态无关,可测)
// ② 保存/清除的落盘往返 + 缓存作废(保存新令牌立即生效,不被 5 分钟 TTL 卡住)
// ③ 保存的形状校验挡明显粘错(空/空格/中文/超长),坏令牌不落盘
// ④ withGithubAuth 注入边界:只对 api.github.com、不覆盖已有 Authorization、不碰 raw/gitee/伪造域
// ⚠️ 令牌文件经 CGUI_GITHUB_TOKEN_FILE 指到临时目录,绝不读写真实 ~/.claude-gui(可能有用户真令牌)。
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cgui-ghtoken-'));
const file = join(dir, 'github-token.json');
process.env.CGUI_GITHUB_TOKEN_FILE = file; // 必须在 import 模块之前设好(模块顶层读一次)
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;

const { resolveGithubToken, invalidateGithubToken, saveGithubToken, clearGithubToken, withGithubAuth } =
  await import('../../server/utils/github-token.js');

// ── ① env 最优先,GH_TOKEN 压过 GITHUB_TOKEN(对齐 gh CLI 惯例)──────────────
process.env.GITHUB_TOKEN = 'envtok_1234567890';
invalidateGithubToken();
assert.deepEqual(await resolveGithubToken(), { token: 'envtok_1234567890', source: 'env' }, 'GITHUB_TOKEN 环境变量生效');
process.env.GH_TOKEN = 'ghtok_1234567890';
invalidateGithubToken();
assert.equal((await resolveGithubToken()).token, 'ghtok_1234567890', 'GH_TOKEN 优先于 GITHUB_TOKEN');
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;

// ── ② PAT 文件往返:保存(trim)→解析→换新→清除;pat 优先于 gh(此断言与机器 gh 状态无关)──
invalidateGithubToken();
await saveGithubToken('  ghp_abcdef1234567890  ');
assert.ok(existsSync(file), '令牌落盘到指定文件');
assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { token: 'ghp_abcdef1234567890' }, '落盘内容为 trim 后的 { token }');
assert.deepEqual(await resolveGithubToken(), { token: 'ghp_abcdef1234567890', source: 'pat' }, '无 env 时用 PAT 文件(优先于 gh 登录态)');
await saveGithubToken('github_pat_NEW9876543210');
assert.equal((await resolveGithubToken()).token, 'github_pat_NEW9876543210', '保存新令牌立即生效(TTL 缓存被作废)');
await clearGithubToken();
assert.ok(!existsSync(file), '清除后文件删掉');
assert.notEqual((await resolveGithubToken())?.source, 'pat', '清除后不再是 pat 来源');

// ── ③ 形状校验:明显粘错的拒收且不落盘 ──────────────────────────────────
for (const bad of ['', '   ', 'short', 'has space inside', 'tok\nen12345', '中文令牌abcdefgh', 'x'.repeat(300)]) {
  await assert.rejects(() => saveGithubToken(bad), (e) => e.status === 400, `拒绝坏形状:${JSON.stringify(bad).slice(0, 30)}`);
}
assert.ok(!existsSync(file), '坏令牌不落盘');

// ── ④ withGithubAuth 注入边界 ──────────────────────────────────────────
const H = { 'User-Agent': 'x', Accept: 'application/vnd.github+json' };
const out = withGithubAuth('https://api.github.com/repos/a/b/git/trees/HEAD', H, 'tok_123456789');
assert.equal(out.Authorization, 'Bearer tok_123456789', 'api.github.com 注入 Bearer');
assert.equal(out['User-Agent'], 'x', '原有请求头保留');
assert.ok(!('Authorization' in H), '不改传入的 headers 对象(共享的 GH_HEADERS 不能被污染)');
assert.equal(withGithubAuth('https://gitee.com/api/v5/repos/a/b', H, 'tok_123456789'), null, 'gitee 不注入');
assert.equal(withGithubAuth('https://raw.githubusercontent.com/a/b/main/SKILL.md', H, 'tok_123456789'), null, 'raw 不注入(不吃 API 配额,少一处泄露面)');
assert.equal(withGithubAuth('https://api.github.com.evil.com/x', H, 'tok_123456789'), null, '前缀伪造域不注入');
assert.equal(withGithubAuth('https://api.github.com/rate_limit', { Authorization: 'Bearer other' }, 'tok_123456789'), null, '调用方已带 Authorization 不覆盖(保存端点验令牌用)');
assert.equal(withGithubAuth('https://api.github.com/x', H, null), null, '无令牌不注入');

// ── ⑤ 保存端点必须先形状校验、再在线验真(判官 M1)────────────────────────
// 含换行的 token 直接拼进 Authorization → fetch 抛 ERR_INVALID_CHAR → 有代理的机器上
// 经 proxyGet 事件回调逃逸成悬死请求,保存按钮永久卡"验证中"。锁:POST 处理器内
// TOKEN_RE 预检必须出现在 rate_limit 在线验真之前。
{
  const { readFileSync } = await import('node:fs');
  const sk = readFileSync(new URL('../../server/routes/skills.js', import.meta.url), 'utf8');
  const post = sk.slice(sk.indexOf("router.post('/skills/github-token'"), sk.indexOf("router.delete('/skills/github-token'"));
  const shapeAt = post.indexOf('TOKEN_RE.test(');
  const onlineAt = post.indexOf('rate_limit');
  assert.ok(shapeAt > -1 && onlineAt > -1 && shapeAt < onlineAt, '⑤ 保存端点:形状校验在在线验真之前(防含换行输入悬死请求)');
}

rmSync(dir, { recursive: true, force: true });
console.log('check-github-token: all assertions passed');
