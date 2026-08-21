// r10-12:旧会话切官方 400 "text content blocks must be non-empty" 的会话文件清理。
// 实证形态(bf36c461,全第三方历史):
//   - assistant 行 content=[{type:'text',text:''}](deepseek 残缺回合)→ 官方直接 400;
//   - assistant 行 content 数组里 {type:'thinking',thinking:''} 与其他块共存。
// 规则(r26-G5 起与两路 proxy 的空块处置完全对齐——anthropic-proxy
// normalizeMessagesForCompat 与 openai-proxy 翻译层均丢弃空 text 与空 thinking 块,
// openai 路不再产出空 reasoning_content;非空 thinking 保留,deepseek 系上游要求
// thinking 轮次回传。本文件把同一规则作用于 jsonl 行):
//   R1 user/assistant 行 message.content 数组中删除空/纯空白 text 块;
//   R2 同处删除空/纯空白 thinking 块;
//   R3 某行 content 因此清空 → 删整行,parentUuid 链接骨(所有指向该行 uuid 的引用
//      重指到该行的 parentUuid)。引用字段清单(session-reader/sessions.js grep 实证):
//      每行 parentUuid、summary 行 leafUuid、compact_boundary 行 logicalParentUuid。
// 只删不改写内容;非 user/assistant 行与解析失败的行原样透传;幂等(二次跑 report 全零)。

const isBlankText = (c) =>
  c && typeof c === 'object' && c.type === 'text'
  && (c.text == null || String(c.text).trim() === '');
const isBlankThinking = (c) =>
  c && typeof c === 'object' && c.type === 'thinking'
  && (c.thinking == null || String(c.thinking).trim() === '');

/**
 * 纯函数:lines(字符串数组,jsonl 各行)→ { lines, report }。
 * report = { emptyText, emptyThinking, droppedLines, relinked }(只数字,不含正文)。
 */
export function repairOfficialCompat(lines) {
  const report = { emptyText: 0, emptyThinking: 0, droppedLines: 0, relinked: 0 };
  // 第一遍:清块;因此清空的行记 uuid → parentUuid,先不落地。
  const entries = []; // { raw, obj|null, changed, dropped }
  const droppedParent = new Map(); // uuid → parentUuid(被删行)
  for (const raw of lines) {
    let obj = null;
    try { obj = JSON.parse(raw); } catch { entries.push({ raw, obj: null }); continue; }
    const isMsg = obj && (obj.type === 'user' || obj.type === 'assistant')
      && obj.message && Array.isArray(obj.message.content);
    if (!isMsg) { entries.push({ raw, obj }); continue; }
    const orig = obj.message.content;
    const kept = [];
    for (const c of orig) {
      if (isBlankText(c)) { report.emptyText++; continue; }
      if (isBlankThinking(c)) { report.emptyThinking++; continue; }
      kept.push(c);
    }
    if (kept.length === orig.length) { entries.push({ raw, obj }); continue; }
    if (kept.length === 0 && orig.length > 0) {
      // R3:整行删除(只有"因清块而空"才删;原本就空的 content 不动,保证幂等)。
      report.droppedLines++;
      if (typeof obj.uuid === 'string') {
        droppedParent.set(obj.uuid, typeof obj.parentUuid === 'string' ? obj.parentUuid : null);
      }
      entries.push({ raw, obj, dropped: true });
    } else {
      obj.message.content = kept;
      entries.push({ raw, obj, changed: true });
    }
  }
  if (droppedParent.size === 0) {
    return {
      lines: entries.map((e) => (e.changed ? JSON.stringify(e.obj) : e.raw)),
      report,
    };
  }
  // 被删行的 parent 也可能被删:沿映射解析到首个存活 uuid(或 null)。
  const resolveAlive = (u) => {
    let cur = u;
    const seen = new Set();
    while (cur != null && droppedParent.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = droppedParent.get(cur);
    }
    return cur ?? null;
  };
  // 第二遍:接骨。所有存活行的 uuid 引用字段若指向被删行 → 重指。
  const out = [];
  for (const e of entries) {
    if (e.dropped) continue;
    if (!e.obj) { out.push(e.raw); continue; }
    const o = e.obj;
    let changed = e.changed;
    for (const field of ['parentUuid', 'logicalParentUuid', 'leafUuid']) {
      const v = o[field];
      if (typeof v === 'string' && droppedParent.has(v)) {
        o[field] = resolveAlive(v);
        changed = true;
        report.relinked++;
      }
    }
    out.push(changed ? JSON.stringify(o) : e.raw);
  }
  return { lines: out, report };
}
