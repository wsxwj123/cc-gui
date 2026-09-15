// 窗内检索(ChatSearch)「把命中带进视野」的滚动决策 —— 纯函数,零 DOM,单测直跑
// (tests/unit/check-search-scroll.mjs)。
//
// 两种模式,由**调用点**区分(输入 vs 导航),别混用:
//   center=false —— 边打边定位(每敲一个字符、首次命中):命中只要与可视带相交就
//     **一个像素都不动**(哪怕只露出一角);完全在视野外才按"最小位移 + 40px 余量"滚。
//     把已经看得见的命中再居中一次,等于每敲一个字符就把视野顶跑一次(用户感受就是
//     "搜一下页面乱跳")。
//   center=true —— 用户主动导航(下一个/上一个按钮、Enter / Shift+Enter):恢复条带
//     折叠之前就有的居中行为 —— 命中不在"舒适带"(距上下边各 40px)里就挪到纵向 1/3
//     处;命中只露出一角时归位靠的就是这条。公式与旧实现逐字一致。
//
// 返回要叠加到 scrollTop 上的增量(**布局 px**);null = 一个像素都不动。
//
// 单位口径(2026-09-13 统一):`rect`/`cr` 来自 `getBoundingClientRect()`,整个 UI 被 <html> 的
// `zoom` 缩放(字号「大 / 超大」= 1.2 / 1.45),所以那套差值是**视觉 px**;而调用点写进去的是
// `scrollTop`,那是**布局 px**。zoom≠1 时两者差 zoom 倍(实测:zoom 1.4 时 `scrollTop += 100`
// 视觉上走了 140px —— 导航「下一个」直接冲过头)。因此在**出口**折算一次:视觉差值 ÷ zoom 才是
// 能加进 scrollTop 的量;调用点传它读到的 `--ui-zoom`(缺省 1 = 与旧行为逐字相同)。
// 与 App.jsx 挂载锚点补偿改用 `offsetTop` 是同一条判据:位移量必须与它要写进去的那个属性同单位。
// **比较**留在视觉空间不动:rect 与 cr 同源,不等式不受正比例缩放影响;40px 余量因此自然是
// "视觉 40px"(用户看得见的余量),不用另算。
// 注意:可折段 `hidden` 之后 `Range.getBoundingClientRect()` 恒为 0×0,调用方必须先用
// `[data-turn-uuid]` 行的矩形兜底,别把 0 尺寸矩形喂进来(否则居中公式会算出一个幻影偏移)。
export function searchScrollDelta(rect, cr, { center = false, zoom = 1 } = {}) {
  const z = zoom > 0 ? zoom : 1;   // 拿不到/拿歪 zoom 时按不缩放走,绝不除出 Infinity
  if (center) {
    if (rect.top < cr.top + 40 || rect.bottom > cr.bottom - 40) return (rect.top - cr.top - cr.height / 3) / z;
    return null;
  }
  if (rect.bottom > cr.top && rect.top < cr.bottom) return null;   // 已在视野里(边打边定位:不动)
  const margin = 40;
  if (rect.top < cr.top) return -(((cr.top - rect.top) + margin) / z);
  return ((rect.bottom - cr.bottom) + margin) / z;
}
