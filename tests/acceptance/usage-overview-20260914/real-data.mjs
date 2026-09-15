// U8:真实数据口径(只读软链 ~/.claude/projects 进隔离 HOME)。
//
// 判据:修后**进程冷启动**的首请求墙钟 < 1s。修前 = 一次全盘扫描(实测 41800ms)。
// 口径说明:冷启动 ≠ 无磁盘缓存。用户报的痛点是"每次重启 GUI 打开用量都要等",
// 所以量的是「磁盘缓存已存在 → 重启 → 首请求」。相位 1 先真扫一次把缓存造出来
// (这一步的耗时等于修前的每一次首请求),相位 2 重启后量。
//
//   ./run-isolated.sh --real
//
// 只读:软链指向真实 projects,夹具 HOME 在本套件 .artifacts 里;用户的
// ~/.claude 与 ~/.claude-gui 一个字节都不写。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, group, summary, assertTrue, assertLt } from './helpers/harness.mjs';
import { startInstance, stopInstance, getUsage, waitForCache, sleep, cachePath } from './helpers/runtime.mjs';
import { ROOT } from './helpers/fixtures.mjs';

const realHome = process.env.HOME || os.homedir();
const realProjects = path.join(realHome, '.claude', 'projects');

async function walk(dir, acc) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (e.name.endsWith('.jsonl')) {
      try { acc.files++; acc.bytes += (await fs.promises.stat(p)).size; } catch { /* 忽略读不到的 */ }
    }
  }
  return acc;
}

/** 真实数据用的隔离 HOME:`.claude/projects` 只读软链到用户真实目录。 */
function realDataHome() {
  const home = path.join(ROOT, 'home-real');
  fs.rmSync(home, { recursive: true, force: true });   // 每次从零:相位 1 必须是真冷扫
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(realProjects, path.join(home, '.claude', 'projects'), 'dir');
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  return home;
}

group('U8 真实数据:重启后首请求 < 1s');
const home = realDataHome();
console.log(`[real] 只读软链 ${realProjects}`);
const acc = await walk(realProjects, { files: 0, bytes: 0 });
console.log(`[real] 数据规模 ${acc.files} 个 jsonl / ${(acc.bytes / 1048576).toFixed(0)}MB`);

let inst = await startInstance({ home, label: 'real-seed' });
const seed = await getUsage({ timeoutMs: 600_000 });
console.log(`[real] 相位1 冷路径(造缓存)${seed.ms.toFixed(0)}ms,HTTP ${seed.status}`);
const raw = await waitForCache(home, { timeoutMs: 20_000 });
await test('U8-pre', '磁盘缓存被写出(相位 2 的前提;修前这条就是红的)', () => {
  assertTrue(raw, `冷路径返回后 20 秒内没写出 ${cachePath(home)} —— 修前无磁盘持久化`);
  return `${(raw.length / 1024).toFixed(0)}KB`;
});
await stopInstance(inst);

inst = await startInstance({ home, label: 'real-restart' });
const first = await getUsage({ timeoutMs: 120_000 });
const second = await getUsage({ timeoutMs: 120_000 });
await test('U8', '新进程首请求墙钟 < 1s(修前 39754ms)', () => {
  assertTrue(first.status === 200 && first.body, `HTTP ${first.status}: ${first.text.slice(0, 200)}`);
  assertTrue(first.body.total?.input > 0, 'total.input 为 0(真实数据没读进去)');
  // 先报墙钟(判据头条),再报佐证
  assertLt(first.ms, 1000, `新进程首请求 ${first.ms.toFixed(0)}ms(修前这一发 = 一次全盘扫描,约 39754ms)`);
  assertTrue(first.body.meta?.stale === true, `首请求应为磁盘回放(meta.stale=true),实际 ${JSON.stringify(first.body.meta)}`);
  return `首请求 ${first.ms.toFixed(0)}ms / 第二发 ${second.ms.toFixed(0)}ms / total.input=${first.body.total.input}`;
});
// 后台重算要读 6GB+,给它时间跑起来再收工(不然可能写坏缓存文件);不参与判据。
await sleep(3000);
await stopInstance(inst);

const code = summary('usage-overview-20260914 U8(真实数据)');
console.log(`[artifacts] 夹具 HOME ${home},日志与大夹具同在 ${ROOT}`);
process.exit(code);
