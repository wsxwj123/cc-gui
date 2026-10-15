// r151b T-X0:CLI 2.1.296 处理宿主推入的跨会话信封时用到的几个函数的复刻,作为 check-r151b-envelope.mjs 的判据。
// 常量与构造逻辑从 CLI 源码逐字照抄(claude.exe 2.1.296,`var RAr=` 起到 `function L5e` 一段,以及 `Ny` / `B` / `V` / `ldt` / `_` / `D$e`),
// 只改了变量名与排版;不依赖本机装没装 CLI。T-X0 已用 CLI 二进制里 eval 出来的原函数在 30 万个变体上核对过复刻输出一致。
// SDK 自带的 2.1.273 同构,唯一差别是标签名里的 `-` 只认 ASCII `-`(不与 `_` 等连接符互通),认得的写法是 2.1.296 的子集。
//   · cliL5e(tag, s):CLI 重建信封时对正文做的改写 —— 把 tag 闭合写法开头的类小于号换成 `<\`。
//   · cliTagHits(tag, s):CLI 认得的 tag 写法(开、闭两种都认,即源码 w(tag, false))在 s 里出现的次数 = "未转义的标签"。
//   · cliNy(name):CLI 的名字清洗。
//   · cliStrictParse(envelope):严格解析 + 按解析结果重建并逐字比较;通过时返回 origin 会带的 { name?, body },否则 undefined。

const RAr = '\\u00ad\\u034f\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u{110bd}\\u{110cd}\\u{13430}-\\u{1343f}\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{16fe4}\\u{e0000}-\\u{e0fff}';
const C = { '＜': '<', '＞': '>', '﹤': '<', '﹥': '>', '〈': '<', '〉': '>', '⟨': '<', '⟩': '>', '〈': '<', '〉': '>', '‹': '<', '›': '>', '˂': '<', '˃': '>', 'ᐸ': '<', 'ᐳ': '>', '❬': '<', '❭': '>', '❮': '<', '❯': '>', '❰': '<', '❱': '>', '⧼': '<', '⧽': '>', '≮': '<', '≯': '>', '≺': '<', '≻': '>', '⋖': '<', '⋗': '>', '／': '/', '∕': '/', '⁄': '/' };
const uu = '\\u0300-\\u0344\\u0346-\\u036f\\u0483-\\u0489\\u0591-\\u05bd\\u05bf\\u05c1\\u05c2\\u05c4\\u05c5\\u05c7\\u0610-\\u061a\\u064b-\\u065f\\u0670\\u06d6-\\u06dc\\u06df-\\u06e4\\u06e7\\u06e8\\u06ea-\\u06ed\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\u3099\\u309a\\ufe20-\\ufe2f';
const D5e = `${RAr}${uu}\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f\\u2028\\u2029`;
const N0t = 'A-Za-z0-9_\\-';
const U = `(?:[^${N0t}]|$)`;
const F0t = '\\p{Pd}\\u2212\\u207b\\u208b\\u02d7\\u2796\\u2043\\u30fc\\uff70';
const xAr = `_\\p{Pc}\\u2017\\u02cd\\u07fa\\u0640${F0t}`;
const H = `[${xAr}]`;
const b = (() => {
  const u = { '<': '<', '>': '>', '/': '/' };
  for (const [e, d] of Object.entries(C)) u[d] += e;
  return { open: u['<'], close: u['>'], slash: u['/'], filler: `^${N0t}${u['<']}${u['>']}` };
})();
const atomic = (cls, n) => `(?=([${cls}]*))(?:\\${n})`; // 源码 J$e:前瞻捕获 + 反向引用 = 原子组
function buildTagRe(tag, closeOnly) { // 源码 K({ tags:[tag], closeOnly, fillerClass: b.filler, spell, tail: undefined })
  let t = 0;
  const spell = (c) => (c === '-' || c === '_' ? H : c);
  const o = closeOnly ? `${atomic(`${b.filler}${b.slash}`, ++t)}[${b.slash}]${atomic(b.filler, ++t)}` : atomic(b.filler, ++t);
  const r = [...tag].map((p, i) => (i === 0 ? '' : atomic(D5e, ++t)) + spell(p)).join('');
  return new RegExp(`[${b.open}](?!\\\\)(?=${o}(?:${r})${U})`, 'giu');
}
const reCache = new Map();
const tagRe = (tag, closeOnly) => {
  const k = `${closeOnly ? '/' : ''}${tag}`;
  if (!reCache.has(k)) reCache.set(k, buildTagRe(tag, closeOnly));
  return reCache.get(k);
};

export const CLI_LT_LIKE = b.open;
export const CLI_GT_LIKE = b.close;
export const CLI_SLASH_LIKE = b.slash;
export const cliL5e = (tag, s) => s.replace(tagRe(tag, true), '<\\');
export const cliTagHits = (tag, s) => [...s.matchAll(tagRe(tag, false))].length;
const cliB = (e) => e.replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, '');
export const cliNy = (e) => { const n = cliB(e).trim(); const r = [...n]; return r.length > 64 ? `${r.slice(0, 64).join('')}…` : n; };

const HV = 'cross-session-message';
const FROM_CHARS = 'A-Za-z0-9%:_/.\\\\-';
const STRICT = new RegExp(`^<${HV}(?: from="([${FROM_CHARS}]+)")?(?: from-session="([A-Za-z0-9_-]{1,80})")?(?: hop-chain="([0-9a-f]{24}(?:,[0-9a-f]{24}){0,31})")?(?: from-name="([^"<>\\n\\r]+)")?(?: from-mode="(bypass|prompting)")?(?: from-plugin="([^"<>\\n\\r]+)")?>\\n([\\s\\S]*)\\n</${HV}>$`);
export function cliStrictParse(s) {
  const t = s.match(STRICT);
  if (!t) return undefined;
  const o = [];
  if (t[1]) o.push(`from="${t[1]}"`);
  if (t[2]) o.push(`from-session="${t[2]}"`);
  if (t[3]) o.push(`hop-chain="${t[3]}"`);
  const d = t[4] === undefined ? undefined : cliNy(t[4].replace(/["<>]/g, ''));
  if (d) o.push(`from-name="${d}"`);
  if (t[5]) o.push(`from-mode="${t[5]}"`);
  const c = t[6] === undefined ? undefined : cliNy(t[6].replace(/["<>]/g, ''));
  if (c) o.push(`from-plugin="${c}"`);
  if (`<${HV}${o.length ? ` ${o.join(' ')}` : ''}>\n${cliL5e(HV, t[7] ?? '')}\n</${HV}>` !== s) return undefined;
  const name = t[4] ? cliNy(t[4]) : '';
  return { ...(name ? { name } : {}), body: t[7] ?? '' };
}
