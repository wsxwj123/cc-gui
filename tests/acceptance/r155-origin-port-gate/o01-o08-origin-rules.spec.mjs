// O1-O8:真实后端 + 原始请求头(Node 客户端伪造 Host/Origin/Sec-Fetch-Site,不开浏览器)。
// 依据:.devflow/r155-origin-port-gate-接口.md §4 A 组。一个用例里的多个输入用 expect.soft,失败信息里带输入标签。
import { test, expect } from '@playwright/test';
import { withInstance, pickPort, WRONG_PASSWORD } from './helpers/world.mjs';
import {
  H, readProbe, loginProbe, preflightProbe, wsProbe, localCookie,
  expectHttpBlocked, expectHttpAllowed, expectWsOpen, expectWsBlocked, describeHttp, acaNames,
} from './helpers/net.mjs';

test('O1 无 Origin 的请求照旧放行:读 200 且不带 ACAO,WS 放行', async () => {
  await withInstance({ label: 'o1' }, async (i) => {
    const hs = H({ host: `127.0.0.1:${i.port}` });
    const r = await readProbe(i, hs);
    expect.soft(r.status, `读探针:期望 200,实际 ${describeHttp(r)}`).toBe(200);
    expect.soft(r.headers['access-control-allow-origin'], '没有 Origin 时不得带 Access-Control-Allow-Origin').toBeUndefined();
    expectWsOpen(await wsProbe(i, hs), 'O1 无 Origin');
  });
});

test('O2 同站放行(127.0.0.1 / localhost / [::1] 三种别名,带与不带 Sec-Fetch-Site)', async () => {
  await withInstance({ label: 'o2' }, async (i) => {
    for (const alias of [`127.0.0.1:${i.port}`, `localhost:${i.port}`, `[::1]:${i.port}`]) {
      for (const sfs of ['same-origin', undefined]) {
        const origin = `http://${alias}`;
        const hs = H({ host: alias, origin, sfs });
        const tag = `O2 Host=Origin主机=${alias} Sec-Fetch-Site=${sfs ?? '省略'}`;
        expectHttpAllowed(await readProbe(i, hs), `${tag} 读探针`, { origin });
        expectHttpAllowed(await preflightProbe(i, hs), `${tag} 预检`, { origin, status: 204, vary: false });
        expectWsOpen(await wsProbe(i, hs), `${tag} WS`);
      }
    }
  });
});

test('O3 开发代理形态放行:Host=localhost:P、Origin=http://127.0.0.1:V、Sec-Fetch-Site=same-origin', async () => {
  await withInstance({ label: 'o3' }, async (i) => {
    const origin = `http://127.0.0.1:${pickPort()}`;
    const hs = H({ host: `localhost:${i.port}`, origin, sfs: 'same-origin' });
    expectHttpAllowed(await readProbe(i, hs), 'O3 读探针', { origin });
    const w = await loginProbe(i, hs);
    expect.soft(w.status, `O3 写探针(正确密码):期望 200,实际 ${describeHttp(w)}`).toBe(200);
    expect.soft((w.text ?? '').trim(), 'O3 写探针正文').toBe('{"ok":true}');
    expectWsOpen(await wsProbe(i, hs), 'O3 WS');
  });
});

test('O4 开发代理形态的五种变体一律拒(加 CF 头 / SFS 大写 / 省略 SFS / SFS=none / 陌生 Origin)', async () => {
  await withInstance({ label: 'o4' }, async (i) => {
    const cookie = await localCookie(i); // 给 WS 带上,这样 401 只可能来自来源校验,而不是"没登录"
    expect(cookie, '前置:本机形态用正确密码登录应拿到 cgui_token').not.toBeNull();
    const base = { host: `localhost:${i.port}`, origin: `http://127.0.0.1:${pickPort()}`, sfs: 'same-origin' };
    const variants = [
      ['(a) 加 CF-Ray', { ...base, extra: { 'CF-Ray': 'x' } }],
      ['(b) Sec-Fetch-Site 大写 SAME-ORIGIN', { ...base, sfs: 'SAME-ORIGIN' }],
      ['(c) 省略 Sec-Fetch-Site', { ...base, sfs: undefined }],
      ['(d) Sec-Fetch-Site=none', { ...base, sfs: 'none' }],
      ['(e) Origin 换成 http://evil.example', { ...base, origin: 'http://evil.example' }],
    ];
    for (const [name, v] of variants) {
      expectHttpBlocked(await readProbe(i, H(v)), `O4${name} 读探针`);
      expectWsBlocked(await wsProbe(i, H({ ...v, cookie })), `O4${name} WS`);
    }
  });
});

test('O5 他端口网页被拒:读/预检/错误密码写/WS 四个探针 × 四组 Host/Origin/SFS,写探针必须是 403 而不是 401 密码错误', async () => {
  const Q = pickPort();
  // 同一实例里错误密码最多发 3 次(会触发 429 限速),四组各发 1 次 → 分两个实例,每个 2 次
  const groups = (P) => [
    ['①localhost:P ← http://localhost:Q, same-site', H({ host: `localhost:${P}`, origin: `http://localhost:${Q}`, sfs: 'same-site' })],
    ['②127.0.0.1:P ← http://127.0.0.1:Q, same-site', H({ host: `127.0.0.1:${P}`, origin: `http://127.0.0.1:${Q}`, sfs: 'same-site' })],
    ['③localhost:P ← http://127.0.0.1:Q, cross-site', H({ host: `localhost:${P}`, origin: `http://127.0.0.1:${Q}`, sfs: 'cross-site' })],
    ['④localhost:P ← http://localhost:Q, 省略 SFS', H({ host: `localhost:${P}`, origin: `http://localhost:${Q}` })],
  ];
  const run = async (i, list) => {
    for (const [name, hs] of list) {
      expectHttpBlocked(await readProbe(i, hs), `O5${name} 读探针`);
      const pf = await preflightProbe(i, hs);
      expect.soft(pf.status, `O5${name} 预检:期望 403,实际 ${describeHttp(pf)}`).toBe(403);
      expect.soft(acaNames(pf), `O5${name} 预检:响应里不得有任何 Access-Control-Allow-* 头`).toEqual([]);
      const w = await loginProbe(i, hs, WRONG_PASSWORD);
      expect.soft(w.status, `O5${name} 错误密码写探针:期望 403(处理器没执行),实际 ${describeHttp(w)}`).toBe(403);
      expectWsBlocked(await wsProbe(i, hs), `O5${name} WS`);
    }
  };
  await withInstance({ label: 'o5a' }, async (i) => run(i, groups(i.port).slice(0, 2)));
  await withInstance({ label: 'o5b' }, async (i) => run(i, groups(i.port).slice(2)));
});

test('O6 浏览器自报跨站即拒(站点文本相同也拒);对照 same-origin / none 放行', async () => {
  await withInstance({ label: 'o6' }, async (i) => {
    const host = `127.0.0.1:${i.port}`;
    const origin = `http://127.0.0.1:${i.port}`;
    for (const sfs of ['cross-site', 'same-site', 'Same-Site', 'same-origin, same-site']) {
      const hs = H({ host, origin, sfs });
      expectHttpBlocked(await readProbe(i, hs), `O6 SFS=${sfs} 读探针`);
      expectWsBlocked(await wsProbe(i, hs), `O6 SFS=${sfs} WS`);
    }
    for (const sfs of ['same-origin', 'none']) {
      const hs = H({ host, origin, sfs });
      expectHttpAllowed(await readProbe(i, hs), `O6 对照 SFS=${sfs} 读探针`, { origin });
      expectWsOpen(await wsProbe(i, hs), `O6 对照 SFS=${sfs} WS`);
    }
  });
});

test('O7 跨协议同默认端口:Host=localhost、Origin=https://localhost、SFS=cross-site 被拒', async () => {
  await withInstance({ label: 'o7' }, async (i) => {
    const hs = H({ host: 'localhost', origin: 'https://localhost', sfs: 'cross-site' });
    expectHttpBlocked(await readProbe(i, hs), 'O7 读探针');
    expectWsBlocked(await wsProbe(i, hs), 'O7 WS');
  });
});

test('O8 非法 Origin 写法一律拒(null / chrome-extension / ftp / 尾斜杠 / 大写主机名)', async () => {
  await withInstance({ label: 'o8' }, async (i) => {
    const host = `127.0.0.1:${i.port}`;
    const origins = ['null', 'chrome-extension://abcdef', `ftp://127.0.0.1:${i.port}`, `http://127.0.0.1:${i.port}/`, `http://LOCALHOST:${i.port}`];
    for (const origin of origins) {
      // 带 same-origin:排除"因为浏览器自报跨站才被拒",证明拒绝是冲着 Origin 的写法本身
      const hs = H({ host, origin, sfs: 'same-origin' });
      expectHttpBlocked(await readProbe(i, hs), `O8 Origin=${origin} 读探针`);
      expectWsBlocked(await wsProbe(i, hs), `O8 Origin=${origin} WS`);
    }
  });
});
