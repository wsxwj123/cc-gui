// r150 夹具:一个临时 HOME(不碰真实的 ~/.claude、~/.claude-gui)+ 假 claude 的状态文件。
// 假 claude(helpers/fake-claude.mjs)只管三样:plugin list、plugin enable / disable、mcp list。
// 状态文件 <CTL>/plugins-state.json 就是"这台机器上的插件现状":测试写它来摆场景,假 claude 的
// enable / disable 改它,plugin list / mcp list 照它输出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R150_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => process.env.R150_CTL || path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');

export const statePath = (ctl = fakeCtlDir()) => path.join(ctl, 'plugins-state.json');
export const callsPath = (ctl = fakeCtlDir()) => path.join(ctl, 'plugin-calls.log');
export const mcpDelayPath = (ctl = fakeCtlDir()) => path.join(ctl, 'mcp-list-delay-ms');

/** 同步插件带来的 MCP(名字照 CLI 的写法 plugin:<插件>:<服务器>)。 */
export const SYNCED_MCP = { 'bio-research': 'plugin:bio-research:pubmed', data: 'plugin:data:warehouse', design: 'plugin:design:figma' };

/**
 * 初始场景:
 *   已安装(在 installed_plugins.json 里):pua@pua-skills(启用)、design@acme-market(启用 —— 与同步段的 design 同名)
 *   账号同步(只出现在 `claude plugin list` 的「Synced from claude.ai」一段):
 *     design@synced(停用)、bio-research@synced(loaded)、data@synced(enabled)
 */
export const initialState = () => ({
  syncHeader: 'Synced from claude.ai:',
  installed: [
    { id: 'pua@pua-skills', version: '2.0.0', status: 'enabled' },
    { id: 'design@acme-market', version: '0.9.0', status: 'enabled' },
  ],
  synced: [
    { name: 'design', version: '1.2.0', status: 'disabled' },
    { name: 'bio-research', version: '1.2.0', status: 'loaded' },
    { name: 'data', version: '3.0.1', status: 'enabled' },
  ],
});

export function writeState(state, ctl = fakeCtlDir()) {
  fs.mkdirSync(ctl, { recursive: true });
  fs.writeFileSync(statePath(ctl), JSON.stringify(state, null, 2));
}
export function readState(ctl = fakeCtlDir()) {
  try { return JSON.parse(fs.readFileSync(statePath(ctl), 'utf8')); } catch { return initialState(); }
}
/** 假 claude 收到过的 plugin enable / disable 调用(一行一条,如 "disable bio-research@synced")。 */
export function readCalls(ctl = fakeCtlDir()) {
  try { return fs.readFileSync(callsPath(ctl), 'utf8').split('\n').filter(Boolean); } catch { return []; }
}
export function clearCalls(ctl = fakeCtlDir()) { try { fs.unlinkSync(callsPath(ctl)); } catch { /* 本来就没有 */ } }
/** 让 `claude mcp list` 在读完状态之后再拖 ms 毫秒才输出(模拟真实的健康检查耗时)。0 = 不拖。 */
export function setMcpListDelay(ms, ctl = fakeCtlDir()) {
  if (ms > 0) fs.writeFileSync(mcpDelayPath(ctl), String(ms));
  else { try { fs.unlinkSync(mcpDelayPath(ctl)); } catch { /* 本来就没有 */ } }
}

export function buildFixtures() {
  const home = homeDir();
  const plugins = path.join(home, '.claude', 'plugins');
  for (const d of [plugins, path.join(home, '.claude-gui'), fakeCtlDir(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });

  // 首启浮层预置成"已看过"(与被测行为无关),网络钉回环(公开版首启会自愈成 0.0.0.0)
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));

  // 已安装插件的登记文件(同步插件不在这里 —— 这正是面板原来看不到它们的原因)
  const inst = (id, version) => [{ scope: 'user', installPath: path.join(plugins, 'cache', id.replace('@', '_')), version, installedAt: '2026-09-01T00:00:00.000Z', lastUpdated: '2026-09-01T00:00:00.000Z' }];
  fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'pua@pua-skills': inst('pua@pua-skills', '2.0.0'), 'design@acme-market': inst('design@acme-market', '0.9.0') },
  }, null, 2));

  writeState(initialState());

  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r150] 夹具就绪:HOME=${r.home}`);
}
