// A 组:读文件接口 raw=1 的响应头(HTTP,无 Origin、无 Sec-Fetch-Site)。A1-A5 修复前红,A6 修复前后都绿。
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { withInstance } from './helpers/world.mjs';
import { httpRequest, expectRawResponse, expectSandboxCsp, expectNoCsp, describeHttp } from './helpers/net.mjs';
import { SVG_SCRIPT, makePdf, bytesFor, writeFixture, dl, rawPath } from './helpers/fixtures.mjs';

const get = (inst, abs, headers = {}, method = 'GET') => httpRequest({ port: inst.port, method, pathname: rawPath(abs), headers });

/** 写一批 [文件名, 期望类型] 的夹具并逐个断言(csp 默认 sandbox)。 */
async function checkBatch(inst, tag, rows, csp = 'sandbox') {
  for (const [name, type] of rows) {
    const bytes = bytesFor(name);
    const file = writeFixture(inst.home, dl(name), bytes);
    expectRawResponse(await get(inst, file), { label: `${tag} ${name}`, type, bytes, csp });
  }
}

test('A1 带脚本 SVG:raw=1 带 nosniff 与 CSP sandbox,字节原样;HEAD 与 Range 的头一致', async () => {
  await withInstance({ label: 'a1' }, async (inst) => {
    const bytes = Buffer.from(SVG_SCRIPT, 'utf8');
    const file = writeFixture(inst.home, dl('x.svg'), bytes);
    const r = await get(inst, file);
    expectRawResponse(r, { label: 'A1 GET', type: 'image/svg+xml', bytes, csp: 'sandbox' });
    expect.soft(r.headers['content-disposition'], 'A1 GET:不得带 Content-Disposition').toBeUndefined();
    expect.soft(r.headers['cache-control'], 'A1 GET:Cache-Control 应为 no-cache').toBe('no-cache');
    const head = await get(inst, file, {}, 'HEAD');
    const range = await get(inst, file, { Range: 'bytes=0-1' });
    for (const [name, x] of [['HEAD', head], ['Range GET', range]]) {
      expect.soft(x.status, `A1 ${name}:状态码应为 200(该接口不支持 Range,不会是 206),实际 ${describeHttp(x)}`).toBe(200);
      expect.soft(x.headers['x-content-type-options'], `A1 ${name}:X-Content-Type-Options 应为 nosniff`).toBe('nosniff');
      expectSandboxCsp(x, `A1 ${name}`);
      expect.soft(x.headers['content-security-policy'], `A1 ${name}:CSP 应与 GET 的完全一致`).toBe(r.headers['content-security-policy']);
    }
    expect.soft(head.body.length, 'A1 HEAD:不应有正文').toBe(0);
  });
});

test('A2 其他图片类型(含大写扩展名 B.PNG):类型不变,带 nosniff 与 sandbox,字节原样', async () => {
  await withInstance({ label: 'a2' }, async (inst) => {
    await checkBatch(inst, 'A2', [
      ['a.png', 'image/png'], ['a.jpg', 'image/jpeg'], ['a.jpeg', 'image/jpeg'], ['a.gif', 'image/gif'],
      ['a.webp', 'image/webp'], ['a.bmp', 'image/bmp'], ['a.ico', 'image/x-icon'], ['B.PNG', 'image/png'],
    ]);
  });
});

test('A3 音视频类型:类型不变,带 nosniff 与 sandbox,字节原样', async () => {
  await withInstance({ label: 'a3' }, async (inst) => {
    await checkBatch(inst, 'A3', [
      ['a.mp4', 'video/mp4'], ['a.webm', 'video/webm'], ['a.mov', 'video/quicktime'], ['a.m4v', 'video/x-m4v'],
      ['a.ogg', 'video/ogg'], ['a.mp3', 'audio/mpeg'], ['a.wav', 'audio/wav'], ['a.m4a', 'audio/mp4'],
    ]);
  });
});

test('A4 未映射类型(html/xml/txt/无扩展名/ogv/flac):按 octet-stream 下发,带 nosniff 与 sandbox,字节原样', async () => {
  await withInstance({ label: 'a4' }, async (inst) => {
    const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>', 'utf8');
    const file = writeFixture(inst.home, dl('a.html'), html);
    expectRawResponse(await get(inst, file), { label: 'A4 a.html', type: 'application/octet-stream', bytes: html, csp: 'sandbox' });
    await checkBatch(inst, 'A4', [
      ['a.xml', 'application/octet-stream'], ['a.txt', 'application/octet-stream'], ['Makefile', 'application/octet-stream'],
      ['a.ogv', 'application/octet-stream'], ['a.flac', 'application/octet-stream'],
    ]);
  });
});

test('A5 PDF(含大写 B.PDF):带 nosniff,不带任何 CSP 头;HEAD 与 Range 同', async () => {
  await withInstance({ label: 'a5' }, async (inst) => {
    const bytes = makePdf();
    const files = ['a.pdf', 'B.PDF'].map((n) => [n, writeFixture(inst.home, dl(n), bytes)]);
    for (const [name, file] of files) {
      expectRawResponse(await get(inst, file), { label: `A5 ${name} GET`, type: 'application/pdf', bytes, csp: 'none' });
    }
    const file = files[0][1];
    for (const [name, x] of [['HEAD', await get(inst, file, {}, 'HEAD')], ['Range GET', await get(inst, file, { Range: 'bytes=0-1' })]]) {
      expect.soft(x.status, `A5 ${name}:状态码应为 200,实际 ${describeHttp(x)}`).toBe(200);
      expect.soft(x.headers['x-content-type-options'], `A5 ${name}:X-Content-Type-Options 应为 nosniff`).toBe('nosniff');
      expectNoCsp(x, `A5 ${name}`);
    }
  });
});

/** 失败应答:状态码 + JSON 里 ok=false 与 code。 */
function expectApiError(r, label, status, code) {
  expect.soft(r.status, `${label}:状态码(${describeHttp(r)})`).toBe(status);
  expect.soft(r.json?.ok, `${label}:JSON ok 应为 false`).toBe(false);
  expect.soft(r.json?.code, `${label}:JSON code`).toBe(code);
}

test('A6 不变项:不存在/目录/相对路径/缺 path/家目录外/受保护文件的错误契约,非 raw 的 JSON 形态,0 字节文件', async () => {
  await withInstance({ label: 'a6' }, async (inst) => {
    const svgText = SVG_SCRIPT;
    const svg = writeFixture(inst.home, dl('x.svg'), Buffer.from(svgText, 'utf8'));
    const empty = writeFixture(inst.home, dl('empty.png'), Buffer.alloc(0));
    const q = (p) => httpRequest({ port: inst.port, pathname: `/api/files/read?raw=1&path=${encodeURIComponent(p)}` });
    expectApiError(await q(path.join(inst.home, dl('nope.svg'))), 'A6(a) 不存在的文件', 404, 'FILE_READ_NOT_FOUND');
    expectApiError(await q(path.join(inst.home, 'Downloads')), 'A6(b) 目录', 400, 'FILE_READ_INVALID_PATH');
    expectApiError(await q(dl('x.svg')), 'A6(c) 相对路径', 400, 'FILE_READ_INVALID_PATH');
    expectApiError(await httpRequest({ port: inst.port, pathname: '/api/files/read?raw=1' }), 'A6(c) 缺 path', 400, 'FILE_READ_INVALID_PATH');
    expectApiError(await q('/etc/hosts'), 'A6(d) 家目录外 /etc/hosts', 403, 'FILE_READ_FORBIDDEN');
    expectApiError(await q(path.join(inst.home, '.claude-gui', 'network.json')), 'A6(e) 受保护的 network.json', 403, 'FILE_READ_FORBIDDEN');
    const plain = await httpRequest({ port: inst.port, pathname: `/api/files/read?path=${encodeURIComponent(svg)}` });
    expect.soft(plain.status, `A6(f) 不带 raw:状态码(${describeHttp(plain, true)})`).toBe(200);
    expect.soft(String(plain.headers['content-type']), 'A6(f) 不带 raw:Content-Type 应含 application/json').toContain('application/json');
    expect.soft(plain.json?.content === svgText, 'A6(f) 不带 raw:JSON 的 content 应等于 SVG 文本').toBe(true);
    expect.soft(plain.json?.binary, 'A6(f) 不带 raw:binary 应为 false').toBe(false);
    expect.soft(plain.json?.truncated, 'A6(f) 不带 raw:truncated 应为 false').toBe(false);
    const zero = await q(empty);
    expect.soft(zero.status, `A6(g) 0 字节文件:状态码(${describeHttp(zero)})`).toBe(200);
    expect.soft(zero.headers['content-length'], 'A6(g) 0 字节文件:Content-Length 应为 0').toBe('0');
    expect.soft(zero.body.length, 'A6(g) 0 字节文件:正文应为空').toBe(0);
  });
});
