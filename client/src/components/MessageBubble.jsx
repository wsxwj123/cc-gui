import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { User, Brain, Copy, Check, RotateCcw, Pencil, GitBranch, Archive, Scissors, ChevronRight, AlertTriangle } from './Icon.jsx';
import {
  computeCostForMessage, costUnavailableReason, costSourceLabel, costUnknownNote, COST_REASON_TEXT,
  formatCost, displayUsd, costTitle,
} from '../utils/pricing.js';
import { formatHitPctOrDash } from '../utils/cacheStats.js';
import { copyText } from '../utils/clipboard.js';
import { useStore } from '../stores/sessionStore.js';
import { isActionMessage, parseActionMessage } from '../genui/host/action-fold.js';

// User messages can be huge (pasted logs, long prompts). Collapse to ~10 lines
// by default with a fade + "展开全部" toggle so the chat stays scannable.
const COLLAPSED_MAX_PX = 240; // ≈ 10 lines at 15px / leading-relaxed
import { Linkify } from '../utils/linkify.jsx';
import { imageAttachmentSrc, imageAttachmentSequence, loadAttachmentImageBytes } from '../utils/attachments.js';

function CollapsibleUserText({ text }) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > COLLAPSED_MAX_PX + 4);
  }, [text]);
  const collapsed = overflowing && !expanded;
  return (
    <div>
      <div className="relative">
        {/* r13-p2-9:淡出改用 mask(让文字自身渐隐),不再叠一层"猜背景色"的渐变。
            原来固定 from-canvas-warm,在气泡有自己底色的主题(青碧等)与皮肤下
            = 绿底上一道白边。mask 不含任何颜色假设,所有主题/皮肤天然正确。 */}
        <div
          ref={ref}
          className="text-[15px] font-reading leading-relaxed whitespace-pre-wrap text-ink overflow-hidden"
          style={collapsed ? {
            maxHeight: COLLAPSED_MAX_PX,
            WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 40px), transparent 100%)',
            maskImage: 'linear-gradient(to bottom, #000 calc(100% - 40px), transparent 100%)',
          } : undefined}
        >
          <Linkify text={text} />
        </div>
      </div>
      {overflowing && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[12px] text-accent hover:underline font-body"
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  );
}

// genui action 消息的折叠标记(INTERFACE §3.2 / §9.2,PLAN §1.3.5)。这类消息是模型
// 画的界面上的一次点击**以用户身份**发出的,所以:
//   · 只折叠,不隐藏 —— 它照常占一条消息位,是用户对这条写通道的唯一审计入口(§1.3.3 L4);
//   · 收起态直接显示动作名 + 组件类型,不用展开就知道自己发了什么;
//   · 展开后是**完整外发原文**,一个字不省。
// 展开态是本组件自己的 state(照 ThinkingFold 的做法):父级不因它展开而整树重渲,
// 也不会给上层 React.memo 的消息列表传新身份 prop。
// 收起时 body **不渲染**(不是 CSS 隐藏)——契约要求它不得存在于 DOM,否则"默认折叠"无法证伪。
// **不带入场动画**(判官裁定):标记一出现用例就点 toggle,0.25s 的 animate-fade-up
// 与"toHaveCount(1) 后立即点击"存在竞态 —— 间歇 flake 比没动画伤害大。别加回来。
function GenuiActionFold({ text, messageId = null }) {
  const [open, setOpen] = useState(false);
  const { action, type } = parseActionMessage(text) || {};
  return (
    <div data-cgui="message-user" data-testid="message-card" data-message-id={messageId || undefined} className="group px-6 py-1">
      <div className="max-w-[var(--content-max)] mx-auto flex flex-col items-end">
        <div data-testid="genui-action-message" className="max-w-[85%] flex flex-col items-end">
          <button
            data-testid="genui-action-message-toggle"
            onClick={() => setOpen((v) => !v)}
            title="模型生成的界面上的一次操作，已以你的名义发出这条消息。点击查看原文"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/12 text-accent text-[10px] font-body hover:bg-accent/20 transition-colors cursor-pointer max-w-full"
          >
            <ChevronRight size={10} className={`transition-transform shrink-0 ${open ? 'rotate-90' : ''}`} />
            <span className="shrink-0">界面操作</span>
            <span className="font-mono truncate">{action || '(数据块无法解析)'}</span>
            {type && <span className="text-accent/70 shrink-0">· {type}</span>}
          </button>
          {open && (
            <div data-testid="genui-action-message-body"
              className="mt-1 p-3 rounded-lg bg-canvas-warm border border-canvas-deep text-[11px] text-ink-muted whitespace-pre-wrap break-all max-h-64 overflow-y-auto font-mono leading-relaxed text-left">
              <Linkify text={text} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Custom user avatar — persisted as data URL in localStorage. Click the
// avatar circle (only on user messages) to upload an image. Showing the
// chosen image makes the chat feel personal; falling back to the default
// User icon when nothing is set.
function UserAvatar() {
  const [src, setSrc] = useState(() => {
    try { return localStorage.getItem('cgui-user-avatar') || ''; } catch { return ''; }
  });
  const fileRef = useRef(null);
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'cgui-user-avatar') setSrc(e.newValue || '');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const pick = () => fileRef.current?.click();
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setSrc(dataUrl);
      try { localStorage.setItem('cgui-user-avatar', dataUrl); } catch {}
    };
    reader.readAsDataURL(f);
  };
  return (
    <>
      <button
        onClick={pick}
        title="点击更换头像"
        className="w-7 h-7 rounded-full bg-accent flex items-center justify-center overflow-hidden hover:ring-2 hover:ring-accent/40 transition-shadow"
      >
        {src
          ? <img src={src} alt="me" className="w-full h-full object-cover" />
          : <User size={14} className="text-white" />}
      </button>
      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden" />
    </>
  );
}
import { ModelBadge, ProviderAvatar, AssistantName } from './ModelBadge.jsx';
import { ToolCallCard } from './ToolCallCard.jsx';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { thinkingLabel } from '../utils/streamStatus.js';
import { ImageLightbox } from './ImageLightbox.jsx';

// Per-message rollback menu. Shows three choices on click:
//   - rollback message + later replies only (chat trim)
//   - rollback message + files, then resend
//   - rollback message + files, then put text back in composer
// onAction is invoked with { mode: 'message'|'both'|'edit' }.
function RollbackMenu({ message, onAction }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null); // {top,right} viewport coords
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const hasSha = !!message.checkpointSha;

  // Outside-click closes — but only if click hits OUTSIDE both the trigger
  // and the portal'd menu (menu is no longer a descendant of wrapRef).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    // stopPropagation:关回滚菜单的 Esc 不冒到 window 上的会话级监听(生成中单击即停)。
    // R1:相位挂 window 捕获(与灯箱/预览等浮层同款)。原来挂 document 冒泡 → 晚于右侧面板
    // 监听的 document 捕获,面板开着时这一击先关面板、菜单留着(层级颠倒)。
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    // mousedown closes too aggressively (clicking inside menu before mouseup
    // can race with the close listener). Use `click` instead — fires only
    // after a complete press-release on the same target.
    document.addEventListener('click', onDocClick);
    window.addEventListener('keydown', onEsc, true);
    return () => {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, [open]);

  const toggle = (e) => {
    e.stopPropagation();
    if (!open && wrapRef.current) {
      const r = wrapRef.current.getBoundingClientRect();
      const gap = 6;
      // 关键:<html> 用了 CSS zoom(字号缩放)。window.innerWidth/Height 是 zoom 不变的,
      // 但 getBoundingClientRect 在 zoom 下是另一套坐标 → 二者相减(原 right=innerWidth-
      // r.right)会按 zoom 倍数错位,菜单飞到一边(用户报告)。改为完全不用 innerWidth/Height
      // 定位:left 放到按钮右缘 + translateX(-100%) 右对齐;上/下用 translateY 翻转。
      // 全部基于 rect + 自身百分比,与 zoom 无关。
      // innerHeight 是 zoom 不变的,r 是 zoom 后视觉坐标 → 需按 --ui-zoom 折算到同一空间
      // (与 App 里 --app-h = innerHeight/z 的约定一致),否则缩放>1 时会误判向下开导致
      // 菜单超出屏幕底部。
      const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
      const visH = window.innerHeight / z;
      const visW = window.innerWidth / z;
      // 实测根因(z>1 时溢出):getBoundingClientRect 返回【视觉px=布局px×z】,而 position:fixed
      // 的 left/top 按【布局px】解释(渲染时再×z)。原代码把视觉px 的 r.right 直接和布局px 的
      // visW/left 混用 → 钳制按错误尺度算 → 菜单横向冲出边界。统一把 r.* 除以 z 折算到布局px。
      const rRight = r.right / z, rTop = r.top / z, rBottom = r.bottom / z;
      const openBelow = (visH - rBottom) >= rTop;
      // 菜单右对齐(translateX -100%)到按钮右缘;窗口比菜单(256)还窄时菜单动态收窄,
      // 保证 right≤visW-8 且 left≥8 同时成立。全部用布局px。
      const menuW = Math.min(256, Math.max(160, visW - 16));
      const left = Math.max(menuW + 8, Math.min(rRight, visW - 8));
      setCoords({
        left,
        top: openBelow ? rBottom + gap : rTop - gap,
        ty: openBelow ? '0' : '-100%',
        w: menuW,
      });
    }
    setOpen(!open);
  };

  // 渲染后兜底钳制:坐标计算在 zoom/平台下可能有边缘误差,这里直接量【实际渲染矩形】
  // (getBoundingClientRect 与 window.innerWidth/Height 同为"视觉px"空间,zoom 无关),
  // 任何方向越界就把 fixed left/top 拉回(视觉超出量 ÷ z 换算成布局px)。收敛 1~2 帧。
  // 这是横向/纵向溢出的最终保险:无论计算对错,渲染出来一定在视口内。
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !coords) return;
    const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
    const m = menuRef.current.getBoundingClientRect();
    const pad = 8;
    let nl = coords.left, nt = coords.top;
    if (m.right > window.innerWidth - pad) nl -= (m.right - (window.innerWidth - pad)) / z;
    if (m.left < pad) nl += (pad - m.left) / z;
    if (m.bottom > window.innerHeight - pad) nt -= (m.bottom - (window.innerHeight - pad)) / z;
    if (m.top < pad) nt += (pad - m.top) / z;
    if (Math.abs(nl - coords.left) > 0.5 || Math.abs(nt - coords.top) > 0.5) {
      setCoords((c) => ({ ...c, left: nl, top: nt }));
    }
  }, [open, coords]);

  // Render the menu in a portal at body level so it doesn't get clipped by
  // any ancestor's overflow / transform / opacity. z-index now actually means
  // "on top of everything" rather than "on top of siblings".
  const menu = open && coords && (
    <div
      ref={menuRef}
      style={{ position: 'fixed', left: coords.left, top: coords.top, width: coords.w || 256, transform: `translate(-100%, ${coords.ty})`, zIndex: 9999 }}
      className="max-w-[calc(var(--app-w,100vw)-16px)] max-h-[min(80vh,calc(var(--app-h,100dvh)-2rem))] overflow-y-auto py-1 rounded-lg shadow-popover bg-canvas border border-canvas-deep animate-glass-rise"
    >
      <div className="px-3 py-2 text-[10px] text-ink-faint uppercase tracking-wider font-body border-b border-canvas-deep">
        回滚此消息{hasSha ? '' : ' · 自动查找快照'}
      </div>
      <button
        onClick={() => { onAction({ mode: 'message' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
      >
        <RotateCcw size={13} className="text-accent mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">仅回退消息</div>
          <div className="text-[11px] text-ink-faint font-body">裁剪会话后自动重发，不动项目文件</div>
        </div>
      </button>
      <button
        onClick={() => { onAction({ mode: 'both' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
        title={hasSha ? '' : '点击后会按消息时间和文本查找对应快照'}
      >
        <RotateCcw size={13} className="text-amber-600 mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">回退消息和文件</div>
          <div className="text-[11px] text-ink-faint font-body">还原文件快照，裁剪会话，再次发送本条</div>
        </div>
      </button>
      <button
        onClick={() => { onAction({ mode: 'edit' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
        title={hasSha ? '' : '点击后会按消息时间和文本查找对应快照'}
      >
        <Pencil size={13} className="text-accent mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">编辑后重发</div>
          <div className="text-[11px] text-ink-faint font-body">自动回退文件，文本回到输入框</div>
        </div>
      </button>
      <div className="border-t border-canvas-deep" />
      <button
        onClick={() => { onAction({ mode: 'summarize-before' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
      >
        <Archive size={13} className="text-accent mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">压缩此前对话</div>
          <div className="text-[11px] text-ink-faint font-body">此条之前的对话替换为 AI 摘要，此条及之后保留，降低上下文占用</div>
        </div>
      </button>
      <button
        onClick={() => { onAction({ mode: 'summarize-after' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
      >
        <Scissors size={13} className="text-amber-600 mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">总结后回退到此处</div>
          <div className="text-[11px] text-ink-faint font-body">回退到此条之前，此条及之后的对话压缩为摘要保留在上下文中</div>
        </div>
      </button>
    </div>
  );

  return (
    <div ref={wrapRef} className="relative inline-flex">
      {/* Bigger hit area + permanently visible (50% opacity) so user can find &
          click it without first hover-locating a 1-character-wide icon. */}
      <button
        onClick={toggle}
        className="opacity-60 hover:opacity-100 transition-opacity p-1.5 hover:bg-canvas-deep rounded inline-flex items-center justify-center"
        title="回滚 / 重新编辑"
      >
        <RotateCcw size={14} className="text-ink-muted" />
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <button
      onClick={async () => {
        if (await copyText(text)) {
          clearTimeout(timerRef.current); // 连点复制:清旧 timer,保住新状态的完整时长
          setCopied(true);
          timerRef.current = setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="p-1 hover:bg-canvas-deep rounded"
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

// R08:raw 原图入口的并发是进程级全局配额(4 个,超出 429 FILE_READ_BUSY),与文件树预览/
// 正文 markdown 图共用;而图片失败是一次性闩死、不自动重试 → 一条消息里第 5 张及以后的图
// 永久"图片不可用"(文件其实在)。只有经 fetch 拿字节才看得见 429,所以 raw 来源统一走
// loadAttachmentImageBytes(有界退避重试,见 utils/attachments.js),preview(data URL)直接用。
// 同一份 blob URL 交给灯箱复用 —— 点开不再重打一次原图请求(既省配额也避免灯箱里 429)。
function useAttachmentImageSrc(src) {
  const remote = typeof src === 'string' && src.startsWith('/api/files/read');
  const [state, setState] = useState(() => ({ src: remote ? null : src || null, failed: false }));
  useEffect(() => {
    if (!remote) { setState({ src: src || null, failed: false }); return undefined; }
    let cancelled = false;
    let objectUrl = null;
    setState({ src: null, failed: false });
    loadAttachmentImageBytes(src).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setState({ src: objectUrl, failed: false });
    }).catch(() => { if (!cancelled) setState({ src: null, failed: true }); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, remote]);
  return state;
}

// R08:图片附件的显示来源见 utils/attachments.js 的 imageAttachmentSrc(preview 优先,
// 没有 preview 时退回受权原图字节入口)。加载失败(文件不存在/越界/读取失败/解码失败)必须
// 明确说"图片不可用"并保留文件名,不画裂图、不造假缩略图;失败的状态要上报给消息体,灯箱
// 序列据此把这张图排除(否则计数与卡片矛盾、还能翻到破图上)。
function UserAttachmentCard({ attachment, onOpenImage, onImageState }) {
  const isImage = attachment?.kind === 'image';
  const src = isImage ? imageAttachmentSrc(attachment) : null;
  const { src: displaySrc, failed: loadFailed } = useAttachmentImageSrc(src);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const failed = loadFailed || decodeFailed;

  useEffect(() => {
    if (!isImage || !onImageState) return;
    onImageState(attachment, failed ? 'failed' : (displaySrc ? 'ok' : 'loading'), displaySrc || null);
  }, [isImage, attachment, failed, displaySrc, onImageState]);

  if (isImage && (!src || failed)) {
    return (
      // 刻意不挂 data-cgui:锚点层承诺的是"跨版本稳定的 chrome 区域",这里是图片附件的
      // 失败回退态(可观测口径是文案「图片不可用」本身,证据脚本也按文案找),正常态卡片
      // 也没有锚点 —— 不该让失败分支单独占用锚点表。
      <div title={attachment?.path || ''}
        className="flex items-center gap-2 px-2 py-1 bg-canvas border border-canvas-deep rounded-lg max-w-[260px]">
        <div className="w-10 h-10 rounded bg-canvas-deep flex items-center justify-center shrink-0">
          <AlertTriangle size={15} className="text-ink-faint" />
        </div>
        <div className="min-w-0">
          <div className="text-[12px] text-ink font-body truncate">{attachment?.name}</div>
          <div className="text-[10px] text-ink-faint font-body">图片不可用</div>
        </div>
      </div>
    );
  }

  return (
    <div
      // #7 决策:图片卡去双击(单击图片放大);非图片文件卡保持双击打开默认 App。
      onDoubleClick={isImage ? undefined : () => { fetch('/api/files/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: attachment.path }) }).catch(() => {}); }}
      className={`flex items-center gap-2 px-2 py-1 bg-canvas border border-canvas-deep rounded-lg max-w-[260px] hover:border-accent/40 transition-colors ${isImage ? '' : 'cursor-pointer'}`}
      title={isImage ? attachment.path : `双击用默认应用打开\n${attachment.path}`}>
      {isImage ? (
        displaySrc ? (
          <img src={displaySrc} alt={attachment.name}
            // 200 空体/字节不完整等解码失败:与取字节失败同口径,明确"图片不可用"。
            onError={() => setDecodeFailed(true)}
            onClick={(e) => { e.stopPropagation(); onOpenImage({ src: displaySrc, name: attachment.name, path: attachment.path }); }}
            className="w-10 h-10 rounded object-cover shrink-0 cursor-zoom-in" />
        ) : (
          // 取字节中(含 429 退避重试窗口):占位不画裂图,更不提前判"不可用"。
          // 刻意不挂 data-cgui:这是加载中/退避重试窗口里的临时占位(随状态出现又消失),
          // 不是跨版本稳定的 chrome 区域。
          <div className="w-10 h-10 rounded bg-canvas-deep shrink-0 animate-pulse" />
        )
      ) : (
        <div className="w-10 h-10 rounded bg-accent/10 flex items-center justify-center shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
      )}
      <div className="min-w-0">
        <div className="text-[12px] text-ink font-body truncate">{attachment.name}</div>
        {attachment.bytes ? <div className="text-[10px] text-ink-faint font-mono">{(attachment.bytes/1024).toFixed(1)} KB</div> : null}
      </div>
    </div>
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

function UsageDisplay({ message }) {
  // hook 必须无条件调用:移到 early return 之前(原在 if(!usage)return 之后=条件调用 hook,
  // usage 有无切换时 hooks 数量变→React 崩;ESLint rules-of-hooks 抓出的真隐患)。
  const provider = useStore((s) => s.currentProvider);
  const usage = message?.usage;
  if (!usage) return null;
  const model = message.model;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  // 计费唯一入口:带 message 是为了 usageCalls(逐次 API 调用各自的时刻)—— 分时段价的
  // 模型必须按每次调用自己的时间戳判档,汇总后的 usage 拆不回"哪一段在什么时刻"。
  const cost = computeCostForMessage(message, provider);
  // 费用未知时不再一律说「未定价」:按契约给具体原因(时段未知/条件歧义/阈值未知…)。
  const unavailable = cost ? null : costUnavailableReason(model, usage, provider, { at: message.timestamp });
  // R24 轮末徽章:一条 assistant 消息的 usage 是【整轮累加】口径(消耗口径),不是单次调用 ——
  // 所以这里叫「整轮命中率」,顶部那条单次调用口径叫「最近API命中率」,会话累计在用量面板。
  const turnDenominator = input + cacheRead + cacheWrite;
  const turnHitPct = turnDenominator > 0 ? (cacheRead / turnDenominator) * 100 : 0;
  // 上游把自相矛盾/无效的用量透传过来时(proxy 盖的 ccgui_usage),这里如实标出来,
  // 不静默改写数字、不按脏数据算钱。
  const usageCodes = Array.isArray(usage.ccgui_usage?.codes) ? usage.ccgui_usage.codes : [];
  // R43:与轮末回合气泡(TurnBubble.jsx)同形 —— 行内只留 输入 / 输出 / 金额,明细
  // (缓存命中 / 缓存写入 / 本轮累计读取 / 整轮命中率)收进本行容器的悬停提示,否则同一条
  // 用量行在两种卡片上长相不同。悬停挂在行容器上(不是金额上):金额的直接父容器仍是
  // 那一组带 ml-auto 的 span,位置判据不动。数值口径一字未改(整轮命中率仍是
  // formatHitPctOrDash(加权累计, 分母),分母 0 显示 —)。
  return (
    <div
      data-cgui="usage-line"
      data-usage-scope="message"
      title={`缓存命中 ${cacheRead.toLocaleString()} · 缓存写入 ${cacheWrite.toLocaleString()}\n本轮累计读取 ${(input + cacheRead + cacheWrite).toLocaleString()}（= 输入 ${input.toLocaleString()} + 缓存命中 ${cacheRead.toLocaleString()} + 缓存写入 ${cacheWrite.toLocaleString()}；一轮里模型每次调用 API 都要重读整段上下文，累计读取量会大于单次上下文大小）\n整轮命中率 ${formatHitPctOrDash(turnHitPct, turnDenominator)}（= 整轮 cache_read /（普通 input + cache_read + cache_creation），整轮所有 API 调用累计加权；切模型或进程冷启的那一轮偏低属正常。分母 0 显示 —）`}
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-faint mt-2 pt-2 border-t border-canvas-deep/50"
    >
      <span>输入 {input.toLocaleString()}</span>
      <span>输出 {output.toLocaleString()}</span>
      {usageCodes.length > 0 && (
        <span className="text-error" title="上游回报的用量字段无效或自相矛盾，数字原样保留、费用按未知处理">
          {usageCodes.join(' / ')}
        </span>
      )}
      {/* R3:说明文案(含"按你填写的单价"/"按官网价估算"的口径切换)由 pricing.js 统一给,
          三个费用显示点共用同一份,不各自维护。
          注释写在属性外只是风格统一 —— 原先写在 title 属性上方的 // 行注释在本项目的
          esbuild 下实测行为正确(属性完好),不是在修 bug。 */}
      {/* R24 展示口径:每条费用都带来源标注 —— 用户手填单价 / 按官方价估算 / 查无单价(未定价)。
          「未知新型号」不会套用旧型号价:lookupPrice 查不到就是查不到,这里如实写未定价。
          R42:来源词不再占行内版面(窄面板下它把这条行撑换行),改为金额 title 的**首行**(悬停可见),
          与轮末回合气泡(TurnBubble.jsx)同形;「已知小计」说明仍留在行内(钱没算全的声明)。 */}
      {cost && !usageCodes.length && (
        <span className="ml-auto flex items-center gap-1.5">
          <span
            data-cgui="usage-amount"
            className="text-accent/80 font-mono"
            // R42:title 首行 = 来源词,第二行起为 pricing.js 统一给的说明文案。
            title={`${costSourceLabel(cost)}\n${costTitle(cost)}`}
          >{formatCost(displayUsd(cost.totalUsd, cost.currency))}</span>
          {costUnknownNote(cost) && (
            <span className="text-[9px] text-ink-ghost" title="金额是已知小计，不含被判定为未知的那部分费用">{costUnknownNote(cost)}</span>
          )}
        </span>
      )}
      {!cost && !usageCodes.length && unavailable && (
        <span className="ml-auto text-ink-ghost" title={`${unavailable.detail}（费用未知，不显示 0）`}>
          {COST_REASON_TEXT[unavailable.reason] || COST_REASON_TEXT.NO_PRICE}
        </span>
      )}
    </div>
  );
}

export function MessageBubble({ message, onRollback, onFork }) {
  const isUser = message.role === 'user';
  const [showThinking, setShowThinking] = useState(false);
  // R09:灯箱持有的是【本消息图片附件里的序号】,不是单张 src —— 计数 "N / M"、左右切图、
  // 首尾边界都由这一个 state 算出来。序列口径与普通/并入消息一致(两者同一渲染点),
  // 只数能显示出来的图片(非图片附件与「图片不可用」的跳过),顺序就是附件原顺序。
  const [zoomIndex, setZoomIndex] = useState(null);
  // 每张图片的加载结局(卡片上报):failed 的必须退出灯箱序列 —— 元数据说有来源、实际
  // 403/404/解码失败的图如果留在序列里,计数就与卡片矛盾(卡上 2 张、灯箱写 1/3),还能
  // 翻到破图上。同时把解析好的 src(blob URL)留给灯箱复用,点开不再重打一次原图请求。
  const [imageStates, setImageStates] = useState(() => new Map());
  const reportImageState = useCallback((attachment, state, src) => {
    setImageStates((prev) => {
      const cur = prev.get(attachment);
      if (cur && cur.state === state && cur.src === src) return prev;
      const next = new Map(prev);
      next.set(attachment, { state, src });
      return next;
    });
  }, []);
  const messageImages = (isUser ? imageAttachmentSequence(message.attachments) : [])
    .filter((attachment) => imageStates.get(attachment)?.state !== 'failed');
  const zoomImage = zoomIndex === null || !messageImages[zoomIndex]
    ? null
    : {
      // 加载失败后不重试(与卡片同口径):能进序列的都已经成功取到字节,这里必命中;
      // 兜底回元数据来源,防上报与渲染之间那一帧。
      src: imageStates.get(messageImages[zoomIndex])?.src || imageAttachmentSrc(messageImages[zoomIndex]),
      name: messageImages[zoomIndex].name,
      path: messageImages[zoomIndex].path,
    };

  if (isUser) {
    // genui action 消息折叠(M7)。用户消息只有 MessageBubble 一个渲染点(历史卡、
    // 实时气泡、引导气泡都走它),折在这里就全覆盖。
    // 两个判据同一条前缀规则:`genuiAction` 是 session-reader 读 jsonl 时打的标记
    // (历史回读走它),前缀识别兜住实时发送与引导气泡这些没经过 session-reader 的路径。
    if (message.genuiAction || isActionMessage(message.text)) {
      return <GenuiActionFold text={message.text} messageId={message.uuid} />;
    }
    return (
      // data-message-id:本产品唯一的非秘密消息身份(INTERFACE「可观察身份」)。历史卡、
      // 实时气泡、并入气泡都走这里,所以一处就全覆盖;带图消息的图片/灯箱也在同一个
      // 容器里,黑盒可用它按消息圈定图片序列。
      <div data-cgui="message-user" data-testid="message-card" data-message-id={message.uuid || undefined} className="group px-6 py-4 animate-fade-up" style={{ animationDuration: '0.25s' }}>
        <div className="max-w-[var(--content-max)] mx-auto flex flex-row-reverse gap-3">
          <div className="shrink-0 mt-0.5">
            <UserAvatar />
          </div>
          <div className="flex-1 min-w-0 flex flex-col items-end">
            <div className="flex items-center gap-2 mb-1.5">
              {/* 「⚡ 并入」进上一个回合的消息:它不是新回合的开头,而是插进了正在跑的回合。
                  标出来,否则用户看到一条用户气泡夹在 AI 回复中间会以为是自己漏发了。
                  R36:回滚入口与普通人工消息相同(折叠形态在磁盘上是一条 attachment 记录,
                  trim 按它自己的 uuid 定位;实时气泡由调用方先解析落盘锚点再回退)。
                  分叉仍旧不开:它按"真·用户提问"找回合边界,attachment 行不是提问。 */}
              {message.steered && (
                <span className="px-1.5 py-0.5 rounded bg-accent/12 text-accent text-[10px] font-body"
                  title="这条消息是在上一个回复进行中并入的，模型在同一回合里读到了它">
                  已并入
                </span>
              )}
              {onRollback && <RollbackMenu message={message} onAction={(a) => onRollback(message, a)} />}
              {onFork && (
                <button onClick={() => onFork(message.uuid)} title="从这条消息分叉出一条新线(只保留到此为止的上下文,丢弃其后对话,原会话不动)"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-ink-faint hover:text-accent hover:bg-canvas-warm transition-colors">
                  <GitBranch size={11} /><span className="hidden md:inline">分叉</span>
                </button>
              )}
              <CopyButton text={message.text} />
              <span className="text-[11px] text-ink-faint font-mono">{formatTime(message.timestamp)}</span>
              <span className="text-[13px] font-medium text-ink font-body">你</span>
            </div>
            <div className="chat-user-bubble max-w-[85%] bg-canvas-warm border border-canvas-deep rounded-lg px-4 py-2.5">
              {/* L3: 附件在文本上方,符合"附件→说明"的自然阅读顺序;CLI 仍收带 @path 的完整 outbound */}
              {Array.isArray(message.attachments) && message.attachments.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {message.attachments.map((a, i) => (
                    <UserAttachmentCard key={i} attachment={a}
                      onImageState={reportImageState}
                      // 打开灯箱时按本消息图片序列定位(不可用/非图片/加载失败的都不在序列里 →
                      // 不打开)。
                      onOpenImage={() => {
                        const index = messageImages.indexOf(a);
                        if (index >= 0) setZoomIndex(index);
                      }} />
                  ))}
                </div>
              )}
              <CollapsibleUserText text={(message.attachments?.length && message.displayText !== undefined) ? message.displayText : message.text} />
            </div>
          </div>
        </div>
        {/* #7/R09 已发送图片单击放大;灯箱内含"用默认 App 打开"。
            序列只限【本消息】的图片附件、按附件原顺序;首尾不循环 —— 到头那一侧不传
            回调(共享灯箱的既有约定:null 回调 = 该方向没有可按的按钮,见 ImageLightbox 注释),
            单图时两侧都没有回调 = 1/1 且不拦方向键。 */}
        <ImageLightbox
          src={zoomImage?.src}
          name={zoomImage?.name}
          path={zoomImage?.path}
          counter={zoomImage ? `${zoomIndex + 1} / ${messageImages.length}` : ''}
          onPrev={zoomImage && zoomIndex > 0 ? () => setZoomIndex(zoomIndex - 1) : null}
          onNext={zoomImage && zoomIndex < messageImages.length - 1 ? () => setZoomIndex(zoomIndex + 1) : null}
          onClose={() => setZoomIndex(null)}
        />
      </div>
    );
  }

  return (
    <div data-cgui="message-assistant" data-testid="message-card" data-message-id={message.uuid || undefined} className="group px-6 py-4 animate-fade-up" style={{ animationDuration: '0.25s' }}>
      <div className="max-w-[var(--content-max)] mx-auto flex gap-3">
        <div className="mt-0.5">
          <ProviderAvatar model={message.model} size={34} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <AssistantName model={message.model} />
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
                <Brain size={12} className="shrink-0" />
                <span className="truncate">{thinkingLabel(message.thinking)}</span>
                <span className="text-[10px] shrink-0">{showThinking ? '▾' : '▸'}</span>
              </button>
              {showThinking && (
                <div className="thinking-block mt-2 p-4 rounded-lg text-xs text-ink-muted whitespace-pre-wrap max-h-64 overflow-y-auto font-body leading-relaxed">
                  {message.thinking}
                </div>
              )}
            </div>
          )}

          {message.text && <MarkdownRenderer content={message.text} dockKeyPrefix={message.uuid} />}

          {message.toolCalls?.length > 0 && (
            <div className="mt-2">
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={tc.id || i} toolCall={tc} result={tc.result} />
              ))}
            </div>
          )}

          <UsageDisplay message={message} />
        </div>
      </div>
    </div>
  );
}
