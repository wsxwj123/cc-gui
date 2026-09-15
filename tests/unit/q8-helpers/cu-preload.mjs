// mcp-server.js 的预加载(node --import 本文件 server/computer-use/mcp-server.js):
// cu-common.js 用 os.userInfo().homedir(不是 $HOME)定位 ~/.claude-gui/cu-runtime,
// 测试要把它指到自己的假家目录,只能在产品模块加载前改掉 os 的两个函数并同步 ESM 命名导出。
// 不改一行产品代码;不设 CU_TEST_HOME 就直接报错,绝不静默落到真家目录。
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const fake = process.env.CU_TEST_HOME;
if (!fake) throw new Error('cu-preload: 必须设置 CU_TEST_HOME(假家目录),拒绝碰真实 ~/.claude-gui');
const realUserInfo = os.userInfo;
os.userInfo = (...args) => ({ ...realUserInfo(...args), homedir: fake });
os.homedir = () => fake;
syncBuiltinESMExports();
