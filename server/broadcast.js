// 已连接的 WebSocket 客户端集合 + 广播。独立成模块的原因:route(chat/prefs/permissions)
// 需要 broadcast,若从入口 index.js 反向 import 会形成循环依赖 —— 直接/孤立 import 任一
// route(如测试单独 import sessions.js)时,index.js 顶层 `app.use('/api', sessionRoutes)`
// 会在 sessionRoutes 尚未初始化时引用它,抛 TDZ(Cannot access 'sessionRoutes' before
// initialization)。把 broadcast 放这个无反向依赖的纯模块里,环即断开。
export const clients = new Set();

export function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}
