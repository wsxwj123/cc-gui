// r184 · 隔离实例的"断外网"预载(NODE_OPTIONS=--import=<本文件的 file:// URL>);复制自 r179 的同名夹具,仅改环境变量名。
// 只放行 127.0.0.1/localhost 且端口在 R184_ALLOW_PORTS(默认 6700-6999)之内的 TCP 连接;其余一律给 ENETUNREACH,并记到 R184_BLOCKED_LOG。
// 不改产品代码,只作用于测试自己起的进程。
import net from 'node:net';
import fs from 'node:fs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::', '[::1]', '']);
const isLoopback = (h) => LOOPBACK.has(h) || /^127\./.test(h) || /\.localhost$/.test(h);
const [lo, hi] = (process.env.R184_ALLOW_PORTS || '6700-6999').split('-').map(Number);
const portAllowed = (p) => Number(p) >= lo && Number(p) <= hi;
const logFile = process.env.R184_BLOCKED_LOG;

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
net.Socket.prototype.connect = function r184GuardedConnect(...args) {
  const t = target(args);
  if (t && !(isLoopback(t.host) && portAllowed(t.port))) {
    const err = Object.assign(new Error(`r184 no-outbound: refused ${t.host}:${t.port}`), { code: 'ENETUNREACH', errno: -51, syscall: 'connect', address: t.host, port: t.port });
    if (logFile) { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${t.host}:${t.port}\n`); } catch { /* 忽略 */ } }
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};
