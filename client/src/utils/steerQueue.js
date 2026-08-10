// 引导注入(steer)的队列态机 —— 设计乙。
//
// 语义:回合进行中直发 = 入队(默认行为,与 0.2.283 一致)。只有用户点队列条目上的
// 「⚡ 并入」才 POST /api/chat/steer 把它推进正在跑的回合。注入成功后消息【留在队列区】
// 换个状态显示,而不是弹出去画气泡 —— 对话流里它只在回合结束、从 jsonl 重排后出现在
// 真实的并入位置(用户实测确认该终态正确)。
//
// 于是"已并入"的条目有两条硬性质:
//   ① 排空(drain)必须跳过它 —— 它已经送达 CLI 了,drain 再发一次就是双发;
//   ② 不可编辑/不可撤回 —— 已送达的东西撤不回来,给按钮就是骗人。
// 而"送没送到"的唯一权威是**回合结束后的持久化核对**(下面 reconcileSteered),不是
// command_lifecycle 事件 —— 后者第三方 provider 未必发,只配做文案上的精确化。

// 这条队列消息是否已经注入出去了。判据用 steerId 而不是状态字符串:状态可能被
// lifecycle 事件改写(sent → merged),但只要有 id 就代表"已送达,别再发第二遍"。
export function isSteered(item) {
  return !!(item && item.steerId);
}

// 队列里第一条【还能发】的消息的下标(-1 = 没有)。
// hidden(计划续跑等系统消息)照旧参与 drain,只是不在 UI 上显示;已注入的必须跳过。
export function firstDrainableIndex(list) {
  if (!Array.isArray(list)) return -1;
  return list.findIndex((m) => m && m.text && !isSteered(m));
}

// 第一条可以点「⚡ 并入」的消息下标:用户可见(非 hidden)且还没注入过。
export function firstSteerableIndex(list) {
  if (!Array.isArray(list)) return -1;
  return list.findIndex((m) => m && m.text && !m.hidden && !isSteered(m));
}

// 内容签名:与持久化记录比对用。CLI 落盘的是原文,但空白可能被规整,故压空白后截断。
export function steerSig(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// 持久化消息里所有用户消息的签名集合(reconcileSteered 的输入)。
export function persistedUserSigs(persisted) {
  const out = new Set();
  for (const m of (Array.isArray(persisted) ? persisted : [])) {
    if (m?.type !== 'user') continue;
    const t = Array.isArray(m.text) ? m.text.join('') : m.text;
    const sig = steerSig(t);
    if (sig) out.add(sig);
  }
  return out;
}

// 回合收尾的落地判定(替代旧设计里的"气泡回捞"):对每个已注入的队列条目查持久化 ——
//   查到了 → CLI 真读了它,从队列移除(它已是对话历史的一部分);
//   查不到 → 折叠之前回合就被停/进程死了,那条命令随 CLI 内存队列一起没了 →
//            退回普通排队态(steerId/steerState 清掉),用户可编辑、可删、也会被 drain
//            正常发出。**一个字都不丢**,这就是撤掉气泡回捞后"无丢失"的承载点。
// 未注入的条目原样不动。无变化时返回原数组引用(不打穿 React 的引用比较)。
export function reconcileSteered(list, landedSigs) {
  if (!Array.isArray(list) || !list.length) return list;
  if (!list.some(isSteered)) return list;
  const sigs = landedSigs instanceof Set ? landedSigs : new Set();
  const out = [];
  for (const m of list) {
    if (!isSteered(m)) { out.push(m); continue; }
    if (sigs.has(steerSig(m.text))) continue; // 已落盘 → 出队
    const { steerId, steerState, ...rest } = m; // eslint-disable-line no-unused-vars
    out.push(rest); // 没落盘 → 翻回普通排队态
  }
  return out;
}

// localStorage 恢复时的清洗:steer 状态是【进程内在飞】的状态,跨重启必然失效 ——
// 上个进程注入到一半就被关掉的条目,若带着"已并入"状态回来,drain 会永远跳过它 =
// 消息永久卡死。恢复时一律退回普通排队态。
export function stripSteerState(queueMap) {
  if (!queueMap || typeof queueMap !== 'object') return {};
  const out = {};
  for (const [k, list] of Object.entries(queueMap)) {
    if (!Array.isArray(list)) continue;
    out[k] = list.map((m) => {
      if (!isSteered(m)) return m;
      const { steerId, steerState, ...rest } = m; // eslint-disable-line no-unused-vars
      return rest;
    });
  }
  return out;
}
