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

// Inline SVG marks for each provider. The anthropic mark is the OFFICIAL
// Claude logo path sourced from anthropics/anthropic-sdk-typescript's
// .github/logo.svg — verbatim, not an approximation.
const ProviderMarks = {
  anthropic: (
    <svg viewBox="0 0 248 248" fill="currentColor" aria-hidden>
      <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
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
  // 去掉圆形背景圈,只裸放官方 Claude spark(用户嫌圆头像别扭)。头像恒为官方 logo
  // (providerAvatar 统一返回 anthropic),spark 用品牌橙,与顶栏 logo 一致。
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
