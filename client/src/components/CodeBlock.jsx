import React from 'react';
import { CollapsibleCode, CopyButton } from './ArtifactPreview.jsx';

// 带语言条 + 复制 + 长代码折叠的围栏代码块。原来长在 MarkdownRenderer.jsx 里,
// r64 抽成独立文件,**唯一目的是断循环依赖**(PLAN r64 §1.7 / §2.0.1-2):
// genui 围栏解析失败要降级回这个代码块,而 MarkdownRenderer 又要 import genui 的围栏
// 组件 —— 留在原地就闭环成
//   MarkdownRenderer → GenuiFence → fence-render.tsx → host/primitives.jsx → MarkdownRenderer
// ESM 循环在 Vite/Rollup 下时灵时不灵,dev 不复现、压缩后才炸。抽出后环消失。
// 行为与抽出前一字不变;折叠与复制按钮都复用 ArtifactPreview 的共用件
// (artifact 代码视图同款,防两处漂移)。
export function CodeBlock({ lang, code }) {
  return (
    <div className="relative group my-3">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#2b2722] rounded-t-lg border border-[#3a342b] border-b-0">
        <span className="text-[11px] font-mono text-[#9a8e78]">{lang || 'code'}</span>
        <CopyButton text={code} />
      </div>
      <CollapsibleCode
        code={code}
        className="bg-[#211e19] border border-[#3a342b] border-t-0 p-4 overflow-x-auto text-[13px] leading-relaxed font-mono text-[#e8e2d6]"
      />
    </div>
  );
}
