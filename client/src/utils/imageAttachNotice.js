// r193:发送应答里的 imageAttach → 页面提示句(或不提示)。纯函数,不碰页面。
// 应答形如 { inlined, skipped: [{ name, reason }] };reason 七种之一。
// 提示句模板(接口文件「错误契约」):有 N 张图没能带上:{原因}。消息已照常发出。
// - outside(路径不在上传目录内)不提示、不计入 N:正常界面产生不了这种路径。
// - 同一次发送有多种原因时,原因按首次出现的顺序用顿号连接,同一种原因只写一次。
// - 认不出的 reason 不提示、不计数(只按已知的七种取词)。
export const IMAGE_ATTACH_REASON_TEXT = {
  missing: '文件已不在(上传的图 7 天后会被清理),请重新添加',
  unreadable: '文件无法读取',
  'too-large': '太大(单张或一条消息合计超过 20MB)',
  'too-many': '一条消息最多带 20 张',
  unsupported: '格式不支持(可用 png、jpg、gif、webp)',
  damaged: '文件已损坏',
};

export function imageAttachNoticeText(imageAttach) {
  const skipped = imageAttach && Array.isArray(imageAttach.skipped) ? imageAttach.skipped : [];
  let count = 0;
  const reasons = [];
  for (const item of skipped) {
    const reason = item && typeof item.reason === 'string' ? item.reason : '';
    if (!Object.prototype.hasOwnProperty.call(IMAGE_ATTACH_REASON_TEXT, reason)) continue;
    count += 1;
    const text = IMAGE_ATTACH_REASON_TEXT[reason];
    if (!reasons.includes(text)) reasons.push(text);
  }
  if (count === 0) return null;
  return `有 ${count} 张图没能带上:${reasons.join('、')}。消息已照常发出。`;
}
