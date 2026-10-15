// r151b 跨会话通信:信封构造、来源名规则、正文中和(方案 X.1.7、INTERFACE X.3.6)。纯函数,不读写任何东西。
//
// 为什么要这样做:GUI 把信封作为一条用户消息推进目标会话的输入流,CLI 认作"宿主注入的跨会话消息"。CLI 只有在
// "按严格解析结果重建的信封与原文逐字相等"时才给出 origin.name / origin.body(CLI 2.1.296 的 `_()` / `ldt()`;
// 2.1.273 同构),重建时:
//   · 正文过 L5e("cross-session-message"):把闭合标签的各种写法开头的类小于号换成 `<\`;
//   · 来源名过 Ny(去掉 Cf/Cc/Cs/Zl/Zp 类字符 → trim → 超过 64 个码点截断加 `…`)。
// 所以 GUI 构造的信封必须是这次重建的"不动点",否则 name 与 body 一起丢(验证 C)。同时 CLI 对推入的正文不做任何
// 中和,模型看到的就是推入的原文 —— 正文里的闭合标签会让信封在模型眼里"提前闭合",所以中和也是为了模型。
//
// 正文中和(H7′,T-X0 实测后加强过的最终形态):
//   1. 回车换行与单独的回车统一成换行。
//   2. 在正文里找标签集合 XS_NEUTRALIZE_TAGS 中任一标签名的写法:不分大小写(含 Unicode 大小写折叠,与 CLI 同为
//      `iu`)、`-` 处可以是任一连接符(CLI 的连接符集合)、各字符之间可夹空白与不可见字符(CLI 的不可见字符集合
//      加上全部格式字符与组合记号)、标签名后面是 `A–Z a–z 0–9 _ -` 以外的字符或正文结尾。标签名前面可以有斜杠
//      (`/` `／` `∕` `⁄`),斜杠与标签名之间同样可夹空白与不可见字符。
//   3. 对每处匹配做两件事,需要插 `\` 的位置去重后一次插入:
//      (a) 取匹配前面(跳过空白与不可见字符)最近的一个字符;如果它不是 ASCII 字母、数字、`_`、`-`,也不是 `\`,
//          就在它后面插入 `\`(方案原规则;`_` `-` 是 T-X0 收窄的:它们与标签名连成一个更长的词,CLI 也不认)。
//      (b) 从标签名第一个字母往前,跨过所有"不是 ASCII 字母数字 / `_` / `-` / 类尖括号"的字符(CLI 闭合标签匹配里
//          类小于号与标签名之间允许出现的就是这些字符,包括 `\`、汉字、标点、换行);如果停在一个类小于号上,而它
//          后面紧跟的不是 `\`,就在它后面插入 `\`(T-X0 加强:CLI 只检查类小于号紧后那一个字符是不是 `\`,
//          `< \/x`、`<中/x`、`</\x` 这类写法在方案原规则下仍会被 CLI 改写,往返失败)。
//   4. 其余字符原样。对结果再中和一次不再变化(幂等)。
// 代价:正文里恰好在符号后面写出这些标签名时会多一个 `\`;origin.body 就是中和后的文本。

export const XS_ENVELOPE_TAG = 'cross-session-message';

/** 正文中和的标签集合 T(方案 X.1.7 第 2 条)。 */
export const XS_NEUTRALIZE_TAGS = Object.freeze([
  'cross-session-message', 'agent-message', 'system-reminder', 'task-notification',
  'command-name', 'command-message', 'command-args',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat',
]);

export const XS_SOURCE_NAME_MAX_UTF16 = 64;
export const XS_UNNAMED_SOURCE = '未命名会话';

// 与 server/services/session-reader.js 的 SESSION_ID_SHAPE 同一判据(单测钉住两者一致;这里不 import 它,保持纯模块)。
const SESSION_ID_SHAPE = /^[0-9a-fA-F-]{36}$/;
/** 信封 from 只有两种:手动转发 `gui:user`,AI 发送 `gui:<发送方会话id>`(都在 CLI 的 from 字符集 A–Z a–z 0–9 % : _ / . \ - 内)。 */
export function isValidXsFrom(from) {
  if (typeof from !== 'string' || !from.startsWith('gui:')) return false;
  const rest = from.slice(4);
  return rest === 'user' || SESSION_ID_SHAPE.test(rest);
}

// ── 字符集合 ─────────────────────────────────────────────────────────────────────
// CLI 2.1.296 / 2.1.273 闭合标签匹配里"字母之间允许夹的字符"(源码 D5e:不可见字符 + 组合记号 + C0/C1 控制字符 +
// 行/段分隔符),原样照抄;再并上全部格式字符(Cf)、组合记号(M)与空白,只会更宽(多插 `\`),不会漏。
const CLI_INVISIBLE = '\\u00ad\\u034f\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u115f\\u1160\\u17b4\\u17b5'
  + '\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb'
  + '\\u{110bd}\\u{110cd}\\u{13430}-\\u{1343f}\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{16fe4}\\u{e0000}-\\u{e0fff}'
  + '\\u0300-\\u0344\\u0346-\\u036f\\u0483-\\u0489\\u0591-\\u05bd\\u05bf\\u05c1\\u05c2\\u05c4\\u05c5\\u05c7\\u0610-\\u061a'
  + '\\u064b-\\u065f\\u0670\\u06d6-\\u06dc\\u06df-\\u06e4\\u06e7\\u06e8\\u06ea-\\u06ed\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff'
  + '\\u3099\\u309a\\ufe20-\\ufe2f\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f\\u2028\\u2029';
const FILL_CLASS = `[\\s${CLI_INVISIBLE}\\p{Cf}\\p{M}]`;
const FILL_ONE = new RegExp(`^${FILL_CLASS}$`, 'u');
// CLI 2.1.296 里标签名的 `-` / `_` 互通的连接符集合(源码 H),原样照抄(\p{Pd} 已含 `-`)。
const CONNECTOR_CLASS = '[_\\p{Pc}\\p{Pd}\\u2017\\u02cd\\u07fa\\u0640\\u2212\\u207b\\u208b\\u02d7\\u2796\\u2043\\u30fc\\uff70]';
// CLI 的类尖括号与类斜杠(源码 C 表:`<` `>` `/` 各自的相似字符)。
const LT_LIKE = new Set(['<', '＜', '﹤', '〈', '⟨', '〈', '‹', '˂', 'ᐸ', '❬', '❮', '❰', '⧼', '≮', '≺', '⋖']);
const GT_LIKE = new Set(['>', '＞', '﹥', '〉', '⟩', '〉', '›', '˃', 'ᐳ', '❭', '❯', '❱', '⧽', '≯', '≻', '⋗']);
const SLASH_LIKE = new Set(['/', '／', '∕', '⁄']);
// ASCII 词字符。带 `iu`:与 CLI 的 `[^A-Za-z0-9_\-]` 同口径(Unicode 大小写折叠下 `ſ` 算 s、开尔文符号算 k)。
const WORD_ONE = /^[A-Za-z0-9_-]$/iu;

const tagPattern = (tag) => [...tag].map((ch, i) => (i === 0 ? '' : `${FILL_CLASS}*`) + (ch === '-' ? CONNECTOR_CLASS : ch)).join('');
const TAG_NAME_RE = new RegExp(`(?:${XS_NEUTRALIZE_TAGS.map(tagPattern).join('|')})(?=[^A-Za-z0-9_\\-]|$)`, 'giu');

/** 位置 end 之前那个码点的起点(不拆代理对)。 */
function codePointStartBefore(s, end) {
  if (end >= 2) {
    const lo = s.charCodeAt(end - 1);
    const hi = s.charCodeAt(end - 2);
    if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) return end - 2;
  }
  return end - 1;
}
/** 从 end 往前跳过空白与不可见字符,返回停下的位置(它前面那个码点不是空白 / 不可见字符,或已到开头)。 */
function skipFillBackward(s, end) {
  let p = end;
  while (p > 0) {
    const start = codePointStartBefore(s, p);
    if (!FILL_ONE.test(s.slice(start, p))) break;
    p = start;
  }
  return p;
}

/** 正文中和(见文件头的规则)。非字符串按 String() 处理;null / undefined 当空串。 */
export function neutralizeXsBody(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const insertAfter = new Set();
  TAG_NAME_RE.lastIndex = 0;
  for (let m = TAG_NAME_RE.exec(s); m; m = TAG_NAME_RE.exec(s)) {
    const nameStart = m.index;
    // (a) 匹配可以带一个斜杠;取匹配前面(跳过空白与不可见字符)最近的字符
    let matchStart = nameStart;
    const beforeName = skipFillBackward(s, nameStart);
    if (beforeName > 0) {
      const slashStart = codePointStartBefore(s, beforeName);
      if (SLASH_LIKE.has(s.slice(slashStart, beforeName))) matchStart = slashStart;
    }
    const nearestEnd = skipFillBackward(s, matchStart);
    if (nearestEnd > 0) {
      const nearest = s.slice(codePointStartBefore(s, nearestEnd), nearestEnd);
      if (nearest !== '\\' && !WORD_ONE.test(nearest)) insertAfter.add(nearestEnd);
    }
    // (b) 跨过 CLI 允许夹在类小于号与标签名之间的字符,停在类小于号上且它后面不是 `\` → 在它后面插 `\`
    let p = nameStart;
    while (p > 0) {
      const start = codePointStartBefore(s, p);
      const ch = s.slice(start, p);
      if (LT_LIKE.has(ch)) { if (s[p] !== '\\') insertAfter.add(p); break; }
      if (GT_LIKE.has(ch) || WORD_ONE.test(ch)) break;
      p = start;
    }
  }
  if (insertAfter.size === 0) return s;
  const cuts = [...insertAfter].sort((x, y) => x - y);
  let out = '';
  let from = 0;
  for (const at of cuts) { out += s.slice(from, at) + '\\'; from = at; }
  return out + s.slice(from);
}

/**
 * 来源名(from-name)规则:删掉 `"` `<` `>`;控制字符(含回车换行)与行 / 段分隔符换成空格;格式字符(零宽字符、方向控制、
 * BOM 等)与孤立代理项删掉;去首尾空白;按 UTF-16 长度截到不超过 64(不切断代理对、不加省略号),截完再去一次尾部空白;
 * 结果为空时用"未命名会话"。产物是 CLI 名字清洗 Ny 的不动点(否则 origin 里 name 与 body 一起丢)。
 * 格式字符删除是 T-X0 加强的:方案原规则只替换控制字符,而 CLI 会删掉 Cf 类字符,标题里有零宽连接符(组合表情)时往返失败。
 */
export function normalizeXsSourceName(raw) {
  let s = String(raw ?? '')
    .replace(/["<>]/g, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[\p{Cf}\p{Cs}]/gu, '')
    .trim();
  if (s.length > XS_SOURCE_NAME_MAX_UTF16) {
    let cut = XS_SOURCE_NAME_MAX_UTF16;
    const lastKept = s.charCodeAt(cut - 1);
    if (lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1; // 截点落在代理对中间 → 整个丢掉这个字符
    s = s.slice(0, cut).trimEnd();
  }
  return s || XS_UNNAMED_SOURCE;
}

/**
 * 构造信封:整条就是这个字符串,前后不加任何东西(验证 E:多一个字符 CLI 就不认或丢 body)。
 * from 不合法属于调用方的编程错误,直接抛 TypeError(不静默改写成别的来源)。
 */
export function buildXsEnvelope({ from, name, body } = {}) {
  if (!isValidXsFrom(from)) throw new TypeError('xsession 信封:from 只能是 gui:user 或 gui:<会话id>');
  return `<${XS_ENVELOPE_TAG} from="${from}" from-name="${normalizeXsSourceName(name)}">\n${neutralizeXsBody(body)}\n</${XS_ENVELOPE_TAG}>`;
}
