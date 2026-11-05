// O16:运行时打开局域网(需要局域网 IP;实例 CGUI_TAURI=1,初始绑回环)。
// 已获用户同意:该实例在用例期间短暂绑 0.0.0.0(有已知随机密码);withInstance 的 finally 会杀掉实例并核对端口已释放。
import { test, expect } from '@playwright/test';
import { withInstance, pickPort, LAN_IP, sleep } from './helpers/world.mjs';
import {
  H, httpRequest, readProbe, loginProbe, wsProbe, cookieFrom, HOST_GATE_BODY,
  expectHttpBlocked, expectHttpAllowed, expectWsOpen, expectWsBlocked, describeHttp, describeWs,
} from './helpers/net.mjs';

test('O16 运行时打开局域网:打开前 Host 门拒绝,打开后同站放行(cookie 不带 Secure),他端口来源仍被拒', async () => {
  test.skip(!LAN_IP, '本机没有名字以 en 开头的非内部 IPv4 地址,无法做局域网用例(O16)');
  await withInstance({ label: 'o16', tauri: true }, async (i) => {
    const P = i.port;
    const lanHost = `${LAN_IP}:${P}`;
    const origin = `http://${lanHost}`;
    const lanHs = H({ host: lanHost, origin, sfs: 'same-origin' });

    // ① 回环绑定时,Host=局域网 IP 被 Host 门拦截
    const r1 = await readProbe(i, lanHs);
    expect.soft(r1.status, `O16① 打开前读探针:期望 403,实际 ${describeHttp(r1)}`).toBe(403);
    expect.soft((r1.text ?? '').trim(), 'O16① 打开前读探针正文应为 Host 门文案').toBe(HOST_GATE_BODY);

    // ② 运行时切到 0.0.0.0 并重新监听
    const net = await httpRequest({ port: P, method: 'POST', pathname: '/api/network', body: { host: '0.0.0.0', port: P } });
    expect.soft(net.status, `O16② POST /api/network:期望 200,实际 ${describeHttp(net)}`).toBe(200);
    expect.soft(net.json?.ok, `O16② POST /api/network 应答 ok,实际 ${describeHttp(net)}`).toBe(true);
    const rs = await httpRequest({ port: P, method: 'POST', pathname: '/api/restart', body: {} });
    expect.soft(rs.status, `O16② POST /api/restart:期望 200,实际 ${describeHttp(rs)}`).toBe(200);
    expect.soft(rs.json?.relistening, `O16② POST /api/restart 应答 relistening,实际 ${describeHttp(rs)}`).toBe(true);
    let reachable = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !reachable) {
      const h = await httpRequest({ port: P, target: LAN_IP, pathname: '/api/health', timeoutMs: 2000 });
      reachable = h.status === 200;
      if (!reachable) await sleep(300);
    }
    expect(reachable, `O16② 重新监听后 http://${lanHost}/api/health 应在 10 秒内可达`).toBe(true);

    // ③ 打开后:同站放行,登录 cookie 不带 Secure,WS 有 cookie 放行/无 cookie 401
    expectHttpAllowed(await readProbe(i, lanHs), 'O16③ 打开后读探针', { origin });
    const lg = await loginProbe(i, lanHs);
    expect.soft(lg.status, `O16③ 登录:期望 200,实际 ${describeHttp(lg)}`).toBe(200);
    const setCookie = [].concat(lg.headers['set-cookie'] || []).find((c) => c.startsWith('cgui_token=')) ?? '';
    expect.soft(setCookie.startsWith('cgui_token='), 'O16③ 登录应发 cgui_token cookie').toBe(true);
    expect.soft(/;\s*Secure\b/i.test(setCookie), `O16③ 明文 http 的局域网登录,cookie 不应带 Secure,实际 ${setCookie.replace(/(cgui_token=)[^;]*/, '$1<…>')}`).toBe(false);
    const cookie = cookieFrom(lg);
    expectWsOpen(await wsProbe(i, H({ host: lanHost, origin, sfs: 'same-origin', cookie })), 'O16③ WS 带 cookie');
    expect.soft(describeWs(await wsProbe(i, lanHs)), 'O16③ WS 无 cookie 期望 401').toBe('拒绝(401)');

    // ④ 同一局域网 IP 的另一个端口当来源 → 拒(带 cookie,排除"没登录"这个原因);带与不带 Sec-Fetch-Site 各测一次
    const Q = pickPort();
    for (const sfs of ['same-site', undefined]) {
      const hs = H({ host: lanHost, origin: `http://${LAN_IP}:${Q}`, sfs, cookie });
      expectHttpBlocked(await readProbe(i, hs), `O16④ Origin=http://${LAN_IP}:Q SFS=${sfs ?? '省略'} 读探针`);
      expectWsBlocked(await wsProbe(i, hs), `O16④ Origin=http://${LAN_IP}:Q SFS=${sfs ?? '省略'} WS`);
    }
  });
});
