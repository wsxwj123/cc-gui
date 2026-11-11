// B06~B09：接口类，从 node 侧直接发 HTTP（直连隔离后端，不经浏览器、不经 Vite）。
import http from 'node:http';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';

const MB = 1024 * 1024;
const LIMIT_BYTES = 10 * MB;

/** GET；abortAfterMs 给了就在这么久之后断开连接。返回 { status, bytes, buf, ms, aborted }。 */
function httpGet(url, { abortAfterMs } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(url, { agent: false }, (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); finish({ status: res.statusCode, bytes: buf.length, buf, ms: Date.now() - t0, aborted: false }); });
      res.on('error', (e) => { if (!done) reject(e); });
    });
    req.on('error', (e) => { if (done) return; if (abortAfterMs !== undefined) finish({ status: null, bytes: 0, buf: Buffer.alloc(0), ms: Date.now() - t0, aborted: true }); else reject(e); });
    if (abortAfterMs !== undefined) setTimeout(() => { if (!done) { req.destroy(); finish({ status: null, bytes: 0, buf: Buffer.alloc(0), ms: Date.now() - t0, aborted: true }); } }, abortAfterMs);
  });
}
const pageUrl = (key, extra) => `${process.env.BACKEND_URL}/api/sessions/${SESSIONS[key].sid}/messages?projectHash=${encodeURIComponent(SESSIONS[key].projectHash)}&limit=120${extra || ''}`;
const parse = (r) => JSON.parse(r.buf.toString('utf8'));
const sha = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');

/** 从第一页翻到 hasMore=false；只留每页的摘要（P 整个会话 100MB+，不能全留在内存里）。 */
let walkCache = null;
async function walkP() {
  if (walkCache) return walkCache;
  const pages = [];
  let extra = '';
  for (let i = 0; i < 200; i += 1) {
    const r = await httpGet(pageUrl('P', extra));
    if (r.status !== 200) { pages.push({ status: r.status, bytes: r.bytes, ms: r.ms }); break; }
    const body = parse(r);
    const s = JSON.stringify(body.messages);
    pages.push({
      status: r.status, bytes: r.bytes, ms: r.ms, count: body.messages.length, hasMore: body.hasMore, beforeCursor: body.beforeCursor, total: body.total,
      hasEnd: s.includes(SESSIONS.P.end), hasBeg: s.includes(SESSIONS.P.beg), keys: body.messages.map(sha),
    });
    if (!body.hasMore) break;
    extra = `&before=${body.beforeCursor}`;
  }
  walkCache = pages;
  return pages;
}
const mb = (n) => `${(n / MB).toFixed(1)}MB`;

test.describe.configure({ timeout: 300_000 });

test('B06 带 limit 的第一页：响应体不超过 10MB，含最新一条与结束标记，hasMore/beforeCursor/total 合规', async () => {
  const pages = await walkP();
  const p1 = pages[0];
  expect(p1.status, '第一页应为 200').toBe(200);
  expect(p1.bytes, `第一页响应体应 ≤ 10MB，实测 ${mb(p1.bytes)}（${p1.count} 条）`).toBeLessThanOrEqual(LIMIT_BYTES);
  expect(p1.hasEnd, '第一页 messages 里应含 P 的结束标记（最新一条在内）').toBe(true);
  expect(p1.hasMore, '第一页 hasMore 应为 true').toBe(true);
  expect(Number.isInteger(p1.beforeCursor) && p1.beforeCursor > 0, `beforeCursor 应是大于 0 的整数，实测 ${p1.beforeCursor}`).toBe(true);
  const sum = pages.reduce((a, p) => a + (p.count || 0), 0);
  expect(p1.total, `total 应等于翻完所有页拿到的消息总数（${sum}，共 ${pages.length} 页）`).toBe(sum);
});

test('B07 翻页：每页都不超过 10MB，拼起来条数等于 total 且无重复，最早一条含开头标记，最后一页 beforeCursor 为 0', async () => {
  const pages = await walkP();
  const sizes = pages.map((p) => mb(p.bytes)).join(', ');
  const over = pages.map((p, i) => ({ i: i + 1, bytes: p.bytes })).filter((x) => x.bytes > LIMIT_BYTES);
  expect(over, `每页响应体都应 ≤ 10MB；各页大小：${sizes}`).toEqual([]);
  const last = pages[pages.length - 1];
  expect(last.status, '最后一页应为 200').toBe(200);
  expect(last.hasMore, '翻到头时 hasMore 应为 false').toBe(false);
  expect(last.beforeCursor, '最后一页 beforeCursor 应为 0').toBe(0);
  const all = pages.flatMap((p) => p.keys || []);
  expect(new Set(all).size, '所有页的消息不应有重复').toBe(all.length);
  expect(all.length, `所有页拼起来的条数应等于 total（共 ${pages.length} 页）`).toBe(pages[0].total);
  expect(last.hasBeg, '最早一页应含 P 的开头标记').toBe(true);
});

test('B08 后端：作废（已断开）的请求不拖慢后面的请求，Q 第一页耗时 ≤ 2×t0+1 秒', async () => {
  const q0 = await httpGet(pageUrl('Q'));
  expect(q0.status, '基线：Q 第一页应为 200').toBe(200);
  const t0 = q0.ms;
  for (let i = 0; i < 10; i += 1) await httpGet(pageUrl('P'), { abortAfterMs: 100 });
  const q1 = await httpGet(pageUrl('Q'));
  expect(q1.status, '10 个作废请求之后 Q 第一页应为 200').toBe(200);
  expect(q1.ms, `Q 第一页耗时应 ≤ 2×t0+1000 = ${2 * t0 + 1000}ms；实测 ${q1.ms}ms（t0=${t0}ms）`).toBeLessThanOrEqual(2 * t0 + 1000);
});

test('B09 普通会话第一页条数不变：L 恰好 120 条，hasMore 为 true，beforeCursor = total - 120', async () => {
  const r = await httpGet(pageUrl('L'));
  expect(r.status, 'L 第一页应为 200').toBe(200);
  const body = parse(r);
  expect(body.messages.length, `L 第一页应恰好 120 条（total=${body.total}）`).toBe(120);
  expect(body.hasMore).toBe(true);
  expect(body.beforeCursor, `beforeCursor 应等于 total - 120（total=${body.total}）`).toBe(body.total - 120);
});
