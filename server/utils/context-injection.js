// r17-①:从"经过本机代理的真实请求体"里读出【这一回合往上下文注入了什么】
// (CLAUDE.md / skills / agents),供前端在回合区列几行小字。
//
// 数据从哪来:CLI 把注入物放在 **messages[0].content 数组**里,每块用
// `<system-reminder>` 包裹,块首文本就是天然分类标识(实测取证,见 r17-1 规格)。
// 注入物**不在 system 里** —— system 恒为 billing header / SDK 身份 / 主 prompt 三块,
// 与项目配置无关。
//
// 为什么官方订阅看不到:只有第三方 provider 的 ANTHROPIC_BASE_URL 指向本机代理
// (8788/8789),官方订阅是 CLI 直连 api.anthropic.com,请求体根本不过我们的手。
// 官方下本模块永不被调用 → 前端无数据 → 整块不渲染(这是设计,不是降级)。
//
// 隐私红线:输出**只有分类/固定标签/字符数**,绝不携带任何正文。用户的 CLAUDE.md
// 可能含隐私,skill 正文可能含私有流程 —— 它们不进日志、不进 WS 广播、不进前端 state。
// 唯一的例外是认不出的块(kind='other'),按规格保留其首行前 40 字,好让 CLI 换文案时
// 还能看出那是什么(首行是 CLI 的样板句,不是用户内容)。

import { broadcast } from '../broadcast.js';

const REMINDER_OPEN = '<system-reminder>';
const REMINDER_CLOSE = '</system-reminder>';

// 分类判据:块首文本前缀。CLI 内部文案会变,认不出一律归 other 并保留首行,不丢。
const RULES = [
  { prefix: 'Available agent types for the Agent tool:', kind: 'agents', label: 'agents' },
  { prefix: 'The following skills are available for use with the Skill tool:', kind: 'skills', label: 'skills' },
  { prefix: 'As you answer the user\'s questions, you can use the following context:', kind: 'claude-md', label: 'CLAUDE.md' },
];

// `<total_tokens>… tokens left</total_tokens>` 是预算播报,不是注入物 → 忽略。
const IGNORE_PREFIX = '<total_tokens>';

const OTHER_LABEL_MAX = 40;

// metadata.user_id 是一个 JSON 字符串:
// {"device_id":"…","account_uuid":"","session_id":"37fc40a1-…"}
// 实测 session_id 与 GUI 的 sessionId(~/.claude/projects/<hash>/<id>.jsonl 文件名)一致。
export function parseSessionIdFromMetadata(metadata) {
  const raw = metadata && metadata.user_id;
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const sid = parsed && parsed.session_id;
  return typeof sid === 'string' && sid ? sid : null;
}

function classify(inner) {
  for (const r of RULES) {
    if (inner.startsWith(r.prefix)) return { kind: r.kind, label: r.label };
  }
  // r17-1b(判官必修1):认不出的块【绝不能把首行原样带出来】。判官实测这不是"某天 CLI 变"
  // 才会踩的假设 —— 用户自己贴一段 transcript 调试、那条消息恰以 <system-reminder> 开头,
  // 首行就会被当成标签截 40 字送进 WS/store/UI。实测泄漏样本:含客户名+密钥+内网 IP 的
  // 中文句、`The user opened /Users/xxx/work/…` 的真实路径。而且 .trim() 会吃掉前导空行,
  // 取到的是第一个非空行而非样板句;40 这个预算按英文样板定,对中文就是一整句话。
  //
  // 现在只保留首行里【像 CLI 样板句的那一段纯 ASCII 字母】:含路径/中文/密钥/数字的一律
  // 匹配不到 → 退回固定标签。这样既保住原初衷(CLI 换文案时仍能看出是个什么块),
  // 又让任何用户内容都带不出来。
  // 判据:CLI 样板句的特征是【多个空格分隔的纯英文单词】;而密钥/标识符/路径的特征是
  // 连续无空格(SECRET-second-line-token-abc、/Users/x/y)。所以逐词扫,遇到第一个"不是
  // 纯字母词"就停,并要求至少凑够 3 个词才采信 —— 凑不够一律退回固定标签。
  const firstLine = inner.split('\n', 1)[0].trim();
  const words = [];
  for (const w of firstLine.split(/\s+/)) {
    if (!/^[A-Za-z][A-Za-z,.']*$/.test(w)) break; // 含数字/连字符/下划线/非 ASCII → 停
    words.push(w);
    if (words.join(' ').length >= OTHER_LABEL_MAX) break;
  }
  const boilerplate = words.length >= 3 ? words.join(' ').slice(0, OTHER_LABEL_MAX) : '';
  return { kind: 'other', label: boilerplate || '未知注入块' };
}

/**
 * 零 IO 纯函数。输入 = 解析后的 Anthropic 请求体。
 * 输出 = { sessionId, items: [{ kind, label, bytes }] },
 * 任何解析不出/没有注入物的情况一律返回 null(调用方据此静默跳过)。
 * kind ∈ {'agents','skills','claude-md','other'};bytes 是该块字符数(不是 token)。
 */
export function extractContextInjection(body) {
  if (!body || typeof body !== 'object') return null;
  const sessionId = parseSessionIdFromMetadata(body.metadata);
  if (!sessionId) return null; // 没有会话钥匙就无处可挂,不广播
  // r17-1b(判官建议2):载荷封顶。真实 CLI 只发 ~6 块,这两条纯属兜底 —— 上游若给出畸形
  // 超大值(判官实测 2MB 的 session_id / 10 万个 block → 4.7MB 广播),会原样推给所有 WS
  // 客户端(含局域网里的手机)。
  if (sessionId.length > 64) return null;

  const first = Array.isArray(body.messages) ? body.messages[0] : null;
  const content = first && Array.isArray(first.content) ? first.content : null;
  if (!content) return null;

  const items = [];
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (!text.startsWith(REMINDER_OPEN)) continue; // 用户自己那条消息不是注入物
    const end = text.lastIndexOf(REMINDER_CLOSE);
    const inner = text.slice(REMINDER_OPEN.length, end === -1 ? undefined : end).trim();
    if (!inner || inner.startsWith(IGNORE_PREFIX)) continue;
    const { kind, label } = classify(inner);
    if (!label) continue;
    items.push({ kind, label, bytes: block.text.length });
  }
  return items.length ? { sessionId, items: items.slice(0, 20) } : null;
}

/**
 * 代理里的**旁路**调用点:解析 + 提取 + 广播,整体吞异常。
 * 代理的首要职责是转发 —— 本功能坏掉不许拖垮聊天,所以这里绝不 rethrow,
 * 也绝不改动 body。入参可以是 Buffer/string(未解析)或已解析的对象。
 */
export function reportContextInjection(bodyOrRaw) {
  try {
    const body = (bodyOrRaw && typeof bodyOrRaw === 'object' && !Buffer.isBuffer(bodyOrRaw))
      ? bodyOrRaw
      : JSON.parse(String(bodyOrRaw));
    const out = extractContextInjection(body);
    if (!out) return null;
    broadcast({ type: 'context-injection', sessionId: out.sessionId, items: out.items });
    return out;
  } catch {
    return null; // 解析失败/广播抛错都不影响转发
  }
}
