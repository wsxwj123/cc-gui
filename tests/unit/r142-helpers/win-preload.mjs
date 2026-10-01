// r142 测试夹具(1/3):把子进程伪装成 win32。
//
// 为什么是"伪平台"而不是产品开关:PLAN-r142 §6.1 明确把 `CCGUI_CU_PLATFORM` 这个**产品 env 钩子去掉了**
// (改用纯函数注入)。运行时链路(Node 侧阶梯、释放合同)没有纯函数入口,只能在测试侧把 platform 改掉。
// 这样**一行产品代码都不改**,而且测到的是真实代码路径;代价是:只证明 Node 侧分派逻辑,证明不了
// Windows API 层(见 TEST-PLAN「未验证」)。
//
// 用法:node --import ./win-preload.mjs server/computer-use/mcp-server.js
//   CU_TEST_HOME 必须显式给假家目录;不给就报错退出,绝不落到真 ~/.claude-gui。
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const fake = process.env.CU_TEST_HOME;
if (!fake) throw new Error('win-preload: 必须设置 CU_TEST_HOME(假家目录),拒绝碰真实 ~/.claude-gui');

// process.platform 与 os.platform() 两条路都要改:mcp-server.js 用 os.platform(),cu-common.js 用 process.platform。
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
const realUserInfo = os.userInfo;
os.platform = () => 'win32';
os.userInfo = (...args) => ({ ...realUserInfo(...args), homedir: fake });
os.homedir = () => fake;
syncBuiltinESMExports();
