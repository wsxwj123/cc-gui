import React, { useState, useEffect, useId } from 'react';
import { Copy, Check, Code2, Eye, AlertTriangle } from 'lucide-react';
import { copyText } from '../utils/clipboard.js';

// 可内联预览的围栏代码语言。html/svg 走沙箱 iframe(原始内容、可能含脚本,必须隔离);
// mermaid 走库渲染成已净化的 svg。其余语言仍走普通代码块。
const PREVIEWABLE = new Set(['html', 'svg', 'mermaid']);

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

function CopyButton({ text }) {
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

function MermaidView({ code }) {
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

export function ArtifactPreview({ lang, code }) {
  const language = normLang(lang);
  const [mode, setMode] = useState('preview');
  const debounced = useDebounced(code, 300);

  const tabBtn = (active) =>
    `flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${
      active ? 'bg-[#3a342b] text-[#e8e2d6]' : 'text-[#9a8e78] hover:text-[#cabba0]'
    }`;

  return (
    <div className="my-3 rounded-lg border border-[#3a342b] overflow-hidden">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#2b2722] border-b border-[#3a342b]">
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
        </div>
      </div>

      {mode === 'code' ? (
        <pre className="bg-[#211e19] p-4 overflow-auto max-h-96 text-[13px] leading-relaxed font-mono text-[#e8e2d6]">
          <code>{code}</code>
        </pre>
      ) : language === 'mermaid' ? (
        <MermaidView code={debounced} />
      ) : (
        // sandbox 不含 allow-same-origin → iframe 脚本拿不到父页 DOM/cookie/
        // localStorage,AI 生成的 HTML 即使含恶意脚本也跨域隔离在沙箱内。
        <iframe
          title="预览"
          sandbox="allow-scripts"
          srcDoc={debounced}
          className="w-full h-[400px] bg-white border-0 block"
        />
      )}
    </div>
  );
}
