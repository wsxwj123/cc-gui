import React from 'react';
import { useStore } from '../stores/sessionStore.js';
import { resolveAssistantName } from '../utils/providerList.js';

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

// Inline SVG marks for each provider. The anthropic mark is the OFFICIAL
// Claude logo path sourced from anthropics/anthropic-sdk-typescript's
// .github/logo.svg — verbatim, not an approximation.
const ProviderMarks = {
  // r13-p2-13:回复头像用 cc-gui 自有标识(双同心开口弧 + 光标点,与顶栏字标同源),
  // 原第三方官方 logo 已退役(去商标)。currentColor 跟随主题/品牌色。
  anthropic: (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M23.2 8.6A10 10 0 1 0 23.2 23.4" stroke="currentColor" strokeWidth="3.1" strokeLinecap="round" />
      <path d="M19.6 12.3A5 5 0 1 0 19.6 19.7" stroke="currentColor" strokeWidth="3.1" strokeLinecap="round" opacity="0.55" />
      <circle cx="26.6" cy="16" r="1.9" fill="currentColor" />
    </svg>
  ),
  // DeepSeek — stylized D in a rounded square
  deepseek: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 5h6a7 7 0 0 1 0 14H6V5zm3 3v8h3a4 4 0 0 0 0-8H9z" />
    </svg>
  ),
  // Gemini — 4-petal sparkle
  gemini: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2 C12 7 17 12 22 12 C17 12 12 17 12 22 C12 17 7 12 2 12 C7 12 12 7 12 2 Z" />
    </svg>
  ),
  // OpenAI — simplified knot
  openai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="8" />
      <path d="M8 12 L16 12 M12 8 L12 16" strokeLinecap="round" />
    </svg>
  ),
  letter: (label) => (
    <span style={{ fontWeight: 700, letterSpacing: '-0.02em' }}>{label[0]}</span>
  ),
};

// Provider visual identity. Each gets a brand gradient + an SVG/text mark.
const PROVIDER_AVATARS = {
  // Brand color — #D97757 是 Anthropic 官方 brand color (verbatim from logo.svg).
  // Background uses a subtle off-white to make the terracotta logo pop, matching
  // how it's displayed on anthropic.com / claude.ai.
  anthropic: { gradient: 'linear-gradient(135deg, #FAF7F2 0%, #F0E8DD 100%)', mark: ProviderMarks.anthropic, label: 'Anthropic', markColor: '#D97757' },
  deepseek:  { gradient: 'linear-gradient(135deg, #4F8EF7 0%, #1E3A8A 100%)', mark: ProviderMarks.deepseek,  label: 'DeepSeek' },
  mimo:      { gradient: 'linear-gradient(135deg, #FF6B6B 0%, #C92A2A 100%)', mark: ProviderMarks.letter('M'), label: 'MiMo' },
  gemini:    { gradient: 'linear-gradient(135deg, #4285F4 0%, #9333EA 100%)', mark: ProviderMarks.gemini,    label: 'Gemini' },
  openai:    { gradient: 'linear-gradient(135deg, #10A37F 0%, #064E3B 100%)', mark: ProviderMarks.openai,    label: 'OpenAI' },
  qwen:      { gradient: 'linear-gradient(135deg, #A855F7 0%, #6B21A8 100%)', mark: ProviderMarks.letter('Q'), label: 'Qwen' },
  zhipu:     { gradient: 'linear-gradient(135deg, #F59E0B 0%, #B45309 100%)', mark: ProviderMarks.letter('Z'), label: '智谱' },
  moonshot:  { gradient: 'linear-gradient(135deg, #6366F1 0%, #312E81 100%)', mark: ProviderMarks.letter('K'), label: 'Kimi' },
  meta:      { gradient: 'linear-gradient(135deg, #EC4899 0%, #9D174D 100%)', mark: ProviderMarks.letter('L'), label: 'Llama' },
  system:    { gradient: 'linear-gradient(135deg, #94A3B8 0%, #475569 100%)', mark: ProviderMarks.letter('·'), label: '系统' },
};

export function providerAvatar(model) {
  // The avatar is the GUI's branding — always show Claude's official logo,
  // regardless of which provider the CLI is talking to (Anthropic / DeepSeek
  // / Xiaomi / OpenRouter etc.). The GUI is for Claude Code, so the chat
  // bubble identity stays Claude. (Provider-specific text/badge still shows
  // elsewhere via ModelBadge.)
  return PROVIDER_AVATARS.anthropic;
}

/**
 * Circular avatar tinted to the model's provider. Used for chat bubbles.
 * Falls back to a neutral gray when the model is unknown.
 */
// `thinking={true}` spins the inner mark, mirroring the CLI's animated
// progress glyph (✻ rotating) so users see Claude is "alive" mid-stream.
export function ProviderAvatar({ model, size = 28, className = '', thinking = false }) {
  const av = providerAvatar(model);
  // 去掉圆形背景圈,只裸放标识(用户嫌圆头像别扭)。头像恒为 cc-gui 自有标识
  // (providerAvatar 统一返回同一枚),与顶栏 logo 同源同色。
  return (
    <div
      className={`shrink-0 flex items-center justify-center provider-mark ${thinking ? 'avatar-thinking-spin' : ''} ${className}`}
      style={{ width: size, height: size, color: av.markColor || '#D97757' }}
      title={av.label}
    >
      <div
        style={{
          width: Math.round(size * 0.92), height: Math.round(size * 0.92),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {av.mark}
      </div>
    </div>
  );
}

/**
 * r76:助手气泡头的名字。官方端点恒「Claude」;走第三方中转时显示用户给该
 * provider 起的名字。解析链在 utils/providerList.js 的 resolveAssistantName
 * (纯函数,有单测);这里只负责把 store 里的三样输入喂给它 —— 两个渲染点
 * (TurnBubble / MessageBubble)共用同一个组件,不会再出现"改一处漏一处"。
 */
export function AssistantName({ model }) {
  const providers = useStore((s) => s.providerRows);
  const activeName = useStore((s) => s.providerName || '');
  const activeOfficial = useStore((s) => (s.currentProvider?.providerHint || 'anthropic') === 'anthropic');
  const name = resolveAssistantName({ model, providers, activeName, activeOfficial });
  return <span className="text-[13px] font-medium text-ink font-body">{name}</span>;
}

function getModelStyle(model) {
  if (!model) return { bg: '#F3F4F6', fg: '#6B7280', border: '#E5E7EB', label: '?', provider: 'system', full: '' };
  const lower = model.toLowerCase();
  // 显示具体模型 id 而非 Opus/Sonnet/MiMo 缩写(#7):去掉 [1m] 后缀与结尾 8 位日期,
  // 其余原样。颜色仍按 provider 关键字匹配。
  const clean = (model.replace(/\[.*?\]/g, '').replace(/-\d{8}$/, '').trim()) || model;
  const label = clean.length > 24 ? clean.slice(0, 22) + '…' : clean;
  for (const [key, style] of Object.entries(MODEL_STYLES)) {
    if (lower.includes(key)) return { ...style, label, full: clean };
  }
  return {
    bg: '#F3F4F6', fg: '#6B7280', border: '#E5E7EB', provider: 'system',
    label, full: clean,
  };
}

// Resolve a model id to its provider { key, label } using the same matching
// as the badge, so the usage panel groups identically to what badges show.
export function modelProvider(model) {
  const key = getModelStyle(model).provider || 'system';
  return { key, label: PROVIDER_AVATARS[key]?.label || key };
}

export function ModelBadge({ model, compact = false }) {
  const style = getModelStyle(model);

  if (compact) {
    return (
      <span
        className="inline-flex items-center px-1.5 py-px text-[10px] font-medium rounded font-body max-w-[200px] truncate"
        style={{ background: style.bg, color: style.fg, border: `1px solid ${style.border}` }}
        title={style.full || style.label}
      >
        {style.label}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md font-body max-w-[240px]"
      style={{ background: style.bg, color: style.fg, border: `1px solid ${style.border}` }}
      title={style.full || style.label}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: style.fg, opacity: 0.6 }} />
      <span className="truncate">{style.label}</span>
    </span>
  );
}
