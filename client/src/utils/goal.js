// /goal 命令的发送侧解析(纯函数,零 React/store 依赖) —— r31-goal-optimistic 抽出可测。
// 常驻条(GoalBar)的乐观显示依赖"发送文本是否 /goal、是设为新条件还是清除"的判定。
// 该判定同时被 App.jsx 的 handleSend(发送侧乐观亮/隐)与单测复用,故提为一个纯函数。
//
// 返回:
//   { type: 'set', condition: <string> }   —— /goal <条件> 设为新目标
//   { type: 'clear' }                      —— /goal clear 手动清除
//   null                                   —— 非 /goal 或不产生目标动作的 /goal
//        · 非 /goal 开头的普通消息
//        · 裸 /goal(无参数,CLI 走用法提示 / 查询当前目标,不设置)
//        · /goal clear 之外的 /goal 子命令不存在,但以防万一统一归 null
export function parseGoalCommand(text) {
  const t = String(text || '').trim();
  const m = /^\/goal\b\s*([\s\S]*)$/i.exec(t);
  if (!m) return null;            // 不是 /goal
  const rest = m[1].trim();
  if (/^clear\b/i.test(rest)) return { type: 'clear' };  // /goal clear
  if (!rest) return null;         // 裸 /goal:用法提示,不设目标
  return { type: 'set', condition: rest };
}

// 乐观目标不能只靠 SessionDetail 组件实例归属：同一 pane 切换会话时 React 会先用
// 新 session 重渲染、再运行清理 effect。把 owner 写进状态并在渲染期同步核对，旧会话
// 的目标便没有一帧机会画进新会话。
export function optimisticGoalForOwner(state, ownerKey) {
  if (!state || !ownerKey || state.ownerKey !== ownerKey) return null;
  return state.goal || null;
}

// draft 收到真实 session id 时，与 pane 换绑放在同一批状态更新中迁移 owner。
// 返回原引用表示本状态不属于该 draft，避免异步 init 误迁其他会话的乐观目标。
export function migrateOptimisticGoalOwner(state, fromOwnerKey, toOwnerKey) {
  if (!state || !fromOwnerKey || !toOwnerKey || state.ownerKey !== fromOwnerKey) return state;
  return { ...state, ownerKey: toOwnerKey };
}

export const MAX_HIDDEN_GOAL_IDENTITIES = 32;

export function goalIdentity(goal) {
  const condition = typeof goal === 'string' ? goal : goal?.condition;
  const normalized = String(condition || '').trim();
  return normalized ? `condition:${JSON.stringify(normalized)}` : '';
}

// 147b213 曾把 met/sentinel 拼进 fingerprint。它们是同一目标生命周期的状态而非身份；
// 这里列出四种旧值用于无损迁移。CLI 没有贯穿 goal_status 的真实 goal UUID，因此最小
// 稳定身份只能是 condition；同 condition 重新设定明确沿用原隐藏偏好。
export function legacyGoalIdentities(goal) {
  const condition = String((typeof goal === 'string' ? goal : goal?.condition) || '').trim();
  if (!condition) return [];
  return [
    `${condition}|false|true`,
    `${condition}|false|false`,
    `${condition}|true|false`,
    `${condition}|true|true`,
  ];
}

// 旧格式是同一 key 下的单个 fingerprint；新格式是 JSON 字符串数组。
// 读取时同时兼容两者，并从尾部保留最近身份，避免异常/旧数据无限膨胀。
export function parseHiddenGoalIdentities(raw, limit = MAX_HIDDEN_GOAL_IDENTITIES) {
  if (typeof raw !== 'string' || !raw) return [];
  let values;
  try {
    const parsed = JSON.parse(raw);
    values = Array.isArray(parsed) ? parsed : [raw];
  } catch {
    values = [raw];
  }
  const unique = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value || unique.includes(value)) continue;
    unique.push(value);
  }
  const cap = Math.max(1, Number(limit) || MAX_HIDDEN_GOAL_IDENTITIES);
  return unique.slice(-cap);
}

export function readHiddenGoalIdentities(storage, key, limit = MAX_HIDDEN_GOAL_IDENTITIES) {
  if (!storage || !key) return [];
  try { return parseHiddenGoalIdentities(storage.getItem(key), limit); } catch { return []; }
}

export function isGoalIdentityHidden(storage, key, identity, aliases = []) {
  if (!identity) return false;
  const hidden = readHiddenGoalIdentities(storage, key);
  return [identity, ...(Array.isArray(aliases) ? aliases : [])].some((value) => hidden.includes(value));
}

export function migrateHiddenGoalIdentity(storage, key, identity, aliases = [], limit = MAX_HIDDEN_GOAL_IDENTITIES) {
  if (!storage || !key || !identity) return false;
  const aliasSet = new Set(Array.isArray(aliases) ? aliases : []);
  const previous = readHiddenGoalIdentities(storage, key, limit);
  if (!previous.some((value) => aliasSet.has(value))) return false;
  const next = [];
  for (const value of previous) {
    const normalized = aliasSet.has(value) ? identity : value;
    if (!next.includes(normalized)) next.push(normalized);
  }
  const bounded = next.slice(-Math.max(1, Number(limit) || MAX_HIDDEN_GOAL_IDENTITIES));
  try {
    const serialized = JSON.stringify(bounded);
    storage.setItem(key, serialized);
    return storage.getItem(key) === serialized;
  } catch { return false; }
}

// 点击隐藏/显示后的本地瞬时态也必须带会话+身份；切到另一目标的首帧不能沿用旧 boolean。
export function resolveGoalHiddenState(transient, key, identity, persistedHidden = false) {
  if (transient?.key === key && transient?.identity === identity) return !!transient.hidden;
  return !!persistedHidden;
}

export function rememberHiddenGoalIdentity(storage, key, identity, limit = MAX_HIDDEN_GOAL_IDENTITIES) {
  if (!storage || !key || !identity) return false;
  const previous = readHiddenGoalIdentities(storage, key, limit).filter((value) => value !== identity);
  const next = [...previous, identity].slice(-Math.max(1, Number(limit) || MAX_HIDDEN_GOAL_IDENTITIES));
  try {
    const serialized = JSON.stringify(next);
    storage.setItem(key, serialized);
    return storage.getItem(key) === serialized;
  } catch { return false; }
}

export function forgetHiddenGoalIdentity(storage, key, identity) {
  if (!storage || !key || !identity) return false;
  const previous = readHiddenGoalIdentities(storage, key);
  const next = previous.filter((value) => value !== identity);
  if (next.length === previous.length) return false;
  try {
    if (next.length) storage.setItem(key, JSON.stringify(next));
    else storage.removeItem(key);
    return true;
  } catch { return false; }
}
