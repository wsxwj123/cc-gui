#!/usr/bin/env node
// claude 版本探测的缓存回退护栏(server/routes/version-check.js getClaudeVersion)。
// 回归对象:`claude --version` 冷启动偶发超时(npm shim 里再起 node / 系统负载 /
// Windows 杀毒实时扫描)就直接报"已检测到 Claude 但读取版本超时",而版本号是强缓存
// 友好的数据 —— 有旧值时应回退旧值而不是报错。
// 两段:①复刻缓存逻辑跑行为断言;②直接读源码,守住修复没被后续改动抹掉(超时值/回退分支)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── ① 行为:复刻 getClaudeVersion 的缓存分支 ────────────────────
function makeProbe(execImpl) {
  const cache = new Map();
  return async function getClaudeVersion(claudePath) {
    const cacheKey = claudePath || 'claude';
    try {
      const stdout = await execImpl(cacheKey);
      const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
      if (m) { cache.set(cacheKey, m[1]); return m[1]; }
      return cache.get(cacheKey) || null;
    } catch (err) {
      // 只有"探测本身没跑成"才回退缓存;二进制真没了(ENOENT)如实 null。
      const transient = err?.killed === true || err?.signal != null
        || ['ETIMEDOUT', 'EBUSY', 'EAGAIN'].includes(err?.code);
      if (!transient) return null;
      return cache.get(cacheKey) || null;
    }
  };
}
const TIMEOUT = () => { throw Object.assign(new Error('ETIMEDOUT'), { killed: true }); };
const GONE = () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); };

// 无缓存 + 超时 → null(真落空,端点照旧报错文案)
{
  const probe = makeProbe(TIMEOUT);
  assert.equal(await probe('/usr/local/bin/claude'), null, '首次探测就超时:无缓存可回退 → null');
}

// 成功 → 缓存;随后超时 → 回退旧值(不报错)
{
  let mode = 'ok';
  const probe = makeProbe(() => (mode === 'ok' ? '2.1.160 (Claude Code)' : TIMEOUT()));
  assert.equal(await probe('/usr/local/bin/claude'), '2.1.160', '首次成功');
  mode = 'timeout';
  assert.equal(await probe('/usr/local/bin/claude'), '2.1.160', '再探超时 → 回退缓存版本,不报"读取版本超时"');
  mode = 'ok';
  assert.equal(await probe('/usr/local/bin/claude'), '2.1.160', '恢复后照常走真值');
}

// 二进制真没了(ENOENT):不回退缓存 —— 否则用户卸载/换装法后 GUI 一直报一个不存在的版本
{
  let mode = 'ok';
  const probe = makeProbe(() => (mode === 'ok' ? '2.1.160 (Claude Code)' : GONE()));
  assert.equal(await probe('/usr/local/bin/claude'), '2.1.160', '首次成功');
  mode = 'gone';
  assert.equal(await probe('/usr/local/bin/claude'), null, 'ENOENT → 如实 null,不拿缓存顶(未安装提示要能出来)');
}

// 缓存按路径分键:两个安装互不串版本
{
  const byPath = { '/opt/a/claude': '2.1.100 (Claude Code)', '/opt/b/claude': '2.2.5 (Claude Code)' };
  let down = false;
  const probe = makeProbe((p) => (down ? TIMEOUT() : byPath[p]));
  assert.equal(await probe('/opt/a/claude'), '2.1.100');
  assert.equal(await probe('/opt/b/claude'), '2.2.5');
  down = true;
  assert.equal(await probe('/opt/a/claude'), '2.1.100', 'a 超时回退 a 自己的版本');
  assert.equal(await probe('/opt/b/claude'), '2.2.5', 'b 超时回退 b 自己的版本');
  assert.equal(await probe('/opt/c/claude'), null, '没探过的路径无缓存 → null');
}

// 成功探测要刷新缓存(用户更新 claude 后不能一直报旧版本)
{
  let out = '2.1.160 (Claude Code)';
  const probe = makeProbe(() => out);
  assert.equal(await probe(null), '2.1.160');
  out = '2.1.200 (Claude Code)';
  assert.equal(await probe(null), '2.1.200', '成功探测刷新缓存(用户更新后不能一直报旧版本)');
  out = 'garbage without version';
  assert.equal(await probe(null), '2.1.200', '输出没版本号(异常形态)→ 用缓存顶着,不误报未安装');
}

// ── ② 源码守卫:修复点不得被改回去 ──────────────────────────────
{
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'version-check.js'),
    'utf8',
  );
  const fn = src.slice(src.indexOf('async function getClaudeVersion'), src.indexOf('async function httpGetText'));
  assert.ok(/ccVersionByPath\.set\(/.test(fn), 'getClaudeVersion 必须写缓存');
  assert.ok((fn.match(/ccVersionByPath\.get\(/g) || []).length >= 2, '成功无匹配 + catch 两条路径都要回退缓存');
  assert.ok(!/timeout:\s*8000/.test(fn), '版本探测超时不得回到 8s');
  assert.ok(/timeout:\s*15000/.test(fn), '版本探测超时应为 15s');
  assert.ok(/const transient =/.test(fn) && /if \(!transient\) return null;/.test(fn),
    'catch 必须区分超时(回退缓存)与二进制消失(如实 null)');
}

console.log('✓ check-claude-version-cache: 行为 5 组 + 源码守卫 全过');
