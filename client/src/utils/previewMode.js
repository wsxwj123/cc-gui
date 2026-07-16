// 问题1:artifact 预览的显示档('preview' | 'code')持久层。
// mode 本是 ArtifactPreview 的本地 useState,但流式中 react-markdown 会重挂本组件
// (见 ArtifactPreview 的 dockKey 注释:重挂使 useId 变、曾致 dock 断链)。重挂 = 本地 state
// 归零,mode 被打回初始 'preview' → 用户切到「代码」后,预览一重渲(常伴运行时报错重采集,即
// 用户看到的「报错出现就跳回预览」)就被弹回。用稳定 artifactId 把用户选的档记在模块级 Map,
// 重挂后 useState 惰性初始化从中恢复,除用户点按钮外谁也不改。
// 纯逻辑(不依赖 React),便于 node 单测。ponytail:条目=短字符串、上限=历史代码块数,可接受;
// 真爆再加 LRU。
export function makeModePersist(memory = new Map()) {
  return {
    get: (id) => memory.get(id) || 'preview',
    set: (id, m) => { memory.set(id, m); },
  };
}
