// r14-1:GitHub 访问的代理回落层(原在 routes/skills.js,抽出共用)。
// 背景:Node 的 fetch(undici)**不读系统代理**,墙内机器直连 api.github.com 常年失败;
// 版本检测原来用裸 fetch → 其他电脑(Mac/Win)一律"检测不到更新",而本机因 Clash TUN
// 劫持全部流量才恰好能通,长期掩盖了这个问题。
// 策略:先直连;网络层失败或 GitHub 匿名限流 403 → 走本机代理(CONNECT 隧道)重试。
// 不设全局代理、不碰 claude 子进程环境。
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { detectLocalProxy } from '../routes/version-check.js';
import { resolveGithubToken, invalidateGithubToken, withGithubAuth } from './github-token.js';

// 这里手写标准 CONNECT 隧道(等价 curl -x),仅 skills 的 GitHub/Gitee 请求用,
// 不设任何全局代理、不碰 claude 子进程环境。仅网络层失败才回落;HTTP 4xx/5xx 正常返回。
function proxyGet(url, proxyUrl, { headers = {}, timeoutMs = 20000, redirects = 2 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), p = new URL(proxyUrl);
    const creq = httpRequest({ host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT', path: `${u.hostname}:${u.port || 443}` });
    creq.setTimeout(timeoutMs, () => creq.destroy(new Error('代理连接超时')));
    creq.on('error', reject);
    creq.on('connect', (cres, socket) => {
      if (cres.statusCode !== 200) { socket.destroy(); return reject(new Error(`代理 CONNECT ${cres.statusCode}`)); }
      const req = httpsRequest(url, { createConnection: () => socket, agent: false, headers }, (r) => {
        if ([301, 302, 307, 308].includes(r.statusCode) && r.headers.location && redirects > 0) {
          r.resume(); // 丢弃 body
          return resolve(proxyGet(new URL(r.headers.location, url).href, proxyUrl, { headers, timeoutMs, redirects: redirects - 1 }));
        }
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('error', reject);
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            ok: r.statusCode >= 200 && r.statusCode < 300,
            status: r.statusCode,
            headers: { get: (k) => r.headers[String(k).toLowerCase()] ?? null },
            text: async () => buf.toString('utf-8'),
            json: async () => JSON.parse(buf.toString('utf-8')),
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          });
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('代理请求超时')));
      req.on('error', reject);
      req.end();
    });
    creq.end();
  });
}
export let _proxyHit = { at: 0, url: null }; // 探测结果 60s 缓存,避免每个文件下载都探测一轮端口
async function localProxy() {
  if (Date.now() - _proxyHit.at > 60_000) _proxyHit = { at: Date.now(), url: await detectLocalProxy().catch(() => null) };
  return _proxyHit.url;
}
export async function gfetch(url, opts = {}, _noAuth = false) {
  // r67:api.github.com 的请求自动带令牌(env → 界面填的 PAT → gh auth token,见 github-token.js)。
  // 匿名 60 次/小时按出口 IP 计,共享代理出口配额常年打满=技能市场恒空的根因;带令牌 5000 次/小时
  // 按令牌计。raw/gitee 不注入;代理回落链路同样带(CONNECT 隧道 TLS 端到端,代理看不到请求头)。
  let headers = opts.headers || {};
  let usedToken = false;
  if (!_noAuth && String(url).startsWith('https://api.github.com/')) {
    const authed = withGithubAuth(url, headers, (await resolveGithubToken())?.token);
    if (authed) { headers = authed; usedToken = true; }
  }
  let r;
  let viaProxy = false;
  try { r = await fetch(url, { ...opts, headers }); }
  catch (e) {
    const proxy = await localProxy();
    if (!proxy) throw e;
    try { r = await proxyGet(url, proxy, { headers }); viaProxy = true; }
    catch { throw e; } // 代理也失败 → 抛原始直连错误(对用户更可读)
  }
  // 带注入令牌收到 401 = 令牌失效(吊销/过期/gh 已轮换):作废缓存,退回匿名重试一次。
  // 最坏结果=回到没有令牌时的匿名行为,不会比改动前更差。
  if (r.status === 401 && usedToken) { invalidateGithubToken(); return gfetch(url, opts, true); }
  // GitHub 匿名 API 限流(60次/时)按来源 IP 计:直连配额烧光时换代理链路重试,配额独立。
  // 仅匿名请求值得换链路:带令牌后配额按令牌计,换出口 IP 无意义,白耗一次请求(判官 minor-2)。
  if (!usedToken && !viaProxy && r.status === 403 && url.startsWith('https://api.github.com/')) {
    const proxy = await localProxy();
    if (proxy) { try { const pr = await proxyGet(url, proxy, { headers }); if (pr.ok) return pr; } catch { /* 保留原响应 */ } }
  }
  return r;
}

