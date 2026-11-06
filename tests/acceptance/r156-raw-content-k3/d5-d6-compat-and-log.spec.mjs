// D5:带 Origin 的既有规则不受影响(抽样,修复前后都绿);D6:K3 拒绝的日志整行格式(修复前红)。
import { test, expect } from '@playwright/test';
import { withInstance, logSize, waitLogSince, blockedLines } from './helpers/world.mjs';
import { httpRequest, expectBlocked, describeHttp } from './helpers/net.mjs';

const get = (inst, pathname, headers = {}) => httpRequest({ port: inst.port, pathname, headers });

/** 发请求前记日志偏移,发完等增量里出现拒绝行(最多 2 秒),返回 [请求结果, 增量里的拒绝行]。 */
async function probeWithLog(inst, pathname, headers, { expectLine }) {
  const off = logSize(inst);
  const r = await get(inst, pathname, headers);
  const text = await waitLogSince(inst, off, (t) => (expectLine ? blockedLines(t).length > 0 : true), expectLine ? 2000 : 0);
  return [r, blockedLines(text)];
}

test('D5 带 Origin 的既有规则不受影响:同站放行、自报跨站 sfs-veto、另一端口 site-mismatch,三次日志都不是 no-origin-sfs-veto', async () => {
  await withInstance({ label: 'd5' }, async (inst) => {
    const sameSite = `http://127.0.0.1:${inst.port}`;
    const otherSite = `http://127.0.0.1:${inst.port === 6999 ? 6998 : inst.port + 1}`;

    const [a, la] = await probeWithLog(inst, '/api/health', { Origin: sameSite }, { expectLine: false });
    expect.soft(a.status, `D5(a) 同站 Origin、不带自报:应 200,实际 ${describeHttp(a)}`).toBe(200);
    expect.soft(a.headers['access-control-allow-origin'], 'D5(a) 应回显 Access-Control-Allow-Origin 为请求的 Origin').toBe(sameSite);
    expect.soft(la, 'D5(a) 放行的请求不应留下拒绝日志').toEqual([]);

    const [b, lb] = await probeWithLog(inst, '/api/health', { Origin: sameSite, 'Sec-Fetch-Site': 'cross-site' }, { expectLine: true });
    expectBlocked(b, 'D5(b) 同站 Origin + Sec-Fetch-Site: cross-site');
    expect.soft(lb.length, `D5(b) 增量里应恰有一行拒绝日志,实际 ${lb.length} 行`).toBe(1);
    expect.soft(/ rule=sfs-veto( |$)/.test(lb[0] ?? ''), `D5(b) 日志 rule 应是 sfs-veto,实际行:${lb[0]}`).toBe(true);
    expect.soft((lb[0] ?? '').includes('no-origin-sfs-veto'), 'D5(b) 日志不得是 no-origin-sfs-veto').toBe(false);

    const [c, lc] = await probeWithLog(inst, '/api/health', { Origin: otherSite }, { expectLine: true });
    expectBlocked(c, 'D5(c) 另一个端口的 Origin、不带自报');
    expect.soft(lc.length, `D5(c) 增量里应恰有一行拒绝日志,实际 ${lc.length} 行`).toBe(1);
    expect.soft(/ rule=site-mismatch( |$)/.test(lc[0] ?? ''), `D5(c) 日志 rule 应是 site-mismatch,实际行:${lc[0]}`).toBe(true);
    expect.soft((lc[0] ?? '').includes('no-origin-sfs-veto'), 'D5(c) 日志不得是 no-origin-sfs-veto').toBe(false);
  });
});

test('D6 日志:K3 拒绝恰留一行,字段齐全(origin=null、sfs 原样大小写、rule=no-origin-sfs-veto、rawHost 带端口)', async () => {
  await withInstance({ label: 'd6' }, async (inst) => {
    const lineRe = (sfs) => new RegExp(`^\\[cors\\] blocked origin=null host="127\\.0\\.0\\.1" path="[^"]*probe=d6[^"]*" sfs="${sfs}" rule=no-origin-sfs-veto rawHost="127\\.0\\.0\\.1:${inst.port}"$`);
    for (const sfs of ['cross-site', 'Same-Site']) {
      const [r, lines] = await probeWithLog(inst, '/api/health?probe=d6', { 'Sec-Fetch-Site': sfs }, { expectLine: true });
      expectBlocked(r, `D6 Sec-Fetch-Site: ${sfs}`);
      const hits = lines.filter((l) => lineRe(sfs).test(l));
      expect.soft(hits.length, `D6 Sec-Fetch-Site: ${sfs}:增量里应恰有一行匹配整行格式,实际匹配 ${hits.length} 行;拒绝行:${JSON.stringify(lines)}`).toBe(1);
    }
  });
});
