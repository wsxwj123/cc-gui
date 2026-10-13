#!/usr/bin/env node
// r150 假 claude CLI:只实现插件面板用得到的几条"列表 / 开关"命令,不发起任何回合。
//   claude plugin list                    照状态文件输出(已安装一段 + 「Synced from claude.ai」一段)
//   claude plugin list --available --json  []
//   claude plugin enable|disable <名字>   改状态文件,并把这次调用记进 <CTL>/plugin-calls.log
//   claude mcp list                       只列"启用着的同步插件"带来的 MCP;先读状态,再按
//                                         <CTL>/mcp-list-delay-ms 拖一会儿才输出(模拟健康检查耗时)
// 其余命令一律空手退出。状态文件见 helpers/fixtures.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { initialState, statePath, callsPath, mcpDelayPath, SYNCED_MCP } from './fixtures.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath(CTL), 'utf8')); } catch { return initialState(); } };
const writeState = (s) => fs.writeFileSync(statePath(CTL), JSON.stringify(s, null, 2));
const mark = (status) => (status === 'disabled' ? '✘ disabled' : status === 'loaded' ? '✔ loaded' : status === 'failed' ? '✘ failed to load' : '✔ enabled');
const isOn = (status) => status === 'enabled' || status === 'loaded';

if (argv[0] === 'plugin') {
  const state = readState();
  if (argv[1] === 'list') {
    if (argv.includes('--available')) { console.log('[]'); process.exit(0); }
    const out = [];
    if (state.installed.length) {
      out.push('Installed plugins:', '');
      for (const p of state.installed) out.push(`  ❯ ${p.id}`, `    Version: ${p.version}`, '    Scope: user', `    Status: ${mark(p.status)}`, '');
    }
    if (state.synced.length) {
      out.push(state.syncHeader || 'Synced from claude.ai:');
      for (const p of state.synced) {
        out.push(`  ❯ ${p.name}@synced`, `    Version: ${p.version}`,
          `    Path: ${path.join(process.env.HOME || '', '.claude', 'plugins', 'synced', '0a1b2c', p.name)}`, `    Status: ${mark(p.status)}`);
      }
    }
    console.log(out.join('\n'));
    process.exit(0);
  }
  if (argv[1] === 'enable' || argv[1] === 'disable') {
    const target = argv[2] || '';
    fs.appendFileSync(callsPath(CTL), `${argv[1]} ${target}\n`);
    const next = argv[1] === 'enable' ? 'enabled' : 'disabled';
    const synced = target.endsWith('@synced') ? state.synced.find((p) => `${p.name}@synced` === target) : null;
    const installed = synced ? null : state.installed.find((p) => p.id === target || p.id.split('@')[0] === target);
    if (!synced && !installed) { console.error(`Plugin "${target}" not found`); process.exit(1); }
    (synced || installed).status = next;
    writeState(state);
    console.log(`✔ Successfully ${next} plugin: ${target}`);
    process.exit(0);
  }
  process.exit(0);
}

if (argv[0] === 'mcp') {
  if (argv[1] === 'list') {
    const state = readState();                       // 先读:输出反映的是"命令开始那一刻"的状态
    let delay = 0;
    try { delay = Number(fs.readFileSync(mcpDelayPath(CTL), 'utf8').trim()) || 0; } catch { /* 没放 = 不拖 */ }
    if (delay > 0) await sleep(delay);
    const out = ['Checking MCP server health...', ''];
    for (const p of state.synced) {
      if (isOn(p.status) && SYNCED_MCP[p.name]) out.push(`${SYNCED_MCP[p.name]}: https://mcp.example.invalid/${p.name} (HTTP) - ✔ Connected`);
    }
    console.log(out.join('\n'));
  }
  process.exit(0);
}

process.exit(0);
