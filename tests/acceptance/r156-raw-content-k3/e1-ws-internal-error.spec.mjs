// E1:WebSocket 握手里出现内部异常 → 立即 401,不挂起,不冒未捕获异常。修复前红(握手挂到客户端超时,日志出现 [uncaughtException])。
// 触发方式(只用对外可见的配置文件):把假家目录里的 network.json 改写成带 tunnelHostname 且没有 tokenSecret 键,再 chmod 0444;
// 然后以隧道主机名 + 带 cgui_token cookie 发握手。收尾 chmod 0644 复原。
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { withInstance, logSize, waitLogSince, listenerPids } from './helpers/world.mjs';
import { httpRequest, wsProbe, describeHttp } from './helpers/net.mjs';

test('E1 握手内部异常:3 秒内 401,后端仍是原进程并在监听,日志有 rule=internal-error 且无 [uncaughtException]', async () => {
  await withInstance({ label: 'e1' }, async (inst) => {
    const cur = JSON.parse(fs.readFileSync(inst.netJson, 'utf8')); // 假家目录里的配置,只取 passwordHash 原样带回
    fs.writeFileSync(inst.netJson, JSON.stringify({ host: '127.0.0.1', port: inst.port, passwordHash: cur.passwordHash, tunnelHostname: 't.example.com' }));
    fs.chmodSync(inst.netJson, 0o444);
    try {
      const off = logSize(inst);
      const w = await wsProbe(inst.port, { Host: 't.example.com', Origin: 'https://t.example.com', Cookie: 'cgui_token=x.y' }, { timeoutMs: 3000 });
      expect.soft(w.kind, `E1 握手:3 秒内应收到被拒应答,实际 ${w.kind}${w.status ? ` ${w.status}` : ''}${w.error ? ` ${w.error}` : ''}(耗时 ${w.ms}ms;timeout=握手挂住)`).toBe('rejected');
      expect.soft(w.status, 'E1 握手:HTTP 状态应为 401').toBe(401);

      const health = await httpRequest({ port: inst.port, pathname: '/api/health' });
      expect.soft(health.status, `E1 之后 /api/health(Host=127.0.0.1:端口)应仍 200,实际 ${describeHttp(health)}`).toBe(200);
      expect.soft(inst.isAlive(), 'E1:后端进程应仍是起初那个 pid 且没退出').toBe(true);
      expect.soft(listenerPids(inst.port).includes(inst.pid), 'E1:起初那个 pid 应仍在监听端口').toBe(true);

      const re = /^\[ws\] blocked .*rule=internal-error/m;
      const text = await waitLogSince(inst, off, (t) => re.test(t), 2000);
      expect.soft(re.test(text), 'E1:握手期间日志增量里应有一行 [ws] blocked … rule=internal-error').toBe(true);
      expect.soft(text.includes('[uncaughtException]'), 'E1:握手期间日志增量里不得出现 [uncaughtException]').toBe(false);
    } finally {
      try { fs.chmodSync(inst.netJson, 0o644); } catch { /* 文件不在 */ }
    }
  });
});
