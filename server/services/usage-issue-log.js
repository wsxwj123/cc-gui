// R22/R24:上游 usage 无效(USAGE_INVALID)/自相矛盾(USAGE_INCONSISTENT)的说明落点。
//
// 【为什么不在 usage 里加自定义字段透传】CLI 落盘只保留 Anthropic 官方字段,自定义键
// (ccgui_usage)写 jsonl 时被丢掉 —— 接受轮实测:实例全部转写里 grep 不到,聚合层就无从
// 判断(数字还被归一压过:负数变 0)。所以判定发生在哪、结论就存在哪:代理把结论写进
// 服务端自有存储(GUI 数据目录,与读会话的进程同一 HOME),session-reader 每次读会话时
// 【现查】这份存储补进 usageTotals.codes/issues —— 不依赖 CLI 落盘,也不改写 CLI 已经
// 写下的数字(原始数字一并存着供说明)。
//
// 匹配键:消息 id(代理生成/上游给的那个,CLI 原样写进转写的 message.id)。
// 兜底:上游若给固定 id(多次调用撞同一个 id),再用「模型 + 四个数字全等 + 10 分钟窗口」
// 复核一次;两者取不到就如实不标(宁缺勿错标)。

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// 测试接缝:单测/多实例可以指到别处,避免碰用户真实数据目录。
const FILE = process.env.CGUI_USAGE_ISSUES_PATH || join(homedir(), '.claude-gui', 'usage-issues.json');
const MAX_ENTRIES = 200;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MATCH_WINDOW_MS = 10 * 60 * 1000;

let mem = null;       // Map<messageId, entry>
let memText = null;   // 上次解析用的文件原文:内容没变就不重复 parse
let memStat = null;   // 上次读到的文件签名(mtime+ctime+size):没变就连 readFileSync 都省掉
// session-reader 读一条 2000+ 记录的会话会按【每条 assistant 记录】调进来一次,同步整读这份
// 上限 200 条的 JSON 在长会话上是上千次阻塞读(实测 1500 × 138KB ≈ 65ms + 同量字符串垃圾)。
// 所以先 stat 判据:签名没变直接吃缓存 —— 别的进程写过(改了文件)签名必变,仍能发现。
let statCount = 0;    // 单测用:statSync / readFileSync 的真实次数
let readCount = 0;

function fileSignature() {
  statCount += 1;
  let s;
  try {
    s = statSync(FILE);
  } catch {
    return null; // 文件不存在/读不到 stat:交给 readFileSync 那步如实失败(行为同以前)
  }
  return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
}

function readEntries() {
  const sig = fileSignature();
  if (mem && sig === memStat) return { text: memText, sig, unchanged: true };
  readCount += 1;
  try {
    return { text: readFileSync(FILE, 'utf8'), sig };
  } catch {
    return { text: null, sig: null }; // 读失败不认这次 stat,下次照旧重试
  }
}

function ensureLoaded() {
  const { text, sig, unchanged } = readEntries();
  if (unchanged) return mem;
  if (mem && memText === text) { memStat = sig; return mem; } // 内容比对兜底:重写过但内容一样就不重 parse
  let entries = [];
  try {
    const parsed = JSON.parse(text || '{}');
    entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch { entries = []; }
  mem = new Map();
  for (const entry of entries) {
    if (entry && typeof entry.messageId === 'string') mem.set(entry.messageId, entry);
  }
  memText = text;
  memStat = sig;
  return mem;
}

function persist(map) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const entries = [...map.values()].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-MAX_ENTRIES);
    const text = JSON.stringify({ version: 1, entries });
    // 原子替换(写法同 usage-stats.js):直写被中途杀掉 = 半截 JSON,ensureLoaded 解析失败当空,7 天的说明标记全丢。
    writeFileSync(tmp, text);
    renameSync(tmp, FILE);
    memText = text; // 自己刚写的就是最新内容,不必重读
    memStat = null; // 但签名交给下一次查询重新取:若别的进程紧接着也写了,下次读得到
  } catch {
    // 落盘失败不影响判定本身:同一进程内 mem 仍然有效;删掉本次临时文件免得堆积。
    try { unlinkSync(tmp); } catch { /* 本来就没写出来 / 删不掉 */ }
  }
}

/** 记录一条用量问题的说明。messageId = 返回给 CLI 的 message.id(转写里逐字同值)。 */
export function recordUsageIssue({ messageId, model = null, codes = [], raw = null, sent = null, at = Date.now() }) {
  if (!messageId || !Array.isArray(codes) || !codes.length) return;
  const map = ensureLoaded();
  map.set(messageId, { messageId, model, codes: [...new Set(codes)], raw, sent, at });
  // 顺手清掉过期条目,别让文件无限长。
  const cutoff = Date.now() - KEEP_MS;
  for (const [id, entry] of map) if ((entry.at || 0) < cutoff) map.delete(id);
  persist(map);
}

function sameNumbers(sent, usage) {
  if (!sent || !usage) return false;
  const keys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  return keys.every((key) => (sent[key] || 0) === (usage[key] || 0));
}

/**
 * 把一条转写记录的 usage 补上说明标记(不存在的键保持原样)。
 * 命中 → { ...usage, ccgui_usage: { codes, raw } };未命中 → 原样返回。
 */
export function attachUsageIssues(usage, { messageId = null, model = null, timestamp = null } = {}) {
  if (!usage || typeof usage !== 'object') return usage;
  const map = ensureLoaded();
  let hit = messageId ? map.get(messageId) : null;
  if (!hit) {
    // 固定 id 的上游:按模型 + 四个数字全等 + 时间窗复核。
    const at = timestamp ? Date.parse(timestamp) : NaN;
    for (const entry of map.values()) {
      if (entry.model && model && entry.model !== model) continue;
      if (!sameNumbers(entry.sent, usage)) continue;
      if (Number.isFinite(at) && Math.abs(at - (entry.at || 0)) > MATCH_WINDOW_MS) continue;
      hit = entry;
      break;
    }
  }
  if (!hit) return usage;
  return { ...usage, ccgui_usage: { codes: hit.codes, raw: hit.raw || null } };
}

/** 仅测试用:丢掉内存缓存,强制下次从文件重读。 */
export function __resetUsageIssueCache() {
  mem = null;
  memText = null;
  memStat = null;
  statCount = 0;
  readCount = 0;
}

/** 仅测试用:导出到当前为止的真实 I/O 次数(证明缓存生效 / 外部改动被发现)。 */
export function __readStats() {
  return { stats: statCount, reads: readCount };
}

export const USAGE_ISSUE_FILE = FILE;
