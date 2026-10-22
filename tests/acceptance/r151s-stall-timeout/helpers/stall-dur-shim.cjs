// r151s 夹具(从 r151h 的 stall-ms-shim.cjs 扩展而来):只给"一次性实例"的服务进程用(node --require 本文件 server/index.js)。
// 把服务进程里时长【恰好】等于 300000 / 600000 / 1200000 毫秒的 setTimeout 分别换成不同的短(或远长)时长,
// 映射表由环境变量 R151S_TIMER_MAP 给(JSON,例 {"300000":1500,"600000":3000000,"1200000":3000000}):
//   - 看门狗按设置选哪一档(5m / 10m / 20m / never)时长,就会落到哪个映射值上;
//     测试从"提示什么时候出现"就能反推服务端用了哪一档(没被选中的档映射成远长于测试等待的时长)。
//   - 其它时长的定时器一概不动;没设 R151S_TIMER_MAP 或不是合法 JSON 时什么都不做。
//   - 不识别代码是否已实现本轮功能:这是夹具层适配,不是断言。
// 不传给子进程(只用 --require,不经 NODE_OPTIONS)。
let map = null;
try {
  const raw = process.env.R151S_TIMER_MAP;
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') map = parsed;
  }
} catch { map = null; }

if (map) {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = function r151sSetTimeout(fn, delay, ...args) {
    const key = String(Number(delay));
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      const to = Number(map[key]);
      if (Number.isFinite(to) && to >= 0) return realSetTimeout(fn, to, ...args);
    }
    return realSetTimeout(fn, delay, ...args);
  };
}
