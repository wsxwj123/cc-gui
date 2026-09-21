// r124 · 隔离实例的"断外网"预载(NODE_OPTIONS=--import=<本文件的 file:// URL>)。
// 目的:验收规则"不联外网"。产品若不认 CGUI_GITHUB_*_BASE 而去打真 GitHub,这里让它拿到一个
// 普通的网络错误(ENETUNREACH),并把被拒的目标记到 R124_BLOCKED_LOG,供用例取证。
// 只拦 TCP 客户端连接(net.Socket#connect 是 http/https/undici/ws 出站的共同入口),不碰监听。
// 放行规则:只放 127.0.0.1/localhost 且端口在 R124_ALLOW_PORTS(默认 6700-6999)之内 ——
// 本机 7897 这类回环代理口也一并拒掉,免得产品拿 HTTPS_PROXY 绕道出网。
// 不改产品代码,只作用于测试自己起的进程。
import net from 'node:net';
import fs from 'node:fs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::', '[::1]', '']);
const isLoopback = (h) => LOOPBACK.has(h) || /^127\./.test(h) || /\.localhost$/.test(h);
const [lo, hi] = (process.env.R124_ALLOW_PORTS || '6700-6999').split('-').map(Number);
const portAllowed = (p) => Number(p) >= lo && Number(p) <= hi;
const logFile = process.env.R124_BLOCKED_LOG;

function target(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];                       // net.createConnection 传进来的是已归一化的 [options, cb]
  if (a && typeof a === 'object') {
    if (a.path && !a.port) return null;                // IPC
    return { host: String(a.host ?? a.hostname ?? 'localhost'), port: a.port };
  }
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(a) };
  }
  return null;                                          // IPC 路径
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function r124GuardedConnect(...args) {
  const t = target(args);
  if (t && !(isLoopback(t.host) && portAllowed(t.port))) {
    const err = Object.assign(new Error(`r124 no-outbound: refused ${t.host}:${t.port}`), { code: 'ENETUNREACH', errno: -51, syscall: 'connect', address: t.host, port: t.port });
    if (logFile) { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${t.host}:${t.port}\n`); } catch { /* 忽略 */ } }
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};
