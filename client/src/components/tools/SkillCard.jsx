import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { MarkdownRenderer } from '../MarkdownRenderer.jsx';

// Skill 调用横幅 — 参考 opencode 的章节分隔样式:skill 名单独一行居中大字,
// 运行期间带流光动画(.skill-banner-name,见 index.css),下方一行小字给
// 调用状态与参数摘要。点击横幅展开输入参数/结果详情(信息不丢)。
// input 形态通常为 { skill, args },不同 skill 可能有额外字段,摘要按通用键值拼。
// nameOverride/subLabel:供"读取类工具直读 SKILL.md"复用(TurnBubble 分流),
// 横幅名取路径解析出的 skill 名,小字注明"读取技能文档"。
export function SkillCard({ toolCall, nameOverride, subLabel }) {
  const [expanded, setExpanded] = useState(false);
  const skillName = nameOverride || toolCall.input?.skill || toolCall.input?.name || toolCall.name;
  const result = toolCall.result;
  const isError = result?.isError;
  const running = !result;
  const content = typeof result?.content === 'string' ? result.content : '';

  // 参数摘要:除 skill/name 外的入参拼成一行(横幅下的小字),超长截断。
  const inputEntries = Object.entries(toolCall.input || {}).filter(([k]) => k !== 'skill' && k !== 'name');
  const inputPreview = inputEntries.length > 0
    ? inputEntries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ').slice(0, 120)
    : '';
  const statusLabel = running ? '调用中' : (isError ? '调用失败' : '调用完成');
  // 状态小字:硬编码英文 "Skill " 前缀已去掉(用户实报:名字后多出杂乱的"S"字样)。
  // 运行中只显状态不拼参数摘要;摘要在完成/失败态给,原始入参展开详情里始终有。
  const statusText = [subLabel, statusLabel].filter(Boolean).join(' · ')
    + (!running && !subLabel && inputPreview ? ` · ${inputPreview}` : '');

  return (
    <div className="my-2">
      {/* 居中横幅:两侧分隔线 + skill 名 + 状态小字。点击切换详情展开 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 py-1.5 text-left cursor-pointer"
        title={expanded ? '收起 Skill 调用详情' : '展开 Skill 调用详情'}
      >
        <span className="flex-1 h-px bg-canvas-deep/70" />
        <span className="flex flex-col items-center min-w-0 max-w-[70%] px-1">
          <span
            className={`skill-banner-name text-[17px] font-semibold font-body leading-tight truncate max-w-full ${
              running ? '' : (isError ? 'skill-banner-name-error' : 'skill-banner-name-done')
            }`}
          >
            {skillName}
          </span>
          <span className="text-[10.5px] text-ink-faint font-body mt-0.5 flex items-center gap-1.5 min-w-0 max-w-full">
            {running && <Loader2 size={10} className="animate-spin shrink-0" />}
            <span className="truncate">{statusText}</span>
          </span>
        </span>
        <span className="flex-1 h-px bg-canvas-deep/70" />
      </button>

      {/* 展开详情:输入参数 + 结果(与其他工具卡片同风格) */}
      {expanded && (
        <div className="border border-canvas-deep rounded-lg overflow-hidden bg-canvas animate-fade-in">
          <details className="px-3 py-2 border-b border-canvas-deep" open>
            <summary className="cursor-pointer text-[10px] text-ink-faint uppercase tracking-wider font-body">
              输入参数
            </summary>
            <pre className="text-[11px] bg-canvas-warm rounded p-2 mt-1 overflow-x-auto max-h-32 font-mono text-ink-muted">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </details>

          {result && (
            <div className={`px-3 py-2 text-[11px] max-h-[600px] overflow-y-auto ${
              isError ? 'bg-red-50 text-red-700' : 'bg-canvas-warm/40 text-ink-muted'
            }`}>
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body mb-1">结果</div>
              {isError
                ? <pre className="font-mono whitespace-pre-wrap">{content}</pre>
                : <MarkdownRenderer content={content} />
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
}
