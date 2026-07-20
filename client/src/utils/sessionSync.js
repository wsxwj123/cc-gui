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
