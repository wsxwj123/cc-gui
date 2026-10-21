// 粘贴乱码自动还原:终端/日志里复制来的文本常见「UTF-8 字节被当成 MacRoman/CP1252 解码」
// (例:✻→‚úª、"当前无可用凭证"→"ÂΩìÂâçÊó†ÂèØÁî®Âá≠ËØÅ")。GUI 的输入框是原生
// 粘贴,本身不做解码,只能拿到已经乱掉的字符串;这里在粘贴时做一次高置信度还原。
//
// 判定(整段粘贴只整体判一次,不分段;任何一条不满足就原样返回 —— 宁可不改,不能把正常文本改坏):
// 1. 原文不含中文,且 >0x7F 的高位字符至少 2 个;
// 2. 用 MacRoman / CP1252 把每个字符反推回一个字节,这串字节必须能严格解码成 UTF-8;
// 3. 解码结果至少含一个 ≥U+0800 的字符。依据:真乱码(中文、✻、“”、… 这类)反推出来都是
//    三字节/四字节 UTF-8,结果 ≥U+0800;Mac 用 Option 键打出的符号对(∆µ、≈∞、∆Ω…)和正常外文
//    最多只拼得出双字节 UTF-8,结果落在 U+0080–U+07FF(例:"∆µ = 5 kJ" 会被拼成 "Ƶ = 5 kJ"),不能动;
// 4. 结果不含私用区字符(三个字符也可能拼出私用区,例:Ôéé → U+F38E),
//    也不含制表符、换行、回车以外的控制字符;
// 5. 结果不比原文长。
//
// 能力边界(故意不修,别当 bug):
// - 只覆盖"UTF-8 字节被单字节解码"这一类;若文本已经含 U+FFFD(信息已丢)、被双重编码、
//   或原文不是 UTF-8 被单字节解码这类形态,都不会动。
// - 只有双字节字符的乱码(例如单独一个 "¬∑",原文是 "·")与正常符号对分不开,不还原;
//   它和 ✻ 这类三字节乱码出现在同一段里时,随整段一起还原。
// - 整段判定:同一段里混着正常外文与乱码时,外文那部分通常反推不出合法 UTF-8,整段原样不动。
//
// 只在浏览器/Node 都可用:TextDecoder 支持 'macintosh' 与 'windows-1252'。
const SINGLE_BYTE_LABELS = ['macintosh', 'windows-1252'];

let encoders = null; // label -> Map(charCode -> byte)
function buildEncoders() {
  if (encoders) return encoders;
  encoders = new Map();
  for (const label of SINGLE_BYTE_LABELS) {
    let dec;
    try { dec = new TextDecoder(label); } catch { continue; }
    const map = new Map();
    for (let b = 0; b < 256; b += 1) {
      const ch = dec.decode(Uint8Array.of(b));
      if (ch && !map.has(ch)) map.set(ch, b);
    }
    encoders.set(label, map);
  }
  return encoders;
}

function looksLikeMojibake(s) {
  if (typeof s !== 'string' || !s) return false;
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(s)) return false; // 已有中文:不是这种乱码
  let high = 0;
  for (const ch of s) if (ch.codePointAt(0) > 0x7f) high += 1;
  // 这里只是粗筛;真正防误改的是 tryRepair 里的严格 UTF-8 解码 + 结果检查(见文件开头)。
  return high >= 2;
}

function tryRepair(s, label) {
  const map = buildEncoders().get(label);
  if (!map) return null;
  const bytes = [];
  for (const ch of s) {
    const b = map.get(ch);
    if (b === undefined) return null; // 有字符不在该单字节表里,不是这种乱码
    bytes.push(b);
  }
  let out;
  try { out = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return null; }
  if (!out || out.includes('\ufffd')) return null;
  if (!isPlausibleRepair(out)) return null;
  if (out.length > s.length) return null;
  return out;
}

// 文件开头判定的第 3、4 条:至少一个 ≥U+0800 的字符;没有私用区字符;
// 没有制表符(0x09)、换行(0x0A)、回车(0x0D)以外的控制字符。
function isPlausibleRepair(out) {
  let hasWide = false;
  for (const ch of out) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xe000 && cp <= 0xf8ff) return false; // 私用区(例:Ôéé → U+F38E)
    if (cp >= 0xf0000) return false; // 补充私用区(平面 15、16),同理不可能是真实文本
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f)) return false; // C0/DEL/C1 控制字符
    if (cp >= 0x800) hasWide = true;
  }
  return hasWide;
}

/** 还原粘贴文本里的 MacRoman/CP1252 式乱码;不确定时原样返回。 */
export function repairMojibake(text) {
  if (typeof text !== 'string' || !looksLikeMojibake(text)) return text;
  for (const label of SINGLE_BYTE_LABELS) {
    const out = tryRepair(text, label);
    if (out && out !== text) return out;
  }
  return text;
}

/**
 * 在受控 textarea/input 的光标处插入文本(替换选区,光标落在插入内容之后,React onChange 照常收到)。
 * 优先用浏览器原生编辑 execCommand('insertText'):这一步进撤销栈(按一次 Cmd/Ctrl+Z 回到插入前),
 * 且浏览器自己派发 input 事件 —— 所以成功时不再手动补事件,否则 onChange 会多跑一次。
 * execCommand 不存在、返回 false 或抛错时,才回落到 setRangeText + 手动派发 input(这条路不进撤销栈)。
 */
export function insertTextAtCaret(el, text) {
  if (!el || typeof text !== 'string') return false;
  const doc = el.ownerDocument;
  if (doc && typeof doc.execCommand === 'function') {
    // execCommand 作用于当前焦点元素:焦点不在目标上就先聚焦,聚焦不了就不走这条路(免得插到别处)。
    if (doc.activeElement !== el && typeof el.focus === 'function') { try { el.focus(); } catch {} }
    if (doc.activeElement === el) {
      let ok = false;
      try { ok = doc.execCommand('insertText', false, text) === true; } catch { ok = false; }
      if (ok) return true;
    }
  }
  const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
  const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
  try { el.setRangeText(text, start, end, 'end'); } catch { el.value += text; }
  try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
  return true;
}
