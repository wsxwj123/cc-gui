import { useEffect, useState } from 'react';
import { loadAttachmentImageBytes } from '../utils/attachments.js';

// R08:raw 原图入口的并发是进程级全局配额(4 个,超出 429 FILE_READ_BUSY),与文件树预览/
// 正文 markdown 图共用;而图片失败是一次性闩死、不自动重试 → 一条消息里第 5 张及以后的图
// 永久"图片不可用"(文件其实在)。只有经 fetch 拿字节才看得见 429,所以 raw 来源统一走
// loadAttachmentImageBytes(有界退避重试,见 utils/attachments.js),preview(data URL)直接用。
// 同一份 blob URL 交给灯箱复用 —— 点开不再重打一次原图请求(既省配额也避免灯箱里 429)。
// r192:从 MessageBubble 挪出来,消息气泡与输入框上方的附件卡片(PendingAttachmentList)共用。
export function useAttachmentImageSrc(src) {
  const remote = typeof src === 'string' && src.startsWith('/api/files/read');
  const [state, setState] = useState(() => ({ src: remote ? null : src || null, failed: false }));
  useEffect(() => {
    if (!remote) { setState({ src: src || null, failed: false }); return undefined; }
    let cancelled = false;
    let objectUrl = null;
    setState({ src: null, failed: false });
    loadAttachmentImageBytes(src).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setState({ src: objectUrl, failed: false });
    }).catch(() => { if (!cancelled) setState({ src: null, failed: true }); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, remote]);
  return state;
}
