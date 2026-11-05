// 被测进程(server/index.js 与 mcp-server.js)的预加载:把"家目录"指到本套件自己的 .artifacts 假目录。
// 授权真源 ~/.claude-gui/cu-runtime/grants.json 是按 os.userInfo().homedir 解析的($HOME 无效),
// 想隔离只能在产品模块加载前改掉 os 的两个函数并同步 ESM 命名导出。产品代码一行不改。
// 双保险:没设 R154_FAKE_HOME、或路径不在本套件 .artifacts 下,一律直接报错,绝不落到真实家目录。
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const fake = process.env.R154_FAKE_HOME;
if (!fake) throw new Error('r154 preload: 必须设置 R154_FAKE_HOME,拒绝碰真实 ~/.claude-gui');
if (!fake.includes('/r154-cu-grant-hardening/.artifacts/')) {
  throw new Error(`r154 preload: 假家目录必须在本套件 .artifacts 下,实际 ${fake}`);
}
const realUserInfo = os.userInfo;
os.userInfo = (...args) => ({ ...realUserInfo(...args), homedir: fake });
os.homedir = () => fake;
syncBuiltinESMExports();
