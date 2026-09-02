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
// r56/r87 生图参数能力表(utils/imageSizeCaps.js)。r87 起判据是 (上游方言, 模型) 二元 ——
// apimart 的 size 是宽高比、OpenAI 官方的 size 是像素,同名反义,只看模型名判不了。
import {
  SIZE_OPTIONS, sizeCapFor, sizeOptionsFor, imageDialect, dialectForBaseURL, APIMART_RATIOS,
} from '../utils/imageSizeCaps.js';
// r84 多图条目:一个任务可能出多张图(MJ 一次 4 张),单图操作一律作用于【选中的那张】。
// r95 序列三函数:把任务列表拍平成一条可浏览序列,供放大层左右切图。
import {
  entryFiles, pickedIndex, pickedFile, entryPreviewUrl, pickedPreviewUrl,
  flattenBrowsable, shotPos, neighbor,
} from '../utils/imageEntry.js';
// r58 上传参考图的 MIME:File.type 为空(Win 缺注册表映射)时按扩展名认,别一律说成 png。
import { refMime } from '../utils/refMime.js';
// r59 程序化写入走撤销通道,否则「恢复」覆盖掉的提示词 ⌘Z 撤不回。
import { applyProgrammaticText } from '../utils/inputUndo.js';

const inputCls = 'w-full bg-canvas-warm border border-canvas-deep rounded-md px-2.5 py-1.5 text-[12px] text-ink font-body focus:outline-none focus:border-accent/50';
const labelCls = 'text-[10.5px] text-ink-faint font-body';

const PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 系（/images/generations）' },
  { id: 'gemini', label: 'Gemini 系（:generateContent）' },
  { id: 'chat', label: '对话接口出图（/chat/completions）' },
  // r82:任务制上游 —— 提交只返回任务号，服务端轮询到出图为止（见下方协议说明）。
  { id: 'mj', label: 'Midjourney（/midjourney/generations，任务制轮询）' },
];

// r54:图生图形态,仅 openai 协议有意义(其余协议的参考图形态是唯一的,没得选)。
const I2I_MODES = [
  { id: 'edits', label: 'OpenAI 官方（/images/edits）' },
  { id: 'generations-image', label: 'Seedream · 方舟（generations 带 image 字段）' },
];

// r52:models = 用户勾选的模型白名单(落盘在 provider 上),「模型」输入框的候选列表读它。
// r56:proxyUrl = 本 provider 的正向代理地址(可选,留空直连)。
// r84:mjVersion / mjSpeed = Midjourney 的具名结构化参数(仅 mj 协议下发,空 = 不指定)。
// r87:dialect = 上游方言(openai 官方语义 / apimart);其余是 OpenAI 系的结构化参数,
// 空 = 不下发该键。存量 provider 没有这些字段,服务端回显时补成同样的缺省值。
const EMPTY_FORM = {
  id: '', name: '', protocol: 'openai', baseURL: '', apiKey: '', model: '', models: [], size: '',
  savePath: '', extra: '', i2iMode: 'edits', proxyUrl: '', mjVersion: '', mjSpeed: '',
  dialect: 'openai', resolution: '', quality: '', outputFormat: '', background: '', moderation: '',
  n: '', nsfwCheck: false,
};

// ─────────────────── r87 OpenAI 系参数的界面文案(取值与服务端白名单同源) ───────────────────
// 服务端权威清单在 server/utils/image-protocols.js(IMAGE_QUALITIES / IMAGE_OUTPUT_FORMATS /
// IMAGE_BACKGROUNDS / IMAGE_MODERATIONS / IMAGE_RESOLUTIONS),那里才是校验闸;界面这份只负责
// 把值翻成人话,可选项本身按 (方言, 模型) 从能力表取,不同模型看到的档位不同。
// 默认档一律写成空串 = 不下发该键,由上游取默认。
const IMG_DIALECTS = [
  { id: 'openai', label: 'OpenAI 官方语义（size 为像素，如 1536x1024）' },
  { id: 'apimart', label: 'apimart（size 为宽高比，如 16:9；像素档位由分辨率字段控制）' },
];
const IMG_QUALITY_LABELS = {
  low: 'low（速度最快，成本最低）', medium: 'medium', high: 'high（精度最高；4k + high 出图可能超过 120 秒）',
};
const IMG_FORMAT_LABELS = { png: 'png（支持透明背景）', jpeg: 'jpeg（不支持透明背景）', webp: 'webp（支持透明背景）' };
const IMG_BACKGROUNDS = [['opaque', 'opaque（不透明）'], ['transparent', 'transparent（透明）']];
const IMG_MODERATIONS = [['low', 'low（更宽松的审核强度）']];
const IMG_COUNTS = [1, 2, 3, 4];
// 折叠条摘要用:字段名 → 摘要里的短标签,顺序即摘要里的顺序(只列真正渲染出来的那几项)。
const ADVANCED_FIELD_LABELS = [
  ['quality', '质量'], ['outputFormat', '输出格式'], ['background', '背景'],
  ['moderation', '审核强度'], ['nsfwCheck', '提交前预审'],
];

// ─────────────────────── r84 Midjourney 参数的界面取值(与服务端清单同源) ───────────────────────
// 服务端权威清单在 server/utils/image-protocols.js 的 MJ_VERSIONS / MJ_SPEEDS,那里才是校验闸;
// 这里是同一份值的界面副本(前端不 import 服务端代码)。tests/unit/check-r84-mj-actions.mjs
// 比对两处:版本【一一对应】,速度是【子集】—— 界面把默认档写成空串(= 不下发 speed 键)
// 而不是字面量 'relax',所以前端只有 fast / turbo 两个真值。
// 版本清单出自 apimart 文档 imagine.md 原文「线上已验证可用版本:8.2、8.1、7、6.1、5.2、5.1、
// niji 7、niji 6」;niji 不是"另一种版本号",是 niji:true + version:"7"/"6" 的搭配,
// 故界面按【写实 / 动漫】两档分组,存储仍是一个字符串(niji 档在协议层拆回两个字段)。
const MJ_VERSION_GROUPS = [
  { id: 'mj', label: '写实', hint: 'Midjourney 主线版本', versions: ['8.2', '8.1', '7', '6.1', '5.2', '5.1'] },
  { id: 'niji', label: '动漫', hint: 'Niji 版本，动漫 / 插画风格', versions: ['niji7', 'niji6'] },
];
const MJ_VERSION_LABEL = { niji7: 'niji 7', niji6: 'niji 6' };
const MJ_SPEEDS = [
  { id: '', label: '默认（relax）' },
  { id: 'fast', label: 'fast（快，计费更高）' },
  { id: 'turbo', label: 'turbo（最快，计费最高）' },
];
// 宽高比预设。MJ 的 size 就是 --ar,不是像素 —— 用途标签只为说明该比例常用于什么，
// 比例值本身可任填(下面还有自定义两格)。
const MJ_RATIOS = [
  ['1:1', '头像'], ['3:2', '文章配图'], ['3:4', '社交媒体'],
  ['4:3', '公众号配图'], ['9:16', '海报图'], ['16:9', '电脑壁纸'],
];
// 附加参数示例:用户原话是「speed stylize chaos seed 这些要怎么写,不会啊」——
// 手写 JSON 是门槛,给一份能直接复制的样例比列字段名有用。
const MJ_EXTRA_EXAMPLE = '{"stylize": 250, "chaos": 20, "seed": 12345, "negative_prompt": "blurry, text"}';
const MJ_EXTRA_FIELDS = 'stylize 风格化 0-1000 · chaos 混乱度 0-100 · weird 怪异度 0-3000 · seed 随机种子 · negative_prompt 负面提示词 · style（如 raw）· quality 0.25/0.5/1/2 · hd 布尔（仅 8.1 / 8.2）';

// r84:MJ 四宫格里"第几张"的人话说法。上游的 index 是 1–4,顺序即返回的 image_urls 顺序,
// 对应四宫格的【左上=1、右上=2、左下=3、右下=4】—— 这个映射被单测钉住,别改顺序。
const MJ_GRID_POSITIONS = ['左上', '右上', '左下', '右下'];
// r84 二次操作:放大 = MJ 的 U1–U4(从四宫格里取出那一张单图),变体 = V1–V4(以那张为基础
// 重抽一组四宫格)。上游把这两件事都做成新任务,结果作为新记录进历史。
const MJ_ACTION_LABEL = { upscale: '放大', variation: '变体' };
const MJ_ACTION_TAG = { upscale: 'U', variation: 'V' };

// 提示词草稿:出图是后台任务,面板关掉再打开输入框里的内容必须还在。
const PROMPT_DRAFT_KEY = 'cgui-image-prompt-draft';
const TASK_VIEW_KEY = 'cgui-image-tasklist-view'; // grid | list,重开面板保留
const POLL_MS = 1500; // 有任务在跑时的历史轮询间隔
const STATUS_LABEL = { running: '生成中', done: '已完成', error: '失败', interrupted: '已中断', cancelled: '已取消' };
// 取消只停止本机这一侧的等待与下载：上游任务（任务制协议尤其如此）仍在生成，费用照算。
// 不写清楚会被理解成"已经把任务撤掉了"。
const CANCEL_NOTE = '已停止等待（上游任务可能仍在生成并计费）';
// 取消提示的行内形态。r95 起预览区也要显示它(新任务被取消时不许回退显示上一轮的图,
// 只剩这一行状态),列表条目与预览区共用这一处 —— 文案抄成两份早晚会各改各的。
const cancelNote = (h) => (h.status === 'cancelled' ? ` · ${CANCEL_NOTE}` : '');
// r54 参考图:张数与单张体积上限,与服务端 MAX_REFS / MAX_REF_BYTES 同值(前端先拦,
// 省一次大 body 往返;真正的闸在服务端)。
const MAX_REFS = 6;
const MAX_REF_BYTES = 15 * 1024 * 1024;
const REF_ACCEPT = 'image/png,image/jpeg,image/webp';
// r58: upload 参考图的 preview 是 objectURL(见 addRefFiles),移除/卸载时必须 revoke,
// 否则那张图的内存一直挂在文档上;history 参考图的 preview 是服务端 URL,撤它没有意义。
const revokeRefPreview = (r) => { if (r?.kind === 'upload' && r.preview) URL.revokeObjectURL(r.preview); };
function readPromptDraft() {
  try { return localStorage.getItem(PROMPT_DRAFT_KEY) || ''; } catch { return ''; }
}
function readTaskView() {
  try { return localStorage.getItem(TASK_VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
}
const shortTime = (ms) => (ms ? new Date(ms).toLocaleString() : '');
// r87 费用:实付取上游任务响应里的 credits_cost / cost(权威值,不是本机估的)。
// 小额居多(实测 0.0479),固定 4 位小数再去掉尾随 0;拿不到就返回空串,由调用方不显示。
const fmtAmount = (n) => (typeof n === 'number' && Number.isFinite(n)
  ? String(Number(n.toFixed(4))) : '');
// 只在真的扣了钱时显示:上游对失败任务常回 cost 0,写一句「实付 0」既没信息量又占位置。
const paidNote = (h) => {
  const positive = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? fmtAmount(n) : '');
  const credits = positive(h?.creditsCost);
  if (credits) return `实付 ${credits} credits`;
  const usd = positive(h?.cost);
  return usd ? `实付 ${usd}` : '';
};
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
  const [browsing, setBrowsing] = useState(false); // r87:「浏览」打开的单选弹窗
  // r87:方言按 baseURL 预选,用户手改过之后就不再跟着地址变(否则改个错字就把选择覆盖掉)。
  const [dialectTouched, setDialectTouched] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsMsg, setModelsMsg] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // r56/r87:命中能力表才有小字说明(未命中 = 走全量候选,不提示)。随「方言 + 模型」实时变。
  const dialect = imageDialect(form);
  const sizeCap = sizeCapFor(dialect, form.model);
  // apimart 方言下 size 是宽高比 → 换成芯片网格(与 r84 的 mj 同款写法);官方方言仍是像素输入框。
  const ratioMode = form.protocol === 'openai' && dialect === 'apimart';
  const has = (f) => !!sizeCap?.fields?.includes(f);
  // 保存时用:能力表没放开的字段一律存空串(= 不下发)。见下面 body 里的注释。
  const keep = (f, v) => (has(f) && v !== null && v !== undefined ? v : '');
  // 透明背景与 jpeg 互斥(官方与 apimart 文档都写明);只提示不硬拦 —— 上游枚举将来可能放宽。
  // 冲突提示只在【两个控件都真的渲染出来】时才有意义:该模型没放开这两个键时,这两个值
  // 根本不会下发(imageParams 门掉),界面上也没有控件可改 —— 再弹一条红字就是让用户看着
  // 一个他修不了、也不会发生的错误。存量残值(transparent + jpeg)切到中转渠道就是这形态。
  const bgConflict = has('background') && has('outputFormat')
    && form.background === 'transparent' && form.outputFormat === 'jpeg';
  // r84 mj:版本分档由已存的值反推(空 = 写实档的"默认")—— 存的仍是一个字符串,
  // 不引入第二个字段,省掉"两个控件必须配对填对"的一整类 bug。
  const mjGroup = MJ_VERSION_GROUPS.find((g) => g.versions.includes(form.mjVersion)) || MJ_VERSION_GROUPS[0];
  // 自定义比例的两格必须有自己的状态:只填了宽时 form.size 还不成立(写进去就是半截值),
  // 靠 form.size 反推会让刚敲进去的数字立刻消失。
  const [customWH, setCustomWH] = useState(() => (/^\d+:\d+$/.test(initial.size || '') ? String(initial.size).split(':') : ['', '']));
  const [customW, customH] = customWH;
  const setCustomRatio = (w, h) => {
    setCustomWH([w, h]);
    // 两格都有值才成一个比例;缺一格时把 size 清空,避免把 "16:" 这种半截值发上去。
    setForm((f) => ({ ...f, size: w && h ? `${w}:${h}` : '' }));
  };

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
        // r84:仅 mj 协议有意义;换成别的协议时一并清空,避免存量脏值在切回来时突然生效。
        mjVersion: form.protocol === 'mj' ? (form.mjVersion || '') : '',
        mjSpeed: form.protocol === 'mj' ? (form.mjSpeed || '') : '',
        // r87:方言描述的是【上游本身】不是某个协议的参数,所以换协议不清空(换回来时它仍然
        // 是对的)。其余结构化参数按【当前 (方言, 模型) 的能力表】过滤后再存:控件是按能力表
        // 显隐的,换个模型控件就消失但值还在 —— 不清的话下次保存又把它写回去,而界面上根本
        // 没有控件能清掉它。协议层同样有这道门(imageParams),这里是双保险,顺带让存量残值
        // 在用户下一次保存时被清掉。要发能力表没列的键,写「附加参数」。
        dialect: form.dialect || 'openai',
        resolution: keep('resolution', form.resolution),
        quality: keep('quality', form.quality),
        outputFormat: keep('outputFormat', form.outputFormat),
        background: keep('background', form.background),
        moderation: keep('moderation', form.moderation),
        n: keep('n', form.n) === '' ? '' : Number(form.n),
        nsfwCheck: has('nsfwCheck') && form.nsfwCheck === true,
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
      {/* r82:任务制协议与三种同步协议的下发内容不同，选中时把差异写清楚（不写的话
          用户会按同步协议的直觉去填尺寸与参考图，然后得到一个"填了没生效"的结果）。 */}
      {form.protocol === 'mj' && (
        <div className="text-[10px] text-ink-faint font-body leading-snug">
          请求发往「接口地址」+ /midjourney/generations，请求体包含提示词、宽高比、版本、速度与附加参数（extra）；模型名不发送，由该路由自动注入。当前版本不支持参考图，已选择的参考图不会随请求发送。提交后服务端每 5 秒查询一次任务状态，单次生成通常需要 1–2 分钟，一次返回 4 张图并分别落盘；超过 15 分钟未出结果记为失败，此时平台侧任务可能仍在继续。
        </div>
      )}
      <label className="space-y-1 block"><span className={labelCls}>接口地址（baseURL，不含 /images/generations 等路径后缀）</span>
        <input
          className={inputCls}
          value={form.baseURL}
          onChange={(e) => {
            const baseURL = e.target.value;
            // r87:未手改过方言时按 host 预选(api.apimart.ai → apimart，其余官方语义)。
            setForm((f) => ({ ...f, baseURL, ...(dialectTouched ? {} : { dialect: dialectForBaseURL(baseURL) }) }));
          }}
          placeholder="https://api.example.com/v1"
        />
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
              onClick={() => setBrowsing(true)}
              disabled={!(form.models || []).length}
              title={(form.models || []).length ? '浏览全部候选模型（带搜索）' : '候选列表为空，请先「拉取模型」或直接在左侧输入模型名'}
              className="shrink-0 px-2 rounded-md border border-canvas-deep text-[11.5px] text-ink-soft font-body hover:bg-canvas-deep/60 disabled:opacity-50"
            >浏览</button>
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
      {/* r87:同一个 size 键在两边同名反义(官方 = 像素、apimart = 宽高比),同一个模型名
          在两个上游上语义相反,所以参数面板与请求组装都必须按方言分叉。默认按接口地址预选。 */}
      {form.protocol === 'openai' && (
        <label className="space-y-1 block"><span className={labelCls}>上游方言</span>
          <select
            className={inputCls}
            value={form.dialect || 'openai'}
            onChange={(e) => { setDialectTouched(true); setForm((f) => ({ ...f, dialect: e.target.value })); }}
          >
            {IMG_DIALECTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <span className="text-[10px] text-ink-faint font-body leading-snug block">
            按接口地址自动预选，可手动改。选错会让尺寸按另一种语义解析：官方语义下填 16:9 不是该上游期望的形态（官方只收像素串）。apimart 以比例为主，同时也接受像素串。
          </span>
        </label>
      )}
      {/* r84:mj 的 size 语义与其余协议不同(宽高比而非像素),故整块换掉 —— 沿用像素输入框
          会让用户按 3840x2160 的直觉去填,上游把它当比例解析。 */}
      {ratioMode ? (
        <div className="space-y-1"><span className={labelCls}>宽高比（apimart 的 size 字段）</span>
          <div className="flex flex-wrap gap-1">
            {APIMART_RATIOS.filter(([r]) => sizeCap.options.includes(r)).map(([r, use]) => (
              <button
                type="button"
                key={r}
                onClick={() => setForm((f) => ({ ...f, size: f.size === r ? '' : r }))}
                className={`px-2 py-1 rounded-md border text-[11px] font-body leading-tight ${form.size === r ? 'border-accent bg-accent/10 text-ink' : 'border-canvas-deep text-ink-soft hover:bg-canvas-deep/60'}`}
              >
                <span className="block font-mono">{r}</span>
                <span className="block text-[9.5px] text-ink-faint">{use}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10.5px] text-ink-faint font-body">自定义</span>
            <input
              className={`${inputCls} w-16 text-center`}
              inputMode="numeric"
              value={customW}
              onChange={(e) => setCustomRatio(e.target.value.replace(/\D/g, ''), customH)}
              placeholder="宽"
            />
            <span className="text-[11px] text-ink-faint font-mono">:</span>
            <input
              className={`${inputCls} w-16 text-center`}
              inputMode="numeric"
              value={customH}
              onChange={(e) => setCustomRatio(customW, e.target.value.replace(/\D/g, ''))}
              placeholder="高"
            />
            <span className="text-[10px] text-ink-faint font-body">{form.size ? `当前 ${form.size}` : '未指定，由上游取默认比例'}</span>
          </div>
          <span className="text-[10px] text-ink-faint font-body leading-snug block">
            该上游的 size 是比例不是像素{has('resolution') ? '，实际输出像素由比例与「分辨率档」共同决定' : '，该模型没有分辨率档，输出像素由上游按比例决定'}。也可直接填像素串（如 1881x836），该上游同时接受这种形态。候选按 {sizeCap.family} 的文档范围列出，手动输入不受限制。
          </span>
        </div>
      ) : form.protocol === 'mj' ? (
        <div className="space-y-1"><span className={labelCls}>宽高比（对应 Midjourney 的 --ar）</span>
          <div className="flex flex-wrap gap-1">
            {MJ_RATIOS.map(([r, use]) => (
              <button
                type="button"
                key={r}
                onClick={() => setForm((f) => ({ ...f, size: f.size === r ? '' : r }))}
                className={`px-2 py-1 rounded-md border text-[11px] font-body leading-tight ${form.size === r ? 'border-accent bg-accent/10 text-ink' : 'border-canvas-deep text-ink-soft hover:bg-canvas-deep/60'}`}
              >
                <span className="block font-mono">{r}</span>
                <span className="block text-[9.5px] text-ink-faint">{use}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10.5px] text-ink-faint font-body">自定义</span>
            <input
              className={`${inputCls} w-16 text-center`}
              inputMode="numeric"
              value={customW}
              onChange={(e) => setCustomRatio(e.target.value.replace(/\D/g, ''), customH)}
              placeholder="宽"
            />
            <span className="text-[11px] text-ink-faint font-mono">:</span>
            <input
              className={`${inputCls} w-16 text-center`}
              inputMode="numeric"
              value={customH}
              onChange={(e) => setCustomRatio(customW, e.target.value.replace(/\D/g, ''))}
              placeholder="高"
            />
            <span className="text-[10px] text-ink-faint font-body">{form.size ? `当前 ${form.size}` : '未指定，由服务端取默认比例'}</span>
          </div>
          {/* 存量条目可能存着像素值(r82 时该字段不下发,填什么都不影响);现在它会真发出去。 */}
          {form.size && !/^\d+:\d+$/.test(form.size) && (
            <span className="text-[10px] text-error font-body leading-snug block">
              当前值不是宽高比格式，会被上游按宽高比解析。请选择上面的预设或填写两格自定义值。
            </span>
          )}
          <span className="text-[10px] text-ink-faint font-body leading-snug block">
            这里填的是比例不是像素。出图像素由服务端按该比例决定，提交时无法指定；需要更大的图，在出图后对单张使用放大。
          </span>
        </div>
      ) : (
        <label className="space-y-1 block"><span className={labelCls}>尺寸 / 分辨率</span>
          <input className={inputCls} list="cgui-image-size-options" value={form.size} onChange={set('size')} placeholder="1024x1024" />
          {/* r56:候选随「模型」输入实时收窄 —— 命中已知家族用其官方支持范围,未知模型回落全量。
              只影响候选显示,手输的值一律照发(发送逻辑零改动)。 */}
          <datalist id="cgui-image-size-options">
            {(sizeOptionsFor(dialect, form.model) ?? SIZE_OPTIONS).map((s) => <option key={s} value={s} />)}
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
      )}
      {/* r87 首屏:每次都可能要改的两项(分辨率档 / 张数)。字段按 (方言, 模型) 能力表显隐 ——
          文档没写该模型收这个键就不显示,别让用户填出一个必然被忽略或 400 的值。 */}
      {form.protocol === 'openai' && (sizeCap?.resolutions || has('n')) && (
        <div className="grid grid-cols-2 gap-2">
          {sizeCap?.resolutions && (
            <div className="space-y-1"><span className={labelCls}>分辨率档（resolution）</span>
              <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-warm text-[11px] font-body w-max">
                {['', ...sizeCap.resolutions].map((r) => (
                  <button
                    type="button"
                    key={r || 'default'}
                    onClick={() => setForm((f) => ({ ...f, resolution: r }))}
                    className={`px-3 py-0.5 rounded transition-colors ${(form.resolution || '') === r ? 'bg-accent text-on-accent' : 'text-ink-muted hover:text-ink'}`}
                  >{r || '默认'}</button>
                ))}
              </div>
              <span className="text-[10px] text-ink-faint font-body leading-snug block">
                与宽高比共同决定输出像素。选「默认」不发送该字段，由上游按 1k 出图。
              </span>
            </div>
          )}
          {has('n') && (
            <label className="space-y-1"><span className={labelCls}>图像数量（n）</span>
              <select className={inputCls} value={form.n === '' || form.n === null || form.n === undefined ? '' : String(form.n)} onChange={(e) => setForm((f) => ({ ...f, n: e.target.value === '' ? '' : Number(e.target.value) }))}>
                <option value="">默认（1 张）</option>
                {IMG_COUNTS.map((c) => <option key={c} value={c}>{c} 张</option>)}
              </select>
              <span className="text-[10px] text-ink-faint font-body leading-snug block">
                一次任务出几张图，费用随张数变化，以出图后的实付为准。多张图分别落盘到保存目录，条目里可逐张切换。
              </span>
            </label>
          )}
        </div>
      )}
      {/* r87 高级参数:首屏只留必填与常改项,其余折叠(与 r84 的 mj 同款)。 */}
      {form.protocol === 'openai' && (has('quality') || has('outputFormat') || has('background') || has('moderation') || has('nsfwCheck')) && (
        <details className="rounded-md border border-canvas-deep px-2 py-1.5">
          {/* 摘要按【实际渲染出来的字段】拼:能力表按 (方言, 模型) 显隐,写死四项的话
              apimart 中转渠道(只放开 nsfw_check)的折叠条会承诺三个里面根本没有的控件。 */}
          <summary className="text-[10.5px] text-ink-soft font-body cursor-pointer select-none">
            高级参数（{ADVANCED_FIELD_LABELS.filter(([f]) => has(f)).map(([, l]) => l).join(' / ')}）
          </summary>
          <div className="pt-2 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              {has('quality') && (
                <label className="space-y-1"><span className={labelCls}>质量（quality）</span>
                  <select className={inputCls} value={form.quality || ''} onChange={set('quality')}>
                    <option value="">默认（不指定）</option>
                    {(sizeCap.qualities || []).map((q) => <option key={q} value={q}>{IMG_QUALITY_LABELS[q] || q}</option>)}
                  </select>
                </label>
              )}
              {has('outputFormat') && (
                <label className="space-y-1"><span className={labelCls}>输出格式（output_format）</span>
                  <select className={inputCls} value={form.outputFormat || ''} onChange={set('outputFormat')}>
                    <option value="">默认（png）</option>
                    {(sizeCap.formats || []).map((f) => <option key={f} value={f}>{IMG_FORMAT_LABELS[f] || f}</option>)}
                  </select>
                </label>
              )}
              {has('background') && (
                <label className="space-y-1"><span className={labelCls}>背景（background）</span>
                  <select className={inputCls} value={form.background || ''} onChange={set('background')}>
                    <option value="">默认（不指定）</option>
                    {IMG_BACKGROUNDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
              )}
              {has('moderation') && (
                <label className="space-y-1"><span className={labelCls}>审核强度（moderation）</span>
                  <select className={inputCls} value={form.moderation || ''} onChange={set('moderation')}>
                    <option value="">默认（不指定）</option>
                    {IMG_MODERATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <span className="text-[10px] text-ink-faint font-body leading-snug block">
                    出图时上游模型的内容过滤松紧{has('nsfwCheck') ? '，与「提交前预审」是两件不同的事' : ''}。
                  </span>
                </label>
              )}
            </div>
            {bgConflict && (
              <span className="text-[10px] text-error font-body leading-snug block">
                背景选择透明时，输出格式必须是 png 或 webp；当前的 jpeg 不支持透明通道，上游会返回错误。
              </span>
            )}
            {has('nsfwCheck') && (
              <label className="flex items-start gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.nsfwCheck === true}
                  onChange={(e) => setForm((f) => ({ ...f, nsfwCheck: e.target.checked }))}
                  className="mt-0.5 accent-accent shrink-0"
                />
                <span className="space-y-0.5">
                  <span className={`${labelCls} block`}>提交前预审（nsfw_check）</span>
                  <span className="text-[10px] text-ink-faint font-body leading-snug block">
                    提交前先用 omni-moderation-latest 审核提示词与输入图片，会额外增加成本与延迟。{has('moderation') ? '与「审核强度」是两件不同的事：本项发生在提交前，审核强度作用于出图时的内容过滤。' : ''}
                  </span>
                </span>
              </label>
            )}
          </div>
        </details>
      )}
      {/* r84:版本 / 速度是文档明列取值的具名参数,做成下拉;冷门参数(stylize / chaos / seed …)
          仍走附加参数 JSON,但给一份可直接复制的样例 —— 用户原话是「不会写」。
          默认折叠:首屏留给地址 / 密钥 / 模型 / 比例这些必填项。 */}
      {form.protocol === 'mj' && (
        <details className="rounded-md border border-canvas-deep px-2 py-1.5">
          <summary className="text-[10.5px] text-ink-soft font-body cursor-pointer select-none">高级参数（版本 / 速度 / 附加参数示例）</summary>
          <div className="pt-2 space-y-2">
            <div className="space-y-1"><span className={labelCls}>风格分档</span>
              <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-warm text-[11px] font-body w-max">
                {MJ_VERSION_GROUPS.map((g) => (
                  <button
                    type="button"
                    key={g.id}
                    title={g.hint}
                    onClick={() => setForm((f) => ({ ...f, mjVersion: g.id === 'niji' ? g.versions[0] : '' }))}
                    className={`px-3 py-0.5 rounded transition-colors ${g.id === mjGroup.id ? 'bg-accent text-on-accent' : 'text-ink-muted hover:text-ink'}`}
                  >{g.label}</button>
                ))}
              </div>
              <span className="text-[10px] text-ink-faint font-body leading-snug block">{mjGroup.hint}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1"><span className={labelCls}>版本</span>
                <select className={inputCls} value={form.mjVersion || ''} onChange={set('mjVersion')}>
                  {mjGroup.id === 'mj' && <option value="">默认（不指定版本）</option>}
                  {mjGroup.versions.map((v) => <option key={v} value={v}>{MJ_VERSION_LABEL[v] || `v${v}`}</option>)}
                </select>
              </label>
              <label className="space-y-1"><span className={labelCls}>速度</span>
                <select className={inputCls} value={form.mjSpeed || ''} onChange={set('mjSpeed')}>
                  {MJ_SPEEDS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </label>
            </div>
            <div className="space-y-1">
              <span className={labelCls}>其余参数写进下方「附加参数」，可复制此样例后改数值</span>
              <div className="flex items-center gap-1">
                <code className="flex-1 min-w-0 truncate rounded-md bg-canvas-warm border border-canvas-deep px-2 py-1 text-[10.5px] text-ink-soft font-mono" title={MJ_EXTRA_EXAMPLE}>{MJ_EXTRA_EXAMPLE}</code>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, extra: MJ_EXTRA_EXAMPLE }))}
                  className="shrink-0 px-2 py-1 rounded-md border border-canvas-deep text-[10.5px] text-ink-soft font-body hover:bg-canvas-deep/60"
                >填入</button>
              </div>
              <span className="text-[10px] text-ink-faint font-body leading-snug block">可用字段：{MJ_EXTRA_FIELDS}。同名键以附加参数为准，会覆盖上面的下拉与比例。</span>
            </div>
          </div>
        </details>
      )}
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
      {/* r87:「浏览」= 全量候选 + 搜索,选中回填输入框。刻意用【模态】不用锚定浮层 ——
          本表单在滚动容器里,浮层在 WKWebView 下的定位与 sticky 都踩过坑(r83 已就此改过)。 */}
      {browsing && (
        <ModelPickModal
          candidates={form.models || []}
          existing={form.model ? [form.model] : []}
          title="选择模型"
          onClose={() => setBrowsing(false)}
          onPick={(id) => { setForm((f) => ({ ...f, model: id })); setBrowsing(false); }}
        />
      )}
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
  // r95:放大层当前这张 = { id, index }(哪条任务的第几张),src/name/path 全部现算。
  // 刻意不存 src 快照:轮询每 1.5s 换一遍 history,快照会过期,也没法在序列里左右移动。
  const [zoom, setZoom] = useState(null);
  const [tab, setTab] = useState('gen'); // gen | jobs —— 局部态,切 tab 不重挂面板,轮询照跑
  const [taskView, setTaskView] = useState(readTaskView); // grid | list
  const [form, setForm] = useState(null); // null = 不在表单态
  // r54 参考图(图生图)。刻意【不进 localStorage 草稿】:一张图就能把 5MB 配额撑爆,
  // 重开面板参考图清空可接受(提示词照旧保留)。
  const [refs, setRefs] = useState([]);
  // r84 多图:条目 id → 选中的第几张。没有记录 = 第 0 张(单图条目永远走这条)。
  // 刻意不持久化:它是"我现在在看哪张",不是配置。
  const [picked, setPicked] = useState({});
  // r54 删除:selectMode = 批量选择开关,selectedIds = 勾中的 jobId 集合。
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const promptRef = useRef(null);
  const refFileRef = useRef(null);
  // r58: 关面板时把还挂着的 objectURL 撤掉。用 ref 镜像 refs 是为了让卸载 effect 的依赖
  // 数组保持空 —— 依赖 refs 的话每次增删都会跑一遍清理,把当前正在显示的预览撤没。
  const refsRef = useRef([]);
  useEffect(() => { refsRef.current = refs; }, [refs]);
  useEffect(() => () => { refsRef.current.forEach(revokeRefPreview); }, []);

  // r87 预估价:仅 apimart 方言有(官方 Images API 没有报价接口)。服务端算好直接给数,
  // 拿不到一律 null → 不显示。刻意不做重试/不报错:预估是锦上添花,不该干扰出图。
  const [estCredits, setEstCredits] = useState(null);
  const [estN, setEstN] = useState(1); // 预估对应的张数(服务端按能力表门控后的 n)

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

  // 切 provider(或保存后重载配置)时重新问一次预估;组件卸载/再切走时丢弃迟到的响应。
  useEffect(() => {
    if (!selId) { setEstCredits(null); return undefined; }
    let alive = true;
    setEstCredits(null);
    fetch(`/api/image/pricing?providerId=${encodeURIComponent(selId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setEstCredits(typeof d?.credits === 'number' ? d.credits : null);
        setEstN(Number.isInteger(d?.n) && d.n >= 1 ? d.n : 1);
      })
      .catch(() => { if (alive) setEstCredits(null); });
    return () => { alive = false; };
  }, [selId, providers]);

  // 提示词草稿:每次输入即写 localStorage,重开面板/刷新都填回原文(用户要求生成后也不清空)。
  const setPromptDraft = useCallback((v) => {
    setPrompt(v);
    try { localStorage.setItem(PROMPT_DRAFT_KEY, v); } catch { /* 隐私模式/配额满:草稿丢了不影响出图 */ }
  }, []);

  // r59:点「恢复」是程序化写入 —— 纯 setState 不产生 input 事件,被覆盖掉的原提示词
  // ⌘Z 撤不回。经 applyProgrammaticText 写(旧值先入栈 + 派发 input 带动 onChange →
  // setPromptDraft 照常写草稿)。框未挂载时退回直接 setState,不丢回填。
  const restorePrompt = useCallback((v) => {
    const el = promptRef.current;
    if (el) applyProgrammaticText(el, v);
    else setPromptDraft(v);
  }, [setPromptDraft]);

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
  // r84:条目上"当前这张"的三件套。单图条目(无 files)与改动前逐字等价。
  const shotIdx = (h) => pickedIndex(h, picked[h.id]);
  const shotFile = (h) => pickedFile(h, picked[h.id]);
  const shotUrl = (h) => pickedPreviewUrl(h, picked[h.id]) || h.previewUrl || '';
  const pickShot = (h, i) => { setCurrentId(h.id); setPicked((m) => ({ ...m, [h.id]: i })); };
  // r95 方向键切图:把任务列表拍平成一条可浏览序列 —— 顺序与用户在列表里看到的逐字一致,
  // 所以序列取自 ordered 而不是 history。Lightbox 只管发方向,序列与位置都在这里算。
  const shots = flattenBrowsable(ordered);
  const zoomPos = shotPos(shots, zoom);
  const zoomEntry = zoom ? history.find((h) => h.id === zoom.id) : null;
  const goShot = (dir) => {
    const next = neighbor(shots, zoom, dir);
    if (!next) return; // 到头停住,不循环
    // 只取坐标存进 state:next 还带着 file / prompt,存下来就又成了会过期的快照。
    const { id, index } = next;
    setZoom({ id, index });
    // 选中态跟着走:关掉放大层后预览区与单图操作对着刚看的那张(next 带 id,pickShot 只读 h.id)。
    pickShot(next, index);
  };
  // r84 可追溯:二次操作产生的条目标出"从哪个任务的第几张来的"。
  const originNote = (h) => {
    const tag = `${MJ_ACTION_TAG[h.mjAction] || ''}${h.mjIndex || ''}`;
    // 父记录还在列表里才说"来自…":被删掉之后再说"来自上一任务"是找不到的指路。
    const hasParent = history.some((x) => x.id === h.parentId);
    return `${MJ_ACTION_LABEL[h.mjAction] || h.mjAction} ${tag}${hasParent ? ` · 来自上一任务第 ${h.mjIndex} 张` : ''}`;
  };

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
        next.forEach(revokeRefPreview); // 半路失败:这一批已建的 objectURL 谁也用不到了
        return;
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(new Error(`读取「${f.name}」失败`));
        fr.readAsDataURL(f);
      }).catch((e) => { setErr(e.message); return ''; });
      if (!dataUrl) { next.forEach(revokeRefPreview); return; }
      next.push({
        kind: 'upload',
        name: f.name,
        mime: refMime(f),
        dataB64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        // preview 用 objectURL 而不是整份 dataURL:后者与 dataB64 是同一份 base64 的两个
        // 副本,6×15MB 时渲染进程凭空多背 ~240MB(Win 上 OOM 白屏,wry 还没接 ProcessFailed
        // 不会自愈)。objectURL 只是个句柄,代价是生命周期得自己管 → revokeRefPreview。
        preview: URL.createObjectURL(f),
      });
    }
    setRefs((cur) => [...cur, ...next].slice(0, MAX_REFS));
  };

  // 「以此图修改」:引用已生成的图 —— 只传 file 路径,不把图片内容回传一遍。
  // r84:作用于【当前选中那张】—— 多图任务里恒取第一张的话,后 3 张永远改不了。
  const addHistoryRef = (h) => {
    setErr('');
    setTab('gen');
    const file = shotFile(h);
    if (!file) return;
    setRefs((cur) => {
      if (cur.some((r) => r.kind === 'history' && r.file === file)) return cur;
      if (cur.length >= MAX_REFS) { setErr(`参考图最多 ${MAX_REFS} 张`); return cur; }
      return [...cur, { kind: 'history', file, name: file.split(/[/\\]/).pop(), preview: entryPreviewUrl(file) }];
    });
  };

  // r84「清空」:一键清掉提示词与参考图,准备下一张。刻意【不弹确认】——
  // 它是随手要用的动作,且提示词经 restorePrompt 写入(走撤销通道,⌘Z 能撤回),
  // 参考图重新选也就几秒。restorePrompt('') 同时会把 localStorage 草稿写空 ——
  // 只清内存的话刷新一下提示词又回来了(草稿是刻意持久的)。
  const clearInputs = () => {
    setErr('');
    restorePrompt('');
    refs.forEach(revokeRefPreview); // objectURL 不撤就一直挂在文档上
    setRefs([]);
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
      // r95:受理成功就把预览区指向新任务 —— 否则新任务跑着,预览区还挂着上一轮的图。
      // 新任务不是 done,下面的预览区 done 门控自然就不渲染旧图了,不必另加"清预览"开关。
      setCurrentId(d.jobId);
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
  // r84:二次操作(放大 / 变体)的报错。与 revealErr 分开 —— 两者的成因与处置完全不同。
  const [actionErr, setActionErr] = useState('');
  const [actionBusy, setActionBusy] = useState(''); // 提交中的 `${jobId}:${action}:${index}`

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
  /**
   * r84:对某条已完成的 mj 任务的第 index 张(1-4)发起放大 / 变体。
   * 服务端复用同一条流水线(提交 → 轮询 → 落盘),这里只管发起与报错。
   */
  const submitAction = async (h, action, index) => {
    const busyKey = `${h.id}:${action}:${index}`;
    if (actionBusy) return; // 双击防重:提交那一瞬只允许一个
    setActionErr('');
    setActionBusy(busyKey);
    try {
      const r = await fetch('/api/image/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: h.id, action, index }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `提交失败（${r.status}）`);
      if (d.jobId) setCurrentId(d.jobId); // r95:与「生成」同口径,预览区跟到新任务上
      loadHistory();
    } catch (e) {
      setActionErr(`${MJ_ACTION_LABEL[action] || action}失败：${e.message}`);
    } finally {
      setActionBusy('');
    }
  };

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
      // 两种"没删掉"成因与解法完全不同,必须分开说:守卫拒 = 去改配置(保存路径),
      // unlink 抛错 = 去关掉占着文件的程序(Windows 上看图程序/缩略图缓存常占着)。
      const notes = [];
      if (d.skipped?.length) notes.push(`${d.skipped.length} 个图片文件未删除：文件路径不在生图 provider 的保存目录之内。`);
      if (d.failed?.length) notes.push(`${d.failed.length} 个图片文件删除失败：文件可能正被其他程序占用，请关闭后重试。`);
      if (notes.length) setErr(notes.join(' '));
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

  // r84 多图缩略条:一个任务出多张时才出现(单图条目返回 null,渲染与改动前一致)。
  // 点某张 = 选中它,上面的大图、放大、以此图修改、在文件夹中显示随之切过去 ——
  // 悬停虽然也能看,但"作用于哪一张"必须由一次明确的点击决定,不能靠鼠标停在哪。
  const imageStrip = (h) => {
    const list = entryFiles(h);
    if (h.status !== 'done' || list.length < 2) return null;
    const cur = shotIdx(h);
    // 二次操作只对 mj 协议、且记了上游任务号的条目开放(r84 之前的老记录没有 taskId,
    // provider 被删或改了协议时同样不给入口 —— 点了必然失败的按钮不该存在)。
    const canAct = !!h.taskId && providers.find((p) => p.id === h.providerId)?.protocol === 'mj';
    return (
      <div className="grid grid-cols-4 gap-1">
        {list.map((f, i) => (
          <div key={f} className={`relative rounded overflow-hidden border ${i === cur ? 'border-accent' : 'border-canvas-deep hover:border-ink-faint'}`}>
            <button
              type="button"
              onClick={() => pickShot(h, i)}
              title={canAct ? `第 ${i + 1} 张（${MJ_GRID_POSITIONS[i] || ''}）：点击选中，大图与单图操作都作用于它；选中后这张下方出现放大 / 变体` : `第 ${i + 1} 张：点击选中，大图与单图操作都作用于它`}
              className="block w-full"
            >
              <img src={entryPreviewUrl(f)} alt={`第 ${i + 1} 张`} className="w-full aspect-square object-cover" />
            </button>
            {canAct && i === cur && (
              // 【只给选中那张渲染】动作条,不用 opacity 藏 —— computed opacity:0 的按钮仍然
              // 命中 elementFromPoint,它盖住缩略图底部约 1/4:在没有 hover 的触屏上,
              // "点一下选中"的第一下就会落在隐藏按钮上直接提交一个【要计费】的任务。
              // 隐藏态加 pointer-events-none 也能挡,但少一个"两个类必须同时对"的失效面。
              <div className="absolute inset-x-0 bottom-0 flex gap-px">
                {['upscale', 'variation'].map((act) => (
                  <button
                    type="button"
                    key={act}
                    disabled={!!actionBusy}
                    onClick={() => submitAction(h, act, i + 1)}
                    title={act === 'upscale'
                      ? `放大：取出四宫格里的第 ${i + 1} 张（${MJ_GRID_POSITIONS[i] || ''}）作为单图，结果记为新任务`
                      : `变体：以第 ${i + 1} 张（${MJ_GRID_POSITIONS[i] || ''}）为基础重新生成一组，结果记为新任务`}
                    className="flex-1 py-0.5 bg-canvas-deep/85 text-[9.5px] text-ink font-body hover:bg-accent hover:text-on-accent disabled:opacity-50"
                  >{MJ_ACTION_LABEL[act]}</button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  // 两种视图共用的条目操作,避免两处各写一份走样。
  const taskActions = (h) => (
    <>
      {h.status === 'running' && (
        <button
          type="button"
          onClick={() => cancelJob(h.id)}
          title="取消：停止该生成任务"
          className="px-1.5 py-1 rounded border border-canvas-deep text-ink-soft hover:bg-canvas-deep/60 flex items-center"
        ><X size={13} /></button>
      )}
      {h.status === 'done' && shotFile(h) && (
        <button
          type="button"
          onClick={() => addHistoryRef(h)}
          title="以此图修改：把这张图作为参考图，在它的基础上继续修改"
          className="px-1.5 py-1 rounded border border-canvas-deep text-ink-soft hover:bg-canvas-deep/60 flex items-center"
        ><Image size={13} /></button>
      )}
      {h.status === 'done' && shotFile(h) && (
        <button
          type="button"
          onClick={() => reveal(shotFile(h))}
          title="在文件夹中显示"
          className="px-1.5 py-1 rounded border border-canvas-deep text-ink-soft hover:bg-canvas-deep/60 flex items-center"
        ><ExternalLink size={13} /></button>
      )}
      <button
        type="button"
        onClick={() => { restorePrompt(h.prompt || ''); setTab('gen'); }}
        title="恢复：把该条提示词填回输入框并切到生图页"
        className="px-1.5 py-1 rounded border border-canvas-deep text-ink-soft hover:bg-canvas-deep/60 flex items-center"
      ><RotateCcw size={13} /></button>
      <button
        type="button"
        onClick={() => deleteEntries([h.id])}
        title="删除：删除这条记录"
        className="px-1.5 py-1 rounded border border-canvas-deep text-error hover:bg-canvas-deep/60 flex items-center"
      ><Trash2 size={13} /></button>
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
                    onClick={() => { revokeRefPreview(r); setRefs((cur) => cur.filter((_, j) => j !== i)); }}
                    title="移除该参考图"
                    className="p-0.5 rounded hover:bg-canvas-deep/60 text-ink-faint"
                  ><X size={10} /></button>
                </span>
              ))}
            </div>
          )}
          {/* r82:mj 协议当前不下发参考图 —— 选了却静默丢弃比不让选更难排查。 */}
          {selected?.protocol === 'mj' && refs.length > 0 && (
            <div className="text-[10px] text-ink-faint font-body leading-snug">
              当前 provider 使用 Midjourney 协议，参考图不会随请求发送。
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
          <button
            type="button"
            onClick={clearInputs}
            disabled={!prompt && !refs.length}
            title="清空提示词与参考图；提示词可用撤销（⌘Z / Ctrl+Z）恢复"
            className="px-3 py-1.5 rounded-md border border-canvas-deep text-[12px] text-ink-soft font-body hover:bg-canvas-deep/60 disabled:opacity-50"
          >清空</button>
          {refs.length > 0 && (
            <span className="text-[11px] text-ink-faint font-body">图生图（{refs.length} 张参考）</span>
          )}
          {/* r87:仅 apimart 方言、且报价接口给得出这一档的价格时才显示。展示价按平台的
              default 分组算，实际扣费可能低于它，故只说"约"；出图后以任务列表里的实付为准。 */}
          {estCredits !== null && (
            <span className="text-[11px] text-ink-faint font-body">预估约 {fmtAmount(estCredits)} credits（按 {estN} 张、平台展示价估算，以出图后的实付为准）</span>
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
            src={shotUrl(current)}
            alt={current.prompt}
            onClick={() => setZoom({ id: current.id, index: shotIdx(current) })}
            className="w-full rounded-panel border border-canvas-deep cursor-zoom-in"
          />
          {imageStrip(current)}
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] text-ink-faint font-mono break-all flex-1">{shotFile(current)}</span>
            <button
              type="button"
              onClick={() => reveal(shotFile(current))}
              className="shrink-0 px-2 py-1 rounded border border-canvas-deep text-[11px] text-ink-soft font-body hover:bg-canvas-deep/60 flex items-center gap-1"
            ><ExternalLink size={11} />在文件夹中显示</button>
          </div>
          {revealErr && <div className="text-[11px] text-error font-body">{revealErr}</div>}
          {actionErr && <div className="text-[11px] text-error font-body break-all">{actionErr}</div>}
        </div>
      )}

      {/* r95:受理新任务后 currentId 指向它,上面的 done 门控自然就不渲染上一轮的图了。
          这里补一行状态 —— 预览区凭空变空会被当成 bug。文案与任务列表逐字同源,
          秒数靠 1.5s 轮询重渲染自然跳动,不另起计时器。 */}
      {current && current.status !== 'done' && (
        <div className={`flex items-center gap-2 rounded-panel border border-canvas-deep px-3 py-4 ${tab === 'gen' ? '' : 'hidden'}`}>
          {current.status === 'running' ? (
            <>
              <Loader2 size={14} className="animate-spin text-ink-faint" />
              <span className="text-[11px] text-ink-faint font-body">生成中 · {elapsedSec(current)}s{current.progress == null ? '' : ` · ${current.progress}%`}</span>
            </>
          ) : (
            <span className="text-[11px] text-error font-body break-all">
              {STATUS_LABEL[current.status] || current.status}{current.error ? ` · ${current.error}` : ''}{cancelNote(current)}
            </span>
          )}
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
        {actionErr && <div className="text-[11px] text-error font-body break-all">{actionErr}</div>}
        <div className={taskView === 'grid' ? 'grid grid-cols-2 gap-2' : 'space-y-1.5'}>
          {ordered.map((h) => (taskView === 'grid' ? (
            <div key={h.id} className={`rounded-panel border overflow-hidden ${h.id === currentId ? 'border-accent' : 'border-canvas-deep'}`}>
              {h.status === 'done' && shotUrl(h) ? (
                <img
                  src={shotUrl(h)}
                  alt={h.prompt}
                  onClick={() => { setCurrentId(h.id); setZoom({ id: h.id, index: shotIdx(h) }); }}
                  className="w-full aspect-square object-cover cursor-zoom-in"
                />
              ) : (
                <div className="w-full aspect-square bg-canvas-warm flex flex-col items-center justify-center gap-1 px-2 text-center">
                  {h.status === 'running' ? (
                    <>
                      <Loader2 size={16} className="animate-spin text-ink-faint" />
                      {/* r82:任务制上游会回报进度,有就显示(同步协议没有,保持原样只显示耗时)。 */}
                      <span className="text-[10px] text-ink-faint font-body">生成中 · {elapsedSec(h)}s{h.progress == null ? '' : ` · ${h.progress}%`}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-[10px] text-error font-body break-all line-clamp-5">{h.error || STATUS_LABEL[h.status] || h.status}</span>
                      {h.status === 'cancelled' && <span className="text-[9.5px] text-ink-faint font-body leading-snug break-all">{CANCEL_NOTE}</span>}
                    </>
                  )}
                </div>
              )}
              <div className="px-1.5 py-1 space-y-1">
                {imageStrip(h)}
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
                  {/* r82:一个任务可能出多张图,预览只显示第一张 —— 张数写出来,否则用户
                      不知道保存目录里还多了几个文件。 */}
                  {h.files?.length > 1 ? <span className="mr-1 px-1 rounded bg-canvas-deep/60 text-ink-soft">第 {shotIdx(h) + 1}/{h.files.length} 张</span> : null}
                  {h.mjAction ? <span className="mr-1 px-1 rounded bg-canvas-deep/60 text-ink-soft">{originNote(h)}</span> : null}
                  {STATUS_LABEL[h.status] || h.status} · {shortTime(h.startedAt)}
                  {paidNote(h) ? ` · ${paidNote(h)}` : ''}
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
              {h.status === 'done' && shotUrl(h) ? (
                <img
                  src={shotUrl(h)}
                  alt={h.prompt}
                  onClick={() => { setCurrentId(h.id); setZoom({ id: h.id, index: shotIdx(h) }); }}
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
                  {h.files?.length > 1 ? <span className="mr-1 px-1 rounded bg-canvas-deep/60 text-ink-soft">第 {shotIdx(h) + 1}/{h.files.length} 张</span> : null}
                  {h.mjAction ? <span className="mr-1 px-1 rounded bg-canvas-deep/60 text-ink-soft">{originNote(h)}</span> : null}
                  {h.status === 'running' ? `生成中 · ${elapsedSec(h)}s${h.progress == null ? '' : ` · ${h.progress}%`}` : (STATUS_LABEL[h.status] || h.status)}
                  {cancelNote(h)}
                  {h.status !== 'done' && h.error ? ` · ${h.error}` : ''}
                  {paidNote(h) ? ` · ${paidNote(h)}` : ''}
                  {h.startedAt ? ` · ${shortTime(h.startedAt)}` : ''}
                </div>
                {imageStrip(h)}
              </div>
              <div className="shrink-0 flex items-center gap-1">{taskActions(h)}</div>
            </div>
          )))}
        </div>
      </div>

      {/* r95:src/name/path 现算(与 shotUrl / shotFile 同口径,只是下标取自 zoom);
          到头那侧传 null → 放大层不画那枚按钮。序列只剩 1 张时不显示计数。 */}
      <ImageLightbox
        src={zoomEntry ? (pickedPreviewUrl(zoomEntry, zoom.index) || zoomEntry.previewUrl || '') : ''}
        name={zoomEntry?.prompt || ''}
        path={zoomEntry ? pickedFile(zoomEntry, zoom.index) : ''}
        onClose={() => setZoom(null)}
        onPrev={zoomPos > 0 ? () => goShot(-1) : null}
        onNext={zoomPos >= 0 && zoomPos < shots.length - 1 ? () => goShot(1) : null}
        counter={zoomPos >= 0 && shots.length > 1 ? `${zoomPos + 1} / ${shots.length}` : ''}
      />

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
                    mjVersion: p.mjVersion || '', mjSpeed: p.mjSpeed || '',
                    // r87:服务端回显已把存量条目补成缺省值(方言 openai / 其余空),原样回填。
                    dialect: p.dialect || 'openai', resolution: p.resolution || '', quality: p.quality || '',
                    outputFormat: p.outputFormat || '', background: p.background || '',
                    moderation: p.moderation || '', n: p.n === 0 || p.n ? p.n : '', nsfwCheck: p.nsfwCheck === true,
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
