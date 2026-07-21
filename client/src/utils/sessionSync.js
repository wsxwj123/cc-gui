// 审计批A2:会话级偏好(权限档/模型 pin/力度 pin)跨设备收敛的客户端合并规则。
// 纯函数,store 与单测共用。
//
// 合并语义(每张 map 独立):
//   - draft-* 键永远保留本地值(未落盘会话不同步,设备本地态);
//   - 服务端有的键,服务端胜出(后写胜出的全端收敛);
//   - 服务端没有的本地实键【保留】—— 不做删除传播。原因:①fire-and-forget PUT
//     在途时收到广播,若按服务端全量替换会把用户刚点的选择闪回旧值;②模型 pin 的
//     批量清除(切 provider)靠 provider-fp/clearModelOverrides 在每端本地执行,
//     不依赖这里;③会话删除的 GC 残留无害(map 只在该会话打开时被读)。
//   - skip(如正在提交中的键)不被服务端覆盖,保留本地值。
export function mergeSyncedMap(local, server, skip) {
  const l = (local && typeof local === 'object') ? local : {};
  const s = (server && typeof server === 'object') ? server : {};
  const next = { ...l };
  for (const k of Object.keys(s)) {
    if (skip && skip.has(k)) continue;
    next[k] = s[k];
  }
  return next;
}

// 未落盘 draft(无稳定 session id)不同步;发首条消息落盘后经 migrateSessionKey 补推。
export const syncableKey = (key) => typeof key === 'string' && !!key && !key.startsWith('draft-');

// 审计批收尾#1:初次迁移回推的键集 ——「本地有、服务端没有」的可同步实键(本功能
// 上线前的存量 pin)。只允许在【从未迁移过】的首次水合执行(store 以 localStorage
// marker 门控),此后水合纯拉取。否则每次重连都回推,离线设备会把对端已 clear
// (切 provider)/已 GC(删会话)的旧键复活 —— 复活的旧 provider 模型 pin 让该
// 会话下次发送报 invalid model。三张 map 同待遇(permissionModes/effortPins 虽无
// clear 语义,但删会话 GC 同样会被回推复活)。
export function pushLocalOnlyKeys(local, server) {
  const l = (local && typeof local === 'object') ? local : {};
  const s = (server && typeof server === 'object') ? server : {};
  return Object.keys(l).filter((k) => syncableKey(k) && !(k in s));
}

// 审计批低危#1:首次迁移的 marker 置位判据 —— 回推批次「全部成功」才置位。
// 现状 bug:GET 成功即置 marker,但回推的 PUT 是 fire-and-forget,若全失败(离线/
// 服务端 5xx),存量键就此只留本机、此后水合纯拉取再不回推 → 该批 pin 永不上云。
// 修:marker 只在全部回推 settle 成功后置位;任一失败不置位,下次重连重试整批。
// 空批(无本地存量键)视为成功(无可推即已收敛)。results = 各 PUT 的成功布尔。
export function shouldMarkMigrated(results) {
  return (results || []).every(Boolean);
}

// 审计批收尾#3:in-flight 计数器。Set 版的坑:同键快速连改两次(两个 PUT 并发在途),
// 第一个 PUT 的 finally delete 会把第二个在途的保护标签一并摘掉 → 此窗口内到达的
// 旧广播把用户刚点的第二次选择闪回。计数归零才真正移除标签。
export function createInFlightCounter() {
  const m = new Map(); // tag → 在途计数
  return {
    acquire(tag) { m.set(tag, (m.get(tag) || 0) + 1); },
    release(tag) {
      const n = (m.get(tag) || 0) - 1;
      if (n > 0) m.set(tag, n); else m.delete(tag);
    },
    has(tag) { return m.has(tag); },
    keys() { return [...m.keys()]; },
  };
}
