import React from 'react';
import { Play } from './Icon';
import { CollapsibleCode, CopyButton } from './ArtifactPreview.jsx';
import { isRunnableLang, requestTerminalRun } from '../utils/terminalBus.js';

// 带语言条 + 复制 + 长代码折叠的围栏代码块。原来长在 MarkdownRenderer.jsx 里,
// r64 抽成独立文件,**唯一目的是断循环依赖**(PLAN r64 §1.7 / §2.0.1-2):
// genui 围栏解析失败要降级回这个代码块,而 MarkdownRenderer 又要 import genui 的围栏
// 组件 —— 留在原地就闭环成
//   MarkdownRenderer → GenuiFence → fence-render.tsx → host/primitives.jsx → MarkdownRenderer
// ESM 循环在 Vite/Rollup 下时灵时不灵,dev 不复现、压缩后才炸。抽出后环消失。
// 行为与抽出前一字不变;折叠与复制按钮都复用 ArtifactPreview 的共用件
// (artifact 代码视图同款,防两处漂移)。

// ▶ 运行:把命令送进内置终端执行(bash/shell 类语言才显示)。首次使用必过确认门,
// 可"本次会话记住";门与请求总线都在 utils/terminalBus.js(防其它入口绕过确认)。
function RunButton({ code }) {
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try { await requestTerminalRun(code); } finally { setBusy(false); }
  };
  return (
    <button
      onClick={run}
      title="在内置终端中执行(真实执行,首次会先确认)"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-[#9a8e78] hover:text-[#e8e2d6] hover:bg-white/5 transition-colors"
    >
      <Play size={11} /> 运行
    </button>
  );
}

export function CodeBlock({ lang, code }) {
  // 工具条作为 header 传进 CollapsibleCode,落在同一个 <pre> 里(见该组件注释:黑盒契约的
  // 「代码块」就是 pre 元素,运行/复制都在它的子树内)。内边距随之落到代码层,工具条全宽贴顶。
  const header = (
    <span className="flex items-center justify-between gap-2 shrink-0 px-3.5 py-1.5 bg-[#2b2722] border-b border-[#3a342b] whitespace-normal">
      <span className="text-[11px] font-mono text-[#9a8e78]">{lang || 'code'}</span>
      <span className="flex items-center gap-1.5">
        {isRunnableLang(lang) && <RunButton code={code} />}
        <CopyButton text={code} />
      </span>
    </span>
  );
  return (
    <div className="relative group my-3">
      <CollapsibleCode
        code={code}
        header={header}
        className="bg-[#211e19] border border-[#3a342b] text-[13px] leading-relaxed font-mono text-[#e8e2d6]"
      />
    </div>
  );
}
