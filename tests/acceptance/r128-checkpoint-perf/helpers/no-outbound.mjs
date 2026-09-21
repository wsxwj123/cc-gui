// r128 · 隔离实例的"断外网"预载(NODE_OPTIONS=--import=<本文件的 file:// URL>);照 r126 的写法。
// 验收规则"不联外网":产品若去打任何非回环地址,这里让它拿到一个普通的网络错误(ENETUNREACH),
// 并把被拒的目标记到 R128_BLOCKED_LOG。只拦 TCP 客户端连接,不碰监听。
// 放行规则:只放 127.0.0.1/localhost 且端口在 6700-6999 之内(本机回环代理口也一并拒掉)。
import net from 'node:net';
import fs from 'node:fs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::', '[::1]', '']);
const isLoopback = (h) => LOOPBACK.has(h) || /^127\./.test(h) || /\.localhost$/.test(h);
const [lo, hi] = (process.env.R128_ALLOW_PORTS || '6700-6999').split('-').map(Number);
const portAllowed = (p) => Number(p) >= lo && Number(p) <= hi;
const logFile = process.env.R128_BLOCKED_LOG;

function target(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  if (a && typeof a === 'object') {
    if (a.path && !a.port) return null;
    return { host: String(a.host ?? a.hostname ?? 'localhost'), port: a.port };
  }
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(a) };
  }
  return null;
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function r128GuardedConnect(...args) {
  const t = target(args);
  if (t && !(isLoopback(t.host) && portAllowed(t.port))) {
    const err = Object.assign(new Error(`r128 no-outbound: refused ${t.host}:${t.port}`), { code: 'ENETUNREACH', errno: -51, syscall: 'connect', address: t.host, port: t.port });
    if (logFile) { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${t.host}:${t.port}\n`); } catch { /* 忽略 */ } }
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};
