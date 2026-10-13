// 启动延后闸(r148 P8)—— 纯机制,零 React / store 依赖。
//
// 病灶:应用一打开,约 20 个请求同一时刻发出。其中几类不是首屏要用的(MCP 预热要起子进程约 2 秒、
// 两个版本检查要问外网、价目目录),却和项目列表、provider、模型这些首屏必需的请求抢同一批连接和
// 同一个后端事件循环。(首页用量不在其列:它是首屏内容,r148b A5 起不延后。)
//
// 用法:afterBoot(fn) —— 启动后的头 BOOT_DEFER_MS 毫秒里调用的,推到闸开那一刻再执行;闸开之后调用的
// 立刻执行(所以只影响"启动那一下",之后任何时候挂载的组件行为不变)。返回取消函数。
// 起点 = 第一次有人调用的时刻(根组件挂载,与首批请求同一时刻)。
export const BOOT_DEFER_MS = 1500;

let gateOpensAt = 0;   // 0 = 还没人问过

/** 启动闸开了没有(没人问过也算没开)。 */
export function bootSettled() {
  return gateOpensAt !== 0 && Date.now() >= gateOpensAt;
}

export function afterBoot(fn) {
  const now = Date.now();
  if (!gateOpensAt) gateOpensAt = now + BOOT_DEFER_MS;
  const wait = gateOpensAt - now;
  if (wait <= 0) { fn(); return () => {}; }
  const id = setTimeout(fn, wait);
  return () => clearTimeout(id);
}
