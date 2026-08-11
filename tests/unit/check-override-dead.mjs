#!/usr/bin/env node
// R8-2 死 override 显式提示护栏。背景:用户手动钉死 claude 路径(claude-bin.json),
// 之后该文件被卸载/移动 —— resolver 静默回落自动优先级,用户以为还在用指定的那个
// (本机事故链:壳包死安装被钉死 → 静默回落旧版,更新"成功"却永远跑旧版)。
// 契约:cli-check / claude-installs / env-check 响应加 overrideDead:true + override 路径;
// 清除(写空)幂等,清除后不再标注。HOME 隔离到 tmp,绝不碰真实 ~/.claude-gui。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REAL_HOME = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'cgui-override-test-'));
process.env.HOME = home;   // os.homedir() 在 POSIX 上优先读 $HOME,必须在 import 前设好

const { setClaudeOverride, getClaudeOverride, resolveClaude } =
  await import('../../server/utils/claude-resolver.js');

try {
  // ── ① override 指向不存在路径:读得出、但解析必须回落(不返回死路径) ──────
  const deadPath = join(home, 'gone', 'claude');
  setClaudeOverride(deadPath);
  assert.equal(getClaudeOverride(), deadPath, 'override 已写入');
  assert.equal(existsSync(deadPath), false, '前提:该路径确实不存在');
  // 端点判定表达式的行为口径:override 存在但文件没了 = dead
  const dead = !!getClaudeOverride() && !existsSync(getClaudeOverride());
  assert.equal(dead, true, 'override 指向不存在路径 → overrideDead 判定为 true');
  // resolver 静默回落:解析结果绝不能是死路径(可能回落到本机真 claude,也可能 null)
  const hit = resolveClaude({ refresh: true });
  if (hit) {
    assert.notEqual(hit.path, deadPath, '解析结果不得是死 override 路径');
    assert.notEqual(hit.via, 'override', '死 override 不得以 override 名义命中');
  }

  // ── ② 清除(写空)→ 不再 dead;幂等 ─────────────────────────────────────
  setClaudeOverride('');
  assert.equal(getClaudeOverride(), '', '清除后 override 为空');
  assert.equal(!!getClaudeOverride() && !existsSync(getClaudeOverride()), false, '清除后 overrideDead 判定为 false');
  setClaudeOverride('');   // 再清一次:幂等,不抛
  // override 文件整个删掉后清除仍 ok(R8-2.3:文件不存在时清除返回 ok)
  rmSync(join(home, '.claude-gui', 'claude-bin.json'), { force: true });
  setClaudeOverride('');
  assert.equal(getClaudeOverride(), '', '文件不存在时清除依然幂等成功');

  // ── ③ 活 override(文件存在)不误标 dead ────────────────────────────────
  const alivePath = join(home, 'alive', 'claude');
  mkdirSync(dirname(alivePath), { recursive: true });
  writeFileSync(alivePath, Buffer.from([0xCF, 0xFA, 0xED, 0xFE, 0, 0, 0, 1]));
  setClaudeOverride(alivePath);
  assert.equal(!!getClaudeOverride() && !existsSync(getClaudeOverride()), false, '路径存在的 override 不标 dead');
  const hit2 = resolveClaude({ refresh: true });
  assert.equal(hit2?.path, alivePath, '活 override 正常命中');
  assert.equal(hit2?.via, 'override', '以 override 名义命中');
  setClaudeOverride('');
} finally {
  process.env.HOME = REAL_HOME;
  rmSync(home, { recursive: true, force: true });
}

// ── ④ 源码守卫:三个端点都必须带 overrideDead 标注,前端两处消费 ────────────
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const cliCheck = readFileSync(join(ROOT, 'server', 'routes', 'cli-check.js'), 'utf8');
  assert.ok(/overrideDead/.test(cliCheck) && /getClaudeOverride/.test(cliCheck),
    'cli-check 响应必须带 overrideDead 标注');
  const vc = readFileSync(join(ROOT, 'server', 'routes', 'version-check.js'), 'utf8');
  assert.ok((vc.match(/overrideDead/g) || []).length >= 2,
    'version-check 的 claude-installs 与 env-check 两处都要标注 overrideDead');
  const sp = readFileSync(join(ROOT, 'client', 'src', 'components', 'SettingsPanel.jsx'), 'utf8');
  assert.ok(/overrideDead/.test(sp) && /switchActive\(''\)/.test(sp),
    '设置面板消费 overrideDead 且提供清除动作(switchActive(空))');
  const ep = readFileSync(join(ROOT, 'client', 'src', 'components', 'EnvCheckPanel.jsx'), 'utf8');
  assert.ok(/overrideDead/.test(ep) && /claude-active/.test(ep),
    '环境面板消费 overrideDead 且提供清除动作(PUT claude-active)');
  // 验收补齐3:清除失败不得静默(局域网端 403 等)。非 2xx 必须抛出并落 clearErr 渲染。
  const clearFn = ep.slice(ep.indexOf('const clearOverride'), ep.indexOf('const install ='));
  assert.ok(/if \(!r\.ok\)/.test(clearFn), 'clearOverride 必须检查响应状态(403 不算成功)');
  // 精确钉 catch 块内的置错(开头的 setClearErr(null) 是清空,不算):catch (e) 之后
  // 必须把异常消息写进 clearErr —— 改回 catch{} 吞错时这里必红。
  const catchAt = clearFn.indexOf('catch (e)');
  assert.ok(catchAt > -1, 'clearOverride 必须捕获异常(带绑定,不许裸 catch 吞掉)');
  assert.ok(/setClearErr\(e\.message/.test(clearFn.slice(catchAt)),
    'catch 内必须把错误消息置入 clearErr(变异哨兵:改回吞错这里红)');
  assert.ok(/清除失败/.test(ep), '失败提示对用户可见');
}

console.log('✓ check-override-dead: 死判定/静默回落/清除幂等/活不误标/端点与前端守卫 全过');
