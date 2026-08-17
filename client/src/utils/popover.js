// r11-p5-2:AnchoredPopover 的水平夹紧纯函数层(node 可测)。
// 语义:视口夹紧为基线;传入容器 rect 时叠加【容器边界夹紧】——弹层右缘 ≤ 容器
// 右缘-8、左缘 ≥ 容器左缘+8(会话行 ⋯ 菜单不许溢出侧栏右缘);容器缺失回落视口。
// 单位:全部视觉像素(与 getBoundingClientRect 同坐标系,调用方最后统一 /zoom)。

/** 水平位置夹紧:container = {left,right} | null。 */
export function clampPopoverX({ left, width, pad, vw, container }) {
  let l = left;
  if (container && Number.isFinite(container.right)) {
    l = Math.min(l, container.right - 8 - width);
    if (Number.isFinite(container.left)) l = Math.max(l, container.left + 8);
  }
  // 视口夹紧兜底(容器夹紧后仍不许出视口)
  return Math.min(Math.max(l, pad), Math.max(pad, vw - pad - width));
}

/** 窄容器下的弹层宽度上限:min(内容自然宽, 容器宽-16),floor 120 防不可用。 */
export function popoverMaxWidth(containerWidth) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return null;
  return Math.max(120, containerWidth - 16);
}
