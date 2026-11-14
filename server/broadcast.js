// 已连接的 WebSocket 客户端集合 + 广播。独立成模块的原因:route(chat/prefs/permissions)
// 需要 broadcast,若从入口 index.js 反向 import 会形成循环依赖 —— 直接/孤立 import 任一
// route(如测试单独 import sessions.js)时,index.js 顶层 `app.use('/api', sessionRoutes)`
// 会在 sessionRoutes 尚未初始化时引用它,抛 TDZ(Cannot access 'sessionRoutes' before
// initialization)。把 broadcast 放这个无反向依赖的纯模块里,环即断开。
export const clients = new Set();

export function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState !== 1) continue;
    // 单个坏客户端不能中断循环,否则排在其后的客户端全部收不到本条广播。
    // 但 send 同步抛异常≠死连接:buffer 满/短暂 IO 错也会抛。以广播连续性优先 ——
    // 抛错后 readyState 仍 OPEN 的保留(下条广播自愈),真已非 OPEN 的才删;
    // 宁留一个慢客户端多试几次,不误删一个活连接致其永久失联。
    try { client.send(msg); } catch { if (client.readyState !== 1) clients.delete(client); }
  }
}

// 打包版 Tauri 后端禁用 chokidar watcher(CGUI_DISABLE_FILE_WATCHER=1)→ 改写 jsonl
// 的端点自身不广播的话,其他客户端(手机/电脑多端)永远收不到"会话变了"的通知,停在
// 旧画面。修法:写入点自己合成与原 watcher 同型的 file-change 广播(0ms,快于 watcher
// 2.5s 轮询,且 dev/打包两形态都覆盖)。客户端判据只看字符串形态,不读文件——所以
// DELETE/archive 后文件不存在也照发原 jsonl 路径。反斜杠统一成正斜杠:useWebSocket
// 兼容 `\projects\`,但 SessionDetail 的 endsWith(`/${sid}.jsonl`) 只认正斜杠,原生
// watcher 在 Windows 发反斜杠命中不了(既有缺陷),合成广播不复刻它。
// r185:本体从 routes/sessions.js 原样搬来(那边原样转出,老调用方不变)。chat.js 也要用它,
// 而 sessions.js 本身 import 了 chat.js,从 sessions.js 引会成环;放在这个无反向依赖的模块里就没有环。
export function broadcastSessionFileChange(file, eventType = 'change') {
  try {
    broadcast({ type: 'file-change', eventType, path: String(file).replace(/\\/g, '/') });
  } catch {}
}
