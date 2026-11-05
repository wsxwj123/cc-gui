// O9-O11:没有 Host 头(原始 socket)、DNS 重绑定防护不变、非 /api 路径的拒绝形态与放行时的 Vary。
import { test, expect } from '@playwright/test';
import { withInstance, logSize, waitLogSince } from './helpers/world.mjs';
import {
  H, readProbe, wsProbe, rawRequest, wsUpgradeNoHost, BLOCK_BODY, HOST_GATE_BODY,
  expectHttpBlocked, expectHttpAllowed, describeHttp, describeWs,
} from './helpers/net.mjs';

const shown = (r) => `${r.status} ${(r.body ?? '').slice(0, 100)}${r.error ? ` [${r.error}]` : ''}`;

test('O9 没有 Host 头(原始 socket):HTTP/1.0 带 Origin 403、不带 200;HTTP/1.1 缺 Host 400;WS 升级带 Origin 401、不带 101', async () => {
  await withInstance({ label: 'o9' }, async (i) => {
    const P = i.port;
    const a = await rawRequest(P, `GET /api/health HTTP/1.0\r\nOrigin: http://localhost:${P}\r\n\r\n`);
    expect.soft(a.status, `O9(a) HTTP/1.0 无 Host + Origin:期望 403,实际 ${shown(a)}`).toBe(403);
    expect.soft((a.body ?? '').trim(), 'O9(a) 正文应为固定的来源拒绝文案').toBe(BLOCK_BODY);
    const b = await rawRequest(P, 'GET /api/health HTTP/1.0\r\n\r\n');
    expect.soft(b.status, `O9(b) HTTP/1.0 无 Host 无 Origin:期望 200,实际 ${shown(b)}`).toBe(200);
    const c = await rawRequest(P, 'GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n');
    expect.soft(c.status, `O9(c) HTTP/1.1 无 Host:期望 400(Node 自己拒),实际 ${shown(c)}`).toBe(400);
    const d1 = await rawRequest(P, wsUpgradeNoHost(`http://localhost:${P}`));
    expect.soft(d1.status, `O9(d) WS 升级无 Host + Origin:期望 401,实际 ${shown(d1)}`).toBe(401);
    const d2 = await rawRequest(P, wsUpgradeNoHost());
    expect.soft(d2.status, `O9(d) WS 升级无 Host 无 Origin:期望 101,实际 ${shown(d2)}`).toBe(101);
  });
});

test('O10 DNS 重绑定防护不变:Host=evil.com 时读/GET //WS 仍由 Host 门拦截,不走到来源校验', async () => {
  await withInstance({ label: 'o10' }, async (i) => {
    const hs = H({ host: `evil.com:${i.port}`, origin: `http://evil.com:${i.port}` });
    const off = logSize(i);
    const r1 = await readProbe(i, hs);
    const r2 = await readProbe(i, hs, '/');
    const w = await wsProbe(i, hs);
    const log = await waitLogSince(i, off, (t) => t.includes('[ws] blocked host='), 2000);
    for (const [name, r] of [['GET /api/health', r1], ['GET /', r2]]) {
      expect.soft(r.status, `O10 ${name}:期望 403,实际 ${describeHttp(r)}`).toBe(403);
      expect.soft((r.text ?? '').trim(), `O10 ${name}:正文应为 Host 门文案`).toBe(HOST_GATE_BODY);
    }
    expect.soft(describeWs(w), 'O10 WS 握手期望被拒绝 401').toBe('拒绝(401)');
    expect.soft(log.includes('[ws] blocked host='), `O10 日志增量应含 "[ws] blocked host=" 行(Host 门的行),实际增量 ${JSON.stringify(log.slice(0, 300))}`).toBe(true);
    expect.soft(/blocked origin=/.test(log), `O10 日志增量里不得有 "blocked origin=" 行(请求在 Host 门就被拦),实际增量 ${JSON.stringify(log.slice(0, 300))}`).toBe(false);
  });
});

test('O11 非 /api 路径被拒时 JSON 形态、无堆栈无绝对路径;同站放行的读探针带 Vary: Origin', async () => {
  await withInstance({ label: 'o11' }, async (i) => {
    const host = `127.0.0.1:${i.port}`;
    const bad = H({ host, origin: 'http://evil.example' });
    for (const p of ['/', '/assets/x.js']) {
      const r = await readProbe(i, bad, p);
      expectHttpBlocked(r, `O11 GET ${p}`);
      for (const frag of ['Error:', '    at ', '/Users/', 'node_modules']) {
        expect.soft((r.text ?? '').includes(frag), `O11 GET ${p}:正文不得出现 ${JSON.stringify(frag)}(无堆栈、无绝对路径),实际正文 ${JSON.stringify((r.text ?? '').slice(0, 200))}`).toBe(false);
      }
    }
    const origin = `http://${host}`;
    expectHttpAllowed(await readProbe(i, H({ host, origin, sfs: 'same-origin' })), 'O11 对照:同站放行的读探针', { origin });
  });
});
