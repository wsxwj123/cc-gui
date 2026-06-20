import React, { useState, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check, Code2, Eye, AlertTriangle, Maximize2, X, PanelRight, RefreshCw } from 'lucide-react';
import { copyText } from '../utils/clipboard.js';
import { useStore } from '../stores/sessionStore.js';
import { useResizable, Splitter } from '../hooks/useResizable.jsx';

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

// 在 HTML 头部注入 storage 垫片。srcDoc 为空(流式中)时不注入。
function withShim(code) {
  if (!code || !code.trim()) return code;
  return STORAGE_SHIM + code;
}

function normLang(lang) {
  return String(lang || '').trim().split(/\s+/)[0].toLowerCase();
}

export function isPreviewable(lang) {
  return PREVIEWABLE.has(normLang(lang));
}

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
    return (
      <div className="flex items-start gap-2 p-4 text-[12px] text-amber-400/90 bg-[#1a1714]">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <span className="font-mono break-all">Mermaid: {err}</span>
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

// 渲染预览主体(代码/mermaid/html-iframe)。fullscreen 时 iframe 撑满高度,内联时固定 400px。
export function PreviewBody({ language, mode, code, debounced, fullscreen, iframeKey }) {
  if (mode === 'code') {
    return (
      <pre className={`bg-[#211e19] p-4 overflow-auto text-[13px] leading-relaxed font-mono text-[#e8e2d6] ${fullscreen ? 'h-full' : 'max-h-96'}`}>
        <code>{code}</code>
      </pre>
    );
  }
  if (language === 'mermaid') return <MermaidView code={debounced} />;
  return (
    <iframe
      // iframeKey 自增 → 重新挂载 iframe 实现 dock 的"刷新"。
      key={iframeKey}
      title="预览"
      sandbox={SANDBOX_FLAGS}
      srcDoc={withShim(debounced)}
      className={`w-full bg-white border-0 block ${fullscreen ? 'h-full' : 'h-[400px]'}`}
    />
  );
}

export function ArtifactPreview({ lang, code }) {
  const language = normLang(lang);
  const [mode, setMode] = useState('preview');
  const [fullscreen, setFullscreen] = useState(false);
  const debounced = useDebounced(code, 300);

  // BH-1b: 桌面端点"停靠"开右侧 dock(全局单 dock);移动端无横向空间走全屏遮罩。
  const openDock = () => {
    const st = useStore.getState();
    st.openArtifactDock({ lang: language, code, tabIndex: st.activeTabIndex });
  };

  // 全屏时按 Esc 关闭 + 锁 body 滚动。
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
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
        <PreviewBody language={language} mode={mode} code={code} debounced={debounced} fullscreen={false} />
      </div>

      {fullscreen && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setFullscreen(false)}
        >
          <div
            className="flex flex-col w-[92vw] h-[92vh] rounded-lg border border-[#3a342b] overflow-hidden shadow-2xl"
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

  // 全屏时按 Esc 关闭 + 锁 body 滚动(与 ArtifactPreview 全屏一致)。
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
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
          <div
            className="flex flex-col w-[92vw] h-[92vh] rounded-lg border border-[#3a342b] overflow-hidden shadow-2xl"
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
