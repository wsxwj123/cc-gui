// r16-3 生图面板:自定义生图 provider(与文本 provider 完全分开,配置落
// ~/.claude-gui/image-providers.json,不碰 ~/.claude/settings.json)。
// 上半是出图(选 provider → 填提示词 → 生成 → 预览/落盘),下半是「管理」态的
// provider 表单。保存路径是配置的一部分且必填:Tauri 下走原生文件夹选择器,
// 浏览器访问时退化成手输绝对路径。
// 模态红线:删除走 confirmDialog(Tauri 禁原生 confirm)。
import { useCallback, useEffect, useState } from 'react';
import { Image, Plus, Trash2, Pencil, FolderOpen, Loader2, Sparkles, ExternalLink, X, Check, RefreshCw } from './Icon.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { pickDirectory, isTauri } from '../utils/pickDirectory.js';

const inputCls = 'w-full bg-canvas-warm border border-canvas-deep rounded-md px-2.5 py-1.5 text-[12px] text-ink font-body focus:outline-none focus:border-accent/50';
const labelCls = 'text-[10.5px] text-ink-faint font-body';

const PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 系（/images/generations）' },
  { id: 'gemini', label: 'Gemini 系（:generateContent）' },
  { id: 'chat', label: '对话接口出图（/chat/completions）' },
];

const EMPTY_FORM = { id: '', name: '', protocol: 'openai', baseURL: '', apiKey: '', model: '', size: '', savePath: '', extra: '' };

// 尺寸候选:三类形态并存(显式宽x高 / K 档 / 纯比例 token),各服务认哪些值以其文档为准。
// datalist 按已输入前缀过滤,候选多不妨碍手输。
const SIZE_OPTIONS = [
  'auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792',
  '1920x1080', '2048x1152', '2048x2048', '2560x1440', '3840x2160', '2160x3840', '4096x4096',
  '1K', '2K', '4K', '1:1', '16:9', '9:16', '4:3', '3:4', '21:9',
];

// 拉取失败的三类可行动文案(与服务端 type 一一对应)。
const FETCH_HINTS = {
  auth: '鉴权失败：密钥无效或该接口不接受此密钥，请检查密钥后重试。',
  network: '网络不通：请求未能到达该地址，请检查接口地址、本机网络与代理设置。',
  unsupported: '该服务未提供模型列表接口，请在「模型」框手动填写模型名。',
};

function ProviderForm({ initial, onDone, onCancel }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [models, setModels] = useState([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsMsg, setModelsMsg] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // 拉模型:编辑态只传 id(服务端强制用存储的 baseURL 与密钥,请求体里的 baseURL 被忽略);
  // 新建态传表单里的地址与密钥。密钥留空也发 —— 部分中转站的模型列表接口不鉴权。
  const loadModels = async () => {
    setFetchingModels(true);
    setModelsMsg('');
    try {
      const body = form.id ? { id: form.id, protocol: form.protocol }
        : { baseURL: form.baseURL.trim(), protocol: form.protocol };
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
      const r = await fetch('/api/image-providers/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setModels([]);
        setModelsMsg(`${FETCH_HINTS[d.type] || `拉取失败（HTTP ${r.status}）。`}${d.message ? `\n${d.message}` : ''}`);
        return;
      }
      const list = d.models || [];
      setModels(list);
      setModelsMsg(list.length
        ? `拉到 ${list.length} 个模型，点击模型框从候选列表中选择，也可继续手动输入。`
        : '该服务返回了空的模型列表，请在「模型」框手动填写模型名。');
    } catch (e) {
      setModels([]);
      setModelsMsg(`拉取失败：${e.message}`);
    } finally {
      setFetchingModels(false);
    }
  };

  const choosePath = async () => {
    setErr('');
    try {
      const { path } = await pickDirectory({ prompt: '选择生成图片的保存目录', startDir: form.savePath || undefined });
      if (path) setForm((f) => ({ ...f, savePath: path }));
    } catch {
      setErr('无法打开文件夹选择器，请直接在输入框里填写绝对路径');
    }
  };

  const save = async () => {
    setErr('');
    let extra = null;
    if (form.extra.trim()) {
      try { extra = JSON.parse(form.extra); }
      catch { setErr('附加参数必须是合法 JSON 对象'); return; }
    }
    setSaving(true);
    try {
      const body = {
        name: form.name, protocol: form.protocol, baseURL: form.baseURL, model: form.model,
        size: form.size, savePath: form.savePath, extra,
      };
      // apiKey 留空 = 保留服务端已存的 key(前端从不持有 key,不能被空字段抹掉)。
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
      const r = await fetch(form.id ? `/api/image-providers/${form.id}` : '/api/image-providers', {
        method: form.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `保存失败（${r.status}）`);
      onDone(d.id || form.id);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-panel border border-canvas-deep bg-canvas-warm/40 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-ink font-body flex-1">{form.id ? '编辑生图 provider' : '新增生图 provider'}</span>
        <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-canvas-deep/60"><X size={13} className="text-ink-faint" /></button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1"><span className={labelCls}>名称</span>
          <input className={inputCls} value={form.name} onChange={set('name')} placeholder="我的 gpt-image" />
        </label>
        <label className="space-y-1"><span className={labelCls}>协议</span>
          <select className={inputCls} value={form.protocol} onChange={set('protocol')}>
            {PROTOCOLS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
      </div>
      <label className="space-y-1 block"><span className={labelCls}>接口地址（baseURL，不含 /images/generations 等路径后缀）</span>
        <input className={inputCls} value={form.baseURL} onChange={set('baseURL')} placeholder="https://api.example.com/v1" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1"><span className={labelCls}>密钥{form.id ? '（留空保留原密钥）' : ''}</span>
          <input className={inputCls} type="password" value={form.apiKey} onChange={set('apiKey')} placeholder="sk-…" autoComplete="off" />
        </label>
        <div className="space-y-1"><span className={labelCls}>模型</span>
          <div className="flex gap-1.5">
            <input className={inputCls} list="cgui-image-model-options" value={form.model} onChange={set('model')} placeholder="gpt-image-2" />
            <datalist id="cgui-image-model-options">
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
            <button
              type="button"
              onClick={loadModels}
              disabled={fetchingModels || (!form.id && !form.baseURL.trim())}
              title={!form.id && !form.baseURL.trim() ? '先填写接口地址（baseURL）' : '按接口地址与密钥拉取可用模型'}
              className="shrink-0 px-2 rounded-md border border-canvas-deep text-[11.5px] text-ink-soft font-body hover:bg-canvas-deep/60 disabled:opacity-50 flex items-center gap-1"
            >
              {fetchingModels ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}拉取模型
            </button>
          </div>
        </div>
      </div>
      {modelsMsg && <div className="text-[10px] text-ink-faint font-body leading-snug whitespace-pre-wrap break-all">{modelsMsg}</div>}
      <label className="space-y-1 block"><span className={labelCls}>尺寸 / 分辨率</span>
        <input className={inputCls} list="cgui-image-size-options" value={form.size} onChange={set('size')} placeholder="1024x1024" />
        <datalist id="cgui-image-size-options">
          {SIZE_OPTIONS.map((s) => <option key={s} value={s} />)}
        </datalist>
        <span className="text-[10px] text-ink-faint font-body leading-snug block">
          {form.protocol === 'openai'
            ? '随请求发送；服务不支持所选尺寸时会报错。'
            : '该协议无原生尺寸字段，此值不发送；需在附加参数（extra）中按服务文档设置。'}
        </span>
      </label>
      <div className="space-y-1">
        <span className={labelCls}>保存路径（必填，出图后自动落盘到此目录）</span>
        <div className="flex gap-1.5">
          <input className={inputCls} value={form.savePath} onChange={set('savePath')} placeholder="/Users/you/Pictures/ai" />
          <button type="button" onClick={choosePath} className="shrink-0 px-2 rounded-md border border-canvas-deep text-[11.5px] text-ink-soft font-body hover:bg-canvas-deep/60 flex items-center gap-1">
            <FolderOpen size={12} />选择
          </button>
        </div>
        {!isTauri() && (
          <div className="text-[10px] text-ink-faint font-body leading-snug">
            浏览器访问时没有原生文件夹选择器：「选择」会在运行 GUI 的那台机器上弹出对话框，也可直接手动填写绝对路径。
          </div>
        )}
      </div>
      <label className="space-y-1 block"><span className={labelCls}>附加参数（可选，JSON 对象，原样并入请求体）</span>
        <textarea className={`${inputCls} font-mono text-[11px] resize-y min-h-[52px]`} value={form.extra} onChange={set('extra')} placeholder='{"quality": "high"}' />
      </label>
      {err && <div className="text-[11px] text-error font-body">{err}</div>}
      <div className="flex gap-2">
        <button type="button" disabled={saving} onClick={save} className="px-3 py-1.5 rounded-md bg-accent text-on-accent text-[12px] font-body disabled:opacity-50 flex items-center gap-1">
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}保存
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-md border border-canvas-deep text-[12px] text-ink-soft font-body">取消</button>
      </div>
    </div>
  );
}

export default function ImagePanel() {
  const [providers, setProviders] = useState([]);
  const [selId, setSelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [history, setHistory] = useState([]); // 本次会话内的出图记录(不落盘,刷新即清)
  const [current, setCurrent] = useState(null);
  const [form, setForm] = useState(null); // null = 不在表单态

  const load = useCallback(async (preferId) => {
    try {
      const r = await fetch('/api/image-providers');
      const d = await r.json();
      const list = d.providers || [];
      setProviders(list);
      setSelId((cur) => preferId || (list.some((p) => p.id === cur) ? cur : (list[0]?.id || '')));
    } catch { /* 面板打开时后端未就绪:留空列表,用户点刷新即可 */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const selected = providers.find((p) => p.id === selId) || null;
  const canGenerate = !!selected && !!selected.savePath && !!prompt.trim() && !busy;

  const generate = async () => {
    if (!canGenerate) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: selId, prompt }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `生成失败（${r.status}）`);
      const entry = { ...d, prompt, providerName: selected.name };
      setHistory((h) => [entry, ...h].slice(0, 24));
      setCurrent(entry);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p) => {
    const ok = await confirmDialog(`删除生图 provider「${p.name}」？只删配置，已生成的图片不动。`, { danger: true, confirmText: '删除' });
    if (!ok) return;
    await fetch(`/api/image-providers/${p.id}`, { method: 'DELETE' }).catch(() => {});
    load();
  };

  const [revealErr, setRevealErr] = useState('');

  // r26-J6:系统打开失败(非 2xx / 网络异常)要内联提示 —— 原先 catch 静默吞掉,
  // 用户点了「在访达中显示」毫无反应,分不清是没点上还是失败了。非阻断操作,
  // 不弹 confirmDialog,在按钮旁给固定文案。
  const reveal = async (file) => {
    setRevealErr('');
    try {
      const r = await fetch('/api/image/reveal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      setRevealErr('打开失败：无法在系统文件管理器中显示该文件');
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-4 space-y-4">
      {/* 出图区 */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <select
            className={`${inputCls} flex-1`}
            value={selId}
            onChange={(e) => setSelId(e.target.value)}
            disabled={!providers.length}
          >
            {!providers.length && <option value="">还没有生图 provider</option>}
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button
            type="button"
            onClick={() => setForm({ ...EMPTY_FORM })}
            title="新增生图 provider"
            className="shrink-0 p-1.5 rounded-md border border-canvas-deep text-ink-soft hover:bg-canvas-deep/60"
          ><Plus size={13} /></button>
        </div>
        <textarea
          className={`${inputCls} resize-y min-h-[64px]`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述你想要的画面…"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!canGenerate}
            onClick={generate}
            className="px-3 py-1.5 rounded-md bg-accent text-on-accent text-[12px] font-body disabled:opacity-50 flex items-center gap-1"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {busy ? '生成中…（最长 120 秒）' : '生成'}
          </button>
          {selected && !selected.savePath && (
            <span className="text-[11px] text-error font-body">该 provider 未设置保存路径，请先编辑并选择保存目录。</span>
          )}
          {!providers.length && (
            <span className="text-[11px] text-ink-faint font-body">先用右上角 + 添加一个生图 provider（地址 / 密钥 / 模型 / 尺寸 / 保存路径均由你填写）。</span>
          )}
        </div>
        {err && <div className="text-[11px] text-error font-body break-all">{err}</div>}
      </div>

      {/* 预览区 */}
      {current && (
        <div className="space-y-1.5">
          <img src={current.previewUrl} alt={current.prompt} className="w-full rounded-panel border border-canvas-deep" />
          <div className="text-[11px] text-ink-soft font-body break-all">{current.prompt}</div>
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] text-ink-faint font-mono break-all flex-1">{current.file}</span>
            <button
              type="button"
              onClick={() => reveal(current.file)}
              className="shrink-0 px-2 py-1 rounded border border-canvas-deep text-[11px] text-ink-soft font-body hover:bg-canvas-deep/60 flex items-center gap-1"
            ><ExternalLink size={11} />在访达中显示</button>
          </div>
          {revealErr && <div className="text-[11px] text-error font-body">{revealErr}</div>}
        </div>
      )}

      {/* 本次会话内的历史缩略图 */}
      {history.length > 1 && (
        <div className="space-y-1">
          <div className={labelCls}>本次会话（{history.length}）</div>
          <div className="grid grid-cols-4 gap-1.5">
            {history.map((h) => (
              <button
                key={h.file}
                type="button"
                onClick={() => setCurrent(h)}
                title={h.prompt}
                className={`aspect-square rounded overflow-hidden border ${current?.file === h.file ? 'border-accent' : 'border-canvas-deep'}`}
              >
                <img src={h.previewUrl} alt={h.prompt} className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 管理态 */}
      {form
        ? <ProviderForm key={form.id || 'new'} initial={form} onCancel={() => setForm(null)} onDone={(id) => { setForm(null); load(id); }} />
        : providers.length > 0 && (
          <div className="space-y-1">
            <div className={labelCls}>生图 provider（配置独立存放，不写入 ~/.claude/settings.json）</div>
            {providers.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-md border border-canvas-deep px-2 py-1.5">
                <Image size={12} className="text-ink-faint shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-ink font-body truncate">{p.name}</div>
                  <div className="text-[10px] text-ink-faint font-mono truncate">
                    {p.protocol} · {p.model}{p.size ? ` · ${p.size}` : ''}{p.hasKey ? ' · 已存密钥' : ' · 无密钥'}
                  </div>
                  <div className="text-[10px] text-ink-faint font-mono truncate" title={p.savePath}>{p.savePath || '未设置保存路径'}</div>
                </div>
                <button
                  type="button"
                  title="编辑"
                  onClick={() => setForm({
                    ...EMPTY_FORM, id: p.id, name: p.name, protocol: p.protocol, baseURL: p.baseURL,
                    model: p.model, size: p.size, savePath: p.savePath,
                    extra: p.extra ? JSON.stringify(p.extra, null, 2) : '',
                  })}
                  className="shrink-0 p-1 rounded hover:bg-canvas-deep/60 text-ink-soft"
                ><Pencil size={12} /></button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => remove(p)}
                  className="shrink-0 p-1 rounded hover:bg-canvas-deep/60 text-error"
                ><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
