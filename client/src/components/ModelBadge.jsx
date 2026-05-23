import React from 'react';

const MODEL_STYLES = {
  opus:     { bg: '#EDE9FE', fg: '#6D28D9', border: '#DDD6FE', label: 'Opus',     provider: 'anthropic' },
  sonnet:   { bg: '#E0E7FF', fg: '#4338CA', border: '#C7D2FE', label: 'Sonnet',   provider: 'anthropic' },
  haiku:    { bg: '#D1FAE5', fg: '#047857', border: '#A7F3D0', label: 'Haiku',    provider: 'anthropic' },
  claude:   { bg: '#FFEDD5', fg: '#C2410C', border: '#FED7AA', label: 'Claude',   provider: 'anthropic' },
  deepseek: { bg: '#FEF3C7', fg: '#B45309', border: '#FDE68A', label: 'DeepSeek', provider: 'deepseek' },
  mimo:     { bg: '#DBEAFE', fg: '#1D4ED8', border: '#BFDBFE', label: 'MiMo',     provider: 'mimo' },
  gemini:   { bg: '#DBEAFE', fg: '#1E40AF', border: '#BFDBFE', label: 'Gemini',   provider: 'gemini' },
  gpt:      { bg: '#D1FAE5', fg: '#047857', border: '#A7F3D0', label: 'GPT',      provider: 'openai' },
  qwen:     { bg: '#F3E8FF', fg: '#7E22CE', border: '#E9D5FF', label: 'Qwen',     provider: 'qwen' },
  glm:      { bg: '#FEF3C7', fg: '#A16207', border: '#FDE68A', label: 'GLM',      provider: 'zhipu' },
  kimi:     { bg: '#E0E7FF', fg: '#4338CA', border: '#C7D2FE', label: 'Kimi',     provider: 'moonshot' },
  llama:    { bg: '#FCE7F3', fg: '#9D174D', border: '#FBCFE8', label: 'Llama',    provider: 'meta' },
  synthetic:{ bg: '#F3F4F6', fg: '#6B7280', border: '#E5E7EB', label: 'System',   provider: 'system' },
};

// Provider visual identity for chat avatars. Each provider gets:
//   - a distinctive gradient (matches brand vibe, not pixel-perfect)
//   - a 1-char glyph and accessible label
// Returns { gradient, glyph, label, provider }.
const PROVIDER_AVATARS = {
  anthropic: { gradient: 'linear-gradient(135deg, #FF7A45 0%, #D84315 100%)', glyph: '✦', label: 'Anthropic' },
  deepseek:  { gradient: 'linear-gradient(135deg, #4F8EF7 0%, #1E3A8A 100%)', glyph: 'D', label: 'DeepSeek' },
  mimo:      { gradient: 'linear-gradient(135deg, #FF6B6B 0%, #C92A2A 100%)', glyph: 'M', label: 'MiMo' },
  gemini:    { gradient: 'linear-gradient(135deg, #4285F4 0%, #9333EA 100%)', glyph: '✧', label: 'Gemini' },
  openai:    { gradient: 'linear-gradient(135deg, #10A37F 0%, #064E3B 100%)', glyph: 'O', label: 'OpenAI' },
  qwen:      { gradient: 'linear-gradient(135deg, #A855F7 0%, #6B21A8 100%)', glyph: 'Q', label: 'Qwen' },
  zhipu:     { gradient: 'linear-gradient(135deg, #F59E0B 0%, #B45309 100%)', glyph: 'Z', label: '智谱' },
  moonshot:  { gradient: 'linear-gradient(135deg, #6366F1 0%, #312E81 100%)', glyph: 'K', label: 'Kimi' },
  meta:      { gradient: 'linear-gradient(135deg, #EC4899 0%, #9D174D 100%)', glyph: 'L', label: 'Llama' },
  system:    { gradient: 'linear-gradient(135deg, #94A3B8 0%, #475569 100%)', glyph: '·', label: '系统' },
};

export function providerAvatar(model) {
  if (!model) return PROVIDER_AVATARS.system;
  const style = getModelStyle(model);
  return PROVIDER_AVATARS[style.provider] || PROVIDER_AVATARS.system;
}

/**
 * Circular avatar tinted to the model's provider. Used for chat bubbles.
 * Falls back to a neutral gray when the model is unknown.
 */
export function ProviderAvatar({ model, size = 28, className = '' }) {
  const av = providerAvatar(model);
  return (
    <div
      className={`shrink-0 rounded-full flex items-center justify-center text-white font-semibold ${className}`}
      style={{
        width: size, height: size,
        background: av.gradient,
        fontSize: Math.round(size * 0.48),
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px rgba(0,0,0,0.12)',
      }}
      title={av.label}
    >
      <span style={{ textShadow: '0 1px 1px rgba(0,0,0,0.15)' }}>{av.glyph}</span>
    </div>
  );
}

function getModelStyle(model) {
  if (!model) return { bg: '#F3F4F6', fg: '#6B7280', border: '#E5E7EB', label: '?', provider: 'system' };
  const lower = model.toLowerCase();
  for (const [key, style] of Object.entries(MODEL_STYLES)) {
    if (lower.includes(key)) return style;
  }
  // Clean up version suffixes for display
  const clean = model.replace(/\[.*\]/, '').replace(/-\d{8}$/, '');
  return {
    bg: '#F3F4F6', fg: '#6B7280', border: '#E5E7EB', provider: 'system',
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
