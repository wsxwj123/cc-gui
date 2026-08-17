// r11-⑥:自动压缩动画态转移(纯函数)。
// 取证(2026-08-17,只读:装机 CLI 二进制 @anthropic-ai/claude-code-darwin-arm64 字符串层
// + 本机真实 jsonl):
//  · 压缩开始:CLI 发 {type:'system',subtype:'status',status:'compacting'} —— auto 与
//    manual 同一发射点(trigger:s?"auto":"manual" 同函数),长压缩期间每 30s 重发一次;
//  · 阶段结束:status 事件的 status 变 null/'requesting'(可带 compact_result/compact_error),
//    随后发 {type:'system',subtype:'compact_boundary'}(CLI 自己的渲染器也在 boundary 处
//    清内部压缩态:`if(subtype==="compact_boundary") Ke.current=!1`);
//  · status 联合类型:'compacting' | 'requesting' | null(与 App.jsx 既有 sdk.d.ts 实测注释一致);
//  · auto/manual 的区分不在 status 事件上 —— 只有落盘/流内 compact_boundary 的
//    compactMetadata.trigger('auto'|'manual')带;流内判别用「本回合是否用户 /compact」
//    (isCompact),与既有 4121 处同一判据。
// 返回:true=压缩进行中;false=压缩阶段结束;undefined=与压缩动画无关(调用方不改状态)。
// 动画起止全以这两类真实事件为准,不做定时假动画。
export function autoCompactTransition(event) {
  if (!event || event.type !== 'system') return undefined;
  if (event.subtype === 'compact_boundary') return false;
  if (event.subtype !== 'status') return undefined;
  return event.status === 'compacting';
}
