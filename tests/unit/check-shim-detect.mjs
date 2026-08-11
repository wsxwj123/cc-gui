#!/usr/bin/env node
// R8-1 壳包识别护栏(server/utils/claude-resolver.js 的 sniffBinaryKind/classifyShim)。
// 背景:npm 包 ≥2.1.227 是原生安装器引导壳 —— bin/claude.exe 初始是 ASCII 假启动器,
// postinstall 从平台包拷真二进制覆盖。慢源半途而废会留下「bin 还是文本 stub」的死安装,
// 列表里看着正常、切过去 spawn 就废。判据双条件(风险清单):
//   「是壳包」= 包目录存在 install.cjs;「坏」= bin 目标缺失或文件头是文本。
// 修好的壳包(claude.exe 为真二进制)只标 shim:true,绝不误标 broken。
// 变异哨兵:删掉 sniffBinaryKind 的魔数判定 → 「真二进制不 broken」断言必须红。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sniffBinaryKind, classifyShim } from '../../server/utils/claude-resolver.js';

const root = mkdtempSync(join(tmpdir(), 'cgui-shim-test-'));
const F = (rel, content) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
};

// ── ① sniffBinaryKind:魔数判定(只读文件头,不执行) ──────────────────────
// 真实形态:mac 平台包真二进制是 Mach-O 64(小端存储 CF FA ED FE);Win 是 PE('MZ')。
const machO = F('bins/macho', Buffer.from([0xCF, 0xFA, 0xED, 0xFE, 0x0C, 0x00, 0x00, 0x01]));
const machOBE = F('bins/macho-be', Buffer.from([0xFE, 0xED, 0xFA, 0xCF, 0x00, 0x00, 0x00, 0x0C]));
const fatBin = F('bins/fat', Buffer.from([0xCA, 0xFE, 0xBA, 0xBE, 0x00, 0x00, 0x00, 0x02]));
const pe = F('bins/pe.exe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]));
const elf = F('bins/elf', Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00]));
// 官方引导壳的初始 ASCII 假启动器形态(shebang 文本)
const stub = F('bins/stub.exe', '#!/usr/bin/env node\nconsole.error("Claude Code native binary not installed; run install.cjs");\n');
const tiny = F('bins/tiny', 'ab'); // 不足 4 字节:放不下任何魔数
assert.equal(sniffBinaryKind(machO), 'binary', 'Mach-O(小端)是二进制');
assert.equal(sniffBinaryKind(machOBE), 'binary', 'Mach-O(大端)是二进制');
assert.equal(sniffBinaryKind(fatBin), 'binary', 'fat Mach-O 是二进制');
assert.equal(sniffBinaryKind(pe), 'binary', 'PE(MZ)是二进制');
assert.equal(sniffBinaryKind(elf), 'binary', 'ELF 是二进制');
assert.equal(sniffBinaryKind(stub), 'text', 'shebang 假启动器是文本');
assert.equal(sniffBinaryKind(tiny), 'text', '超短残缺文件按文本处理');
assert.equal(sniffBinaryKind(join(root, 'no-such-file')), 'unreadable', '不存在的文件 unreadable');

// ── ② classifyShim:壳包三态(fixture 按真实 npm 布局) ────────────────────
// 布局A(*nix):<prefix>/lib/node_modules/@anthropic-ai/claude-code/,bin/claude 软链
// 解析后的 real 就在包内。
const mkPkg = (prefixRel, { installCjs, binKind }) => {
  const pkg = join(root, prefixRel, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  if (installCjs) writeFileSync(join(pkg, 'install.cjs'), '// bootstrap installer\n');
  if (binKind === 'binary') writeFileSync(join(pkg, 'bin', 'claude.exe'), Buffer.from([0xCF, 0xFA, 0xED, 0xFE, 0, 0, 0, 1]));
  if (binKind === 'text') writeFileSync(join(pkg, 'bin', 'claude.exe'), '#!/bin/sh\necho placeholder\n');
  return pkg;
};

// 坏壳包:install.cjs 在、bin 目标还是文本 stub → shim + broken + 人话 reason
{
  const pkg = mkPkg('p-broken', { installCjs: true, binKind: 'text' });
  const r = classifyShim(join(pkg, 'bin', 'claude.exe'));
  assert.equal(r?.shim, true, '坏壳包 shim:true');
  assert.equal(r?.broken, true, '文本 stub → broken:true');
  assert.ok(/壳包未完成安装/.test(r?.reason || ''), 'reason 是人话原因');
}

// 修好的壳包:install.cjs 在、bin 目标是真 Mach-O → 只标 shim,不标 broken(误判红线)
{
  const pkg = mkPkg('p-fixed', { installCjs: true, binKind: 'binary' });
  const r = classifyShim(join(pkg, 'bin', 'claude.exe'));
  assert.equal(r?.shim, true, '修好的壳包仍是 shim');
  assert.ok(!r?.broken, '真二进制绝不标 broken(变异哨兵:删魔数判定这里必红)');
}

// bin 目标缺失:postinstall 根本没跑 → broken
{
  const pkg = mkPkg('p-missing', { installCjs: true, binKind: null });
  // real 传 cli 入口(包内其他文件路径),bin/claude.exe 不存在
  const r = classifyShim(join(pkg, 'cli.js'));
  assert.equal(r?.broken, true, 'bin 目标缺失 → broken');
}

// 非壳包(旧 npm 包无 install.cjs)→ null,零标注
{
  const pkg = mkPkg('p-legacy', { installCjs: false, binKind: 'binary' });
  const r = classifyShim(join(pkg, 'bin', 'claude.exe'));
  assert.equal(r, null, '无 install.cjs 的旧包不是壳包');
}

// 非 npm 安装(原生 ~/.local/bin/claude,路径里没有 node_modules)→ null
{
  const native = F('native/.local/bin/claude', Buffer.from([0xCF, 0xFA, 0xED, 0xFE, 0, 0, 0, 1]));
  assert.equal(classifyShim(native), null, '原生安装与壳包判定无关');
}

// 布局B(Windows 平铺):real 是 <prefix>\claude.cmd(shim 非软链),包在 <prefix>/node_modules 下
{
  const prefix = join(root, 'win-prefix');
  const pkg = join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'install.cjs'), '// bootstrap\n');
  writeFileSync(join(pkg, 'bin', 'claude.exe'), ':: not a real exe\r\necho stub\r\n');
  const shim = join(prefix, 'claude.cmd');
  writeFileSync(shim, '@echo off\r\nnode "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  const r = classifyShim(shim);
  assert.equal(r?.shim, true, 'Windows 平铺布局也能定位包目录');
  assert.equal(r?.broken, true, 'Windows 文本 stub 同样 broken');
}

rmSync(root, { recursive: true, force: true });
console.log('✓ check-shim-detect: 魔数 8 形态 + 壳包三态 + 双布局 全过');
