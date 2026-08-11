#!/usr/bin/env node
// R8-1 更新命令护栏(server/routes/version-check.js updateCmdFor):npm 渠道已被官方
// 降级为原生安装器引导壳(≥2.1.227),`npm i -g` 更新会撞慢源半途而废的整条事故链
// (npmmirror 对 81MB 平台包 16-20KB/s → 超时僵尸 → bin 链未建 → 死安装)。
// method=npm 的更新命令必须改走原生渠道 `claude update`,mac / Windows 两分支同守。
// 变异哨兵:npm 分支改回 `npm install -g` → 「不含 npm install」断言必须红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { updateCmdFor } from '../../server/routes/version-check.js';

// 在当前平台(darwin/linux)与伪装 win32 下各跑一遍两分支。
// process.platform 可用 defineProperty 覆写(node 官方允许,测完还原)。
const realPlatform = process.platform;
const setPlatform = (v) => Object.defineProperty(process, 'platform', { value: v, configurable: true });

try {
  // ── mac/linux 分支 ──────────────────────────────────────────────
  setPlatform('darwin');
  {
    const cmd = updateCmdFor('npm', '/Users/u/.npm-global/bin/claude');
    assert.ok(!/npm\s+i(nstall)?\s+-g/.test(cmd), `mac npm 分支不得再生成 npm i -g:${cmd}`);
    assert.ok(!/@anthropic-ai\/claude-code/.test(cmd), 'mac npm 分支不得再引用 npm 包名');
    assert.ok(/\bupdate\b/.test(cmd), `mac npm 分支走 claude update(原生渠道自更新):${cmd}`);
    assert.ok(cmd.includes(`'/Users/u/.npm-global/bin/claude'`), '用绝对路径(单引号转义)防 PATH 解析到另一个安装');
  }
  {
    // 路径含单引号的转义(与 native 分支同款防注入写法)
    const cmd = updateCmdFor('npm', `/Users/o'brien/bin/claude`);
    assert.ok(cmd.includes(`'\\''`), '单引号路径按 bash 安全转义');
  }
  assert.equal(updateCmdFor('npm', ''), 'claude update', '无路径兜底裸 claude update');
  // native 分支不动(update/upgrade 是同一命令的别名,native 沿用既有 upgrade)
  assert.ok(/\bupgrade\b/.test(updateCmdFor('native', '/usr/local/bin/claude')), 'native 分支保持既有 upgrade');

  // ── Windows 分支 ────────────────────────────────────────────────
  setPlatform('win32');
  {
    const cmd = updateCmdFor('npm', 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
    assert.ok(!/npm\s+i(nstall)?\s+-g/.test(cmd), `win npm 分支不得再生成 npm i -g:${cmd}`);
    assert.ok(!/registry\.npmmirror\.com/.test(cmd), 'win npm 分支不再需要镜像源(不走 npm 了)');
    assert.ok(/\bupdate\b/.test(cmd), `win npm 分支走 claude update:${cmd}`);
    // .bat 里直调另一个 .cmd 控制权不返回(installCmdFor 注释的经典坑)→ 必须 call
    assert.ok(/^call\s/.test(cmd), 'win npm 分支必须以 call 开头(claude.cmd 是批处理)');
    assert.ok(cmd.includes('"C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd"'), '路径双引号包裹');
  }
  assert.equal(updateCmdFor('npm', ''), 'call claude update', 'win 无路径兜底');
} finally {
  setPlatform(realPlatform);
}

// ── 源码守卫:npm 更新链路里不许再出现 npm install -g(防悄悄改回) ────────
{
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'version-check.js'),
    'utf8',
  );
  const fn = src.slice(src.indexOf('export function updateCmdFor'), src.indexOf('export function installCmdFor'));
  assert.ok(!/npm install -g/.test(fn), 'updateCmdFor 内不得再有 npm install -g(安装命令 installCmdFor 不在此列)');
  assert.ok(/case 'npm'/.test(fn) && /update/.test(fn), 'npm 分支存在且走 update');
}

console.log('✓ check-update-cmd-npm: mac+win npm 分支走 claude update、native 不动 全过');
