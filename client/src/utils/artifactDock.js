// #3 停靠面板 code 回写的纯判定(便于单测)。
// 仅当 id 匹配当前停靠的 artifact 且 code 真变化时,返回带新 code 的 dock 对象;
// 否则返回原对象(引用不变)——上层据此短路,避免流式每 token 空 setState 风暴。
export function nextDockCode(dock, id, code) {
  if (dock && dock.artifactId === id && dock.code !== code) return { ...dock, code };
  return dock;
}
