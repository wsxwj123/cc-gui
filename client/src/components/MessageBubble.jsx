import React, { useState } from 'react';
import { User, Brain, Copy, Check, Sparkles } from 'lucide-react';
import { ModelBadge } from './ModelBadge.jsx';
import { ToolCallCard } from './ToolCallCard.jsx';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-canvas-deep rounded"
      title="复制"
    >
      {copied ? (
        <Check size={12} className="text-success" />
      ) : (
        <Copy size={12} className="text-ink-faint" />
      )}
    </button>
  );
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function UsageDisplay({ usage }) {
  if (!usage) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  return (
    <div className="flex gap-3 text-[10px] text-ink-faint mt-2 pt-2 border-t border-canvas-deep/50">
      <span>输入 {input.toLocaleString()}</span>
      <span>输出 {output.toLocaleString()}</span>
      {cacheRead > 0 && <span>缓存 {cacheRead.toLocaleString()}</span>}
    </div>
  );
}

export function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  const [showThinking, setShowThinking] = useState(false);

  if (isUser) {
    return (
      <div className="group px-6 py-4 animate-fade-up" style={{ animationDuration: '0.25s' }}>
        <div className="max-w-3xl mx-auto flex flex-row-reverse gap-3">
          <div className="shrink-0 mt-0.5">
            <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center">
              <User size={14} className="text-white" />
            </div>
          </div>
          <div className="flex-1 min-w-0 flex flex-col items-end">
            <div className="flex items-center gap-2 mb-1.5">
              <CopyButton text={message.text} />
              <span className="text-[11px] text-ink-faint font-mono">{formatTime(message.timestamp)}</span>
              <span className="text-[13px] font-medium text-ink font-body">你</span>
            </div>
            <div className="user-bubble rounded-2xl rounded-tr-md px-4 py-2.5 max-w-[85%]">
              <div className="text-[14px] font-body leading-relaxed whitespace-pre-wrap">{message.text}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group px-6 py-4 animate-fade-up" style={{ animationDuration: '0.25s' }}>
      <div className="max-w-3xl mx-auto flex gap-3">
        <div className="shrink-0 mt-0.5">
          <div className="w-7 h-7 rounded-full bg-accent-subtle flex items-center justify-center">
            <Sparkles size={14} className="text-accent" />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[13px] font-medium text-ink font-body">Claude</span>
            {message.model && <ModelBadge model={message.model} compact />}
            <span className="text-[11px] text-ink-faint font-mono">{formatTime(message.timestamp)}</span>
            <div className="flex-1" />
            <CopyButton text={message.text} />
          </div>

          {message.thinking && (
            <div className="mb-3">
              <button
                onClick={() => setShowThinking(!showThinking)}
                className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink-muted transition-colors font-body"
              >
                <Brain size={12} />
                <span>思考过程</span>
                <span className="text-[10px]">{showThinking ? '▾' : '▸'}</span>
              </button>
              {showThinking && (
                <div className="thinking-block mt-2 p-4 rounded-lg text-xs text-ink-muted whitespace-pre-wrap max-h-64 overflow-y-auto font-body leading-relaxed">
                  {message.thinking}
                </div>
              )}
            </div>
          )}

          {message.text && <MarkdownRenderer content={message.text} />}

          {message.toolCalls?.length > 0 && (
            <div className="mt-2">
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={tc.id || i} toolCall={tc} result={tc.result} />
              ))}
            </div>
          )}

          <UsageDisplay usage={message.usage} />
        </div>
      </div>
    </div>
  );
}
