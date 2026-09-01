import React from 'react';
import { useStore } from '../stores/sessionStore.js';
import { resolveAssistantProvider, parseAvatar } from '../utils/providerList.js';
import { PROVIDER_ICONS } from '../../../server/utils/provider-icons.js';

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

// r83:标识全部来自 server/utils/provider-icons.js 的静态 path 表(来源与许可证逐条
// 记在该文件头)。渲染成 24×24 单色 svg,fill=currentColor —— 颜色由外层 chip 给,
// 同一枚 path 在浅色/深色主题下只换一个 color 就成立。
function iconMark(def) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden
      {...(def.evenodd ? { fillRule: 'evenodd', clipRule: 'evenodd' } : null)}>
      <path d={def.d} />
    </svg>
  );
}

// cc-gui 自有标识(双同心开口弧 + 光标点,与顶栏字标同源)。官方端点恒用它,不借用
// Anthropic 官方 logo —— 那会读成"这是 Anthropic 出的应用"。(这条理由本身成立,但
// r83 之前它挂着 "r13-p2-13 去商标取舍" 的出处,归档里查不到该记录,故只留理由不留出处。)
// 图标表里的 anthropic / claude 两枚是给用户挑给自己 provider 用的,与这枚无关。
const CCGUI_AVATAR = {
  label: 'Anthropic',
  markColor: '#D97757',
  mark: (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M23.2 8.6A10 10 0 1 0 23.2 23.4" stroke="currentColor" strokeWidth="3.1" strokeLinecap="round" />
      <path d="M19.6 12.3A5 5 0 1 0 19.6 19.7" stroke="currentColor" strokeWidth="3.1" strokeLinecap="round" opacity="0.55" />
      <circle cx="26.6" cy="16" r="1.9" fill="currentColor" />
    </svg>
  ),
};

// Provider 视觉标识:一枚标识 + 品牌色。r83 起没有品牌渐变底 —— 底色与描边一律走
// 主题变量(见 ProviderMark 的 chip),品牌色只上到标识本身。markColor 为空表示这枚
// 标识本身是单色的,跟随主题字色。
const PROVIDER_AVATARS = Object.fromEntries(
  Object.entries(PROVIDER_ICONS).map(([key, def]) => [
    key, { mark: iconMark(def), label: def.label, markColor: def.color || null },
  ]),
);

// 官方那一枚:cc-gui 自有标识,与顶栏 logo 同源同色。官方端点恒用它(r78/r83 不改)。
export function providerAvatar() {
  return CCGUI_AVATAR;
}

// r78/r83:首字母(默认回落的最后一档)。chip 与内置图标那档完全一致,只是标识换成
// 一个字符 —— 颜色按名字哈希取一档,同一个 provider 每次渲染同色,不同 provider 大
// 概率不同色。刻意不给没有干净图标来源的厂商配色块冒充图标:回落就明说是回落。
// 标识在 chip 里占多大。chip 有底色和描边,内层要留白,所以比 r83 之前的裸标识小。
const GLYPH_SCALE = 0.68;
// 官方那枚单独留一个旋钮:r83 之前它走独立分支、裸标识不需要留边距,内层是 0.92×size;
// 现在与其它形态共用 chip,收到与它们相同的 0.68(约小 26%)。装机后若嫌官方标识变小,
// 只改这一个数即可(0.92 = 回到 r83 之前的大小),不影响其余 55 枚。
const OFFICIAL_GLYPH_SCALE = 0.68;

const LETTER_COLORS = ['#64748B', '#0EA5E9', '#0D9488', '#D97706', '#DC2626', '#7C3AED'];
function letterAvatar(name) {
  const s = String(name || '').trim();
  const label = ([...s][0] || '?').toUpperCase();
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 100003;
  return {
    mark: <span style={{ fontWeight: 700, letterSpacing: '-0.02em' }}>{label}</span>,
    markColor: LETTER_COLORS[h % LETTER_COLORS.length],
    label: s || '?',
  };
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
 * r78:provider 头像。气泡头、顶栏切换卡片、管理列表、手机 Provider 页共用同一枚,
 * 四处观感由这一个组件统一决定。官方端点走 official 分支(恒 cc-gui 自有标识),
 * 其余按 providerAvatarSpec。
 *
 * r83 chip:表面色底 + 0.5px 细边框,品牌色只上到标识本身,不再有品牌渐变底。
 * 底色与描边取主题变量而不写死颜色 —— canvas 是当前主题的基底色,canvas-deep 在浅色
 * 主题里比它深一档、在深色主题里比它浅一档,所以同一对变量在深浅两侧都描得出边,
 * 也不会出现深色下白底刺眼。四种形态(图标 / 图片 / emoji / 首字母)共用同一枚 chip。
 * 圆角方片而不是圆形:沿用 r78 就有的既有选择,**没有**用户偏好依据 —— r83 之前这里
 * 引 r13-p2-13 说"用户嫌圆头像别扭",查原始记录(v0.2.103 第 5 条)说的是"去圆形
 * **背景**只留 spark",讲的是官方那枚的底,与方圆形状无关。要改成正圆就改 borderRadius。
 *
 * provider-mark 这个类必须挂在每一种形态上:iOS/WKWebView 把只有 viewBox、没有
 * width/height 的内联 svg 渲染成 0×0,靠 .provider-mark svg{width:100%} 撑开
 * (index.css:1521)。r83 之前它只挂在 official 分支上,内置图标全改成 svg 之后
 * 漏挂就是"手机上头像整片消失"。
 */
export function ProviderMark({ row = null, name = '', size = 16, official = false, className = '', thinking = false }) {
  const spin = thinking ? 'avatar-thinking-spin' : '';
  const chip = {
    width: size,
    height: size,
    borderRadius: Math.max(3, Math.round(size * 0.28)),
    background: 'var(--color-canvas)',
    border: '0.5px solid var(--color-canvas-deep)',
  };
  const cls = `shrink-0 provider-mark ${spin} ${className}`;
  const spec = official ? { kind: 'mark', ...CCGUI_AVATAR } : providerAvatarSpec({ row, name });
  if (spec.kind === 'text') {
    // emoji/文字走 React 文本节点(不用 dangerouslySetInnerHTML)。
    return (
      <span className={`inline-flex items-center justify-center leading-none ${cls}`}
        style={{ ...chip, fontSize: Math.round(size * 0.66) }} title={spec.label}>{spec.text}</span>
    );
  }
  if (spec.kind === 'file') {
    return (
      <img src={`/api/provider-avatars/${spec.file}`} alt="" title={spec.label} draggable={false}
        className={`object-cover ${cls}`} style={chip} />
    );
  }
  const inner = Math.round(size * (official ? OFFICIAL_GLYPH_SCALE : GLYPH_SCALE));
  return (
    <div className={`flex items-center justify-center ${cls}`}
      style={{ ...chip, color: spec.markColor || 'var(--color-ink)' }} title={spec.label}>
      <div style={{ width: inner, height: inner, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.round(size * 0.62) }}>
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

// r83:用量面板的分组显示名覆盖。图标表里 moonshot/meta 是**厂商名**(Moonshot/Meta),
// 选择器该显示厂商名;但用量面板沿用用户熟悉的产品叫法 Kimi/Llama。只覆盖显示名 ——
// 分桶与 React key 都用 key,改这里不产生任何数据迁移。
const PANEL_LABELS = { moonshot: 'Kimi', meta: 'Llama' };

// Resolve a model id to its provider { key, label } using the same matching
// as the badge, so the usage panel groups identically to what badges show.
export function modelProvider(model) {
  const key = getModelStyle(model).provider || 'system';
  return { key, label: PANEL_LABELS[key] || PROVIDER_AVATARS[key]?.label || key };
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
