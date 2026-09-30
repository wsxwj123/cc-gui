// tool_result.content 在多数 provider 下不是字符串,而是内容块数组
// [{type:'text', text:'正文\n\n第二段'}]。直接 JSON.stringify 会把整段连同字面 \n
// 序列化成 JSON 原文(子代理/后台任务回复显示成 JSON 的根因 AZ4)。
// 抽出可读文本;字符串原样返回;其它兜底 String()。
//
// r132:字符串里**夹带图片载荷**的也要拆开 —— 有些 provider / 工具把图片塞进文本
// (`data:image/png;base64,xxx` 或 `{"type":"image","file":{"base64":...}}`,甚至双层转义),
// 以前整段当正文显示 → 用户看到满屏 base64、看不到图(用户实报)。现在这类载荷会被抽成
// images、并从正文里摘掉;**不含图片载荷的字符串一字不改**(反向锁见
// tests/unit/check-r116-tool-result-shape.mjs 的 U6 与本轮新增的反向条)。

/** 短于这个长度的 base64 不当图片(源码 / 日志里贴的示例串不该被当图)。 */
export const MIN_IMAGE_PAYLOAD = 512;
const IMAGE_MIME_RE = /image\/(png|jpe?g|webp|gif|bmp|avif)/i;
const B64_RUN_RE = /[A-Za-z0-9+/]{512,}={0,2}/g;
// 认"长 base64 串是不是图片"的上下文判据:±400 字里得出现图片标记
const IMAGE_CONTEXT_RE = /image\/(png|jpe?g|webp|gif|bmp|avif)|"type"\s*:\s*"image"|\\"type\\"\s*:\s*\\"image\\"|"base64"|\\"base64\\"/i;

/** 已知图片格式的 base64 前缀(前 12 字节)→ mime;认不出返回 null。
 *  不用 atob/Buffer,客户端与 server 两份拷贝能逐字相同。 */
export function sniffMimeFromB64(b64) {
  const head = String(b64 || '').slice(0, 24);
  if (head.startsWith('iVBORw0KGgo')) return 'image/png';
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  if (head.startsWith('Qk')) return 'image/bmp';
  return null;
}

/**
 * 把字符串里的图片载荷抽出来:返回 { images:[{mime,data}], rest:"摘掉载荷后的正文" }。
 * 纯函数、单趟;认不出图片时 **rest 与入参逐字相同**(调用方据此保持"纯文本字符串一字不改")。
 * 认两种写法:
 *   ① data URL:`data:image/png;base64,<≥256 字符>`(显式标记,够可信),连前缀一起摘掉;
 *   ② JSON 文本形态(含 `\"` 双层转义):≥512 字符的 base64 串,且 ±400 字内有图片标记
 *      (media_type / mimeType / "type":"image" / "base64"),mime 取上下文里的、其次按 magic bytes 认。
 */
/** 单层反转义(有些工具把 JSON 序列化了两次:`{\\"type\\":\\"image\\"…}`)。 */
function unescapeJsonOnce(t) {
  return String(t).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/** 整个字符串就是一个 JSON 值时:按结构走一遍,抽图(含 file.base64 / source.data / MCP 形态)
 *  并把 text 字段当正文。返回 {images, rest} 或 null(不是 JSON / 没图)。 */
function jsonImageScan(src) {
  const t = String(src).trim();
  if (!/^[[{]/.test(t) || !/[}\]]$/.test(t)) return null;
  for (const cand of [t, unescapeJsonOnce(t)]) {
    let obj;
    try { obj = JSON.parse(cand); } catch { continue; }
    const images = [];
    const texts = [];
    const walk = (n, insideImg) => {
      if (Array.isArray(n)) { for (const x of n) walk(x, insideImg); return; }
      if (!n || typeof n !== 'object') return;
      const str = (v) => (typeof v === 'string' ? v : '');
      const data = str(n.source?.data || n.base64 || n.data || n.file?.base64);
      const typeStr = str(n.type);
      const looksImg = typeStr === 'image' || /^image\//.test(typeStr) || (insideImg && !!data);
      if (looksImg && data) {
        const mime = str(n.source?.media_type || n.mimeType || n.media_type || n.file?.type || (/^image\//.test(typeStr) ? typeStr : '')) || sniffMimeFromB64(data) || 'image/png';
        const dm = data.match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/);
        images.push(dm
          ? { mime: dm[1].toLowerCase(), data: dm[2].replace(/\s+/g, '') }
          : { mime: mime.toLowerCase(), data });
        return;   // 同一棵子树里的内层 base64 不再重复认
      }
      if (typeof n.text === 'string') texts.push(n.text);
      for (const v of Object.values(n)) walk(v, false);
    };
    walk(obj, false);
    if (images.length) return { images, rest: texts.join('\n').trim() };
  }
  return null;
}

export function splitImagePayloadsInString(input) {
  const src = typeof input === 'string' ? input : (input == null ? '' : String(input));
  if (src.length < 256) return { images: [], rest: src };
  const asJson = jsonImageScan(src);
  if (asJson) return asJson;
  const images = [];
  let rest = src.replace(/data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]{256,})/gi, (_m, mime, data) => {
    images.push({ mime: String(mime).toLowerCase(), data: String(data).replace(/\s+/g, '') });
    return '';
  });
  rest = rest.replace(B64_RUN_RE, (run, offset) => {
    const around = rest.slice(Math.max(0, offset - 400), offset + run.length + 400);
    if (!IMAGE_CONTEXT_RE.test(around)) return run;
    const hit = around.match(IMAGE_MIME_RE);
    images.push({ mime: hit ? `image/${hit[1].toLowerCase()}` : (sniffMimeFromB64(run) || 'image/png'), data: run });
    return '';
  });
  if (!images.length) return { images: [], rest: src };
  const cleaned = rest
    .replace(/data:image\/[\w.+-]+;base64,\s*/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 摘完剩下的是**普通散文**就原样留(不许把"图在这:…完事"这种短句吞掉);
  // 只有当它长得像 JSON 脚手架时,才按"去掉键名后还剩多少可读内容"决定要不要留。
  if (!/[{[\"]/.test(cleaned)) return { images, rest: cleaned };
  const stripped = cleaned.replace(/"(?:type|source|base64|data|media_type|mimeType|file|file_path|dimensions|originalSize|displayWidth|displayHeight|image|text)"\s*:?/g, '');
  const meaningful = stripped.replace(/[\s{}[\]",:\\]+/g, '');
  const hasCJK = /[\u4e00-\u9fff]/.test(meaningful);
  return { images, rest: (hasCJK || meaningful.length >= 24) ? cleaned : '' };
}

export function extractToolResultText(content) {
  if (typeof content === 'string') return splitImagePayloadsInString(content).rest;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b) => splitImagePayloadsInString(b.text || '').rest)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return splitImagePayloadsInString(content.text).rest;
  }
  return content == null ? '' : String(content);
}

// 抽出 tool_result 里的图像块(三种形态都收:Anthropic 的 source:{type:'base64',
// media_type,data}、MCP 直传的 {mimeType,data}、以及"夹在字符串 / 文本块里的载荷")。
// computer-use 截图等工具的返回靠它进 UI;没有则返回 []。
export function extractToolResultImages(content) {
  const fromBlocks = (blocks) => blocks
    .filter((b) => b && (b.type === 'image' || typeof b.data === 'string'))
    .map((b) => ({ mime: b.source?.media_type || b.mimeType || 'image/png', data: b.source?.data || b.data || '' }))
    .filter((b) => b.data);
  if (typeof content === 'string') return splitImagePayloadsInString(content).images;
  if (Array.isArray(content)) {
    const images = fromBlocks(content);
    // 文本块里夹带的图片载荷:同一条 result 既有正文又有图时不丢图
    for (const b of content) {
      if (b && typeof b.text === 'string') images.push(...splitImagePayloadsInString(b.text).images);
    }
    return images;
  }
  if (content && typeof content === 'object') {
    const images = fromBlocks([content]);
    if (images.length) return images;
    if (typeof content.text === 'string') return splitImagePayloadsInString(content.text).images;
  }
  return [];
}

// 停止(真杀进程,turnAborted=killedRef)时给未回执的普通工具补一个合成终态,
// 否则 tool_result 永不到达 → 卡片(SkillCard/ToolCallRow 只看 result)永久转圈。
// gate 必须是 turnAborted:detach/后台化(killedRef=false)进程还在跑、tool_result 会迟到,
// 不能提前标终态。tc.result 短路天然不覆盖已有回执(含 run_in_background 的"已派发"result)。
// ⚠️ 排除 Task/Agent:其卡片状态走 activeAgents + TaskCard 的 isInterrupted(=!agent&&!result)。
// 给它补 result 会让【无 agent 的 Task】(不发父流事件 provider)从"已停止"翻成绿勾"完成"。
export function finalizePendingToolCalls(toolCalls, turnAborted) {
  return (toolCalls || []).map((tc) => {
    const isAgent = tc && (tc.name === 'Task' || tc.name === 'Agent');
    return {
      ...tc,
      category: tc.category || 'call',
      result: (tc.result || !turnAborted || isAgent)
        ? tc.result
        : { content: '', isError: false, synthetic: true, interrupted: true },
    };
  });
}

// 把 finalize 后的 toolCalls 按 id 回写进有序 blocks(fable 判官阻断项):官方 CLI
// includePartialMessages 恒开必发 stream_event → tool_use 进 blocks → TurnBubble 有
// blocks 时【只渲染 blocks】,只 finalize toolCalls 修不到主路径,卡片照样永久转圈。
// 只替换"原本无 result 且 finalize 后拿到 result"的 tool_use 块;已有 result 的块
// 与非工具块原引用返回,不打穿下游 memo。
export function applyFinalizedToBlocks(blocks, finalizedCalls) {
  if (!Array.isArray(blocks) || blocks.length === 0) return blocks;
  const byId = new Map((finalizedCalls || []).filter((t) => t && t.id).map((t) => [t.id, t]));
  return blocks.map((b) => {
    if (!b || b.type !== 'tool_use' || !b.toolCall || b.toolCall.result) return b;
    const fin = byId.get(b.toolCall.id);
    return fin && fin.result ? { ...b, toolCall: fin } : b;
  });
}
