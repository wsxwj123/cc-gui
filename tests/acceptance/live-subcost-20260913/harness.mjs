// 直播子代理金额验收的夹具:起一份完全隔离的 CC-GUI(临时 HOME + PATH 上的假 claude)。
// 红线与 r64-genui/browser/harness.js 一致:绝不碰 6677/6689,绝不写真实 ~/.claude。
// 端口写死在本文件的 PORTS 里(不从环境变量取默认值 —— 本批踩过"继承了 PORT=6677 打真实例")。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');

/** 允许的端口(写死;6795/6796 与 r64 的 6703-6710、本批隔离实例的 6790 都不重叠)。 */
export const PORTS = [6795, 6796];

const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ } };

async function waitHealthy(port, proc, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`隔离实例没起来(端口 ${port})。日志尾部:\n${String(proc.__log || '').slice(-2000)}`);
}

export async function startApp() {
  let port = null;
  for (const p of PORTS) {
    const busy = await fetch(`http://127.0.0.1:${p}/api/health`).then(() => true).catch(() => false);
    if (!busy) { port = p; break; }
  }
  if (port === null) throw new Error(`测试端口 ${PORTS.join('/')} 都被占着(别的实例没退干净?)。本夹具不抢别人的端口。`);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), `cgui-live-subcost-home-${port}-`));
  // realpath 必须:macOS 的 /var → /private/var 会让子进程的 cwd 与本进程拿到的串不同,
  // 编码出的 projects 目录名随之不同(假 CLI 落盘的转写服务端就读不到)。
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cgui-live-subcost-proj-${port}-`)));
  const bin = path.join(home, 'fakebin');
  const projectDir = path.join(home, '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  fs.mkdirSync(path.join(home, 'fake-claude'), { recursive: true });
  // 首启三层整屏浮层(指引/更新说明/权限说明)会吃掉第一次点击,预置成"已看过"。
  const appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: appVersion }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), new Date().toISOString());
  // 计费口径:临时 HOME 里没有任何凭证 → 官方 provider 无 AUTH_TOKEN ⇒ 客户端判成"订阅包月",
  // 一律不显示金额(isSubscriptionBilling,这是产品设计)。本用例量的是「金额有没有到卡片上」,
  // 所以给一份假 token 把口径钉成按量付费。假 CLI 不碰凭证,不会被用到。
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-e2e-local-test' } }));

  const shim = path.join(bin, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);

  const proc = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}:${process.env.PATH}`,
      CGUI_FAKE_CLAUDE_DIR: path.join(home, 'fake-claude'),
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.__log = '';
  proc.stdout.on('data', (b) => { proc.__log += b; });
  proc.stderr.on('data', (b) => { proc.__log += b; });

  const health = await waitHealthy(port, proc);
  return {
    port, home, cwd, projectDir, proc, health,
    baseURL: `http://127.0.0.1:${port}`,
    ctlDir: path.join(home, 'fake-claude'),
    /** 遥控假 CLI:写文件 = 放行一步(见 fake-claude.mjs 的三段式)。 */
    ctl: {
      go: () => fs.writeFileSync(path.join(home, 'fake-claude', 'go'), String(Date.now())),
      finish: () => fs.writeFileSync(path.join(home, 'fake-claude', 'finish'), String(Date.now())),
    },
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
      if (proc.exitCode === null) proc.kill('SIGKILL');
      rmrf(home); rmrf(cwd);
    },
  };
}
