// r123 · 端口纪律:只在 6700–6999 里挑当前能绑上的口,硬拒 6677 / 6689 / 6710;只绑 127.0.0.1。
// 看到不是自己起的监听一律不碰(挑口只做"能不能绑上"探测,绑上立刻放掉)。
import net from 'node:net';

export const FORBIDDEN = new Set([6677, 6689, 6710]);
export const okPort = (p) => Number.isInteger(p) && p >= 6700 && p <= 6999 && !FORBIDDEN.has(p);

/** 在 [start, 6999] 里挑一个当前能绑上的端口。 */
export function freePort(start = 6800) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > 6999) { reject(new Error('6700–6999 没有空闲端口')); return; }
      if (FORBIDDEN.has(p)) { tryPort(p + 1); return; }
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

/** 挑一个"没人听"的端口给 network 类用例用(连接被拒);挑完不去听它。 */
export const unlistenedPort = (start = 6950) => freePort(start);
