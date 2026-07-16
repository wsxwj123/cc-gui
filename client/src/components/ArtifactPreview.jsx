import React, { useState, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check, Code2, Eye, AlertTriangle, Maximize2, X, PanelRight, RefreshCw } from 'lucide-react';
import { copyText } from '../utils/clipboard.js';
import { useStore } from '../stores/sessionStore.js';
import { useResizable, Splitter } from '../hooks/useResizable.jsx';
import {
  ERROR_COLLECTOR, PREVIEW_ERR_KEY, PREVIEW_ERR_LABEL, MAX_PREVIEW_ERRORS,
  normalizePreviewErr, formatPreviewErrors,
} from '../utils/previewErrors.js';
import { makeModePersist } from '../utils/previewMode.js';

// BH-1b: 桌面端把"全屏"升级成右侧 dock,移动端无横向空间仍走全屏遮罩。
function isMobileViewport() {
  try { return window.matchMedia('(max-width: 767px)').matches; }
  catch { return typeof window !== 'undefined' && window.innerWidth < 768; }
}

// 可内联预览的围栏代码语言。html/svg 走沙箱 iframe(原始内容、可能含脚本,必须隔离);
// mermaid 走库渲染成已净化的 svg。其余语言仍走普通代码块。
const PREVIEWABLE = new Set(['html', 'svg', 'mermaid']);

// BH-2: sandbox 不含 allow-same-origin → iframe 拿不到父页 DOM/cookie/localStorage,
// AI 生成的 HTML 即使含恶意脚本也跨域隔离在沙箱内。但 opaque origin 下 localStorage/
// sessionStorage 访问会抛 SecurityError 使整段脚本崩溃 → 页面按钮全失灵。注入一个垫片:
// 真 storage 不可用时回退到内存对象,让 demo 跑起来而不破坏隔离。allow-forms/modals/
// popups 让表单提交、alert/confirm、window.open 这些常见交互生效(均不破坏 origin 隔离)。
const SANDBOX_FLAGS = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox';
const STORAGE_SHIM = `<script>
(function(){
  function makeMem(){
    var m={};
    return {getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null;},
      setItem:function(k,v){m[k]=String(v);},removeItem:function(k){delete m[k];},
      clear:function(){m={};},key:function(i){return Object.keys(m)[i]||null;},
      get length(){return Object.keys(m).length;}};
  }
  ['localStorage','sessionStorage'].forEach(function(name){
    var ok=false;
    try{var s=window[name];s.setItem('__t','1');s.removeItem('__t');ok=true;}catch(e){}
    if(!ok){try{Object.defineProperty(window,name,{value:makeMem(),configurable:true});}catch(e){}}
  });
})();
</script>`;

// 在 HTML 头部注入 storage 垫片 + F2 运行时报错采集脚本。srcDoc 为空(流式中)时不注入。
// 两者都是无副作用前缀(不改 artifact 渲染),与旧行为一致。
function withShim(code) {
  if (!code || !code.trim()) return code;
  return STORAGE_SHIM + ERROR_COLLECTOR + code;
}

function normLang(lang) {
  return String(lang || '').trim().split(/\s+/)[0].toLowerCase();
}

export function isPreviewable(lang) {
  return PREVIEWABLE.has(normLang(lang));
}

// 问题1:mode('preview'|'code')按稳定 artifactId 记忆,规避流式重挂丢档。见 previewMode.js。
const modePersist = makeModePersist();

// mermaid 体积大(~500KB),懒加载且全局只初始化一次,多个图表共享同一实例。
let mermaidPromise;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      // securityLevel:'strict' → 禁用图定义里的 click 跳转和 html 标签内联脚本。
      m.default.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
      return m.default;
    });
  }
  return mermaidPromise;
}

// 流式输出时 code 每个 token 都在变;直接重渲会让 iframe 反复重载、mermaid 对半截
// 语法狂报错。debounce 到输出停顿后再渲染一次。
function useDebounced(value, delay) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => { if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}
      className="flex items-center gap-1 text-[10px] text-[#9a8e78] hover:text-[#cabba0] transition-colors"
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? '已复制' : '复制'}
    </button>
  );
}

// 问题2:预览运行时报错的右下角徽章 + 弹层 + 「发给 AI」。抽成共用组件,让 iframe 预览
// (PreviewIframe,html/svg 走沙箱)与父页渲染的 mermaid(MermaidView)复用同一套 UI/发送逻辑,
// 不另造。errors 为已 normalize 的 {type,text,sig} 数组;空则不渲染。放在 relative 容器内。
export function PreviewErrorBadge({ errors }) {
  const [open, setOpen] = useState(false);
  if (!errors || errors.length === 0) return null;
  // 填进当前活跃 pane 的输入框(用户自己按发送,不代发)。targetKey 与 sessionQueueKey 同构,
  // 分屏时只填活跃 pane(与 FileExplorer 的"添加到上下文"同款门控)。
  const sendToAI = () => {
    const text = formatPreviewErrors(errors);
    if (!text) return;
    const s = useStore.getState();
    const pane = (s.paneSessions || [])[s.activeTabIndex] || s.selectedSession;
    const targetKey = pane?.sessionId || `draft-${pane?.projectHash || 'none'}`;
    window.dispatchEvent(new CustomEvent('cgui:composer-fill', { detail: { text, append: true, targetKey } }));
    setOpen(false);
  };
  return (
    // inset-2 给容器确定的宽高(= 预览容器 - 16px),弹层用 % 才有分母可约束;pointer-events-none
    // 让全尺寸遮罩不挡下方 iframe 点击,仅按钮/弹层收回 auto。justify-end 把内容压到右下。
    <div className="absolute inset-2 z-10 flex flex-col items-end justify-end pointer-events-none">
      {open && (
        // flex 列三段(头/正文/底),不用 sticky —— webview 下 sticky 在带 transform 容器内失效。
        // 宽高 clamp 在容器内(min(固定, 100%)):小窗退化为占满内滚,不溢出。别用 vw/vh(webview zoom 分母坑)。
        <div className="mb-1.5 w-[320px] max-w-full max-h-[min(280px,100%)] pointer-events-auto flex flex-col rounded-lg border border-[#3a342b] bg-[#2b2722] shadow-2xl overflow-hidden">
          <div className="px-3 py-1.5 text-[10px] font-mono text-[#9a8e78] border-b border-[#3a342b] shrink-0">
            预览运行时报错 · {errors.length} 条
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1.5">
            {errors.map((e, i) => (
              <div key={i} className="text-[11px] font-mono text-[#e8e2d6] break-all leading-snug">
                <span className="text-amber-400/80">[{PREVIEW_ERR_LABEL[e.type] || e.type}]</span> {e.text}
              </div>
            ))}
          </div>
          <div className="px-3 py-2 border-t border-[#3a342b] shrink-0">
            <button
              onClick={sendToAI}
              className="w-full py-1 rounded-md bg-[#3a342b] text-[11px] font-mono text-[#e8e2d6] hover:bg-[#453e33] transition-colors"
            >
              把报错发给 AI
            </button>
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        title="预览运行时报错"
        className="pointer-events-auto flex items-center gap-1 px-2 py-1 rounded-md bg-[#2b2722]/95 border border-amber-500/40 text-[10px] font-mono text-amber-300 shadow-lg hover:bg-[#3a342b] transition-colors"
      >
        <AlertTriangle size={11} /> {errors.length}
      </button>
    </div>
  );
}

export function MermaidView({ code }) {
  const [svg, setSvg] = useState('');
  const [err, setErr] = useState('');
  const rawId = useId();
  const id = 'mmd' + rawId.replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => {
    let cancelled = false;
    if (!code.trim()) { setSvg(''); setErr(''); return; }
    loadMermaid()
      .then((mermaid) => mermaid.render(id, code))
      .then(({ svg }) => { if (!cancelled) { setSvg(svg); setErr(''); } })
      .catch((e) => { if (!cancelled) setErr(e?.message || '图表渲染失败'); });
    return () => { cancelled = true; };
  }, [code, id]);

  if (err) {
    // 问题2:mermaid 在父页渲染(非 iframe),ERROR_COLLECTOR 覆盖不到;把 catch 到的渲染错误
    // 规整成与 iframe 同形状,复用 PreviewErrorBadge 一键发 AI。inline amber 框保留作上下文。
    const badgeErrors = [normalizePreviewErr({ type: 'error', msg: 'Mermaid: ' + err })].filter(Boolean);
    return (
      <div className="relative">
        <div className="flex items-start gap-2 p-4 text-[12px] text-amber-400/90 bg-[#1a1714]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="font-mono break-all">Mermaid: {err}</span>
        </div>
        <PreviewErrorBadge errors={badgeErrors} />
      </div>
    );
  }
  if (!svg) return <div className="p-4 text-[12px] text-[#9a8e78] bg-[#1a1714]">渲染中…</div>;
  return (
    <div
      className="mermaid-host flex justify-center p-4 bg-[#1a1714] overflow-auto max-h-[520px] [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// 长代码折叠:首 N 行 + "展开剩余/收起"(与 MarkdownRenderer 的 CodeBlock 同一套逻辑,
// 抽此共用组件避免两处漂移)。className 传 <pre> 的完整样式(含深色底/边框);末行圆角由
// collapsible 决定:可折叠时底部平接 toggle 按钮,不可折叠时收 rounded-b-lg。
export function CollapsibleCode({ code, className = '', collapseAt = 5 }) {
  const lines = code.split('\n');
  const collapsible = lines.length > collapseAt;
  const [expanded, setExpanded] = useState(false);
  const shown = collapsible && !expanded ? lines.slice(0, collapseAt).join('\n') : code;
  return (
    <>
      <pre className={`${className} ${collapsible ? '' : 'rounded-b-lg'}`}>
        <code>{shown}</code>
      </pre>
      {collapsible && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full text-[11px] font-mono text-[#9a8e78] hover:text-[#cabba0] bg-[#2b2722] border border-[#3a342b] border-t-0 rounded-b-lg py-1 transition-colors"
        >
          {expanded ? '收起' : `展开剩余 ${lines.length - collapseAt} 行 ▾`}
        </button>
      )}
    </>
  );
}

// F2 preview 开发者模式:承载沙箱 iframe + 采集其运行时报错 + 有错时右下角徽章/弹层。
// 采集脚本由 withShim() 注入进 srcDoc,经 postMessage 穿透 sandbox。父页只收自己 iframe
// (event.source 比对)的消息。srcDoc/iframeKey 变(流式新内容或手动刷新)即清空 buffer 重计
// —— 规避流式半截 HTML 产生的伪错误(只有渲染稳定态的报错会留存)。
export function PreviewIframe({ srcDoc, fullscreen, iframeKey }) {
  const frameRef = useRef(null);
  const [errors, setErrors] = useState([]);
  const sigs = useRef(new Set());

  // 内容变更/刷新 → 清空,规避流式半截 HTML 的伪错误累积。
  useEffect(() => { setErrors([]); sigs.current = new Set(); }, [srcDoc, iframeKey]);

  useEffect(() => {
    const onMsg = (e) => {
      // sandbox opaque origin 下无法比对 origin,只能确认消息来自本 iframe 的 window。
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const rec = e.data && e.data[PREVIEW_ERR_KEY];
      if (!rec) return;
      const n = normalizePreviewErr(rec);
      if (!n || sigs.current.has(n.sig)) return;
      if (sigs.current.size >= MAX_PREVIEW_ERRORS) return;
      sigs.current.add(n.sig);
      setErrors((prev) => (prev.length >= MAX_PREVIEW_ERRORS ? prev : [...prev, n]));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  return (
    <div className={`relative w-full ${fullscreen ? 'h-full' : 'h-[400px]'}`}>
      <iframe
        ref={frameRef}
        // iframeKey 自增 → 重新挂载 iframe 实现 dock 的"刷新"。
        key={iframeKey}
        title="预览"
        sandbox={SANDBOX_FLAGS}
        srcDoc={srcDoc}
        className="w-full h-full bg-white border-0 block"
      />
      <PreviewErrorBadge errors={errors} />
    </div>
  );
}

// 渲染预览主体(代码/mermaid/html-iframe)。fullscreen 时 iframe 撑满高度,内联时固定 400px。
export function PreviewBody({ language, mode, code, debounced, fullscreen, iframeKey }) {
  if (mode === 'code') {
    // 全屏有纵向空间,保持 h-full 滚动;内联(会话内)长代码折叠首 5 行,复用 CollapsibleCode。
    if (fullscreen) {
      return (
        <pre className="cgui-dark-select bg-[#211e19] p-4 overflow-auto text-[13px] leading-relaxed font-mono text-[#e8e2d6] h-full">
          <code>{code}</code>
        </pre>
      );
    }
    return (
      <CollapsibleCode
        code={code}
        className="cgui-dark-select bg-[#211e19] p-4 overflow-x-auto text-[13px] leading-relaxed font-mono text-[#e8e2d6]"
      />
    );
  }
  if (language === 'mermaid') return <MermaidView code={debounced} />;
  return <PreviewIframe srcDoc={withShim(debounced)} fullscreen={fullscreen} iframeKey={iframeKey} />;
}

export function ArtifactPreview({ lang, code, coexist = false, dockKey }) {
  const language = normLang(lang);
  // #3 稳定身份:标识"这个内联块"是否正被停靠(dock 单例带回同一 artifactId)。
  // 优先用调用链透传的 dockKey(消息/turn 稳定前缀 + 代码块偏移):流式全程不变、组件重挂载
  // 也不变 → 消除"重挂 useId 变→断链回弹→dock 冻结"。dockKey 缺失(coexist/文件预览等非流式
  // 路径)时回退 useId,那些路径不流式,不受此 bug 影响。useId 恒调用(不违反 hooks 规则)。
  const autoId = useId();
  const artifactId = dockKey || autoId;
  // 问题1:mode 惰性初始化从 modePersist 恢复(按 artifactId),setMode 写回 → 重挂不丢用户选的档。
  const [mode, setModeState] = useState(() => modePersist.get(artifactId));
  const setMode = (m) => { modePersist.set(artifactId, m); setModeState(m); };
  const [fullscreen, setFullscreen] = useState(false);
  const debounced = useDebounced(code, 300);
  const isDocked = useStore((s) => s.artifactDock?.artifactId === artifactId);
  const foldInline = isDocked && !coexist; // 会话内代码块停靠才折叠;文件浏览器停靠(coexist)不折叠

  // BH-1b: 桌面端点"停靠"开右侧 dock(全局单 dock);移动端无横向空间走全屏遮罩。
  // CK-5: coexist=true(从文件浏览器停靠)时,dock 作为独立最右列与文件浏览器并存,
  // 不替换右栏 —— 让用户一边看文件树一边大图预览 html/svg。
  const openDock = () => {
    const st = useStore.getState();
    st.openArtifactDock({ lang: language, code, tabIndex: st.activeTabIndex, coexist, artifactId });
  };

  // #3 流式回写:被停靠时,内联块每拿到新 code 就同步进 dock,右侧面板随流式实时刷新
  // (不再冻结在点击瞬间快照)。updateArtifactDockCode 内 id 匹配 + code 变化双闸短路。
  useEffect(() => {
    if (isDocked) useStore.getState().updateArtifactDockCode(artifactId, code);
  }, [code, isDocked, artifactId]);

  // #3 停靠瞬间默认折成代码(内容已在右侧 dock),但只在 false→true 转换那一刻设一次:
  // 若每次 render 都强设 code,用户点"预览"会立刻被打回代码,toggle 失效。
  const wasFoldRef = useRef(false);
  useEffect(() => {
    if (foldInline && !wasFoldRef.current) setMode('code');
    wasFoldRef.current = foldInline;
  }, [foldInline]);

  // 全屏时按 Esc 关闭 + 锁 body 滚动。capture 阶段监听(对齐 ImageLightbox),先于冒泡的上层 Esc。
  // 注意:沙箱 iframe(无 allow-same-origin)会吞掉焦点在内时的 Esc,故真正的兜底是全屏浮层里
  // 视口锚定的关闭按钮,Esc 只锦上添花。
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey, true); document.body.style.overflow = prev; };
  }, [fullscreen]);

  const tabBtn = (active) =>
    `flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${
      active ? 'bg-[#3a342b] text-[#e8e2d6]' : 'text-[#9a8e78] hover:text-[#cabba0]'
    }`;

  const toolbar = (inModal) => (
    <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#2b2722] border-b border-[#3a342b] shrink-0">
      <span className="text-[11px] font-mono text-[#9a8e78]">{language}</span>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-md bg-[#211e19] border border-[#3a342b] p-0.5">
          <button onClick={() => setMode('preview')} className={tabBtn(mode === 'preview')}>
            <Eye size={10} /> 预览
          </button>
          <button onClick={() => setMode('code')} className={tabBtn(mode === 'code')}>
            <Code2 size={10} /> 代码
          </button>
        </div>
        <CopyButton text={code} />
        {inModal ? (
          <button
            onClick={() => setFullscreen(false)}
            title="退出全屏 (Esc)"
            className="flex items-center gap-1 text-[10px] text-[#9a8e78] hover:text-[#cabba0] transition-colors"
          >
            <X size={12} /> 关闭
          </button>
        ) : isMobileViewport() ? (
          <button
            onClick={() => setFullscreen(true)}
            title="全屏预览"
            className="flex items-center gap-1 text-[10px] text-[#9a8e78] hover:text-[#cabba0] transition-colors"
          >
            <Maximize2 size={11} /> 全屏
          </button>
        ) : (
          <button
            onClick={openDock}
            title="停靠到右侧"
            className="flex items-center gap-1 text-[10px] text-[#9a8e78] hover:text-[#cabba0] transition-colors"
          >
            <PanelRight size={11} /> 停靠
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="my-3 rounded-lg border border-[#3a342b] overflow-hidden">
        {toolbar(false)}
        {foldInline && mode === 'code' ? (
          // #3 已停靠且当前为代码档:主体折叠成紧凑代码块 + 提示(实时内容看右侧 dock);toolbar 三按钮保留。
          // 点"预览"(mode='preview')则落到 else 分支的 PreviewBody,内联显示预览 → toggle 生效。
          <div>
            <pre className="cgui-dark-select bg-[#211e19] px-4 py-2 overflow-hidden text-[12px] leading-snug font-mono text-[#9a8e78] max-h-24">
              <code>{code}</code>
            </pre>
            <div className="px-3.5 py-1 bg-[#2b2722] text-[10px] font-mono text-[#9a8e78] flex items-center gap-1.5 border-t border-[#3a342b]">
              <PanelRight size={10} className="shrink-0" /> 已停靠到右侧,内容随生成实时更新
            </div>
          </div>
        ) : (
          <PreviewBody language={language} mode={mode} code={code} debounced={debounced} fullscreen={false} />
        )}
      </div>

      {fullscreen && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setFullscreen(false)}
        >
          {/* 视口锚定关闭键:锚在背景层(非卡片内),任何缩放/尺寸算错都留在视口右上角。
              WebView2 下 vw/vh 不随 --ui-zoom 折算,裸 92vh 会把卡片顶栏(含关闭键)顶出屏幕 → 此为真兜底。 */}
          <button
            onClick={(e) => { e.stopPropagation(); setFullscreen(false); }}
            title="退出全屏 (Esc)"
            className="absolute top-4 right-4 z-[210] w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
          >
            <X size={16} />
          </button>
          <div
            className="flex flex-col w-[92%] h-[92%] rounded-lg border border-[#3a342b] overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {toolbar(true)}
            <div className="flex-1 min-h-0 bg-[#1a1714]">
              <PreviewBody language={language} mode={mode} code={code} debounced={debounced} fullscreen={true} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// BH-1b: ChatWise 式右侧停靠面板。读 store 的 artifactDock,占右栏(优先于 RightPanel)。
// 自身宽度可拖拽,左缘放 Splitter。复用 PreviewBody/withShim/沙箱逻辑。
export function ArtifactDock() {
  const artifactDock = useStore((s) => s.artifactDock);
  const closeArtifactDock = useStore((s) => s.closeArtifactDock);
  const [mode, setMode] = useState('preview');
  const [fullscreen, setFullscreen] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [width, onDrag] = useResizable({
    initial: 480, min: 360, max: 900, axis: 'x', invert: true, storageKey: 'cgui-artifact-dock-width',
  });
  const code = artifactDock?.code || '';
  const language = normLang(artifactDock?.lang);
  const debounced = useDebounced(code, 300);

  // 全屏时按 Esc 关闭 + 锁 body 滚动(与 ArtifactPreview 全屏一致,capture 阶段)。
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey, true); document.body.style.overflow = prev; };
  }, [fullscreen]);

  if (!artifactDock) return null;

  const tabBtn = (active) =>
    `flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${
      active ? 'bg-[#3a342b] text-[#e8e2d6]' : 'text-[#9a8e78] hover:text-[#cabba0]'
    }`;

  const toolbar = (inModal) => (
    <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#2b2722] border-b border-[#3a342b] shrink-0">
      <span className="text-[11px] font-mono text-[#9a8e78]">{language}</span>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-md bg-[#211e19] border border-[#3a342b] p-0.5">
          <button onClick={() => setMode('preview')} className={tabBtn(mode === 'preview')}>
            <Eye size={10} /> 预览
          </button>
          <button onClick={() => setMode('code')} className={tabBtn(mode === 'code')}>
            <Code2 size={10} /> 代码
          </button>
        </div>
        <CopyButton text={code} />
        <button
          onClick={() => setIframeKey((k) => k + 1)}
          title="刷新预览"
          className="flex items-center gap-1 text-[10px] text-[#9a8e78] hover:text-[#cabba0] transition-colors"
        >
          <RefreshCw size={11} /> 刷新
        </button>
        <button
          onClick={() => setFullscreen(!inModal)}
          title={inModal ? '退出全屏 (Esc)' : '全屏预览'}
          className="flex items-center gap-1 text-[10px] text-[#9a8e78] hover:text-[#cabba0] transition-colors"
        >
          {inModal ? <X size={12} /> : <Maximize2 size={11} />}
          {inModal ? '退出' : '全屏'}
        </button>
        {!inModal && (
          <button
            onClick={closeArtifactDock}
            title="关闭停靠面板"
            className="flex items-center gap-1 text-[10px] text-[#9a8e78] hover:text-[#cabba0] transition-colors"
          >
            <X size={12} /> 关闭
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <Splitter onMouseDown={onDrag} axis="x" />
      <div
        style={{ width }}
        className="shrink-0 flex flex-col m-3 ml-0 rounded-2xl overflow-hidden border border-[#3a342b] bg-[#1a1714] animate-glass-rise"
      >
        {toolbar(false)}
        <div className="flex-1 min-h-0 bg-[#1a1714]">
          <PreviewBody language={language} mode={mode} code={code} debounced={debounced} fullscreen iframeKey={iframeKey} />
        </div>
      </div>

      {fullscreen && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setFullscreen(false)}
        >
          {/* 视口锚定关闭键:锚在背景层(非卡片内),WebView2 缩放算错时仍在视口右上角可点(见 ArtifactPreview 同注)。 */}
          <button
            onClick={(e) => { e.stopPropagation(); setFullscreen(false); }}
            title="退出全屏 (Esc)"
            className="absolute top-4 right-4 z-[210] w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
          >
            <X size={16} />
          </button>
          <div
            className="flex flex-col w-[92%] h-[92%] rounded-lg border border-[#3a342b] overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {toolbar(true)}
            <div className="flex-1 min-h-0 bg-[#1a1714]">
              <PreviewBody language={language} mode={mode} code={code} debounced={debounced} fullscreen iframeKey={iframeKey} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
