import React, { useState } from 'react';
import { Shield } from './Icon.jsx';
import { modelRefusalText } from '../utils/modelFallback.js';

// r200:主对话里「命令行中途换了模型」的说明行(原模型的回复被安全检查拦下,设置里允许不问直接换)。
// 直播与读历史同一形状(type 'model-fallback')。只是提示:不弹框、不打断这一轮、不动模型菜单的选择。
// r206:用户 2026-11-20 要求「居中，像后台任务提示一样」—— 呈现与 App.jsx 的 TaskNoticeRow 同构:
// 两侧分隔线 + 居中标题 + 一行说明;命令行原文(含帮助链接)默认收起,点横幅展开,一个字不删。
// 说明那句可以折行、不截断(原模型、新模型、类别都要看得见)。折叠态用本地 useState,
// 与 TaskNoticeRow 一样切走会话再回来回到收起。
export function ModelFallbackNotice({ notice }) {
  const [expanded, setExpanded] = useState(false);
  const raw = notice?.content || '';
  const banner = (
    <>
      <span className="flex-1 h-px bg-canvas-deep/70" />
      <span className="flex flex-col items-center min-w-0 max-w-[70%] px-1">
        <span className="text-[12px] font-semibold font-body leading-tight text-ink-muted flex items-center gap-1.5">
          <Shield size={11} className="shrink-0 text-ink-faint" />
          已换模型
        </span>
        <span className="text-[10.5px] text-ink-faint font-body mt-0.5 text-center break-words max-w-full">
          {modelRefusalText(notice)}
        </span>
      </span>
      <span className="flex-1 h-px bg-canvas-deep/70" />
    </>
  );
  return (
    <div data-cgui="model-fallback-notice" className="max-w-[var(--content-max)] mx-auto px-4 py-1.5">
      {raw ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded ? 'true' : 'false'}
          className="w-full flex items-center gap-3 py-1.5 text-left cursor-pointer"
          title={expanded ? '收起命令行原文' : '展开命令行原文'}
        >
          {banner}
        </button>
      ) : (
        <div className="w-full flex items-center gap-3 py-1.5">{banner}</div>
      )}
      {raw && expanded && (
        <div className="border border-canvas-deep rounded-lg overflow-hidden bg-canvas animate-fade-in">
          <pre className="px-3 py-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-ink-muted bg-canvas-warm/40">{raw}</pre>
        </div>
      )}
    </div>
  );
}
