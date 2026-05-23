import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import sessionRoutes from './routes/sessions.js';
import chatRoutes from './routes/chat.js';
import processRoutes from './routes/processes.js';
import settingsRoutes from './routes/settings.js';
import usageRoutes from './routes/usage.js';
import mcpRoutes from './routes/mcp.js';
import forkRoutes from './routes/fork.js';
import fileChangesRoutes from './routes/file-changes.js';
import searchRoutes from './routes/search.js';
import checkpointsRoutes from './routes/checkpoints.js';
import agentsRoutes from './routes/agents.js';
import worktreeRoutes from './routes/worktree.js';
import { setupFileWatcher } from './services/file-watcher.js';
import { getDefaultModel, getAvailableModels, setDefaultModel } from './services/model-resolver.js';
import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 6677;

const app = express();
app.use(cors());
app.use(express.json());

// API routes
app.use('/api', sessionRoutes);
app.use('/api', chatRoutes);
app.use('/api', processRoutes);
app.use('/api', settingsRoutes);
app.use('/api', usageRoutes);
app.use('/api', mcpRoutes);
app.use('/api', forkRoutes);
app.use('/api', fileChangesRoutes);
app.use('/api', searchRoutes);
app.use('/api', checkpointsRoutes);
app.use('/api', agentsRoutes);
app.use('/api', worktreeRoutes);

// GET /api/model — current default model + available models
app.get('/api/model', async (req, res) => {
  try {
    const data = await getAvailableModels();
    res.json({ model: data.current, available: data.models, provider: data.provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/model — set default model
app.put('/api/model', async (req, res) => {
  try {
    const { model } = req.body;
    if (!model) return res.status(400).json({ error: 'model is required' });
    await setDefaultModel(model);
    res.json({ ok: true, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 仅作 UI 提示用，绝不在 server 端做命令路由。所有 slash 一律原样透传给 `claude -p`，
// 由 CLI 自己决定如何处理（含 skill 加载、interactive-only 提示等）。
//   interactiveOnly: true   实测 `claude -p "/xxx"` 会返回 "isn't available in this environment"
//   requiresAnthropic       cc switch 到第三方端点后的可用性，与 CLI 是否支持 -p 正交
const BUILTIN_COMMANDS = [
  // -p 模式 CLI 会真正执行
  { name: '/clear',           desc: '清除当前会话上下文',  type: 'builtin' },
  { name: '/compact',         desc: '压缩会话历史',        type: 'builtin' },
  { name: '/cost',            desc: '显示当前会话费用',    type: 'builtin', requiresAnthropic: 'partial', note: '第三方端点 token 计价不准' },
  { name: '/init',            desc: '生成项目 CLAUDE.md',  type: 'builtin' },
  { name: '/resume',          desc: '恢复会话',            type: 'builtin' },
  { name: '/review',          desc: '代码审查',            type: 'builtin' },
  { name: '/pr-comments',     desc: '查看 PR 评论',        type: 'builtin' },
  { name: '/security-review', desc: '安全审查',            type: 'builtin' },
  { name: '/bug',             desc: '报告 Bug',            type: 'builtin', requiresAnthropic: 'partial', note: '上报到 Anthropic' },
  { name: '/add-dir',         desc: '添加工作目录',        type: 'builtin' },
  { name: '/export',          desc: '导出会话',            type: 'builtin' },
  { name: '/todos',           desc: '查看任务列表',        type: 'builtin' },

  // -p 模式 CLI 拒绝（交互式专属）
  { name: '/help',           desc: '帮助',           type: 'builtin', interactiveOnly: true },
  { name: '/status',         desc: '会话状态',       type: 'builtin', interactiveOnly: true },
  { name: '/doctor',         desc: '健康检查',       type: 'builtin', interactiveOnly: true },
  { name: '/mcp',            desc: 'MCP 管理',       type: 'builtin', interactiveOnly: true },
  { name: '/config',         desc: '配置',           type: 'builtin', interactiveOnly: true },
  { name: '/permissions',    desc: '权限设置',       type: 'builtin', interactiveOnly: true },
  { name: '/model',          desc: '切换模型',       type: 'builtin', interactiveOnly: true, requiresAnthropic: 'partial' },
  { name: '/memory',         desc: '编辑 CLAUDE.md', type: 'builtin', interactiveOnly: true },
  { name: '/agents',         desc: '管理 subagents', type: 'builtin', interactiveOnly: true },
  { name: '/vim',            desc: 'Vim 模式',       type: 'builtin', interactiveOnly: true },
  { name: '/terminal-setup', desc: '终端集成',       type: 'builtin', interactiveOnly: true },
  { name: '/login',          desc: 'Anthropic 登录', type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full' },
  { name: '/logout',         desc: '退出登录',       type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full' },
  { name: '/fast',           desc: 'Opus Fast',      type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full' },
  { name: '/remote-control', desc: '远程控制会话',   type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full',
    note: 'claude --remote-control 是 CLI flag，需在终端启动' },
];

// 第三方端点不可用的 skill/plugin 名称（按 slash 名匹配）
const SUBSCRIPTION_ONLY_NAMES = new Set([
  'loop', 'schedule', 'remote-trigger',
]);

// Extract description from SKILL.md frontmatter
async function getSkillDescription(skillDir, skillName) {
  try {
    const content = await readFile(join(skillDir, skillName, 'SKILL.md'), 'utf-8');
    const match = content.match(/^---[\s\S]*?description:\s*(.+?)[\n\r]/);
    if (match) {
      const desc = match[1].trim().replace(/^[>]+\s*/, '');
      return desc.length > 100 ? desc.slice(0, 100) + '...' : desc;
    }
  } catch {}
  return skillName.replace(/-/g, ' ');
}

app.get('/api/slash-commands', async (req, res) => {
  try {
    const commands = [...BUILTIN_COMMANDS];

    const skillsDir = join(homedir(), '.claude', 'skills');
    try {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      const skillDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
      const descriptions = await Promise.all(skillDirs.map(d => getSkillDescription(skillsDir, d.name)));
      skillDirs.forEach((entry, i) => {
        if (commands.some(c => c.name === `/${entry.name}`)) return;
        commands.push({
          name: `/${entry.name}`,
          desc: descriptions[i],
          type: 'skill',
          requiresAnthropic: SUBSCRIPTION_ONLY_NAMES.has(entry.name) ? 'full' : false,
        });
      });
    } catch {}

    try {
      const pluginsData = JSON.parse(
        await readFile(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf-8')
      );
      const plugins = pluginsData.plugins || {};
      for (const [name] of Object.entries(plugins)) {
        const pluginName = name.split('@')[0];
        if (commands.some(c => c.name === `/${pluginName}`)) continue;
        commands.push({
          name: `/${pluginName}`,
          desc: `Plugin: ${pluginName}`,
          type: 'plugin',
          requiresAnthropic: SUBSCRIPTION_ONLY_NAMES.has(pluginName) ? 'full' : false,
        });
      }
    } catch {}

    // Tell the client which endpoint is currently active so it can gray out
    // subscription-only commands when cc switch points to a third-party endpoint.
    let provider = 'Anthropic';
    try {
      const data = await getAvailableModels();
      provider = data.provider || 'Anthropic';
    } catch {}
    const isAnthropic = provider === 'Anthropic';

    res.json({ commands, provider, isAnthropic });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve static frontend in production
const clientDist = join(__dirname, '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('/{*splat}', (req, res) => {
    res.sendFile(join(clientDist, 'index.html'));
  });
}

// HTTP + WebSocket server
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Track connected clients
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));

  getDefaultModel()
    .then((model) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'model', model }));
    })
    .catch((err) => console.warn('getDefaultModel on WS connect failed:', err.message));
});

// Broadcast to all connected clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

// File watcher → WebSocket broadcast
let watcher = null;
try {
  watcher = setupFileWatcher((eventType, filePath) => {
    broadcast({ type: 'file-change', eventType, path: filePath });
  });
} catch {
  console.warn('File watcher failed to start (chokidar)');
}

server.listen(PORT, () => {
  console.log(`Claude GUI server running at http://localhost:${PORT}`);
  console.log(`WebSocket at ws://localhost:${PORT}/ws`);
});

export { broadcast };
