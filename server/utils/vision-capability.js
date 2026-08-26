// ── 视觉能力目录(r26-G6;r63 抽为独立纯模块)──────────────────────────────
// 用途:openai-proxy 的剥图判定(upstreamNoVision)主判据 —— 按 baseURL 正则判视觉
// 能力会被同名部署/网关聚合 URL 误判漏判,模型名才是能力的真实载体。
// 与思考目录同原则:只收有把握的形态,查无记录 → null(调用方回落旧 baseURL 正则,
// 维持现状),拿不准的一律不进表(判错成 vision:true 会把 deepseek 这类无视觉上游
// 的历史图片原样转发 → 400,方向性损失)。
//
// r63:从 model-capabilities.js 抽出(那边 re-export,服务端既有 import 路径不变)。
// 原因:前端黄条警告(ChatInput)需要与服务端同一份判定口径,而 model-capabilities.js
// 顶层 import node:fs(思考数据表)无法进 vite bundle —— 本文件必须保持零 node 依赖
// 的纯函数(client 引 server 纯模块先例:client/src/utils/plan.js → server/utils/plan.js)。
const VISION_CAPABILITY_CATALOG = [
  // r37:DeepSeek 识图系(deepseek-v4-flash-vision-exp 等,2026-08 上线)。必须排在下面
  // 全系 false 的一刀切【之前】(目录首命中即返回);实测其 openai 端点已收 image_url、
  // anthropic 端点收 image block(各答对纯色图),CI-4 的"全系 400"对识图系已过时。
  // 不锚定结尾:兼容 -exp 变体与 [1m] 后缀形态。字符类含 `/`:聚合商主流形态
  // `deepseek/deepseek-…-vision`(org 恰为 deepseek)在【全 id】阶段就会首命中下面的
  // 一刀切并返回,永远轮不到剥尾段重试 —— 例外行必须自己吃下这种全 id(判官 r37 实测)。
  { re: /^deepseek[\w./-]*vision/i, vision: true },
  // DeepSeek 其余模型无图像输入(CI-4 实证:image_url 报 400 unknown variant)。
  { re: /^deepseek/i, vision: false },
  // 以下为多模态公开事实明确的家族(判错成 false 只是多剥一次图,有占位文本兜底)。
  { re: /^claude-/i, vision: true },   // claude 3 起全系视觉
  { re: /^gpt-4o/i, vision: true },
  { re: /^gpt-4\.1/i, vision: true },
  { re: /^gpt-5/i, vision: true },
  { re: /^gemini/i, vision: true },
  { re: /^qwen[\w.-]*-vl/i, vision: true }, // qwen 视觉系
];

/**
 * 视觉能力查询:命中 → true/false;查无记录 → null(调用方按既有兜底处理,不猜)。
 * 命名空间前缀与 lookupModelCapabilities 同口径:剥到最后一段重试一次。
 */
export function lookupVisionCapability(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  const id = modelId.trim();
  const tail = id.includes('/') ? id.split('/').pop() : '';
  for (const key of tail ? [id, tail] : [id]) {
    for (const row of VISION_CAPABILITY_CATALOG) {
      if (row.re.test(key)) return row.vision;
    }
  }
  return null;
}
