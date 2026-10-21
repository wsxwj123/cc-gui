// 单测的端口约束:只在 6900–6999 里挑(常驻端口 6677/6689/6710/8788/8789/8798/8799/8000 都不在这一段)。
// 逐个端口直接 listen:绑定成功就用;EADDRINUSE / EACCES = 被占,换下一个重试。探测和占用是同一次绑定,
// 不存在"探测时空闲、真正 listen 前被别人抢走"的空档。起点随机,几个单测同时跑时少撞同一个口。
import { createServer } from 'node:http';

export const PORT_FROM = 6900;
export const PORT_TO = 6999;

/** target:express app(请求处理函数)或已建好的 http/net Server。返回正在监听的 Server(端口从 server.address() 读)。 */
export async function listenInRange(target, { host = '127.0.0.1', from = PORT_FROM, to = PORT_TO } = {}) {
  const server = typeof target === 'function' ? createServer(target) : target;
  const span = to - from + 1;
  const offset = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = from + ((offset + i) % span);
    const bound = await new Promise((resolve, reject) => {
      const onListening = () => { server.off('error', onError); resolve(true); };
      const onError = (e) => {
        server.off('listening', onListening);
        if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) resolve(false); else reject(e);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host); // 上一次 listen 出错后允许对同一个 Server 再 listen(Node 文档)
    });
    if (bound) return server;
  }
  throw new Error(`${from}-${to} 没有空闲端口`);
}
