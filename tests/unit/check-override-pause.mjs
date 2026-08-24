#!/usr/bin/env node
// 单测:r12-① npm 更新链路配置保全。
// t1 override 三态纯逻辑(claude-resolver 真函数,临时 HOME 沙箱,禁碰真实 ~/.claude-gui)
// t2 恢复判据矩阵(version-check.tryRestorePausedOverride 真函数,假安装/坏壳/缺失)
// t3 接线守卫(PUT pause 分支不清 path/{path:''} 仍彻底清/installs 只增字段/门禁与 broken 拒选逐字在位)
// 哨兵(实际验证过红):readOverrideRaw 删 paused 兼容读(恒 paused=false)→ t1 红。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REAL_HOME = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'cgui-pause-test-'));
process.env.HOME = home; // os.homedir() POSIX 优先读 $HOME,必须在 import 前设好

const {
  setClaudeOverride, getClaudeOverride, getClaudeOverrideRaw, pauseClaudeOverride,
} = await import('../../server/utils/claude-resolver.js');
const { tryRestorePausedOverride } = await import('../../server/routes/version-check.js');

const OVERRIDE_FILE = join(home, '.claude-gui', 'claude-bin.json');

try {
  // ── t1 三态纯逻辑 ──────────────────────────────────────────────
  // 旧格式 {path} 兼容读:paused=false
  mkdirSync(join(home, '.claude-gui'), { recursive: true });
  writeFileSync(OVERRIDE_FILE, JSON.stringify({ path: '/old/format/claude' }));
  assert.deepEqual(getClaudeOverrideRaw(), { path: '/old/format/claude', paused: false, pausedAt: null }, 't1: 旧格式兼容读(哨兵锚)');
  assert.equal(getClaudeOverride(), '/old/format/claude', 't1: 旧格式生效 override 照旧');
  // pause 不丢 path;生效 override 变空(resolver 视同无 override)
  assert.equal(pauseClaudeOverride(), true, 't1: pause 成功');
  const raw = getClaudeOverrideRaw();
  assert.equal(raw.path, '/old/format/claude', 't1: pause 不丢 path');
  assert.equal(raw.paused, true, 't1: paused 置位');
  assert.ok(Number.isFinite(raw.pausedAt), 't1: pausedAt 记录');
  assert.equal(getClaudeOverride(), '', 't1: paused 时 getClaudeOverride 返回空(resolver=无 override)');
  // 恢复钉选(正常 set path)清 paused
  setClaudeOverride('/old/format/claude');
  assert.deepEqual(getClaudeOverrideRaw().paused, false, 't1: 重新钉选清 paused');
  assert.equal(getClaudeOverride(), '/old/format/claude', 't1: 恢复后生效');
  // 空串彻底清除(含 paused 态)
  pauseClaudeOverride();
  setClaudeOverride('');
  assert.deepEqual(getClaudeOverrideRaw(), { path: '', paused: false, pausedAt: null }, 't1: 空串彻底清除');
  assert.equal(pauseClaudeOverride(), false, 't1: 无 path 时 pause no-op');
  // 损坏 JSON 安全读
  writeFileSync(OVERRIDE_FILE, 'not-json');
  assert.deepEqual(getClaudeOverrideRaw(), { path: '', paused: false, pausedAt: null }, 't1: 损坏文件安全回落');

  // ── t2 恢复判据矩阵 ────────────────────────────────────────────
  // 无 paused → no-op
  setClaudeOverride('');
  assert.equal(await tryRestorePausedOverride(), null, 't2: 无 paused → no-op');
  // paused + 路径缺失 → 不动(保持 paused)
  setClaudeOverride(join(home, 'gone-claude'));
  pauseClaudeOverride();
  assert.equal(await tryRestorePausedOverride(), null, 't2: 路径缺失不恢复');
  assert.equal(getClaudeOverrideRaw().paused, true, 't2: 缺失时保持 paused 不动(幂等)');
  // paused + broken 壳(npm 包目录带 install.cjs、bin/claude.exe 是文本)→ 不动。
  // 壳 stub 刻意「会撒谎」:可执行且打印版本号 —— 若删掉 classifyShim broken 闸,
  // 版本探测会被它骗过而错误恢复;本用例保证 broken 闸是唯一拦截者(哨兵②有效性)。
  const pkgDir = join(home, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(join(pkgDir, 'install.cjs'), '// shim installer');
  writeFileSync(join(pkgDir, 'bin', 'claude.exe'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
  chmodSync(join(pkgDir, 'bin', 'claude.exe'), 0o755);
  const shimEntry = join(pkgDir, 'bin', 'claude.exe');
  setClaudeOverride(shimEntry);
  pauseClaudeOverride();
  assert.equal(await tryRestorePausedOverride(), null, 't2: broken 壳不恢复(即使 stub 能打印版本)');
  assert.equal(getClaudeOverrideRaw().paused, true, 't2: broken 时保持 paused');
  // paused + 路径健康(可执行、版本探测成功、非壳包)→ 自动恢复钉选并清 paused
  const good = join(home, 'good-claude');
  writeFileSync(good, '#!/bin/sh\necho "2.1.99 (Claude Code)"\n');
  chmodSync(good, 0o755);
  setClaudeOverride(good);
  pauseClaudeOverride();
  const restored = await tryRestorePausedOverride();
  assert.ok(restored, 't2: 健康路径自动恢复');
  assert.equal(restored.path, good, 't2: 恢复的正是原钉选路径');
  assert.equal(restored.version, '2.1.99', 't2: 版本探测成功');
  assert.deepEqual(getClaudeOverrideRaw(), { ...getClaudeOverrideRaw(), path: good, paused: false }, 't2: 恢复后 paused 清除');
  assert.equal(getClaudeOverride(), good, 't2: 生效 override 回来了');

  // ── t3 接线守卫(源码级) ────────────────────────────────────────
  const vc = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  const put = vc.slice(vc.indexOf("router.put('/claude-active'"), vc.indexOf("// ─── 统一环境检查"));
  assert.match(put, /if \(req\.body\?\.pause === true\) \{/, 't3: PUT pause 分支存在');
  assert.match(put, /if \(!raw\.path\) return res\.status\(400\)/, 't3: 无 path 可暂停 → 400');
  assert.match(put, /pauseClaudeOverride\(\);/, 't3: pause 分支只置 paused 不清 path');
  assert.doesNotMatch(put.slice(put.indexOf('pause === true'), put.indexOf('const p =')), /setClaudeOverride/, 't3: pause 分支不碰 setClaudeOverride(不清 path)');
  // 老语义与红线逐字在位
  assert.match(put, /if \(!isLocalReq\(req\)\) return res\.status\(403\)\.json\(\{ error: '该操作仅限本机执行' \}\);/, 't3: 本机门禁逐字保留');
  assert.match(put, /if \(shimInfo\?\.broken\) \{/, 't3: broken 壳拒选逐字保留');
  assert.match(put, /setClaudeOverride\(p\);/, 't3: {path} 钉选/{path:\'\'} 彻底清除老语义在位');
  assert.match(vc, /overridePaused: rawOv\.paused, overridePausedPath: rawOv\.paused \? rawOv\.path : ''/, 't3: claude-installs 只增字段');
  const cc = readFileSync(new URL('../../server/routes/cli-check.js', import.meta.url), 'utf8');
  assert.match(cc, /overridePaused: true, overridePausedPath: rawOv\.path/, 't3: cli-check 只增字段');
  assert.match(vc, /overridePaused: true, overridePausedPath: getClaudeOverrideRaw\(\)\.path/, 't3: env-check 只增字段');

  // ── t3b ①b/①d 前端与文案守卫 ─────────────────────────────────
  const env = readFileSync(new URL('../../client/src/components/EnvCheckPanel.jsx', import.meta.url), 'utf8');
  assert.match(env, /暂停指定\(可恢复\)/, 't3b: EnvCheckPanel 主出口=暂停');
  assert.match(env, /JSON\.stringify\(body\)/, 't3b: 统一 putClaudeActive');
  assert.match(env, /pauseOverride = \(\) => putClaudeActive\(\{ pause: true \}\)/, 't3b: 暂停走 {pause:true}');
  assert.match(env, /clearOverride = \(\) => putClaudeActive\(\{ path: '' \}\)/, 't3b: 彻底清除保留老语义');
  assert.match(env, /item\?\.overridePaused && !item\?\.overrideDead/, 't3b: overridePaused 恢复横幅');
  assert.match(env, /立即恢复/, 't3b: 立即恢复按钮');
  assert.match(env, /改钉当前回落安装/, 't3b: 不自动改钉,一键按钮代替');
  const sp = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(sp, /暂停指定\(可恢复\)/, 't3b: SettingsPanel 同语义');
  assert.match(sp, /body: JSON\.stringify\(\{ pause: true \}\)/, 't3b: SettingsPanel pause 接线');
  assert.match(sp, /overridePaused && !overrideDead/, 't3b: SettingsPanel 恢复横幅');
  assert.match(sp, /改钉当前活跃安装/, 't3b: 改钉一键按钮');
  assert.match(sp, /ev\.type === 'override-restored'/, 't3b: 更新流回执消费');
  assert.match(sp, /已自动恢复你的手动指定/, 't3b: 回执文案');
  assert.match(sp, /改用终端更新\n?\s*<\/button>/, 't3b: ①d 失败态终端兜底可见');
  // r34:8 分钟不再终止(强杀会毁掉半装完的 npm 包),文案改成"仍在跑"的预期管理;
  // 但旧文案给的两个出口(代理/改用终端)必须保留 —— 挪到 60 分钟兜底那条上。
  assert.match(vc, /npm 源过慢是常见根因:确认代理已开后重试,或点「改用终端更新」走官方渠道/, 't3b: ①d 超时文案指引');
  assert.match(vc, /npm 源较慢时 81MB 的平台包可能需要 30-60 分钟/, 't3b: ①d 慢提示给出真实耗时预期');
  assert.match(vc, /重新运行一次更新即可补齐/, 't3b: ①d 中断后给恢复指引');
  assert.doesNotMatch(vc, /npm config set registry|--registry/, 't3b: 不做一键换源(不碰 npm 配置)');

  console.log('check-override-pause: all passed');
} finally {
  process.env.HOME = REAL_HOME;
  rmSync(home, { recursive: true, force: true });
}
