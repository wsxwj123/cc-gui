// r193:附件段格式的唯一定义,页面(buildAttachmentMessage)与后端(图片改写)共用。
// 不依赖 node 内置模块,页面可直接引用。
// 形状:「文字 + 空行 + 附件: + 每行一个 @路径」;只有附件没有文字时文字部分是默认句。

export const ATTACHMENT_LABEL = '附件:';
export const ATTACHMENT_DEFAULT_TEXT = '请查看这些附件';

const SEGMENT_HEAD = `\n\n${ATTACHMENT_LABEL}\n`;

/**
 * 把「文字 + 路径列表」拼成发给命令行的提示词。text 由调用方先 trim;
 * 路径为空时只返回文字(文字也为空时用默认句)。
 * @param {string} text
 * @param {string[]} paths
 */
export function formatAttachmentPrompt(text, paths) {
  const list = Array.isArray(paths) ? paths : [];
  const body = String(text || '') || ATTACHMENT_DEFAULT_TEXT;
  if (!list.length) return body;
  return body + SEGMENT_HEAD + list.map((p) => `@${p}`).join('\n');
}

/**
 * 从提示词末尾解析附件段。只认末尾、前面有一个空行的「附件:」段,段内每行以 @ 开头,
 * @ 之后整行是路径(可含空格)。形状不符 → null(当作没有附件段)。
 * @param {string} prompt
 * @returns {{ text: string, paths: string[] } | null}
 */
export function parseAttachmentPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const at = prompt.lastIndexOf(SEGMENT_HEAD);
  if (at < 0) return null;
  const lines = prompt.slice(at + SEGMENT_HEAD.length).split('\n');
  const paths = [];
  for (const line of lines) {
    // 空行、不以 @ 开头的行、只有 @ 的行都说明这不是附件段(包括末尾多一个换行)。
    if (line.length < 2 || line[0] !== '@') return null;
    paths.push(line.slice(1));
  }
  return { text: prompt.slice(0, at), paths };
}
