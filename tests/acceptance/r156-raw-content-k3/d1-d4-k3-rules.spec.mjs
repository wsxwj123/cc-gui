// D1-D4:K3 —— 无 Origin 的 /api/* 请求,Sec-Fetch-Site 自报 same-site / cross-site 就拒(403 固定正文);其余放行。
// 全部用 node:http 或原始 socket 精确控制请求头;Host 默认 127.0.0.1:端口;都不带 Origin。
import { test, expect } from '@playwright/test';
import { withInstance, logSince, blockedLines } from './helpers/world.mjs';
import { httpRequest, rawGet, expectBlocked, describeHttp, mediaType } from './helpers/net.mjs';
import { SVG_PLAIN, writeFixture, dl, rawPath } from './helpers/fixtures.mjs';

const get = (inst, pathname, headers = {}) => httpRequest({ port: inst.port, pathname, headers });
const svgFixture = (inst) => writeFixture(inst.home, dl('plain.svg'), Buffer.from(SVG_PLAIN, 'utf8'));

test('D1 same-site / cross-site 被拒:五个不同挂载点(health / auth-status / network / skins / 读文件)都 403 固定正文', async () => {
  await withInstance({ label: 'd1' }, async (inst) => {
    const svg = svgFixture(inst);
    const eps = [['/api/health', false], ['/api/auth-status', false], ['/api/network', true], ['/api/skins', false], [rawPath(svg), false]];
    for (const [p, redact] of eps) {
      const isRead = p.startsWith('/api/files/read');
      for (const v of ['same-site', 'cross-site']) {
        const label = `D1 ${isRead ? '/api/files/read?raw=1' : p} + Sec-Fetch-Site: ${v}`;
        const r = await get(inst, p, { 'Sec-Fetch-Site': v });
        expectBlocked(r, label, { redact });
        if (isRead) expect.soft(r.text.includes('<rect'), `${label}:应答里不得含 SVG 文件内容(路由处理器不该执行)`).toBe(false);
      }
    }
  });
});

test('D2 取值变体仍被拒:大小写、逗号多值、尾随空格、两行同名头', async () => {
  await withInstance({ label: 'd2' }, async (inst) => {
    const variants = [
      ['Sec-Fetch-Site: Cross-Site', ['Sec-Fetch-Site: Cross-Site']],
      ['Sec-Fetch-Site: SAME-SITE', ['Sec-Fetch-Site: SAME-SITE']],
      ['Sec-Fetch-Site: same-origin, cross-site', ['Sec-Fetch-Site: same-origin, cross-site']],
      ['Sec-Fetch-Site: none, same-site', ['Sec-Fetch-Site: none, same-site']],
      ['Sec-Fetch-Site: cross-site␠(尾随空格)', ['Sec-Fetch-Site: cross-site ']],
      ['两行同名头(第一行 same-origin,第二行 same-site)', ['Sec-Fetch-Site: same-origin', 'Sec-Fetch-Site: same-site']],
    ];
    for (const [name, lines] of variants) expectBlocked(await rawGet(inst.port, '/api/health', lines), `D2 ${name}`);
  });
});

test('D3 放行:none / same-origin / 不带该头 / 未知取值 都 200,读文件正文等于 SVG 字节,且不留拒绝日志', async () => {
  await withInstance({ label: 'd3' }, async (inst) => {
    const svg = svgFixture(inst);
    const bytes = Buffer.from(SVG_PLAIN, 'utf8');
    const heads = [['Sec-Fetch-Site: none', { 'Sec-Fetch-Site': 'none' }], ['Sec-Fetch-Site: same-origin', { 'Sec-Fetch-Site': 'same-origin' }], ['不带 Sec-Fetch-Site', {}], ['Sec-Fetch-Site: bogus', { 'Sec-Fetch-Site': 'bogus' }]];
    for (const p of ['/api/health', rawPath(svg)]) {
      const isRead = p.startsWith('/api/files/read');
      for (const [name, h] of heads) {
        const label = `D3 ${isRead ? '/api/files/read?raw=1' : p} + ${name}`;
        const r = await get(inst, p, h);
        expect.soft(r.status, `${label}:应放行 200,实际 ${describeHttp(r)}`).toBe(200);
        if (isRead) expect.soft(r.body.equals(bytes), `${label}:正文应等于 SVG 文件字节(实际 ${r.body.length} 字节)`).toBe(true);
      }
    }
    expect.soft(blockedLines(logSince(inst, 0)), 'D3:放行的请求不应留下任何 [cors] blocked 日志').toEqual([]);
  });
});

test('D4 路径范围与路由一致:大小写/尾斜杠写法照样拒;非 /api 路径与各种怪写法不是来源拒绝(与不带自报头的对照一致)', async () => {
  await withInstance({ label: 'd4' }, async (inst) => {
    const sfs = ['Sec-Fetch-Site: cross-site'];
    for (const p of ['/API/health', '/Api/Health', '/api/health/']) {
      expectBlocked(await rawGet(inst.port, p, sfs), `D4 ${p} + cross-site`);
    }
    // 其余写法路由不认作 /api,来源拒绝不得介入。接口文件按"隔离实例没有前端构建产物"写的是 404;
    // 本工作树里 client/dist 软链存在、后端会托管前端,这些路径实际回前端页(200 text/html)。
    // 所以断言写成:不是 403、没有来源拒绝文案,并且与"不带自报头"的对照请求(来源拒绝完全不介入)状态码、类型都相同
    // ——没有前端构建时对照就是 404,这条同样强制 404;实际状态记进用例注解。
    const seen = [];
    for (const p of ['/apix/health', '//api/health', '/api//health', '/api%2Fhealth', '/%61pi/health', '/', '/assets/x.js', '/icons/a.png']) {
      const control = await rawGet(inst.port, p);
      const r = await rawGet(inst.port, p, sfs);
      seen.push(`${p}→${r.status}`);
      expect.soft(r.status, `D4 ${p} + cross-site:不得是来源拒绝 403,实际 ${describeHttp(r)}`).not.toBe(403);
      expect.soft(r.text.includes('Cross-origin request blocked by cc-gui'), `D4 ${p} + cross-site:正文里不得含来源拒绝文案`).toBe(false);
      expect.soft(r.status, `D4 ${p}:带 cross-site 的状态码应与不带自报头的对照相同(对照 ${control.status})`).toBe(control.status);
      expect.soft(mediaType(r), `D4 ${p}:带 cross-site 的 Content-Type 应与不带自报头的对照相同`).toBe(mediaType(control));
    }
    test.info().annotations.push({ type: 'D4 非 /api 路径实际状态(接口文件写 404;有 client/dist 时是前端页 200)', description: seen.join(' ') });
  });
});
