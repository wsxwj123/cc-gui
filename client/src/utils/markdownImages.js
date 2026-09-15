// 聊天气泡/文件预览共用的图片正文预处理纯函数集。
// 修复背景:此前仅文件预览(basePath 模式)渲染图片,聊天气泡一律原文 —— 用户看到的是
// 路径甚至整坨 base64。四种形态全链路见 docs/stream-image.md:
//   ① markdown 路径含空格 ② data: URL ③ 裸路径独立行 ④ 裸 base64 独立行
// 全部为纯函数、O(n) 单趟、围栏感知 —— 流式期间每条 chunk 都会重跑,不能贵、不能有随机性。

// data URL / 裸 base64 大小上限:超过只给占位,防超长字符串进 DOM 拖垮渲染。
// 30 万字符 ≈ 225KB 二进制,覆盖绝大多数截图粘贴,又拦得住整文件 dump。
export const IMAGE_DATA_MAX_CHARS = 300_000;

// 判定 data:图片 src 是否超限。超限返回占位文案,否则 null(export 供单测)。
export function oversizedImageDataNote(src) {
  const s = String(src || '');
  if (!/^data:image\//i.test(s)) return null;
  if (s.length <= IMAGE_DATA_MAX_CHARS) return null;
  const kb = Math.round((s.length - 'data:image/png;base64,'.length) * 3 / 4 / 1024);
  return `图片数据过大(约 ${kb} KB),已折叠不渲染`;
}

// AI 生成的 ![alt](路径含空格) 不符合 CommonMark:URL 含空格必须用 <> 包裹或编码,
// 否则解析器在第一个空格处断开 → 整条不被识别为图片,渲染成纯文本。
// 给"含空格、未包裹、非外链、无标题"的图片 URL 套上 <>。URL 含 `(` 时不碰:
// `Screenshot (1).png` 这类会在捕获的第一个 `)` 截断,包了反而产出坏 markdown。
export function wrapSpacedImageUrls(md) {
  if (!md) return md;
  return md.replace(/(!\[[^\]]*\]\()([^)]+)(\))/g, (full, pre, url, post) => {
    const u = url.trim();
    if (u.startsWith('<') || u.includes('"') || u.includes('(') || /^(https?:|data:|blob:)/i.test(u) || !u.includes(' ')) return full;
    return `${pre}<${u}>${post}`;
  });
}

// 把 markdown 图片 src 解析成 webview 能加载的地址。http(s)/data/blob 原样保留;
// 相对文件系统路径相对 md 文件自身目录(basePath)解析;绝对路径直接改写。
// 聊天气泡没有 basePath:绝对路径仍要改写成 raw 端点(否则 <img src="/Users/...">
// 相对页面 origin 解析 → 404 死图),相对路径无法定位则保持原样。
export function resolveImageSrc(src, basePath) {
  if (!src) return src;
  const s = String(src).trim();
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  const baseDir = basePath ? String(basePath).replace(/\\/g, '/').replace(/\/[^/]*$/, '') : '';
  // 解码必须**先于**反斜杠归一:react-markdown 会把 URL 里的空格编码成 %20、反斜杠编码成
  // %5C(AI 也常直接给编码后的路径)。顺序反了的话,%5C 解出来的 `\` 绕过归一 → 整条 Windows
  // 路径带着反斜杠进查询串 → 服务端按字面拼目录 → 死图(R05 根因)。
  // 只解一次:文件名里真实的 `%`(markdown 写作 %25)解回 `%` 后,末尾 encodeURIComponent
  // 再编一次,不会反复解码变成别的路径;非法转义序列(裸 `%`)保持原文。
  let rel = s;
  try { rel = decodeURIComponent(rel); } catch {}
  rel = rel.replace(/\\/g, '/');
  if (!basePath && !rel.startsWith('/') && !/^[A-Za-z]:\//.test(rel)) return s;
  // AI 常把绝对路径误拼成 ./ ../ // 开头的畸形相对路径(如 `..//Users/...`)。
  // 剥掉开头的 ./ ../ / 后若紧跟一个绝对路径(/Users、/home 或盘符 C:/),按绝对处理。
  const embedded = rel.match(/^[./]*((?:\/(?:Users|home)\/|[A-Za-z]:\/).*)$/);
  if (embedded) rel = embedded[1];
  const isAbs = rel.startsWith('/') || /^[A-Za-z]:\//.test(rel);
  const joined = isAbs ? rel : `${baseDir}/${rel}`;
  // 折叠 ./ 与 ../,保留路径前缀(POSIX 的 `/` 或 Windows 的 `C:/`)
  const m = joined.match(/^([A-Za-z]:\/|\/)/);
  const prefix = m ? m[0] : '/';
  const out = [];
  for (const seg of joined.slice(prefix.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/api/files/read?path=${encodeURIComponent(prefix + out.join('/'))}&raw=1`;
}

// 裸 base64 行嗅探:只认常见图片格式 magic bytes,避免把随机长串误渲染成裂图。
export function sniffImageMime(b64) {
  let head = '';
  try { head = atob(b64.slice(0, 32)).slice(0, 16); } catch { return null; }
  if (head.startsWith('\x89PNG')) return 'image/png';
  if (head.startsWith('\xFF\xD8\xFF')) return 'image/jpeg';
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.startsWith('BM')) return 'image/bmp';
  if (head.length > 12 && head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// 围栏开启判定:开启行 ≤3 空格缩进、同类字符 ≥3 个;反引号围栏的 info string 里不能再有反引号。
function fenceOpen(line) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null;
  return { char: m[1][0], len: m[1].length };
}

// 围栏闭合判定:同类字符且**长度不短于开启行**、只剩空白。长度必须比 —— 四反引号包三反引号
// (写说明书/嵌套示例时很常见)如果只认首字符,内层 ``` 就会把外层围栏关掉,之后整段代码被当正文改写。
function fenceClose(line, fence) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return !!m && m[1][0] === fence.char && m[1].length >= fence.len;
}

// 逐行标记代码区(true = 该行是代码,内容一字不改)。围栏判定见上面两个函数,其余按 CommonMark:
//   · 围栏未闭合时其后整段都算围栏内(流式半截不误改代码);闭合行本身也在代码区内;
//   · 闭合围栏后行首就是新块起点(围栏块不留段落):紧跟的 4 空格行是**新的**缩进代码块,
//     不复位 prevBlank 就会把它当正文改写,代码块里凭空冒出 ![](…) 字面量;
//   · 缩进代码块:行首 ≥4 空格(或 tab)且上一行是空行/文首/围栏块结束才成立(缩进行不能打断段落)。
function codeLineFlags(lines) {
  const flags = [];
  let fence = null;      // 当前围栏 {char,len};null = 不在围栏内
  let indented = false;  // 当前在缩进代码块内
  let prevBlank = true;  // 上一行是空行或文首(缩进代码块只能从这里开始)
  for (const line of lines) {
    if (fence) {
      if (fenceClose(line, fence)) { fence = null; prevBlank = true; }
      flags.push(true);
      continue;
    }
    const open = fenceOpen(line);
    if (open) { fence = open; indented = false; flags.push(true); continue; }
    if (/^\s*$/.test(line)) { prevBlank = true; flags.push(false); continue; } // 空行不结束缩进代码块
    if (/^( {4,}|\t)/.test(line) && (indented || prevBlank)) { indented = true; flags.push(true); continue; }
    indented = false;
    prevBlank = false;
    flags.push(false);
  }
  return flags;
}

// 围栏/缩进代码感知行扫描:对非代码行调用 fn。
// 流式安全三点:fn 纯函数、O(n) 单趟、围栏未闭合时后半按围栏内处理(不误改半截代码)。
export function mapLinesOutsideFences(md, fn) {
  const lines = String(md).split('\n');
  const code = codeLineFlags(lines);
  return lines.map((line, i) => (code[i] || /^\s*$/.test(line) ? line : fn(line, i))).join('\n');
}

// 裸路径独立行(如 AI 直接输出 /Users/x/screenshot.png)→ 图片 markdown。
// 只认整行恰为无空格图片路径(带空格的裸路径与普通句子无法区分,不碰 —— 那种形态
// 走 markdown 的 wrapSpacedImageUrls);已是 markdown/标题/引用的行不碰;围栏内不碰。
export function embedBareImagePaths(md) {
  // Windows 盘符路径只有反斜杠,`/` 与 `\` 任一出现才可能命中
  if (!md || (!md.includes('/') && !md.includes('\\'))) return md;
  return mapLinesOutsideFences(md, (line) => {
    const t = line.trim();
    if (!t || t.length > 512 || /[<>"')\]]/.test(t)) return line; // 引号/括号收尾=多半是正文
    if (/^(!\[|\[|#{1,6}\s|>)/.test(t)) return line;              // 已是图片/链接/标题/引用
    if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(t)
      && (t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t))) {
      return `${line.slice(0, line.indexOf(t))}![](${t})`;
    }
    return line;
  });
}

// 裸 base64 独立行 → data URL 图片(需 magic bytes 嗅探通过);超上限给占位文案。
export function embedBareBase64Images(md) {
  if (!md) return md;
  return mapLinesOutsideFences(md, (line) => {
    const t = line.trim();
    // 无上界:超限内容在下面分支被替换成短占位(只收缩不膨胀);上界反而会让
    // 超长整文件 dump 原样漏进 DOM,与防爆炸目标相反。
    if (t.length < 512) return line;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return line;
    const mime = sniffImageMime(t);
    if (!mime) return line;
    if (t.length > IMAGE_DATA_MAX_CHARS) {
      const kb = Math.round(t.length * 3 / 4 / 1024);
      return `${line.slice(0, line.indexOf(t))}*图片数据过大(约 ${kb} KB),已折叠不渲染*`;
    }
    return `${line.slice(0, line.indexOf(t))}![](data:${mime};base64,${t})`;
  });
}

// 行内代码 span(`...`)与代码区(围栏/缩进块)都不参与空格路径改写 —— 用户可复制的示例代码
// 不能被污染(围栏有 mapLinesOutsideFences 保护,行内代码原来没有)。
// 代码区先按行切出来整段原样输出:反引号串不跨块配对(CommonMark 先分块再找行内结构)。不切的话,
// 围栏正文里出现与围栏等长的反引号串(```` ```md / Use ``` for fences ````)时,最外层会拿它当
// 行内代码的闭合,围栏剩余部分被当正文塞进 <> —— 用户复制到的是被改写的字面量(R06)。
function wrapOutsideInlineCode(md) {
  const lines = String(md ?? '').split('\n');
  const code = codeLineFlags(lines);
  const out = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && code[j] === code[i]) j++;
    const block = lines.slice(i, j).join('\n');
    out.push(code[i] ? block : wrapOutsideCodeSpans(block));
    i = j;
  }
  return out.join('\n');
}

// 代码区之外的块(行内代码 span 可以跨行,所以按块而不是按行切)。按 CommonMark 的反引号串规则:
// 开启的反引号串必须由**等长**串闭合,串内可以含其它长度的反引号(` `` a ` b `` `)。原来用
// /(`+[^`]*`+)/ 切是错的 —— 它会把 ```` ``` ```` 这类相邻围栏行连同中间换行吃成一段"代码",
// 奇偶段错位,后面的正文/围栏内容被当非代码改写(R06)。
function wrapOutsideCodeSpans(text) {
  let out = '';
  let i = 0;
  let plainStart = 0;
  while (i < text.length) {
    if (text[i] !== '`') { i++; continue; }
    let run = 0;
    while (i + run < text.length && text[i + run] === '`') run++;
    let j = i + run;
    let close = -1;
    while (j < text.length) {
      if (text[j] !== '`') { j++; continue; }
      let r2 = 0;
      while (j + r2 < text.length && text[j + r2] === '`') r2++;
      if (r2 === run) { close = j; break; }
      j += r2;
    }
    // 未闭合的反引号串在 markdown 里就是普通字符(渲染器按字面文本处理),余下按正文改写,
    // 与渲染结果保持一致;流式半截场景另有 preprocessImages 的末行保护兜底。
    if (close < 0) break;
    out += wrapSpacedImageUrls(text.slice(plainStart, i));
    out += text.slice(i, close + run);
    i = close + run;
    plainStart = i;
  }
  out += wrapSpacedImageUrls(text.slice(plainStart));
  return out;
}

// 正文统一预处理(顺序敏感:先补 <>,再认裸路径,最后认裸 base64)。
// isStreaming=true 时**最后一行不参与转换**:流式中末行必然不完整,半截裸
// base64 会被逐 chunk 转成越来越长的 img src → 浏览器每个 chunk 重新解码一次
// (O(n²) 解码成本 + 裂图闪烁)。留给下一个 chunk 转完再转,只晚一拍。
export function preprocessImages(md, isStreaming = false) {
  const text = String(md ?? '');
  const lastNl = text.lastIndexOf('\n');
  const split = isStreaming && lastNl >= 0;
  const head = split ? text.slice(0, lastNl) : text;
  const tail = split ? text.slice(lastNl) : '';
  const processed = embedBareBase64Images(embedBareImagePaths(wrapOutsideInlineCode(head)));
  return processed + tail;
}
