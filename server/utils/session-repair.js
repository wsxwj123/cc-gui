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
// 只删不改写内容;非 user/assistant 行与解析失败的行原样透传;幂等(二次跑 report 的
// emptyText/emptyThinking/droppedLines/relinked 全零)。
// r26-G7:原本就是空数组的 content[](非清块所致)只报不修——report.zeroBlocks 计数
// (zeroBlocksByType 按 user/assistant 分桶),行原样保留。不自动删的理由:jsonl 行有
// parentUuid 链,删行会让其子行变孤儿,接骨复杂度与收益(几行空壳)不配;若未来要做,
// 应做「重指 parent 后删」的完整事务。zeroBlocks 是存量观察计数,二次跑仍会报出,
// 不属于幂等"全零"口径。

const isBlankText = (c) =>
  c && typeof c === 'object' && c.type === 'text'
  && (c.text == null || String(c.text).trim() === '');
const isBlankThinking = (c) =>
  c && typeof c === 'object' && c.type === 'thinking'
  && (c.thinking == null || String(c.thinking).trim() === '');

/**
 * 纯函数:lines(字符串数组,jsonl 各行)→ { lines, report }。
 * report = { emptyText, emptyThinking, droppedLines, relinked, zeroBlocks,
 *            zeroBlocksByType: { user, assistant } }(只数字,不含正文)。
 */
export function repairOfficialCompat(lines) {
  const report = {
    emptyText: 0, emptyThinking: 0, droppedLines: 0, relinked: 0,
    zeroBlocks: 0, zeroBlocksByType: { user: 0, assistant: 0 },
  };
  // 第一遍:清块;因此清空的行记 dropped 候选(uuid → parentUuid),先不落地。
  const entries = []; // { raw, obj|null, changed, dropped }
  const droppedCandidates = []; // { uuid, parentUuid } 按出现顺序
  for (const raw of lines) {
    let obj = null;
    try { obj = JSON.parse(raw); } catch { entries.push({ raw, obj: null }); continue; }
    const isMsg = obj && (obj.type === 'user' || obj.type === 'assistant')
      && obj.message && Array.isArray(obj.message.content);
    if (!isMsg) { entries.push({ raw, obj }); continue; }
    const orig = obj.message.content;
    // r26-G7:原本就空的 content[](非清块所致)——只报不修,计数后原样透传。
    if (orig.length === 0) {
      report.zeroBlocks++;
      report.zeroBlocksByType[obj.type]++; // isMsg 已保证 type ∈ {user, assistant}
      entries.push({ raw, obj });
      continue;
    }
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
        droppedCandidates.push({
          uuid: obj.uuid,
          parentUuid: typeof obj.parentUuid === 'string' ? obj.parentUuid : null,
        });
      }
      entries.push({ raw, obj, dropped: true });
    } else {
      obj.message.content = kept;
      entries.push({ raw, obj, changed: true });
    }
  }
  // r26-G8:同 uuid 重复行(断线重发/补丁写入的真实形态)——优先指向仍存活(未被本次
  // 修复摘除)的同名行:被删行的 uuid 若有存活同名行,不进 droppedParent,指向它的引用
  // 保持原样(即指向活行)。同名行全灭才沿 parent 链上溯;多个全灭同名行时后者覆盖
  // 前者(Map.set 语义),即指向最后出现的死行的 parent(保确定性)。
  const aliveUuids = new Set();
  for (const e of entries) {
    if (!e.dropped && e.obj && typeof e.obj.uuid === 'string') aliveUuids.add(e.obj.uuid);
  }
  const droppedParent = new Map(); // uuid → parentUuid(被删行,且无存活同名行)
  for (const d of droppedCandidates) {
    if (!aliveUuids.has(d.uuid)) droppedParent.set(d.uuid, d.parentUuid);
  }
  if (droppedParent.size === 0) {
    // r26-G8:被摘行的 uuid 都有存活同名行时 droppedParent 为空——无需接骨,
    // 但被摘行本身仍须从输出剔除(e.dropped 过滤不能省)。
    return {
      lines: entries.filter((e) => !e.dropped).map((e) => (e.changed ? JSON.stringify(e.obj) : e.raw)),
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
