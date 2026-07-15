// #3 停靠面板 code 回写的纯判定(便于单测)。
// 仅当 id 匹配当前停靠的 artifact 且 code 真变化时,返回带新 code 的 dock 对象;
// 否则返回原对象(引用不变)——上层据此短路,避免流式每 token 空 setState 风暴。
export function nextDockCode(dock, id, code) {
  if (dock && dock.artifactId === id && dock.code !== code) return { ...dock, code };
  return dock;
}

// #3 稳定停靠身份:由"消息/turn 稳定前缀 + 该代码块在源文本中的起始偏移"拼成。
// 为什么流式期间不变:前缀取 turn.uuid(流式全程恒为 'streaming' 哨兵,持久化后恒为真 uuid,
// 各自阶段内不变),offset 是该围栏块在其所属文本块源码中的起始字符位置——流式是往末尾追加,
// 已出现的代码块之前的内容不再变动,故其 start.offset 恒定;组件重挂载也只重算同一值。
// 同一文本里多个可预览块靠不同 offset 区分。前缀缺失(coexist/文件预览等非流式路径)或
// 无位置信息时返回 undefined,调用方回退到 useId(那些路径不流式,不受重挂断链影响)。
export function dockKeyFor(prefix, offset) {
  if (!prefix || typeof offset !== 'number') return undefined;
  return `${prefix}:${offset}`;
}
