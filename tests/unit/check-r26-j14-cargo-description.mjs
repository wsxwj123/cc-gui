#!/usr/bin/env node
// r26-J14【单测】:src-tauri/Cargo.toml 的 description 改新名 CC-GUI。
// 范围按 PLAN:只改 description 一行;package name(lib name)不动;
// release.local.sh 是 gitignored 私有脚本,不归本轮改(交付报告提醒)。
// 文本哨兵:①description 为 CC-GUI;②无 "Claude GUI" 旧名残留;③name/lib name 不动。
// Run: node tests/unit/check-r26-j14-cargo-description.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

const src = readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8');

ok(src.includes('description = "CC-GUI — native shell"'), 'J14: description 必须是 CC-GUI');
ok(!src.includes('Claude GUI'), 'J14: 不得残留旧名 "Claude GUI"');
ok(/name = "claude-gui"/.test(src), 'J14: package name 不动(非本条范围)');
ok(/name = "claude_gui_lib"/.test(src), 'J14: lib name 不动(非本条范围)');

console.log(`PASS check-r26-j14-cargo-description (${n} assertions)`);
