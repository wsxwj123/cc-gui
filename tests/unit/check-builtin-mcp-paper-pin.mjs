// r88:内置 Paper Search 预设必须钉 mcp<2 —— mcp 2.0(2026-07-28)改名 FastMCP,
// paper-search-mcp 0.1.4 仍 import mcp.server.fastmcp,不钉 = 公开版用户点添加即连不上。
// 变异:去掉 --with mcp<2 → 红;改回 uvx paper-search-mcp 裸入口 → 红(同样受影响)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { BUILTIN_MCP_SERVERS } = await import(join(root, 'client/src/utils/builtinMcpServers.js'));
const entry = BUILTIN_MCP_SERVERS.find((s) => s.id === 'paper-search-mcp');
assert.ok(entry, '内置预设含 paper-search-mcp');
const toks = entry.commandLine.split(/\s+/);
assert.equal(toks[0], 'uvx', '经 uvx 拉起');
const i = toks.indexOf('--with');
assert.ok(i > 0 && toks[i + 1] === 'mcp<2', `必须钉 --with mcp<2(实际:${entry.commandLine})`);
assert.ok(toks.includes('paper_search_mcp.server'), '仍跑模块 paper_search_mcp.server(裸 console 入口同样受 mcp 2 影响)');
assert.ok(/mcp<2/.test(entry.note), 'note 向用户说明钉版本的原因');
// 后端拆分器不经 shell,'mcp<2' 应作为独立 token 原样保留(与 server/routes/mcp.js parseCommandLine 同款正则)
const re = /"([^"]*)"|'([^']*)'|(\S+)/g; const out = []; let m;
while ((m = re.exec(entry.commandLine)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
assert.deepEqual(out.slice(0, 3), ['uvx', '--with', 'mcp<2'], '拆分后 mcp<2 是独立参数,不会被当重定向');
console.log('check-builtin-mcp-paper-pin: all passed');
