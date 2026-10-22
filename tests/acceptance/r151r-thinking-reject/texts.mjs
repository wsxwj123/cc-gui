// 接口文件(.devflow/r151r-thinking-reject-接口.md)里逐字给出的文案。改这里必须同步对照接口文件(标点有全角/半角之分)。
export const CARD_BUTTON = '体检与清理(自动备份原文件)…';
export const CARD_DESC_PENDING = '检测到历史可能含官方不接受的空内容块';
export const cardDescDone = (emptyText, emptyThinking) => `检测到历史含官方不接受的空内容块(空text ${emptyText} 处/空thinking ${emptyThinking} 处)`;
export const GUIDE_CARD = '清理只删除空段落。清理后仍被拒：切回原来的 provider,在此会话执行 /compact 后再切回;或新开会话。';
export const GUIDE_SIGNATURE = '会话历史里有其他模型留下的思考内容，当前接口不接受。切回原来的 provider,在此会话执行 /compact 后再切回;或新开会话。';

export const ERR_THINKING_BLANK = 'API Error: 400 messages.3.content.0.thinking: each thinking block must contain non-whitespace thinking';
export const ERR_TEXT_EMPTY = 'API Error: 400 messages.1.content.0.text: text content blocks must be non-empty';
export const ERR_TOO_LONG = 'API Error: 400 prompt is too long: 250000 tokens > 200000 maximum';
export const ERR_SIGNATURE = 'API Error: 400 messages.5.content.0: Invalid `signature` in `thinking` block';
// 接口写明"大小写不敏感,反引号可有可无":下面两条各放宽一处
export const ERR_SIGNATURE_NO_TICKS = 'API Error: 400 messages.5.content.0: Invalid signature in thinking block';
export const ERR_SIGNATURE_UPPER = 'API Error: 400 messages.5.content.0: INVALID `SIGNATURE` IN `THINKING` BLOCK';

// 页面上用来确认"这条报错已经显示出来"的片段(Playwright getByText 默认不分大小写)
export const SNIP_THINKING_BLANK = 'each thinking block must contain non-whitespace thinking';
export const SNIP_TEXT_EMPTY = 'text content blocks must be non-empty';
export const SNIP_TOO_LONG = 'prompt is too long: 250000 tokens > 200000 maximum';
// 签名报错:页面渲染报错时会吃掉反引号(按 markdown 行内代码显示),所以定位用"反引号可有可无 + 不分大小写"的正则;
// 比先后顺序时用去掉反引号后的小写纯文本。
export const SIG_ERROR_RE = /invalid\s+`?signature`?\s+in\s+`?thinking`?\s+block/i;
export const SIG_ERROR_PLAIN = 'invalid signature in thinking block';
