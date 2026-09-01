import React from 'react';
import { useStore } from '../stores/sessionStore.js';
import { resolveAssistantProvider, parseAvatar } from '../utils/providerList.js';

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

// 官方那一枚:cc-gui 自有标识,与顶栏 logo 同源同色。官方端点恒用它(r78 不改)。
export function providerAvatar() {
  return PROVIDER_AVATARS.anthropic;
}

// r78:首字母色块(默认回落的最后一档)。渐变按名字哈希取,同一个 provider 每次
// 渲染同一色,不同 provider 大概率不同色。
const LETTER_GRADIENTS = [
  'linear-gradient(135deg, #64748B 0%, #334155 100%)',
  'linear-gradient(135deg, #0EA5E9 0%, #0C4A6E 100%)',
  'linear-gradient(135deg, #14B8A6 0%, #115E59 100%)',
  'linear-gradient(135deg, #F59E0B 0%, #92400E 100%)',
  'linear-gradient(135deg, #EF4444 0%, #7F1D1D 100%)',
  'linear-gradient(135deg, #8B5CF6 0%, #4C1D95 100%)',
];
function letterAvatar(name) {
  const s = String(name || '').trim();
  const label = ([...s][0] || '?').toUpperCase();
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 100003;
  return { gradient: LETTER_GRADIENTS[h % LETTER_GRADIENTS.length], mark: ProviderMarks.letter(label), label: s || '?' };
}

// 没设 avatar 时按【名字 + 首个模型 id】的关键字命中现成的 PROVIDER_AVATARS
// (与 ModelBadge 的配色同一张 MODEL_STYLES 表,观感一致)。都不中 → null。
function keywordAvatar(name, models) {
  const hay = `${name || ''} ${(Array.isArray(models) ? models[0] : '') || ''}`.toLowerCase();
  for (const [key, style] of Object.entries(MODEL_STYLES)) {
    if (hay.includes(key) && PROVIDER_AVATARS[style.provider]) return PROVIDER_AVATARS[style.provider];
  }
  return null;
}

/**
 * r78:一行 provider 该显示什么头像。纯函数,四级:
 *   ① avatar 是上传文件名 → 本地图片(永远走自家路由,不热链)
 *   ② avatar 是内置图标名 → 该图标
 *   ③ avatar 是 emoji/短文字 → 原样显示
 *   ④ 未设 → 名字/模型关键字命中内置图标 → 都不中用首字母色块
 */
export function providerAvatarSpec({ row = null, name = '' } = {}) {
  const label = String(name || row?.name || '').trim();
  const parsed = parseAvatar(row?.avatar);
  if (parsed?.kind === 'file') return { kind: 'file', file: parsed.value, label };
  if (parsed?.kind === 'mark' && PROVIDER_AVATARS[parsed.value]) return { kind: 'mark', ...PROVIDER_AVATARS[parsed.value], label: label || PROVIDER_AVATARS[parsed.value].label };
  if (parsed?.kind === 'text') return { kind: 'text', text: parsed.value, label };
  return { kind: 'mark', ...(keywordAvatar(label, row?.models) || letterAvatar(label)), label: label || '?' };
}

/**
 * r78:provider 头像。气泡头、顶栏切换卡片、管理列表、手机 Provider 页共用同一枚。
 * 官方端点走 official 分支(裸标识,与 r77 前完全一致);其余按 providerAvatarSpec。
 * 圆角方片而不是圆形 —— 用户嫌圆头像别扭(r13-p2-13 的取舍沿用)。
 */
export function ProviderMark({ row = null, name = '', size = 16, official = false, className = '', thinking = false }) {
  const spin = thinking ? 'avatar-thinking-spin' : '';
  if (official) {
    const av = providerAvatar();
    return (
      <div className={`shrink-0 flex items-center justify-center provider-mark ${spin} ${className}`}
        style={{ width: size, height: size, color: av.markColor || '#D97757' }} title={av.label}>
        <div style={{ width: Math.round(size * 0.92), height: Math.round(size * 0.92), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {av.mark}
        </div>
      </div>
    );
  }
  const spec = providerAvatarSpec({ row, name });
  const box = { width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.28)) };
  if (spec.kind === 'text') {
    // emoji/文字走 React 文本节点(不用 dangerouslySetInnerHTML)。
    return (
      <span className={`shrink-0 inline-flex items-center justify-center leading-none ${spin} ${className}`}
        style={{ ...box, fontSize: Math.round(size * 0.86) }} title={spec.label}>{spec.text}</span>
    );
  }
  if (spec.kind === 'file') {
    return (
      <img src={`/api/provider-avatars/${spec.file}`} alt="" title={spec.label} draggable={false}
        className={`shrink-0 object-cover ${spin} ${className}`} style={box} />
    );
  }
  return (
    <div className={`shrink-0 flex items-center justify-center text-white ${spin} ${className}`}
      style={{ ...box, background: spec.gradient, color: spec.markColor || '#fff' }} title={spec.label}>
      <div style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.round(size * 0.56) }}>
        {spec.mark}
      </div>
    </div>
  );
}

/**
 * r76+r78:助手消息属于哪个 provider。名字与头像**同一次调用**的返回值,
 * 不许各解析一遍(那样必然出现"名字是 A、头像是 B")。
 */
export function useAssistantProvider(model) {
  const providers = useStore((s) => s.providerRows);
  const activeName = useStore((s) => s.providerName || '');
  const activeOfficial = useStore((s) => (s.currentProvider?.providerHint || 'anthropic') === 'anthropic');
  return resolveAssistantProvider({ model, providers, activeName, activeOfficial });
}

/**
 * 气泡头像。r78 起跟随 provider:官方端点恒 cc-gui 自有标识(不变),第三方按
 * 该 provider 的头像设置(未设则按名字回落)。`thinking` 时旋转内部标识,
 * 对应 CLI 的 ✻ 动画。
 */
export function ProviderAvatar({ model, size = 28, className = '', thinking = false }) {
  const { official, row, name } = useAssistantProvider(model);
  return <ProviderMark official={official} row={row} name={name} size={size} className={className} thinking={thinking} />;
}

/**
 * r76:助手气泡头的名字。官方端点恒「Claude」;走第三方中转时显示用户给该
 * provider 起的名字。解析链在 utils/providerList.js 的 resolveAssistantProvider
 * (纯函数,有单测);这里只负责把 store 里的三样输入喂给它 —— 两个渲染点
 * (TurnBubble / MessageBubble)共用同一个组件,不会再出现"改一处漏一处"。
 */
export function AssistantName({ model }) {
  const { name } = useAssistantProvider(model);
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
