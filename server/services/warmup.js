// r21:启动预热的选取判据(纯函数 + prefs 读)。单测 tests/unit/check-warmup-hidden.mjs。
//
// 背景:server/index.js 启动后台预热会话列表缓存,原实现取 listProjects() 的 top-16。
// 但 hiddenProjects(用户在侧栏隐藏的项目)过滤只做在前端 —— 本机 39 个项目里 35 个
// 已隐藏,top-16 里 14 个是侧栏根本不显示的目录(含家目录和一个 346MB 项目)。
// 更要命的是预热用 4 个 worker 并发,而 Node 的 libuv 线程池默认就是 4(全仓无
// UV_THREADPOOL_SIZE 设置):这 2.5 秒里预热占满池子,直接堵住用户正在等的那条
// 「拉当前项目会话列表」请求。所以这不只是浪费,是在拖慢首屏。

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

/**
 * 预热集选取:减去已隐藏的项目,再封上限。
 * @param {Array<{hash?:string}>} projects listProjects() 的输出(已按 lastActivity 降序)
 * @param {Set<string>|string[]} hidden   prefs.hiddenProjects,**按 hash 匹配**(不是 path)
 * @param {number} cap                    上限。8 = 当前可见 4 的两倍余量;是个数字,不做成配置
 * @returns {Array} 原顺序的子集(绝不重排:listProjects 的降序就是「最可能点开」的判据)
 */
export function pickWarmupTargets(projects, hidden, cap = 8) {
  const set = hidden instanceof Set ? hidden : new Set(hidden || []);
  const list = Array.isArray(projects) ? projects : [];
  return list.filter((p) => p?.hash && !set.has(p.hash)).slice(0, Math.max(0, cap));
}

/**
 * 读 prefs.hiddenProjects。
 * 红线(R2):任何异常(文件不存在 / JSON 损坏 / 无该字段 / 字段类型不对)一律回落
 * **空 Set = 不过滤**,行为等同改动前。绝不能反向回落成「全过滤」—— 那会静默变成
 * 零预热且没人发现。
 */
export async function readHiddenProjects(prefsPath = join(homedir(), '.claude-gui', 'prefs.json')) {
  try {
    const prefs = JSON.parse(await readFile(prefsPath, 'utf-8'));
    const list = prefs?.hiddenProjects;
    return new Set(Array.isArray(list) ? list.filter((h) => typeof h === 'string') : []);
  } catch {
    return new Set(); // 回落「不过滤」,不是「全过滤」
  }
}
