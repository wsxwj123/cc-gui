#!/usr/bin/env node
// r26-H3 单测:custom-providers.json 落盘 0600 + 原子写 + 旧文件启动收回。
// 隔离 HOME(mkdtemp),绝不碰真实 ~/.claude-gui。端口 6703。
// 哨兵:①POST 创建后 stat mode&0o777 === 0o600;②落盘是原子写(rename 后无 tmp 残留);
// ③旧 0644 文件经 ensureCustomProvidersMode 收 0600;④文件内容仍是合法 JSON。
// Run: node tests/unit/check-custom-providers-mode.mjs
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

const home = await mkdtemp(join(tmpdir(), 'cgui-h3-'));
process.env.HOME = home; // 必须先于 import:路径常量在模块加载期绑定
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%,不同设沙箱失效

const express = (await import('express')).default;
const settingsRoutes = (await import('../../server/routes/settings.js')).default;
const { ensureCustomProvidersMode } = await import('../../server/routes/settings.js');

const FILE = join(home, '.claude-gui', 'custom-providers.json');
const isWin = process.platform === 'win32';

const app = express();
app.use(express.json());
app.use('/api', settingsRoutes);
const server = await new Promise((res, rej) => {
  const s = app.listen(6703, '127.0.0.1', () => res(s));
  s.once('error', rej);
});

let failure = null;
try {
  // ① 创建 provider → 落盘 0600
  const r = await fetch('http://127.0.0.1:6703/api/custom-providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'h3-test', type: 'openai',
      baseURL: 'http://127.0.0.1:9', // 回环豁免 SSRF 闸,且永不真连
      apiKey: 'sk-test-dummy-not-real', models: ['m1'],
    }),
  });
  ok(r.status === 200, `创建 provider 应 200(实际 ${r.status}: ${await r.clone().text().catch(() => '')})`);
  if (!isWin) {
    const mode = (await stat(FILE)).mode & 0o777;
    ok(mode === 0o600, `落盘权限必须 0600(实际 ${mode.toString(8)})`);
  }
  // ④ 内容合法
  const parsed = JSON.parse(await readFile(FILE, 'utf8'));
  ok(Array.isArray(parsed) && parsed.length === 1 && parsed[0].name === 'h3-test', '落盘内容是合法 JSON 且含新条目');

  // ② 原子写:目录里无 tmp 残留
  const leftovers = (await readdir(join(home, '.claude-gui'))).filter((f) => f.includes('.tmp-'));
  ok(leftovers.length === 0, `原子写不留 tmp 残留(发现 ${leftovers.join(',') || '无'})`);

  // ③ 旧文件 0644 → ensureCustomProvidersMode 收 0600(模拟升级前的存量文件)
  if (!isWin) {
    // 注意:对已存在文件 writeFile 的 mode 不生效(只在创建时),夹具必须显式 chmod。
    const { chmod } = await import('node:fs/promises');
    await chmod(FILE, 0o644);
    ok(((await stat(FILE)).mode & 0o777) === 0o644, '夹具:先造一个 0644 旧文件');
    await ensureCustomProvidersMode();
    ok(((await stat(FILE)).mode & 0o777) === 0o600, 'ensureCustomProvidersMode 必须收回 0600');
    await ensureCustomProvidersMode(); // ENOENT 路径:删掉文件后调用不抛
    await import('node:fs/promises').then((fs) => fs.unlink(FILE));
    await ensureCustomProvidersMode();
    ok(true, '文件不存在时 ensureCustomProvidersMode 静默不抛');
  }
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}
if (failure) throw failure;
console.log(`PASS check-custom-providers-mode (${n} assertions)`);
