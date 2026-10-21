// 粘贴乱码自动还原:终端/日志里复制来的文本常见「UTF-8 字节被当成 MacRoman/CP1252 解码」
// (例:✻→‚úª、"当前无可用凭证"→"ÂΩìÂâçÊó†ÂèØÁî®Âá≠ËØÅ")。GUI 的输入框是原生
// 粘贴,本身不做解码,只能拿到已经乱掉的字符串;这里在粘贴时做一次高置信度还原:
// 若这段文本用 MacRoman/CP1252 反推字节后能严格解出 UTF-8、且原串没有中文而结果有中文,
// 就返回还原后的文本;否则原样返回(宁可不改,不能把正常外文改坏)。
//
// 能力边界(故意不修,别当 bug):只覆盖"UTF-8 字节被单字节解码"这一类;若文本已经含
// U+FFFD(信息已丢)、被双重编码、或原文是日文假名/韩文/俄文等(还原后不含中文,无法
// 与正常外文区分),都不会动。
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
  // 只要求有高位字符;真正防误改的是"反推字节必须能严格解出 UTF-8 且结果含中文"
  // (正常外文反推出的字节几乎必然不是合法 UTF-8,或解出的不是中文)。
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
  if (!/[\u3400-\u9fff\uf900-\ufaff]/.test(out)) return null; // 还原后必须有中文才可信
  if (out.length > s.length) return null;
  return out;
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

/** 在受控 textarea/input 的光标处插入文本(触发 React onChange)。 */
export function insertTextAtCaret(el, text) {
  if (!el || typeof text !== 'string') return false;
  const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
  const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
  try { el.setRangeText(text, start, end, 'end'); } catch { el.value += text; }
  try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
  return true;
}
