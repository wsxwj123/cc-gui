// r151c:只给"一次性实例"的服务进程用(node --require 本文件 server/index.js)。把服务端的 Date / Date.now 平移
// <R151C_CLOCK_FILE> 里写的毫秒数(文件不存在 = 0,每 100ms 重读),用来验"超过 30 分钟""10 分钟窗口过去"这类按时长判定的规则。
// 只动服务进程的墙上时间,不动计时器,也不传给子进程(不经 NODE_OPTIONS)。
const fs = require('fs');
const file = process.env.R151C_CLOCK_FILE;
let off = 0;
const read = () => { try { off = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { off = 0; } };
read();
setInterval(read, 100).unref();
const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
globalThis.Date = new Proxy(RealDate, {
  construct(t, args, nt) { return Reflect.construct(t, args.length ? args : [realNow() + off], nt); },
  apply() { return new RealDate(realNow() + off).toString(); },
  get(t, p, r) { return p === 'now' ? () => realNow() + off : Reflect.get(t, p, r); },
});
