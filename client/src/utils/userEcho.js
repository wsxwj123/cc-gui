// 用户消息「本地乐观气泡」与「历史回显」只画一份。
//
// 正常路径:流式期间 streamHistCutoff 把历史里那条藏起来;回合结束/落盘对账把本地气泡清掉。
// 但流式状态可能卡住(SSE 没收到 done、reattach/切窗格时序),对账 effect 因
// streamingRef.current 直接跳过 → 本地气泡一直留在列表末尾,而历史里其实早已落盘并继续
// 往后推进。表现:自己刚发的那句话反复出现在「最新消息」位置,切会话再回来就恢复。
//
// 这里给渲染层一道兜底:如果历史里能找到同一句话(文本归一化后相等),且那条历史之后
// 已经有其它内容(回合已推进),就把对应的本地副本隐藏 —— 历史那份仍在,不会少画。
// 只处理 user 类型;同一句话真的连发两次时,第二次的本地气泡时间戳晚于历史末条用户消息,
// 不会被误伤。
const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const squash = (text) => String(text || '').replace(/\s+/g, '');

export function dropStaleUserEchoes(localEntries, historyMessages, textOf) {
  const local = Array.isArray(localEntries) ? localEntries : [];
  const history = Array.isArray(historyMessages) ? historyMessages : [];
  if (!local.length || !history.length) return local;
  const getText = typeof textOf === 'function' ? textOf : (m) => (typeof m?.text === 'string' ? m.text : '');
  const lastTs = (m) => { const t = Date.parse(m?.timestamp); return Number.isFinite(t) ? t : null; };
  const stale = new Set();
  for (const entry of local) {
    if (entry?.type !== 'user') continue;
    const text = normalize(getText(entry));
    const textSquashed = squash(getText(entry));
    if (!text) continue;
    let hitAt = -1;
    let hitIdx = -1;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const m = history[i];
      if (m?.type !== 'user') continue;
      if (normalize(getText(m)) !== text && squash(getText(m)) !== textSquashed) continue;
      hitAt = lastTs(m);
      hitIdx = i;
      break;
    }
    if (hitIdx < 0) continue;
    // 历史里这句话之后已有内容(回复/下一条),说明本回合已推进:本地这份是残留。
    const advanced = hitIdx < history.length - 1;
    if (!advanced) continue;
    // 双保险:本地气泡必须不晚于历史那条(同文本连发时,后发的那条要保留)。
    const entryTs = lastTs(entry);
    if (entryTs != null && hitAt != null && entryTs > hitAt + 1500) continue;
    stale.add(entry);
  }
  return stale.size ? local.filter((m) => !stale.has(m)) : local;
}
