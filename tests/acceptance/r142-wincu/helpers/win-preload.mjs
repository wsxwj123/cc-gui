// r142-wincu 验收套件:把**隔离实例的 node 进程**伪装成目标平台。
//
// 为什么走这条路:方案 §4.3/§4.2 要改的是"按平台分支的 UI 与路由",而 `process.platform` 在 mac 上
// 只能是 darwin。若不给实例注入平台,Windows 分支在本机永远不可执行 —— 那就只能靠"读源码猜"。
// 这里只改测试侧的子进程环境,产品代码一行不动(方案 §6.1 也明确把 CCGUI_CU_PLATFORM 这个产品钩子去掉了)。
//
// ⚠️ 边界(必须写进报告):本套件验的是"平台分派/文案/字段"这一层,验不了 Windows API 行为。
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const platform = process.env.CGUI_TEST_PLATFORM || 'win32';
const fakeHome = process.env.HOME; // run-isolated.sh 已经把 HOME 指到夹具目录
if (!fakeHome) throw new Error('win-preload: HOME 未设置,拒绝猜家目录');

Object.defineProperty(process, 'platform', { value: platform, configurable: true });
const realUserInfo = os.userInfo;
const realPlatform = os.platform;
os.platform = () => platform;
os.userInfo = (...args) => ({ ...realUserInfo(...args), homedir: fakeHome });
os.homedir = () => fakeHome;
syncBuiltinESMExports();
export const patched = { platform, fakeHome, realPlatform: realPlatform() };
