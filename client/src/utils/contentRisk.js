// r99:上游内容审核拒绝的识别 + 回退锚点定位。纯函数,零依赖(单测直接 import)。
// 形态来源:用户真机会话 0470c33e(DeepSeek,2026-09-03)落盘的 <synthetic> 消息
// 「API Error: 400 Content Exists Risk」。
// 只收录有实证的形态。GLM / Kimi / 通义 / Azure 的疑似文案未经官方文档核对,一律不收
// (误判的代价是劝用户删掉一段没问题的历史,比漏判贵)。收录一条 = 加一行 + 加一条单测正例。
const REFUSAL_PATTERNS = [
  // 不绑 HTTP 状态码:中转网关会把 400 改写成各种 4xx/5xx,绑了只会漏判;
  // 该短语本身足够特异,\s+ 兼容多空格/制表符换行。
  { vendor: 'deepseek', re: /content\s+exists\s+risk/i },
];

/** 上游错误文案是否为"内容审核拒绝"。只喂错误文本,绝不喂用户消息 / 模型正文。 */
export function classifyUpstreamRefusal(text) {
  const s = typeof text === 'string' ? text : '';
  for (const { vendor, re } of REFUSAL_PATTERNS) {
    if (re.test(s)) return { kind: 'content-risk', vendor };
  }
  return null;
}

/** 历史里最后一条真实用户消息的下标;没有返回 -1。纯空白不算。 */
export function lastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.type === 'user' && typeof m.text === 'string' && m.text.trim()) return i;
  }
  return -1;
}

/**
 * 回退锚点:从后往前找【最后一个已拿到 result 的 tool_use】,连同其后全部内容裁掉。
 * result == null 的悬挂工具是失败那一刻的产物,不是污染源,跳过。
 * carryText = 锚点之后最后一条用户消息的文本(会被一起裁掉,必须捞出来重发);没有则 ''。
 * 找不到锚点返回 null(调用方走退化路径)。
 */
export function locateRiskAnchor(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.type !== 'turn' || !Array.isArray(m.toolCalls)) continue;
    const done = m.toolCalls.filter((t) => t && t.id && t.name && t.result != null);
    if (!done.length) continue;
    const tool = done[done.length - 1];
    const ui = lastUserIndex(messages.slice(i + 1));
    return {
      turnIndex: i,
      turnUuid: m.uuid,
      toolUseId: tool.id,
      toolName: tool.name,
      toolInput: tool.input,
      carryText: ui === -1 ? '' : messages[i + 1 + ui].text,
    };
  }
  return null;
}

/**
 * 回退后给模型的续跑指令。绝不能复用「工具重做」那句"再跑一次同一个工具"的原文案 ——
 * 那会让模型立刻再产出同一段被审核拦截的内容 = 死循环。
 */
export const RISK_CONTINUE_PROMPT = [
  '上一步的工具输出被服务商的内容审核拒绝，GUI 已把会话裁剪到该工具调用之前。',
  '不要重新执行同一个工具、也不要重新读取同一段内容。',
  '改用其它方式继续原任务；若该内容是任务必需的，直接说明无法获取并给出替代方案。',
].join('\n');
