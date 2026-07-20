// 审计批A2:会话级偏好(权限档 / 模型 pin / 力度 pin)跨设备同步的纯逻辑层。
// 只做「三张 per-sessionKey map 的 PUT 应用」,不碰磁盘/网络 —— 路由(prefs.js)
// 与单测(tests/unit/check-session-sync.mjs)共用同一份,保证行为一致。
// 语义:偏好层,只影响「下次 spawn 用哪档/哪个模型/哪个力度」;chat.js 的
// slot.guiMode 运行时链路不经这里。

export const SYNC_KINDS = {
  permissionMode: 'permissionModes',
  modelPin: 'modelPins',
  effortPin: 'effortPins',
};

const MAP_KEYS = Object.values(SYNC_KINDS);

// 归一化:任何来源的 sessionSync 对象 → 恒有三键、值恒为 object。
export function normalizeSessionSync(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const k of MAP_KEYS) {
    out[k] = (src[k] && typeof src[k] === 'object') ? { ...src[k] } : {};
  }
  return out;
}

// 对当前状态应用一次 PUT(纯函数,后写胜出=直接覆盖同 key)。body:
//   { kind:'permissionMode'|'modelPin'|'effortPin', sessionId, value }
//     value 为 null/undefined → 删除该 key;'' 对 effortPin 是合法档位(「默认」),
//     对其余两类视为删除(客户端本就不会发 '')。
//   { clear:'modelPins' } → 清空整张表(切 provider 清模型 pin 与前端
//     clearModelOverrides 对齐;其余表也允许 clear,幂等)。
// 返回 { maps, changed, error }。error 非空时 maps 为原样归一化结果、changed=false。
export function applySessionSyncPut(cur, body) {
  const maps = normalizeSessionSync(cur);
  const { kind, sessionId, value, clear } = body || {};
  if (clear != null) {
    if (!MAP_KEYS.includes(clear)) return { maps, changed: false, error: `clear 必须是 ${MAP_KEYS.join('/')}` };
    const changed = Object.keys(maps[clear]).length > 0;
    maps[clear] = {};
    return { maps, changed, error: null };
  }
  const mapKey = SYNC_KINDS[kind];
  if (!mapKey) return { maps, changed: false, error: 'kind 必须是 permissionMode/modelPin/effortPin' };
  if (typeof sessionId !== 'string' || !sessionId || sessionId.startsWith('draft-')) {
    return { maps, changed: false, error: 'sessionId 必须是非 draft 的非空字符串' };
  }
  const isDelete = value == null || (value === '' && kind !== 'effortPin');
  if (!isDelete && (typeof value !== 'string' || value.length > 200)) {
    return { maps, changed: false, error: 'value 必须是 ≤200 字符的字符串或 null' };
  }
  const m = maps[mapKey];
  const changed = isDelete ? (sessionId in m) : m[sessionId] !== value;
  if (isDelete) delete m[sessionId];
  else m[sessionId] = value;
  return { maps, changed, error: null };
}
