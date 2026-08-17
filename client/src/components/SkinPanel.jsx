// r11-③:皮肤 UI —— 主题弹层「皮肤」段(入口落位再修订版:选择器+管理入口都在
// 弹层内,导入/生成器弹独立对话框)。gallery 网格(试穿/应用/删除 confirmDialog)、
// zip + 三件套粘贴 + dsh JSON 三条导入通道、AI 提示词生成器、「开发者皮肤(本机)」
// 总开关(默认关,首次启用 confirmDialog 明示权限;永无分享/市场入口)。
// 模态红线:flex 列三段(禁 sticky footer)、confirmDialog(Tauri 禁原生 confirm)。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Palette, Copy, Trash2, X, Sparkles, Check } from './Icon.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { copyText } from '../utils/clipboard.js';
import {
  BUILTIN_SKINS, activateSkin, deactivateSkin, getSkinState, subscribeSkin, getSkinVersion,
  devSkinsEnabled, setDevSkinsEnabled, SKIN_TOKENS_CLIENT, SKIN_TOKENS_REJECTED_CLIENT,
} from '../utils/skins.js';
import { ICON_SEMANTICS } from '../utils/iconOverrides.js';
import { SKIN_ANCHORS } from '../utils/skinAnchors.js';
import { buildSkinPrompt } from '../utils/skinPrompt.js';


const inputCls = 'w-full bg-canvas-warm border border-canvas-deep rounded-md px-2.5 py-1.5 text-[12px] text-ink font-body focus:outline-none focus:border-accent/50';
const taCls = `${inputCls} font-mono text-[11px] resize-y min-h-[72px]`;

// 首次启用开发者皮肤的确认(总开关默认关;公开版同门槛同警示)。
async function ensureDevSkins() {
  if (devSkinsEnabled()) return true;
  const ok = await confirmDialog(
    '启用「开发者皮肤(本机)」:皮肤代码(skin.css / client.js)拥有页面全部权限,可读取界面上的一切内容。只导入你自己编写或完全信任的代码。仅本机生效。',
    { danger: true, confirmText: '我明白,启用' },
  );
  if (ok) setDevSkinsEnabled(true);
  return ok;
}

function SkinCard({ row, active, onChanged }) {
  const isBuiltin = row.source === 'builtin';
  const apply = async (tryOn) => {
    if (row.manifest?.tier === 2 && !(await ensureDevSkins())) return;
    await activateSkin(row, { tryOn });
    onChanged?.();
  };
  const remove = async () => {
    const ok = await confirmDialog(`删除皮肤「${row.name}」？文件将从本机皮肤库移除。`, { danger: true, confirmText: '删除' });
    if (!ok) return;
    try { await fetch(`/api/skins/${row.id}`, { method: 'DELETE' }); } catch {}
    if (getSkinState().id === row.id) deactivateSkin();
    onChanged?.(true);
  };
  return (
    <div className={`rounded-panel border p-2 flex flex-col gap-1.5 ${active ? 'border-accent/60 bg-accent-subtle/40' : 'border-canvas-deep bg-canvas-warm/50'}`}>
      <div className="flex items-center gap-1.5 min-w-0">
        {row.preview
          ? <img src={row.preview} alt="" className="w-7 h-7 rounded object-cover shrink-0" />
          : <span className="w-7 h-7 rounded shrink-0 border border-canvas-deep" style={{ background: swatchOf(row) }} />}
        <span className="text-[11.5px] text-ink font-body truncate flex-1" title={row.name}>{row.name}</span>
        {active && <Check size={12} className="text-accent shrink-0" />}
      </div>
      <div className="flex items-center gap-1 text-[10.5px] font-body">
        <span className="text-ink-faint mr-auto">{row.manifest?.tier === 2 ? 'T2 代码' : 'T1 声明'}{isBuiltin ? ' · 示例' : ''}</span>
        <button type="button" onClick={() => apply(true)} className="px-1.5 py-0.5 rounded hover:bg-canvas-deep/60 text-ink-soft" title="试穿(不保存,刷新即回)">试穿</button>
        <button type="button" onClick={() => apply(false)} className="px-1.5 py-0.5 rounded hover:bg-canvas-deep/60 text-accent" title="应用并记住">应用</button>
        {!isBuiltin && (
          <button type="button" onClick={remove} className="p-0.5 rounded hover:bg-canvas-deep/60" title="删除">
            <Trash2 size={11} className="text-ink-faint" />
          </button>
        )}
      </div>
    </div>
  );
}
// 无预览图时的色板:取 manifest 强调/画布色拼渐变。
function swatchOf(row) {
  const m = row.manifest || {};
  const a = m.light?.vars?.['--color-accent'] || m.dark?.vars?.['--color-accent'] || m.shared?.vars?.['--color-accent'] || 'var(--color-accent)';
  const c = m.light?.vars?.['--color-canvas'] || m.dark?.vars?.['--color-canvas'] || 'var(--color-canvas-warm)';
  return `linear-gradient(135deg, ${c} 55%, ${a} 55%)`;
}

// ── 导入/生成器对话框(独立 portal 模态;flex 列三段,禁 sticky) ──
// p2-2:portal 落 document.body(在主题弹层 wrapRef 之外)→ 根节点带
// data-cgui-skin-dialog 标记,弹层的外点/Esc 判定据此让位;对话框自管 Esc
// (capture+stopPropagation,不惊动会话级 Esc 监听)。全部按钮 type="button"
// (防将来被嵌进 form 时隐式 submit,同 ChatInput 既有口径)。
function SkinManagerDialog({ onClose, onChanged }) {
  const fileRef = useRef(null);
  useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [onClose]);
  const [tab, setTab] = useState('trio'); // trio | dsw | prompt
  const [name, setName] = useState('');
  const [css, setCss] = useState('');
  const [js, setJs] = useState('');
  const [a11y, setA11y] = useState('');
  const [dsw, setDsw] = useState('');
  const [notice, setNotice] = useState(null); // {ok, text}
  const [busy, setBusy] = useState(false);

  const report = (d, fallback) => {
    const warn = (d.warnings || []).map((w) => w.message).join('；');
    setNotice({ ok: !d.error, text: d.error ? (d.message || fallback) : `已导入「${d.name}」${warn ? `。提示:${warn}` : ''}` });
  };
  const importZip = async (file) => {
    if (!file) return;
    setBusy(true); setNotice(null);
    try {
      const r = await fetch('/api/skins/import', {
        method: 'POST',
        headers: { 'x-upload-name': encodeURIComponent(file.name) },
        body: file,
      });
      const d = await r.json();
      report(d, '导入失败');
      if (r.ok) onChanged?.();
    } catch (e) { setNotice({ ok: false, text: `导入失败:${e.message}` }); }
    setBusy(false);
  };
  const tryOnTrio = async () => {
    if (!(await ensureDevSkins())) return;
    const texts = { 'skin.css': css, 'client.js': js, 'a11y.css': a11y };
    const manifest = { format: 'cgui-skin/1', name: name.trim() || '粘贴试穿', tier: 2 };
    for (const [f, t] of Object.entries(texts)) { if (t.trim()) manifest[f.replace('.', '_')] = f; }
    const { t2 } = await activateSkin({ id: 'builtin-tryon', manifest, t2Texts: texts }, { tryOn: true }) || {};
    // p2-1:装载结果不再静默吞——脚本被静态校验拒载时如实报出(样式部分已生效)。
    if (t2 && !t2.loaded && t2.reason === 'script_rejected') {
      setNotice({ ok: false, text: `client.js 含被禁止的调用,未载入:${(t2.hits || []).join('、')}(样式部分已试穿)` });
      return;
    }
    setNotice({ ok: true, text: '已试穿(未保存;刷新或点停用即回)。满意后点「保存为皮肤」。' });
  };
  const saveInline = async (kind) => {
    setBusy(true); setNotice(null);
    try {
      const body = kind === 'trio' ? { kind, name, css, js, a11y } : { kind, name, dswJson: dsw };
      const r = await fetch('/api/skins/import-inline', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      report(d, '保存失败');
      if (r.ok) onChanged?.();
    } catch (e) { setNotice({ ok: false, text: `保存失败:${e.message}` }); }
    setBusy(false);
  };
  const copyPrompt = async () => {
    await copyText(buildSkinPrompt());
    setNotice({ ok: true, text: '提示词已复制。粘贴给任意 AI,产出 skin.json/三件套后回来导入。' });
  };

  return createPortal(
    <div data-cgui-skin-dialog className="fixed inset-0 z-[220] flex items-center justify-center bg-black/40 backdrop-blur-soft animate-fade-in" onClick={onClose}>
      <div
        className="glass-popover rounded-panel w-[560px] max-w-[calc(var(--app-w,100vw)-2rem)] max-h-[calc(var(--app-h,100dvh)-6rem)] flex flex-col animate-glass-rise"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头(shrink-0) */}
        <div className="shrink-0 px-4 py-3 border-b border-canvas-deep/60 flex items-center gap-2">
          <Palette size={14} className="text-accent" />
          <span className="text-[13px] font-medium text-ink font-body flex-1">导入皮肤 / 生成器</span>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-canvas-deep/60"><X size={13} className="text-ink-faint" /></button>
        </div>
        {/* 正文(flex-1 滚动) */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          <div className="flex items-center gap-1 p-0.5 rounded-panel bg-canvas-warm text-[11px] font-body">
            {[['trio', '三件套粘贴(T2)'], ['dsw', 'dsh 主题 JSON'], ['prompt', 'AI 提示词生成器']].map(([id, label]) => (
              <button type="button" key={id} onClick={() => { setTab(id); setNotice(null); }}
                className={`flex-1 py-1.5 rounded-md transition-colors ${tab === id ? 'bg-accent text-on-accent' : 'text-ink-muted hover:text-ink'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
              className="btn-accent px-3 py-1.5 text-[12px] font-body disabled:opacity-40">导入 zip / .cguiskin…</button>
            <input ref={fileRef} type="file" accept=".zip,.cguiskin" className="hidden"
              onChange={(e) => { importZip(e.target.files?.[0]); e.target.value = ''; }} />
            <span className="text-[10.5px] text-ink-faint font-body">T1/T2 皮肤包(≤30MB)。导入素材版权由使用者自行负责,仅限个人使用。</span>
          </div>
          {tab !== 'prompt' && (
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
              placeholder="皮肤名称(保存必填,≤40 字)" className={inputCls} />
          )}
          {tab === 'trio' && (
            <>
              <div className="text-[10.5px] text-ink-faint font-body">
                开发者皮肤三件套。样式请只用 [data-cgui=…] 锚点选择器;client.js 禁网络/eval 类调用(静态校验),须注册 window.__cguiSkinDispose 卸载器。
              </div>
              <textarea value={css} onChange={(e) => setCss(e.target.value)} placeholder="skin.css" className={taCls} />
              <textarea value={js} onChange={(e) => setJs(e.target.value)} placeholder="client.js" className={taCls} />
              <textarea value={a11y} onChange={(e) => setA11y(e.target.value)} placeholder="a11y.css(可选)" className={taCls} />
            </>
          )}
          {tab === 'dsw' && (
            <>
              <div className="text-[10.5px] text-ink-faint font-body">
                粘贴 dsh theme-gallery 导出的 JSON(--dsw-* 变量)。可确证的变量尽力映射为 cgui token,不可映射项在导入结果中列出。dsh skin-gallery 的 JS bundle 绑定 dsh 页面结构,不可直用——请按锚点清单改写为三件套。
              </div>
              <textarea value={dsw} onChange={(e) => setDsw(e.target.value)} placeholder='{"vars":{"--dsw-bg":"#101010", …}}' className={`${taCls} min-h-[140px]`} />
            </>
          )}
          {tab === 'prompt' && (
            <div className="text-[11px] text-ink-soft font-body leading-relaxed space-y-2">
              <p>一键组装完整提示词(变量白名单 {SKIN_TOKENS_CLIENT.length - SKIN_TOKENS_REJECTED_CLIENT.length} 项、图标语义名 {Object.keys(ICON_SEMANTICS).length} 项、锚点 {SKIN_ANCHORS.length} 项、skin.json schema、T1/T2 骨架、明暗规范与 {'{name}'} 说明),复制给任意 AI 直接产出皮肤。</p>
              <button type="button" onClick={copyPrompt} className="btn-accent px-3 py-1.5 text-[12px] font-body flex items-center gap-1.5">
                <Copy size={12} /> 复制完整提示词
              </button>
            </div>
          )}
          {notice && (
            <div className={`text-[11px] font-body px-2.5 py-1.5 rounded-md ${notice.ok ? 'bg-accent-subtle/50 text-ink-soft' : 'bg-error-subtle text-error'}`}>
              {notice.text}
            </div>
          )}
        </div>
        {/* 底操作条(shrink-0,flex 列第三段) */}
        {tab !== 'prompt' && (
          <div className="shrink-0 px-4 py-2.5 border-t border-canvas-deep/60 flex items-center gap-2">
            {tab === 'trio' && (
              <button type="button" onClick={tryOnTrio} disabled={busy || (!css.trim() && !js.trim() && !a11y.trim())}
                className="px-3 py-1.5 text-[12px] font-body rounded-md border border-canvas-deep hover:bg-canvas-warm text-ink-soft disabled:opacity-40">
                试穿(不落盘)
              </button>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => saveInline(tab)}
              disabled={busy || !name.trim() || (tab === 'trio' ? (!css.trim() && !js.trim() && !a11y.trim()) : !dsw.trim())}
              className="btn-accent px-3.5 py-1.5 text-[12px] font-body disabled:opacity-40">
              保存为皮肤
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── 主题弹层「皮肤」段 ─────────────────────────────────────────
export function SkinSection() {
  useSyncExternalStore(subscribeSkin, getSkinVersion, getSkinVersion);
  const [installed, setInstalled] = useState([]);
  const [managerOpen, setManagerOpen] = useState(false);
  const [devOn, setDevOn] = useState(devSkinsEnabled());
  const activeId = getSkinState().id;

  const refresh = async () => {
    try {
      const r = await fetch('/api/skins');
      const d = await r.json();
      setInstalled(Array.isArray(d.skins) ? d.skins : []);
    } catch { setInstalled([]); }
  };
  useEffect(() => { refresh(); }, []);

  const toggleDev = async () => {
    if (!devOn) { if (!(await ensureDevSkins())) return; }
    else setDevSkinsEnabled(false);
    setDevOn(devSkinsEnabled());
  };

  const rows = [...installed, ...BUILTIN_SKINS];
  return (
    <div className="space-y-1.5" data-cgui-skin-section>
      <div className="flex items-center gap-2">
        <Sparkles size={12} className="text-ink-muted" />
        <span className="text-[11px] text-ink font-body font-medium flex-1">皮肤</span>
        {activeId && (
          <button type="button" onClick={() => deactivateSkin()} className="text-[10.5px] text-ink-faint hover:text-ink font-body">停用</button>
        )}
        <button type="button" onClick={() => setManagerOpen(true)} className="text-[10.5px] text-accent font-body">导入 / 生成器…</button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {rows.map((row) => (
          <SkinCard key={row.id} row={row} active={activeId === row.id}
            onChanged={(removed) => { if (removed) refresh(); }} />
        ))}
      </div>
      <label className="flex items-center gap-2 pt-0.5 cursor-pointer select-none">
        <input type="checkbox" checked={devOn} onChange={toggleDev} className="accent-[var(--color-accent)]" />
        <span className="text-[10.5px] text-ink-faint font-body">开发者皮肤(本机)——允许 T2 代码皮肤执行。皮肤代码拥有页面全部权限,只导入自己写的。</span>
      </label>
      {managerOpen && <SkinManagerDialog onClose={() => setManagerOpen(false)} onChanged={refresh} />}
    </div>
  );
}
