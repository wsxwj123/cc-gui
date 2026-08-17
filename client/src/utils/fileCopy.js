// r11-⑦:文件浏览器预览「复制」的判定与图片位图复制。
// 文本复制复用既有消息气泡的 copyText(utils/clipboard.js,双上下文回退),不重造;
// 本模块只做:显隐判定(纯函数)、内容来源判定(截断态取全文)、位图复制(能力检测+
// 非 png 经 canvas 转 png —— ClipboardItem 普遍只认 image/png)。

// 与文本预览端点(server/routes/files.js MAX_PREVIEW_BYTES=256KB 截断)的约定对齐:
// 复制全文走 raw=1 全量流,客户端设 5MB 上限,超限拒绝并说明(不静默截断)。
export const COPY_TEXT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 复制按钮显隐判定(纯函数):
 *  - 文本型预览(含 markdown/html/代码,含截断态)→ 'text'(复制全文);
 *  - 图片预览(png/jpg/webp/gif 静帧/svg/bmp/ico)→ 'image'(复制位图);
 *  - 其余二进制(pdf / 音视频 / word / 压缩包等 binary)→ null(不显示);
 *  - 读取中 / 出错 / 编辑态 → null。
 */
export function copyButtonKind({ isImage, isVideo, isAudio, isPdf, binary, loading, error, editing } = {}) {
  if (loading || error || editing) return null;
  if (isImage) return 'image';
  if (isVideo || isAudio || isPdf) return null;
  if (binary) return null;
  return 'text';
}

/** 复制内容来源:截断预览(只载了前 256KB)必须回后端取完整文件;未截断用已加载内容。 */
export function pickCopySource({ truncated, content } = {}) {
  return truncated ? { from: 'backend' } : { from: 'preview', text: content || '' };
}

/** 图片位图复制能力检测(WKWebView/WebView2 支持度不齐,不支持要显式提示不静默)。 */
export function canCopyImageBitmap(env = globalThis) {
  return typeof env.ClipboardItem !== 'undefined' && typeof env.navigator?.clipboard?.write === 'function';
}

/**
 * 把图片复制进剪贴板(位图,不是路径)。png 直接写;jpeg/webp/gif(静帧)/svg/bmp/ico
 * 经 canvas 转 png 再写。返回 { ok } 或 { ok:false, reason }(reason='unsupported'=
 * 环境不支持,调用方给「当前环境不支持复制图片」提示)。
 */
export async function copyImageBitmap(url, extension) {
  if (!canCopyImageBitmap()) return { ok: false, reason: 'unsupported' };
  try {
    let blob;
    if (extension === 'png') {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      blob = await r.blob();
    } else {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      if (!canvas.width || !canvas.height) throw new Error('图片尺寸为 0');
      canvas.getContext('2d').drawImage(img, 0, 0);
      blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('位图转码失败'))), 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || '剪贴板写入失败' };
  }
}
