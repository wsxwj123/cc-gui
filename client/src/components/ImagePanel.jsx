// r16-3 生图面板:自定义生图 provider(与文本 provider 完全分开,配置落
// ~/.claude-gui/image-providers.json,不碰 ~/.claude/settings.json)。
// 上半是出图(选 provider → 填提示词 → 生成 → 预览/落盘),下半是「管理」态的
// provider 表单。保存路径是配置的一部分且必填:Tauri 下走原生文件夹选择器,
// 浏览器访问时退化成手输绝对路径。
// 模态红线:删除走 confirmDialog(Tauri 禁原生 confirm)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Plus, Trash2, Pencil, FolderOpen, Loader2, Sparkles, ExternalLink, X, Check, RefreshCw, RotateCcw } from './Icon.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { pickDirectory, isTauri } from '../utils/pickDirectory.js';
import { ImageLightbox } from './ImageLightbox.jsx';
import { ModelPickModal, mergeModelLines, stripJunkModels } from './ModelPickModal.jsx';
// r56 尺寸候选按模型家族过滤(能力表在 utils/imageSizeCaps.js,未知模型回落全量)。
import { SIZE_OPTIONS, sizeCapFor, sizeOptionsFor } from '../utils/imageSizeCaps.js';

const inputCls = 'w-full bg-canvas-warm border border-canvas-deep rounded-md px-2.5 py-1.5 text-[12px] text-ink font-body focus:outline-none focus:border-accent/50';
const labelCls = 'text-[10.5px] text-ink-faint font-body';

const PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 系（/images/generations）' },
  { id: 'gemini', label: 'Gemini 系（:generateContent）' },
  { id: 'chat', label: '对话接口出图（/chat/completions）' },
];

// r54:图生图形态,仅 openai 协议有意义(其余协议的参考图形态是唯一的,没得选)。
const I2I_MODES = [
  { id: 'edits', label: 'OpenAI 官方（/images/edits）' },
  { id: 'generations-image', label: 'Seedream · 方舟（generations 带 image 字段）' },
];

// r52:models = 用户勾选的模型白名单(落盘在 provider 上),「模型」输入框的候选列表读它。
// r56:proxyUrl = 本 provider 的正向代理地址(可选,留空直连)。
const EMPTY_FORM = { id: '', name: '', protocol: 'openai', baseURL: '', apiKey: '', model: '', models: [], size: '', savePath: '', extra: '', i2iMode: 'edits', proxyUrl: '' };

// 提示词草稿:出图是后台任务,面板关掉再打开输入框里的内容必须还在。
const PROMPT_DRAFT_KEY = 'cgui-image-prompt-draft';
const TASK_VIEW_KEY = 'cgui-image-tasklist-view'; // grid | list,重开面板保留
const POLL_MS = 1500; // 有任务在跑时的历史轮询间隔
const STATUS_LABEL = { running: '生成中', done: '已完成', error: '失败', interrupted: '已中断', cancelled: '已取消' };
// r54 参考图:张数与单张体积上限,与服务端 MAX_REFS / MAX_REF_BYTES 同值(前端先拦,
// 省一次大 body 往返;真正的闸在服务端)。
const MAX_REFS = 6;
const MAX_REF_BYTES = 15 * 1024 * 1024;
const REF_ACCEPT = 'image/png,image/jpeg,image/webp';
function readPromptDraft() {
  try { return localStorage.getItem(PROMPT_DRAFT_KEY) || ''; } catch { return ''; }
}
function readTaskView() {
  try { return localStorage.getItem(TASK_VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
}
const shortTime = (ms) => (ms ? new Date(ms).toLocaleString() : '');
// 已耗时:轮询每 1.5s 换一次 history 引用 → 重渲染时自然走秒,不额外起计时器。
const elapsedSec = (h) => Math.max(0, Math.round((Date.now() - (h.startedAt || Date.now())) / 1000));

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
  const [pickCandidates, setPickCandidates] = useState(null); // r52:非空 = 勾选弹窗打开
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsMsg, setModelsMsg] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // r56:命中能力表才有小字说明(未命中 = 走全量候选,不提示)。随「模型」输入实时变。
  const sizeCap = sizeCapFor(form.model);

  // 拉模型:编辑态只传 id(服务端强制用存储的 baseURL 与密钥,请求体里的 baseURL 被忽略);
  // 新建态传表单里的地址与密钥。密钥留空也发 —— 部分中转站的模型列表接口不鉴权。
  const loadModels = async () => {
    setFetchingModels(true);
    setModelsMsg('');
    try {
      // 新建态把表单里的代理一并发过去(编辑态服务端一律用存储值,与 baseURL 同口径)。
      const body = form.id ? { id: form.id, protocol: form.protocol }
        : { baseURL: form.baseURL.trim(), protocol: form.protocol, proxyUrl: (form.proxyUrl || '').trim() };
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
      const r = await fetch('/api/image-providers/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setModelsMsg(`${FETCH_HINTS[d.type] || `拉取失败（HTTP ${r.status}）。`}${d.message ? `\n${d.message}` : ''}`);
        return;
      }
      // r52:拉取结果是候选,不是配置 —— 过滤掉嵌入/语音/视频/重排类噪音后开勾选弹窗,
      // 勾中的才 merge 进 form.models(保存时随 provider 落盘)。
      const list = stripJunkModels(d.models || [], 'image');
      // 拉取成功 = 地址与密钥这条链路通了(拉列表不计费,可当免费的连通性检查)。
      if (list.length) {
        setPickCandidates(list);
        setModelsMsg(`连接正常，拉到 ${list.length} 个模型，请勾选要添加的模型；保存后候选列表持久生效。`);
      } else {
        setModelsMsg('连接正常，但该服务返回了空的模型列表，请在「模型」框手动填写模型名。');
      }
    } catch (e) {
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
        models: form.models || [], size: form.size, savePath: form.savePath, extra,
        i2iMode: form.i2iMode || 'edits',
        proxyUrl: (form.proxyUrl || '').trim(), // 空串 = 清除(改回直连)
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
              {(form.models || []).map((m) => <option key={m} value={m} />)}
            </datalist>
            <button
              type="button"
              onClick={loadModels}
              disabled={fetchingModels || (!form.id && !form.baseURL.trim())}
              title={!form.id && !form.baseURL.trim() ? '先填写接口地址（baseURL）' : form.id ? '使用已保存的接口地址与密钥拉取（表单中未保存的修改不生效）' : '按接口地址与密钥拉取可用模型'}
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
        {/* r56:候选随「模型」输入实时收窄 —— 命中已知家族用其官方支持范围,未知模型回落全量。
            只影响候选显示,手输的值一律照发(发送逻辑零改动)。 */}
        <datalist id="cgui-image-size-options">
          {(sizeOptionsFor(form.model) ?? SIZE_OPTIONS).map((s) => <option key={s} value={s} />)}
        </datalist>
        <span className="text-[10px] text-ink-faint font-body leading-snug block">
          {form.protocol === 'openai'
            ? '随请求发送；服务不支持所选尺寸时会报错。'
            : '该协议无原生尺寸字段，此值不发送；需在附加参数（extra）中按服务文档设置。'}
        </span>
        {sizeCap && (
          <span className="text-[10px] text-ink-faint font-body leading-snug block">
            候选已按 {sizeCap.family} 的官方支持范围过滤；手动输入不受限制。
          </span>
        )}
      </label>
      {/* r54:图生图形态。两种协议形态官方不兼容 —— OpenAI 有 /images/edits 端点,
          方舟(Seedream)没有,图生图靠 generations 的 image 字段。选错则上游 404/400。 */}
      {form.protocol === 'openai' && (
        <label className="space-y-1 block"><span className={labelCls}>图生图形态（带参考图时使用）</span>
          <select className={inputCls} value={form.i2iMode || 'edits'} onChange={set('i2iMode')}>
            {I2I_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <span className="text-[10px] text-ink-faint font-body leading-snug block">
            OpenAI 官方形态发往 /images/edits，参考图以 multipart 上传；方舟形态仍发往 /images/generations，参考图以 image 字段随请求体发送。不带参考图时两者请求一致。
          </span>
        </label>
      )}
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
      {/* r56:按 provider 的正向代理。生图链路(生成 / 拉取模型 / 图片下载)是服务端发起的,
          不读系统代理设置,被墙的域名只能靠这个字段指定出口。 */}
      <label className="space-y-1 block"><span className={labelCls}>代理地址（可选）</span>
        <input className={inputCls} value={form.proxyUrl || ''} onChange={set('proxyUrl')} placeholder="http://127.0.0.1:7897" autoComplete="off" />
        <span className="text-[10px] text-ink-faint font-body leading-snug block">
          留空直连。填写后本 provider 的生成、拉取模型、图片下载均经此代理（如 Clash 本机端口）；地址不支持内嵌账号密码。
        </span>
      </label>
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
      {/* r52:拉取结果的勾选弹窗。确认后并进白名单(原有项一律保留),随「保存」落盘。 */}
      {pickCandidates && (
        <ModelPickModal
          candidates={pickCandidates}
          existing={form.models || []}
          onClose={() => setPickCandidates(null)}
          onConfirm={(ids) => {
            setForm((f) => ({ ...f, models: mergeModelLines(f.models || [], ids) }));
            setPickCandidates(null);
            setModelsMsg('已加入候选列表，点击「模型」输入框即可选择；点「保存」后持久生效。');
          }}
        />
      )}
    </div>
  );
}

export default function ImagePanel() {
  const [providers, setProviders] = useState([]);
  const [selId, setSelId] = useState('');
  const [prompt, setPrompt] = useState(readPromptDraft);
  const [submitting, setSubmitting] = useState(false); // 只是"受理请求"这一瞬,生成态看历史
  const [err, setErr] = useState('');
  const [history, setHistory] = useState([]); // 服务端持久化历史(≤100 条,新在前)
  const [currentId, setCurrentId] = useState('');
  const [zoom, setZoom] = useState(null);
  const [tab, setTab] = useState('gen'); // gen | jobs —— 局部态,切 tab 不重挂面板,轮询照跑
  const [taskView, setTaskView] = useState(readTaskView); // grid | list
  const [form, setForm] = useState(null); // null = 不在表单态
  // r54 参考图(图生图)。刻意【不进 localStorage 草稿】:一张图就能把 5MB 配额撑爆,
  // 重开面板参考图清空可接受(提示词照旧保留)。
  const [refs, setRefs] = useState([]);
  // r54 删除:selectMode = 批量选择开关,selectedIds = 勾中的 jobId 集合。
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const promptRef = useRef(null);
  const refFileRef = useRef(null);

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

  // 提示词草稿:每次输入即写 localStorage,重开面板/刷新都填回原文(用户要求生成后也不清空)。
  const setPromptDraft = useCallback((v) => {
    setPrompt(v);
    try { localStorage.setItem(PROMPT_DRAFT_KEY, v); } catch { /* 隐私模式/配额满:草稿丢了不影响出图 */ }
  }, []);

  const setTaskViewPref = useCallback((v) => {
    setTaskView(v);
    try { localStorage.setItem(TASK_VIEW_KEY, v); } catch { /* 存不下就只在本次会话生效 */ }
  }, []);

  // 输入框随内容长高(上限 240px,再多则框内滚动)。挂载恢复草稿、点「恢复」回填都会
  // 改 prompt → 这个 effect 一并覆盖,不必各处手动调。
  const fitPrompt = useCallback(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // 判官r51必修:display:none(在任务列表页点「恢复」时)下 scrollHeight 恒 0,写 0px
    // 会让切回生图页后输入框塌成一条缝 —— 隐藏时不测高,交给 deps 里的 tab 切回补跑。
    if (el.value && el.scrollHeight === 0) { el.style.height = ''; return; }
    el.style.height = (el.value ? Math.min(el.scrollHeight, 240) : 64) + 'px';
  }, []);
  useEffect(() => { fitPrompt(); }, [prompt, tab, fitPrompt]);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch('/api/image/history');
      const d = await r.json();
      const list = Array.isArray(d.history) ? d.history : [];
      setHistory(list);
      // 面板重开时的当前预览:优先保持已选中那条,否则取最近一条已完成的。
      setCurrentId((cur) => (list.some((h) => h.id === cur) ? cur : (list.find((h) => h.status === 'done')?.id || '')));
    } catch { /* 后端未就绪:下次轮询/重开面板再拉 */ }
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const running = history.filter((h) => h.status === 'running');
  const hasRunning = running.length > 0;
  // 轮询:有任务在跑就 1.5s 拉一次,全部落终态自动停。卸载只清 interval —— 任务在服务端
  // 跑,关面板不影响它。
  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = setInterval(loadHistory, POLL_MS);
    return () => clearInterval(timer);
  }, [hasRunning, loadHistory]);

  const selected = providers.find((p) => p.id === selId) || null;
  // 有任务在跑【不】禁用生成:服务端支持并发(上限 3),点一次就多一个任务。
  // submitting 只挡请求发出的那一瞬(防双击重复提交)。
  const canGenerate = !!selected && !!selected.savePath && !!prompt.trim() && !submitting;
  const current = history.find((h) => h.id === currentId) || null;
  // 任务列表:running 排最上,其余保持时间倒序(sort 稳定,组内次序不变)。
  const ordered = [...history].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1));

  // 参考图选择:单张与张数都先在前端拦一道(超限直接报错不发),真正的闸在服务端。
  const addRefFiles = async (files) => {
    setErr('');
    const picked = Array.from(files || []);
    if (!picked.length) return;
    if (refs.length + picked.length > MAX_REFS) {
      setErr(`参考图最多 ${MAX_REFS} 张，当前已有 ${refs.length} 张`);
      return;
    }
    const next = [];
    for (const f of picked) {
      if (f.size > MAX_REF_BYTES) {
        setErr(`「${f.name}」超过单张上限 ${MAX_REF_BYTES / 1048576}MB，请换用更小的图片`);
        return;
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(new Error(`读取「${f.name}」失败`));
        fr.readAsDataURL(f);
      }).catch((e) => { setErr(e.message); return ''; });
      if (!dataUrl) return;
      next.push({
        kind: 'upload',
        name: f.name,
        mime: f.type || 'image/png',
        dataB64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        preview: dataUrl,
      });
    }
    setRefs((cur) => [...cur, ...next].slice(0, MAX_REFS));
  };

  // 「以此图修改」:引用已生成的图 —— 只传 file 路径,不把图片内容回传一遍。
  const addHistoryRef = (h) => {
    setErr('');
    setTab('gen');
    setRefs((cur) => {
      if (cur.some((r) => r.kind === 'history' && r.file === h.file)) return cur;
      if (cur.length >= MAX_REFS) { setErr(`参考图最多 ${MAX_REFS} 张`); return cur; }
      return [...cur, { kind: 'history', file: h.file, name: h.file.split(/[/\\]/).pop(), preview: h.previewUrl }];
    });
  };

  const generate = async () => {
    if (!canGenerate) return;
    setSubmitting(true); setErr('');
    try {
      const payload = { providerId: selId, prompt };
      if (refs.length) {
        payload.refs = refs.map((r) => (r.kind === 'history'
          ? { kind: 'history', file: r.file }
          : { kind: 'upload', name: r.name, mime: r.mime, dataB64: r.dataB64 }));
      }
      const r = await fetch('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      // 413 来自请求体解析层(参考图总体积超过 25MB),响应不是 JSON,得单独给人话。
      if (r.status === 413) throw new Error('参考图总体积过大，请减少参考图数量或换用更小的图片');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `生成失败（${r.status}）`);
      if (!d.jobId) throw new Error('服务端未返回任务标识');
      await loadHistory(); // 拿到 running 条目 → 轮询自动起
    } catch (e) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
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
  // 用户点了「在文件夹中显示」毫无反应,分不清是没点上还是失败了。非阻断操作,
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

  // 取消生成中的任务:只作用于点名的那一个 jobId。不弹确认 —— 取消可重发,不是破坏性操作。
  const cancelJob = async (id) => {
    setErr('');
    try {
      const r = await fetch(`/api/image/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!d.ok && d.error) setErr(d.error);
    } catch {
      setErr('取消失败：请求未能到达后端');
    }
    loadHistory();
  };

  // 删除记录(单删与批量同一条路径)。确认框带「同时删除本地图片文件」勾选框,默认不勾 ——
  // 删记录与删磁盘上的图是两件事,后者不可撤销,必须用户显式勾选。
  const deleteEntries = async (ids) => {
    if (!ids.length) return;
    const runningCount = history.filter((h) => ids.includes(h.id) && h.status === 'running').length;
    const answer = await confirmDialog(
      `删除 ${ids.length} 条生成记录？${runningCount ? `\n其中 ${runningCount} 条仍在生成中，将先取消再删除。` : ''}`,
      { danger: true, confirmText: '删除', checkbox: { label: '同时删除本地图片文件（不可恢复）' } },
    );
    if (!answer?.confirmed) return;
    setErr('');
    try {
      const r = await fetch('/api/image/history/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, deleteFile: !!answer.checked }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `删除失败（${r.status}）`);
      if (d.skipped?.length) setErr(`${d.skipped.length} 个图片文件未删除：文件路径不在生图 provider 的保存目录之内。`);
    } catch (e) {
      setErr(e.message);
    }
    setSelectedIds(new Set());
    setSelectMode(false);
    // 当前预览若指向被删条目,loadHistory 会自动回退到最近一条已完成的(或清空)。
    await loadHistory();
  };

  const toggleSelected = (id) => setSelectedIds((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // 两种视图共用的条目操作,避免两处各写一份走样。
  const taskActions = (h) => (
    <>
      {h.status === 'running' && (
        <button
          type="button"
          onClick={() => cancelJob(h.id)}
          title="停止该生成任务"
          className="px-1.5 py-0.5 rounded border border-canvas-deep text-[10px] text-ink-soft font-body hover:bg-canvas-deep/60 flex items-center gap-1"
        ><X size={10} />取消</button>
      )}
      {h.status === 'done' && h.file && (
        <button
          type="button"
          onClick={() => addHistoryRef(h)}
          title="把这张图作为参考图，在它的基础上继续修改"
          className="px-1.5 py-0.5 rounded border border-canvas-deep text-[10px] text-ink-soft font-body hover:bg-canvas-deep/60 flex items-center gap-1"
        ><Image size={10} />以此图修改</button>
      )}
      {h.status === 'done' && h.file && (
        <button
          type="button"
          onClick={() => reveal(h.file)}
          title="在文件夹中显示"
          className="px-1.5 py-0.5 rounded border border-canvas-deep text-[10px] text-ink-soft font-body hover:bg-canvas-deep/60 flex items-center gap-1"
        ><ExternalLink size={10} />在文件夹中显示</button>
      )}
      <button
        type="button"
        onClick={() => { setPromptDraft(h.prompt || ''); setTab('gen'); }}
        title="把该条提示词填回输入框并切到生图页"
        className="px-1.5 py-0.5 rounded border border-canvas-deep text-[10px] text-ink-soft font-body hover:bg-canvas-deep/60 flex items-center gap-1"
      ><RotateCcw size={10} />恢复</button>
      <button
        type="button"
        onClick={() => deleteEntries([h.id])}
        title="删除这条记录"
        className="px-1.5 py-0.5 rounded border border-canvas-deep text-[10px] text-error font-body hover:bg-canvas-deep/60 flex items-center gap-1"
      ><Trash2 size={10} />删除</button>
    </>
  );

  return (
    <div className="h-full overflow-y-auto px-4 py-4 space-y-4">
      {/* 选项卡:生图 / 任务列表(切换只是前端局部态,轮询与后台任务都不受影响) */}
      <div className="flex items-center gap-1 p-0.5 rounded-panel bg-canvas-warm text-[11px] font-body">
        {[['gen', '生图'], ['jobs', `任务列表${hasRunning ? ` ·${running.length}` : ''}`]].map(([id, label]) => (
          <button
            type="button"
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 py-1.5 rounded-md transition-colors ${tab === id ? 'bg-accent text-on-accent' : 'text-ink-muted hover:text-ink'}`}
          >{label}</button>
        ))}
      </div>

      {/* 出图区 */}
      <div className={`space-y-2 ${tab === 'gen' ? '' : 'hidden'}`}>
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
        {/* r54 参考图条:有参考图时按图生图形态发请求,提示词描述的是「要改成什么样」。 */}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={labelCls}>参考图（可选，最多 {MAX_REFS} 张，单张 {MAX_REF_BYTES / 1048576}MB 以内）</span>
            <button
              type="button"
              onClick={() => refFileRef.current?.click()}
              disabled={refs.length >= MAX_REFS}
              className="px-1.5 py-0.5 rounded border border-canvas-deep text-[10px] text-ink-soft font-body hover:bg-canvas-deep/60 disabled:opacity-50 flex items-center gap-1"
            ><Plus size={10} />添加参考图</button>
            <input
              ref={refFileRef}
              type="file"
              accept={REF_ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => { addRefFiles(e.target.files); e.target.value = ''; }}
            />
          </div>
          {refs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {refs.map((r, i) => (
                <span key={`${r.kind}-${r.file || r.name}-${i}`} className="flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-md border border-canvas-deep bg-canvas-warm/60">
                  <img src={r.preview} alt={r.name} className="w-6 h-6 rounded object-cover" />
                  <span className="text-[10px] text-ink-soft font-body max-w-[110px] truncate" title={r.name}>{r.name}</span>
                  <button
                    type="button"
                    onClick={() => setRefs((cur) => cur.filter((_, j) => j !== i))}
                    title="移除该参考图"
                    className="p-0.5 rounded hover:bg-canvas-deep/60 text-ink-faint"
                  ><X size={10} /></button>
                </span>
              ))}
            </div>
          )}
        </div>
        <textarea
          ref={promptRef}
          className={`${inputCls} resize-none overflow-y-auto`}
          style={{ height: 64 }}
          value={prompt}
          onChange={(e) => setPromptDraft(e.target.value)}
          placeholder="描述你想要的画面…"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!canGenerate}
            onClick={generate}
            className="px-3 py-1.5 rounded-md bg-accent text-on-accent text-[12px] font-body disabled:opacity-50 flex items-center gap-1"
          >
            {submitting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            生成
          </button>
          {refs.length > 0 && (
            <span className="text-[11px] text-ink-faint font-body">图生图（{refs.length} 张参考）</span>
          )}
          {hasRunning && (
            <span className="text-[11px] text-ink-faint font-body">
              {running.length} 个任务在后台运行，可继续发起新任务（同时最多 3 个）；关闭面板不影响，进度在「任务列表」页。
            </span>
          )}
          {selected && !selected.savePath && (
            <span className="text-[11px] text-error font-body">该 provider 未设置保存路径，请先编辑并选择保存目录。</span>
          )}
          {!providers.length && (
            <span className="text-[11px] text-ink-faint font-body">先用右上角 + 添加一个生图 provider（地址 / 密钥 / 模型 / 尺寸 / 保存路径均由你填写）。</span>
          )}
        </div>
        {err && <div className="text-[11px] text-error font-body break-all">{err}</div>}
      </div>

      {/* 预览区(当前已完成的那张)。不显示提示词全文:长提示词会把面板顶爆,
          识别靠任务列表里的截断显示,全文在 Lightbox 标题或「恢复」回输入框看。 */}
      {current && current.status === 'done' && (
        <div className={`space-y-1.5 ${tab === 'gen' ? '' : 'hidden'}`}>
          <img
            src={current.previewUrl}
            alt={current.prompt}
            onClick={() => setZoom({ src: current.previewUrl, name: current.prompt, path: current.file })}
            className="w-full rounded-panel border border-canvas-deep cursor-zoom-in"
          />
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] text-ink-faint font-mono break-all flex-1">{current.file}</span>
            <button
              type="button"
              onClick={() => reveal(current.file)}
              className="shrink-0 px-2 py-1 rounded border border-canvas-deep text-[11px] text-ink-soft font-body hover:bg-canvas-deep/60 flex items-center gap-1"
            ><ExternalLink size={11} />在文件夹中显示</button>
          </div>
          {revealErr && <div className="text-[11px] text-error font-body">{revealErr}</div>}
        </div>
      )}

      {/* 任务列表页:持久化历史(≤100 条)。running 排最上,error/interrupted 的报错写在图块里。 */}
      <div className={`space-y-2 ${tab === 'jobs' ? '' : 'hidden'}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={`${labelCls} flex-1`}>共 {history.length} 条，最多保留 100 条</div>
          {/* r54 批量删除:「选择」开关 → 每条出现勾选框 + 全选 + 删除所选(选中 0 条时禁用)。 */}
          <button
            type="button"
            onClick={() => { setSelectMode((v) => !v); setSelectedIds(new Set()); }}
            disabled={!history.length}
            className={`px-2 py-0.5 rounded-md border text-[10.5px] font-body disabled:opacity-50 ${selectMode ? 'border-accent text-ink' : 'border-canvas-deep text-ink-soft hover:bg-canvas-deep/60'}`}
          >{selectMode ? '退出选择' : '选择'}</button>
          {selectMode && (
            <>
              <button
                type="button"
                onClick={() => setSelectedIds((cur) => (cur.size === history.length ? new Set() : new Set(history.map((h) => h.id))))}
                className="px-2 py-0.5 rounded-md border border-canvas-deep text-[10.5px] text-ink-soft font-body hover:bg-canvas-deep/60"
              >{selectedIds.size === history.length && history.length ? '取消全选' : '全选'}</button>
              <button
                type="button"
                onClick={() => deleteEntries([...selectedIds])}
                disabled={!selectedIds.size}
                className="px-2 py-0.5 rounded-md border border-canvas-deep text-[10.5px] text-error font-body hover:bg-canvas-deep/60 disabled:opacity-50 flex items-center gap-1"
              ><Trash2 size={10} />删除所选（{selectedIds.size}）</button>
            </>
          )}
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-warm text-[10.5px] font-body">
            {[['grid', '网格'], ['list', '列表']].map(([id, label]) => (
              <button
                type="button"
                key={id}
                onClick={() => setTaskViewPref(id)}
                className={`px-2 py-0.5 rounded transition-colors ${taskView === id ? 'bg-accent text-on-accent' : 'text-ink-muted hover:text-ink'}`}
              >{label}</button>
            ))}
          </div>
        </div>
        {!history.length && <div className="text-[11px] text-ink-faint font-body">还没有生成记录。</div>}
        {revealErr && <div className="text-[11px] text-error font-body">{revealErr}</div>}
        <div className={taskView === 'grid' ? 'grid grid-cols-2 gap-2' : 'space-y-1.5'}>
          {ordered.map((h) => (taskView === 'grid' ? (
            <div key={h.id} className={`rounded-panel border overflow-hidden ${h.id === currentId ? 'border-accent' : 'border-canvas-deep'}`}>
              {h.status === 'done' && h.previewUrl ? (
                <img
                  src={h.previewUrl}
                  alt={h.prompt}
                  onClick={() => { setCurrentId(h.id); setZoom({ src: h.previewUrl, name: h.prompt, path: h.file }); }}
                  className="w-full aspect-square object-cover cursor-zoom-in"
                />
              ) : (
                <div className="w-full aspect-square bg-canvas-warm flex flex-col items-center justify-center gap-1 px-2 text-center">
                  {h.status === 'running' ? (
                    <>
                      <Loader2 size={16} className="animate-spin text-ink-faint" />
                      <span className="text-[10px] text-ink-faint font-body">生成中 · {elapsedSec(h)}s</span>
                    </>
                  ) : (
                    <span className="text-[10px] text-error font-body break-all line-clamp-5">{h.error || STATUS_LABEL[h.status] || h.status}</span>
                  )}
                </div>
              )}
              <div className="px-1.5 py-1 space-y-1">
                <div className="flex items-start gap-1">
                  {selectMode && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(h.id)}
                      onChange={() => toggleSelected(h.id)}
                      title="选中以批量删除"
                      className="mt-0.5 shrink-0 accent-red-600"
                    />
                  )}
                  <div className="text-[10.5px] text-ink font-body truncate flex-1" title={h.prompt}>{h.prompt}</div>
                </div>
                <div className="text-[9.5px] text-ink-faint font-body truncate">
                  {h.refs?.length ? <span className="mr-1 px-1 rounded bg-canvas-deep/60 text-ink-soft">图生图</span> : null}
                  {STATUS_LABEL[h.status] || h.status} · {shortTime(h.startedAt)}
                </div>
                <div className="flex items-center gap-1">{taskActions(h)}</div>
              </div>
            </div>
          ) : (
            <div key={h.id} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${h.id === currentId ? 'border-accent' : 'border-canvas-deep'}`}>
              {selectMode && (
                <input
                  type="checkbox"
                  checked={selectedIds.has(h.id)}
                  onChange={() => toggleSelected(h.id)}
                  title="选中以批量删除"
                  className="shrink-0 accent-red-600"
                />
              )}
              {h.status === 'done' && h.previewUrl ? (
                <img
                  src={h.previewUrl}
                  alt={h.prompt}
                  onClick={() => { setCurrentId(h.id); setZoom({ src: h.previewUrl, name: h.prompt, path: h.file }); }}
                  className="shrink-0 w-9 h-9 rounded object-cover border border-canvas-deep cursor-zoom-in"
                />
              ) : (
                <div className="shrink-0 w-9 h-9 rounded border border-canvas-deep flex items-center justify-center">
                  {h.status === 'running'
                    ? <Loader2 size={12} className="animate-spin text-ink-faint" />
                    : <Image size={12} className="text-ink-faint" />}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[11.5px] text-ink font-body truncate" title={h.prompt}>{h.prompt}</div>
                <div className="text-[10px] text-ink-faint font-body truncate">
                  {h.refs?.length ? <span className="mr-1 px-1 rounded bg-canvas-deep/60 text-ink-soft">图生图</span> : null}
                  {h.status === 'running' ? `生成中 · ${elapsedSec(h)}s` : (STATUS_LABEL[h.status] || h.status)}
                  {h.status !== 'done' && h.error ? ` · ${h.error}` : ''}
                  {h.startedAt ? ` · ${shortTime(h.startedAt)}` : ''}
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-1">{taskActions(h)}</div>
            </div>
          )))}
        </div>
      </div>

      <ImageLightbox src={zoom?.src} name={zoom?.name} path={zoom?.path} onClose={() => setZoom(null)} />

      {/* 管理态(属「生图」页)。r54:用 hidden 类切换而非条件渲染 —— 条件渲染会在切到
          任务列表时卸载表单,编辑到一半的未保存字段全丢(与上面双 tab 同法)。 */}
      <div className={tab === 'gen' ? '' : 'hidden'}>{(form
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
                    model: p.model, models: p.models || [], size: p.size, savePath: p.savePath,
                    extra: p.extra ? JSON.stringify(p.extra, null, 2) : '', i2iMode: p.i2iMode || 'edits',
                    proxyUrl: p.proxyUrl || '',
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
        ))}
      </div>
    </div>
  );
}
