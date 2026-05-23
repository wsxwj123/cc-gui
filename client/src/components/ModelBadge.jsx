import React from 'react';

const MODEL_STYLES = {
  opus: { bg: '#EDE9FE', fg: '#6D28D9', border: '#DDD6FE', label: 'Opus' },
  sonnet: { bg: '#E0E7FF', fg: '#4338CA', border: '#C7D2FE', label: 'Sonnet' },
  haiku: { bg: '#D1FAE5', fg: '#047857', border: '#A7F3D0', label: 'Haiku' },
  deepseek: { bg: '#FEF3C7', fg: '#B45309', border: '#FDE68A', label: 'DeepSeek' },
  mimo: { bg: '#DBEAFE', fg: '#1D4ED8', border: '#BFDBFE', label: 'MiMo' },
  synthetic: { bg: '#F3F4F6', fg: '#6B7280', border: '#E5E7EB', label: 'System' },
};

function getModelStyle(model) {
  if (!model) return { bg: '#F3F4F6', fg: '#6B7280', border: '#E5E7EB', label: '?' };
  const lower = model.toLowerCase();
  for (const [key, style] of Object.entries(MODEL_STYLES)) {
    if (lower.includes(key)) return style;
  }
  // Clean up version suffixes for display
  const clean = model.replace(/\[.*\]/, '').replace(/-\d{8}$/, '');
  return {
    bg: '#F3F4F6', fg: '#6B7280', border: '#E5E7EB',
    label: clean.length > 15 ? clean.slice(0, 13) + '...' : clean
  };
}

export function ModelBadge({ model, compact = false }) {
  const style = getModelStyle(model);

  if (compact) {
    return (
      <span
        className="inline-flex items-center px-1.5 py-px text-[10px] font-medium rounded font-body"
        style={{ background: style.bg, color: style.fg, border: `1px solid ${style.border}` }}
      >
        {style.label}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md font-body"
      style={{ background: style.bg, color: style.fg, border: `1px solid ${style.border}` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: style.fg, opacity: 0.6 }} />
      {style.label}
    </span>
  );
}
