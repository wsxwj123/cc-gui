// 夹具 HOME 的准备。隔离实例的 HOME 指到这里 → 服务端 homedir() 也指到这里,
// 于是 /api/computer-use/status 的 registered 读的是【这份】.claude.json:
// 面板只在 registered:true 时渲染 cu-grants(§F.0.7),而这条前置在隔离实例上必须由夹具提供。
// 写的是合成条目,不代操作者注册、不碰真实的 ~/.claude.json 与 ~/.claude-gui 一个字节。
import fs from 'node:fs';
import path from 'node:path';

const home = process.argv[2];
const worktree = process.argv[3];
if (!home || !worktree) {
  console.error('用法: node helpers/prepare-home.mjs <home> <worktree>');
  process.exit(2);
}
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
// network.json 钉成回环:公开版首启会自愈成 0.0.0.0 + 随机密码(写盘 + 抢真实端口)
fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));

const claudeJson = path.join(home, '.claude.json');
let existing = {};
try { existing = JSON.parse(fs.readFileSync(claudeJson, 'utf8')); } catch { existing = {}; }
existing.mcpServers = existing.mcpServers || {};
if (!existing.mcpServers['ccgui-computer-use']) {
  existing.mcpServers['ccgui-computer-use'] = {
    type: 'stdio',
    command: process.execPath,
    args: [path.join(worktree, 'server', 'computer-use', 'mcp-server.js')],
  };
}
fs.writeFileSync(claudeJson, JSON.stringify(existing, null, 2));
console.log(`[cu-grant-ui] 夹具 HOME 就绪:${home}`);
