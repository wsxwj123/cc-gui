// O12-O14:隧道放行、隧道 Host 被改写的旧形态仍拒、拒绝日志格式(含注入与截断)。
import { test, expect } from '@playwright/test';
import { withInstance, pickPort, TUNNEL_HOST, logSize, waitLogSince } from './helpers/world.mjs';
import {
  H, CF, tunnelHeaders, readProbe, loginProbe, authProbe, wsProbe, rawRequest, wsUpgradeNoHost, cookieFrom, localCookie,
  expectHttpBlocked, expectWsOpen, expectWsBlocked, describeHttp, describeWs,
} from './helpers/net.mjs';

const mask = (setCookie) => String(setCookie).replace(/(cgui_token=)[^;]*/, '$1<…>');

test('O12 隧道放行:登录带 Secure 的 cookie;鉴权层 401/200;WS 有 cookie 放行无 cookie 401;显式 :443 放行;换端口的 Origin 被拒', async () => {
  await withInstance({ label: 'o12', tunnelHostname: TUNNEL_HOST }, async (i) => {
    // ① 隧道形态登录
    const lg = await loginProbe(i, tunnelHeaders());
    expect.soft(lg.status, `O12① 隧道登录:期望 200,实际 ${describeHttp(lg)}`).toBe(200);
    expect.soft((lg.text ?? '').trim(), 'O12① 登录正文').toBe('{"ok":true}');
    const setCookie = [].concat(lg.headers['set-cookie'] || []).find((c) => c.startsWith('cgui_token=')) ?? '';
    expect.soft(setCookie.startsWith('cgui_token='), `O12① 应发 cgui_token cookie,实际 Set-Cookie=${JSON.stringify(lg.headers['set-cookie'] ? '有但无 cgui_token' : '无')}`).toBe(true);
    expect.soft(/;\s*Secure\b/i.test(setCookie), `O12① 隧道登录的 cookie 应带 Secure,实际 ${mask(setCookie)}`).toBe(true);
    const cookie = cookieFrom(lg);
    // ② 鉴权层:来源校验已放行,由鉴权层回应
    const noCookie = await authProbe(i, tunnelHeaders());
    expect.soft(noCookie.status, `O12② 无 cookie 鉴权探针:期望 401,实际 ${describeHttp(noCookie)}`).toBe(401);
    expect.soft(noCookie.json, 'O12② 无 cookie 鉴权探针正文').toEqual({ error: 'unauthorized', authRequired: true });
    const withCookie = await authProbe(i, tunnelHeaders({ cookie }));
    expect.soft(withCookie.status, `O12② 带 cookie 鉴权探针:期望 200,实际 ${describeHttp(withCookie)}`).toBe(200);
    // ③ WS
    expectWsOpen(await wsProbe(i, tunnelHeaders({ cookie })), 'O12③ WS 带 cookie');
    const wsNo = await wsProbe(i, tunnelHeaders());
    expect.soft(describeWs(wsNo), 'O12③ WS 不带 cookie 期望 401').toBe('拒绝(401)');
    // ④ 显式默认端口
    const p443 = await authProbe(i, tunnelHeaders({ host: `${TUNNEL_HOST}:443`, cookie }));
    expect.soft(p443.status, `O12④ Host=${TUNNEL_HOST}:443 + 同 Origin,带 cookie 鉴权探针:期望 200,实际 ${describeHttp(p443)}`).toBe(200);
    // ⑤ 端口不同的 Origin
    expectHttpBlocked(await readProbe(i, tunnelHeaders({ origin: `https://${TUNNEL_HOST}:8443` })), 'O12⑤ Origin 带 :8443 读探针');
  });
});

test('O13 隧道 Host 被前置代理改写成 localhost 的旧形态仍拒(带与不带 CF 头)', async () => {
  await withInstance({ label: 'o13', tunnelHostname: TUNNEL_HOST }, async (i) => {
    const cookie = await localCookie(i); // 给 WS 带上,401 只可能来自来源校验
    expect(cookie, '前置:本机形态用正确密码登录应拿到 cgui_token').not.toBeNull();
    for (const [name, extra] of [['带 CF 头', CF], ['不带 CF 头', {}]]) {
      const v = { host: `localhost:${i.port}`, origin: `https://${TUNNEL_HOST}`, sfs: 'same-origin', extra };
      expectHttpBlocked(await readProbe(i, H(v)), `O13 ${name} 读探针`);
      expectWsBlocked(await wsProbe(i, H({ ...v, cookie })), `O13 ${name} WS`);
    }
  });
});

// ───────────────────────── O14 拒绝日志格式 ─────────────────────────
const V = '(?:null|"(?:[^"\\\\]|\\\\.)*")'; // 字面量 null 或 JSON 字符串字面量
const HTTP_RE = new RegExp(`^\\[cors\\] blocked origin=(${V}) host=(${V}) path=(${V}) sfs=(${V}) rule=([a-z-]+) rawHost=(${V})$`);
const WS_RE = new RegExp(`^\\[ws\\] blocked origin=(${V}) host=(${V}) sfs=(${V}) rule=([a-z-]+) rawHost=(${V})$`);

/** 取"该请求发出前后"的日志增量里第一条整行匹配格式的拒绝行。 */
async function grab(i, off, kind) {
  const marker = kind === 'http' ? '[cors] blocked' : '[ws] blocked origin=';
  const text = await waitLogSince(i, off, (t) => t.includes(marker), 1500);
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.includes(marker));
  const re = kind === 'http' ? HTTP_RE : WS_RE;
  const m = lines.map((l) => re.exec(l)).find(Boolean) ?? null;
  return { m, lines, f: m && (kind === 'http' ? { origin: m[1], sfs: m[4], rule: m[5], rawHost: m[6] } : { origin: m[1], sfs: m[3], rule: m[4], rawHost: m[5] }) };
}
function expectLine(g, tag, kind, rule, { sfsNull = false, rawHostNull = false } = {}) {
  expect.soft(g.m, `O14 ${tag} ${kind}:增量里应有整行匹配格式的拒绝行,实际候选行 ${JSON.stringify(g.lines)}`).not.toBeNull();
  if (!g.f) return;
  expect.soft(g.f.rule, `O14 ${tag} ${kind}:rule 字段`).toBe(rule);
  if (sfsNull) expect.soft(g.f.sfs, `O14 ${tag} ${kind}:没发 Sec-Fetch-Site 时 sfs 应为字面量 null`).toBe('null');
  if (rawHostNull) expect.soft(g.f.rawHost, `O14 ${tag} ${kind}:没发 Host 时 rawHost 应为字面量 null`).toBe('null');
}

test('O14 拒绝日志格式:HTTP/WS 两种整行格式、rule 取值与判定先后、注入被关在引号里、超长 Origin 被截断', async () => {
  await withInstance({ label: 'o14' }, async (i) => {
    const P = i.port;
    const Q = pickPort();
    const host = `127.0.0.1:${P}`;
    const httpCase = async (tag, hs, rule, opts) => {
      const off = logSize(i);
      await readProbe(i, hs);
      expectLine(await grab(i, off, 'http'), tag, 'HTTP', rule, opts);
    };
    const wsCase = async (tag, hs, rule, opts) => {
      const off = logSize(i);
      await wsProbe(i, hs);
      expectLine(await grab(i, off, 'ws'), tag, 'WS', rule, opts);
    };
    const o5_1 = H({ host: `localhost:${P}`, origin: `http://localhost:${Q}`, sfs: 'same-site' });
    const o5_4 = H({ host: `localhost:${P}`, origin: `http://localhost:${Q}` });
    const o8null = H({ host, origin: 'null' });
    const o6 = H({ host, origin: `http://${host}`, sfs: 'cross-site' });
    // HTTP 行
    await httpCase('O5① 他端口+same-site', o5_1, 'sfs-veto');
    await httpCase('O5④ 他端口+省略SFS', o5_4, 'site-mismatch', { sfsNull: true });
    await httpCase('O8 Origin=null', o8null, 'bad-origin', { sfsNull: true });
    await httpCase('O6 cross-site', o6, 'sfs-veto');
    await httpCase('先后:Origin=null 又 cross-site', H({ host, origin: 'null', sfs: 'cross-site' }), 'bad-origin');
    let off = logSize(i);
    await rawRequest(P, `GET /api/health HTTP/1.0\r\nOrigin: http://localhost:${P}\r\n\r\n`);
    expectLine(await grab(i, off, 'http'), 'O9(a) 无 Host', 'HTTP', 'no-host', { sfsNull: true, rawHostNull: true });
    off = logSize(i);
    await rawRequest(P, `GET /api/health HTTP/1.0\r\nOrigin: http://localhost:${P}\r\nSec-Fetch-Site: cross-site\r\n\r\n`);
    expectLine(await grab(i, off, 'http'), '先后:无 Host 又 cross-site', 'HTTP', 'sfs-veto', { rawHostNull: true });
    // WS 行
    await wsCase('O5① 他端口+same-site', o5_1, 'sfs-veto');
    await wsCase('O8 Origin=null', o8null, 'bad-origin', { sfsNull: true });
    await wsCase('O6 cross-site', o6, 'sfs-veto');
    off = logSize(i);
    await rawRequest(P, wsUpgradeNoHost(`http://localhost:${P}`));
    expectLine(await grab(i, off, 'ws'), 'O9(d) 无 Host', 'WS', 'no-host', { sfsNull: true, rawHostNull: true });
    // 注入:Origin 里带空格和伪造的 rule=same-site
    off = logSize(i);
    await readProbe(i, H({ host, origin: 'http://x rule=same-site' }));
    expectLine(await grab(i, off, 'http'), '注入 Origin="http://x rule=same-site"', 'HTTP', 'bad-origin');
    off = logSize(i);
    await wsProbe(i, H({ host, origin: 'http://x rule=same-site' }));
    expectLine(await grab(i, off, 'ws'), '注入 Origin="http://x rule=same-site"', 'WS', 'bad-origin');
    // 截断:300 个 a
    for (const kind of ['http', 'ws']) {
      off = logSize(i);
      if (kind === 'http') await readProbe(i, H({ host, origin: 'a'.repeat(300) })); else await wsProbe(i, H({ host, origin: 'a'.repeat(300) }));
      const g = await grab(i, off, kind);
      expect.soft(g.m, `O14 超长 Origin ${kind}:增量里应有整行匹配格式的拒绝行,实际候选行(截前 300 字符)${JSON.stringify(g.lines.map((l) => l.slice(0, 300)))}`).not.toBeNull();
      if (g.f) {
        const longest = Math.max(0, ...((g.f.origin.match(/a+/g) ?? []).map((s) => s.length)));
        expect.soft(longest, `O14 超长 Origin ${kind}:origin= 字面量里连续原始字符应不超过 200 个,实际 ${longest}`).toBeLessThanOrEqual(200);
      }
    }
  });
});
