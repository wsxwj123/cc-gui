// r145 复现测试共用件:临时 HOME 隔离、端口(只在 6700–6999 挑,硬拒 6677/6689/6710)、
// PATH 前挂的假命令、计数器。各用例文件自己决定场景,这里不放任何断言逻辑。
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createServer } from 'node:net';

// 6677 = 用户正在用的生产实例,6689 / 6710 = 其它常驻实例:任何情况下都不许 listen。
export const FORBIDDEN_PORTS = new Set([6677, 6689, 6710]);
const PORT_LO = 6700;
const PORT_HI = 6999;

/**
 * 必须先于任何 server 模块的 import 调用:server 里的路径常量在模块加载期按 homedir() 绑定,
 * import 之后再改 HOME 就会打到真实 ~/.claude。同时剥掉 ANTHROPIC_* 与代理变量(等价 env -u),
 * 并在 PATH 最前面挂一个空的假命令目录(由 writeFakeCommand 往里放 claude / security)。
 */
export function isolateHome(tag) {
  // 物理路径:macOS 的 tmpdir 在 /var(→ /private/var)下,被测代码里做 realpath 的门禁与 cwd 比较才对得上。
  const home = realpathSync(mkdtempSync(join(tmpdir(), `cgui-r145-${tag}-`)));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const k of Object.keys(process.env)) {
    if (/^ANTHROPIC_/.test(k) || /^(https?|all)_proxy$/i.test(k) || k === 'CLAUDE_CONFIG_DIR') delete process.env[k];
  }
  const bin = join(home, 'fakebin');
  mkdirSync(bin, { recursive: true });
  process.env.PATH = `${bin}${delimiter}${process.env.PATH || ''}`;
  return { home, bin, cleanup: () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* 尽力清 */ } } };
}

/** 假命令:<bin>/<name> 是一个 sh 包装,exec 当前 node 跑 <name>.impl.mjs(jsSource)。 */
export function writeFakeCommand(bin, name, jsSource) {
  const impl = join(bin, `${name}.impl.mjs`);
  writeFileSync(impl, jsSource);
  const sh = join(bin, name);
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

/** 在 6700–6999 里(随机起点)找一个能 listen 的端口并就地占住;禁用端口永远跳过。 */
export async function listenInRange(server, host = '127.0.0.1') {
  const span = PORT_HI - PORT_LO + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = PORT_LO + ((start + i) % span);
    if (FORBIDDEN_PORTS.has(port)) continue;
    const ok = await new Promise((resolve) => {
      const onErr = () => { server.removeListener('listening', onOk); resolve(false); };
      const onOk = () => { server.removeListener('error', onErr); resolve(true); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, host);
    });
    if (ok) return port;
  }
  throw new Error(`${PORT_LO}–${PORT_HI} 没有空闲端口`);
}

/** 给"自己会 listen 的模块"(如代理)挑一个当下空闲的端口:探测后立刻释放。 */
export async function pickPortInRange() {
  const probe = createServer();
  const port = await listenInRange(probe);
  await new Promise((r) => probe.close(r));
  return port;
}

export function assertPortAllowed(port, what) {
  if (!(port >= PORT_LO && port <= PORT_HI) || FORBIDDEN_PORTS.has(port)) {
    console.error(`[r145] ${what} 落在了不允许的端口 ${port},立即退出`);
    process.exit(2);
  }
}

/** 逐条记账:每条各自红绿,一条失败不影响后面的。 */
export function makeChecker(label) {
  let pass = 0;
  const failed = [];
  async function check(name, fn) {
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed.push(name);
      const msg = String((e && e.message) || e).split('\n').slice(0, 6).join('\n      ');
      console.log(`  ✗ ${name}\n      ${msg}`);
    }
  }
  function finish() {
    const total = pass + failed.length;
    console.log(`${label}: ${failed.length ? 'FAIL' : 'PASS'} (${pass}/${total})`);
    return failed.length ? 1 : 0;
  }
  return { check, finish };
}
