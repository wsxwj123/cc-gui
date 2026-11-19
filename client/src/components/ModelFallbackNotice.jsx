import React from 'react';
import { modelRefusalText } from '../utils/modelFallback.js';

// r200:主对话里「命令行中途换了模型」的说明行(原模型的回复被安全检查拦下,设置里允许不问直接换)。
// 直播与读历史同一形状(type 'model-fallback');命令行原文(含帮助链接)收在可折叠的「命令行原文」里。
// 只是提示:不弹框、不打断这一轮、不动模型菜单的选择。
export function ModelFallbackNotice({ notice }) {
  return (
    <div data-cgui="model-fallback-notice" className="px-4 py-1 text-[11px] text-ink-muted font-body">
      <div>{modelRefusalText(notice)}</div>
      {notice?.content ? (
        <details className="mt-0.5">
          <summary className="cursor-pointer select-none text-ink-faint">命令行原文</summary>
          <div className="mt-1 whitespace-pre-wrap break-words text-ink-faint">{notice.content}</div>
        </details>
      ) : null}
    </div>
  );
}
