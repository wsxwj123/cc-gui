import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2, Square, Terminal, Puzzle, Wrench, Gauge, ChevronDown, X, FileText, Paperclip, Shield, ShieldOff, ClipboardList, Check, Pencil, Smartphone, AtSign, MessagesSquare, Folder, CornerLeftUp, Sparkles, ArrowDownToLine, Zap } from 'lucide-react';
import { useStore, PERMISSION_MODES } from '../stores/sessionStore.js';
import { PermissionPrompt } from './PermissionPrompt.jsx';
import { TodoPanel } from './TodoPanel.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { ImageLightbox } from './ImageLightbox.jsx';
import { AnchoredPopover } from './SessionSelectors.jsx';

// Permission mode metadata — mirrors `claude --permission-mode <choice>`。
// P2.1:文案对齐官方六档语义(RESEARCH-mode-semantics §④b);bypass 中文名保持「放任」。
export const MODE_META = {
  default:           { label: '逐步确认', desc: '每次编辑 / 命令 / 网络请求前都询问；只读操作直接执行', icon: Shield,        tone: 'text-ink-muted' },
  acceptEdits:       { label: '接受编辑', desc: '文件编辑与 mkdir/mv/rm 等文件命令直接执行；其它命令、网络、MCP 仍逐次询问', icon: Check,         tone: 'text-amber-600' },
  plan:              { label: '规划', desc: '只读研究并给出方案，批准前不改任何文件；批准计划后自动切到执行档', icon: ClipboardList, tone: 'text-blue-600' },
  auto:              { label: '自动', desc: '由后台安全分类器逐动作审查，通过即执行、有风险才询问；少弹窗但非零风险', icon: Zap,           tone: 'text-emerald-600' },
  bypassPermissions: { label: '放任', desc: '跳过全部权限检查与提示（危险，仅建议在隔离环境使用）', icon: ShieldOff,     tone: 'text-red-500' },
};

// ── auto 档可用性(T3 两层门控) ──────────────────────────────────
// 静态过滤:仅官方 Anthropic provider 显示「自动」(第三方中转不支持 SDK auto 分类器);
// 运行时失败(账户/模型/CLI 版本不够)由发送错误链路调用 markAutoUnavailable 记本地标记
// (provider+model 键,换 provider/模型自动重试),此后该组合下隐藏。
const AUTO_UNAVAILABLE_KEY = 'cgui-auto-unavailable';
const autoKey = (hint, model) => `${hint || 'anthropic'}|${String(model || '').replace(/\[1m\]/i, '')}`;
export function isAutoUnavailable(hint, model) {
  try { return !!(JSON.parse(localStorage.getItem(AUTO_UNAVAILABLE_KEY) || '{}'))[autoKey(hint, model)]; }
  catch { return false; }
}
export function markAutoUnavailable(hint, model) {
  try {
    const map = JSON.parse(localStorage.getItem(AUTO_UNAVAILABLE_KEY) || '{}');
    map[autoKey(hint, model)] = true;
    localStorage.setItem(AUTO_UNAVAILABLE_KEY, JSON.stringify(map));
  } catch {}
  window.dispatchEvent(new CustomEvent('cgui:auto-availability'));
}
// 当前可见的权限档列表(desktop 模式按钮与手机模式分页共用同一份门控)。
export function useVisiblePermissionModes(permKey = null) {
  const providerHint = useStore((s) => s.currentProvider?.providerHint || 'anthropic');
  const model = useStore((s) => (permKey && s.modelBySession[permKey]) || s.currentModel || '');
  const [, setBump] = useState(0);
  useEffect(() => {
    const f = () => setBump((n) => n + 1);
    window.addEventListener('cgui:auto-availability', f);
    return () => window.removeEventListener('cgui:auto-availability', f);
  }, []);
  return PERMISSION_MODES.filter((m) => m !== 'auto'
    || (providerHint === 'anthropic' && !isAutoUnavailable(providerHint, model)));
}

// 修正批#1b 模式按钮:composer 工具行最左(桌面+手机同入口),弹层上弹。
// 文案自适应:有空间显示档位名,容器变窄自动只留图标(container query,
// .cgui-composer-tools / .cgui-perm-label 见 index.css)——桌面窄分屏与手机同一套逻辑。
export function PermissionModeSelector({ permKey, tourAnchor = false }) {
  // Read THIS session's mode (keyed). Subscribing to the map slice keeps the
  // chip in sync when the active session changes underneath us.
  const permissionMode = useStore((s) => (permKey ? (s.permissionModeBySession[permKey] || s.permissionMode) : s.permissionMode));
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const visibleModes = useVisiblePermissionModes(permKey);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const current = MODE_META[permissionMode] || MODE_META.default;
  const Icon = current.icon;

  return (
    <div ref={wrapRef} className="relative" data-tour={tourAnchor ? 'mode-selector' : undefined}>
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-black/5 transition-colors"
        title={`权限模式: ${current.label} — ${current.desc}`}>
        <Icon size={12} className={current.tone} />
        <span className={`cgui-perm-label text-[11px] font-body whitespace-nowrap ${current.tone}`}>{current.label}</span>
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      <AnchoredPopover anchorRef={wrapRef} open={open} onRequestClose={() => setOpen(false)} drop="up"
        className="w-64 max-w-[calc(var(--app-w,100vw)-1.5rem)] py-1 max-h-[min(60vh,calc(var(--app-h,100dvh)-6rem))] overflow-y-auto">
        <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider font-body">权限模式 (--permission-mode)</div>
        {visibleModes.map((m) => {
          const meta = MODE_META[m];
          const MIcon = meta.icon;
          return (
            <button key={m}
              onClick={() => {
                // plan 与 agent 不再互斥:内置 agent 的 tools 已含 ExitPlanMode,
                // agent 主控本体在 plan 模式下能正常出计划卡片(headless 实证)。
                setPermissionMode(m, permKey);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 flex items-start gap-2 ${permissionMode === m ? 'bg-accent/12' : ''} hover:bg-black/5`}>
              <MIcon size={13} className={`${meta.tone} mt-0.5 shrink-0`} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-ink font-body">{meta.label}</div>
                <div className="text-[10px] text-ink-faint font-body">{meta.desc}</div>
              </div>
              {permissionMode === m && <div className="w-1.5 h-1.5 rounded-full bg-accent mt-1.5 shrink-0" />}
            </button>
          );
        })}
      </AnchoredPopover>
    </div>
  );
}

// 修正批#1b:composer ⋮ 菜单已删除(用户终稿布局)。远程控制迁顶栏
// (RemoteControlButton,手机走 MobileMenu 同一行);「转后台」并入流式时的
// 输入行独立按钮(全平台,原仅手机兜底的那颗)。单一入口,无功能丢失。

export const EFFORT_LEVELS = [
  { id: '',       label: '默认', desc: '让 CLI 自己决定' },
  { id: 'low',    label: '低',   desc: '快速、便宜' },
  { id: 'medium', label: '中',   desc: '平衡' },
  { id: 'high',   label: '高',   desc: '深思' },
  { id: 'xhigh',  label: '极高', desc: '复杂推理' },
  { id: 'max',    label: '极限', desc: '最大努力' },
];

// 修正批#1b:力度按钮(顶栏,作用于活跃窗格会话)。弹层走 AnchoredPopover。
export function EffortSelector({ permKey = null, hideLabel = false, tourAnchor = false, drop = 'down' }) {
  // Per-SESSION effort:这条会话自己的力度,无 entry 回落全局默认。和模型/权限一样按
  // 会话隔离持久化,改它不影响其他会话。
  const effort = useStore((s) => (permKey && permKey in (s.effortBySession || {})) ? s.effortBySession[permKey] : s.effort);
  const openAIProtocol = useStore((s) => (s.currentProvider?.protocol || 'anthropic') === 'openai');
  // 全局默认思考强度(settings 的 CLAUDE_CODE_EFFORT_LEVEL,/api/model 带回)。"默认"档
  // 的真实落点:设了全局 → CLI 吃全局值;没设 → 由模型/服务端自适应。文案照实显示。
  const defaultEffort = useStore((s) => s.defaultEffort || '');
  const setEffort = (id) => useStore.getState().setEffortFor(permKey, id);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const current = EFFORT_LEVELS.find((e) => e.id === effort) || EFFORT_LEVELS[0];

  return (
    <div ref={wrapRef} className="relative" data-tour={tourAnchor ? 'effort-selector' : undefined}>
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-black/5 transition-colors"
        title={openAIProtocol
          ? `Effort: ${current.label}（OpenAI 兼容模式会映射为 reasoning_effort；不支持的端点自动降级）`
          : `Effort: ${current.label}`}>
        <Gauge size={12} className="text-ink-muted" />
        {!hideLabel && <span className="text-[11px] font-body text-ink-muted whitespace-nowrap">{current.label}</span>}
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      <AnchoredPopover anchorRef={wrapRef} open={open} onRequestClose={() => setOpen(false)} drop={drop}
        className="w-44 max-w-[calc(var(--app-w,100vw)-1.5rem)] py-1 max-h-[min(60vh,calc(var(--app-h,100dvh)-6rem))] overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider font-body">
            {openAIProtocol ? '推理力度 (reasoning_effort)' : '推理力度 (--effort)'}
          </div>
          {EFFORT_LEVELS.map((e) => {
            // "默认"档 desc 按真实落点显示:全局(settings 环境变量)设了值时 CLI 会吃它,
            // 并非"CLI 自己决定"——原静态文案在设了全局时是错的(用户实报困惑)。
            const desc = e.id !== '' ? e.desc
              : defaultEffort
                ? `跟随全局设置:${EFFORT_LEVELS.find((x) => x.id === defaultEffort)?.label || defaultEffort}(通用 → 高级 → 环境变量可清除)`
                : '未设全局,由模型自适应';
            return (
            <button key={e.id || 'default'} onClick={() => { setEffort(e.id); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 hover:bg-black/5 flex items-center justify-between ${effort === e.id ? 'bg-accent/12' : ''}`}>
              <div>
                <div className="text-xs font-medium text-ink font-body">{e.label}</div>
                <div className="text-[10px] text-ink-faint font-body">{desc}</div>
              </div>
              {effort === e.id && <div className="w-1.5 h-1.5 rounded-full bg-accent" />}
            </button>
            );
          })}
      </AnchoredPopover>
    </div>
  );
}

const TYPE_ICONS = {
  builtin: Terminal,
  skill: Wrench,
  plugin: Puzzle,
  project: Folder,
};

const TYPE_LABELS = {
  builtin: '内置',
  skill: '技能',
  plugin: '插件',
  project: '项目',
};

// #12:任务清单转圈的"仍在工作"判定用的终态集(与监控页 AgentMonitorPanel 口径一致)。
const TODO_AGENT_TERMINAL = ['done', 'error', 'stopped'];
const TODO_BG_TERMINAL = ['done', 'failed', 'killed', 'stopped', 'error'];

export function ChatInput({ onSend, onStop, onStopBackground, onAccelerate, onBackground, suggestion = null, onDismissSuggestion, disabled, isStreaming, backgroundWorking = false, queueLength = 0, queueItems = [], onRemoveFromQueue, onEditFromQueue, todos = null, plan = '', permKey = null, sessionId = null, tabIndex = null, onBtwOpen, btwUnread = 0 }) {
  const [text, setText] = useState('');
  // 编辑重发态(#4):点击「重新编辑并发送」后进入。此时历史消息尚未被破坏,
  // 按 Esc 可整条取消(清空输入+通知上层撤销待回滚),给用户反悔余地。
  const [editingResend, setEditingResend] = useState(false);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [showCommands, setShowCommands] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commands, setCommands] = useState([]);
  const [provider, setProvider] = useState('Anthropic');
  const [isAnthropic, setIsAnthropic] = useState(true);
  // Pending attachments: { kind, path, preview?, name, bytes }
  const [attachments, setAttachments] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [zoomImage, setZoomImage] = useState(null); // #7 单击放大的图片附件
  // @ 引用选择器(Tutti 式上下文引用):光标前出现 `@xxx` 时弹出,文件 tab 插入
  // `@相对路径`(CLI 原生 @ 语法读文件),会话 tab 把该会话导出为精简 md 后插入 `@绝对路径`。
  const [atState, setAtState] = useState(null); // null | { query, start } start = '@' 在 text 中的下标
  const [atTab, setAtTab] = useState('files');  // 'files' | 'sessions'
  const [atFiles, setAtFiles] = useState([]);   // [{ kind:'up'|'dir'|'file', name, rel }]
  const [atDir, setAtDir] = useState('');       // 层级浏览中的当前相对目录('' = 项目根)
  const [atIndex, setAtIndex] = useState(0);
  const [atBusy, setAtBusy] = useState(false);  // 会话引用生成中
  const atCtxRef = useRef({ cwd: '', projectHash: '' }); // 打开面板时快照,避免 selector 新引用重渲
  const sessions = useStore((s) => s.sessions);
  // P2.4:data-tour 锚点只挂在【活跃窗格】—— composer per-pane 渲染后锚点会出现多份,
  // GuideTour querySelector 取首个可能圈错窗格;cgui:open-provider 也按此门控单实例响应。
  const paneIsActive = useStore((s) => (s.paneCount || 1) === 1 || (s.activeTabIndex || 0) === (tabIndex ?? 0));
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const draftBeforeHistoryRef = useRef('');
  const navigatingHistoryRef = useRef(false);

  // 双击 Esc 停止生成:唯一实现在 App.jsx 的 window 级 effect(带 paneIsActive 守卫
  // + permission 让行 + backgroundPid 支持)。这里曾有第二份 document 捕获实现(CD-2),
  // 无 pane 守卫且捕获阶段先于守卫版执行 → 分屏多窗格流式时一次双击全停(用户实报,
  // AZ1 只守卫了 App.jsx 那份漏了这份)——已删,禁止在此重加。textarea 的 Esc 只
  // preventDefault 不 stopPropagation,事件照常冒泡到 window,守卫版收得到。
  // Permission mode lives in the store, keyed per-session via permKey so each
  // conversation keeps its own mode. Fall back to the global value only when
  // no key is supplied (shouldn't happen in normal render).
  const permissionMode = useStore((s) => (permKey ? (s.permissionModeBySession[permKey] || s.permissionMode) : s.permissionMode));
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  // CI-4:当前 provider 是否无视觉(deepseek 等)。发图会被上游 400(`unknown variant 'image_url'`),
  // 这里提前提示用户;后端 openai-proxy 也会把图剥成文本占位兜底。
  const noVision = useStore((s) => {
    const p = s.currentProvider || {};
    return /deepseek/i.test(p.providerHint || '') || /deepseek/i.test(p.baseUrl || '');
  });
  // While the session is handed off to phone remote control, lock the composer:
  // the hidden `--remote-control` pty owns the session file, so spawning a `-p`
  // turn here would double-write the same jsonl. Reclaim to unlock.
  const rcLocked = useStore((s) => (sessionId ? !!s.remoteControlled[sessionId] : false));
  // #12:任务清单转圈跟随"会话整体是否仍有工作":本地流式 || 本会话活跃子代理(含主会话
  // 停止后仍在跑的后台化子代理)|| 本会话 run_in_background 后台长任务(如模型训练)。
  // 主会话+子代理+后台任务全停才停转。selector 返回布尔,引用稳定不多渲。
  const agentsWorking = useStore((s) => (sessionId
    ? Object.values(s.activeAgents || {}).some((a) => a && a.sessionId === sessionId && !TODO_AGENT_TERMINAL.includes(a.status))
    : false));
  // 部件②总闸计数:本会话仍非终态的子代理/teammate 数。仅用于「回合已结束」(!working)时
  // 显示独立「停止后台 N」按钮 —— 门控见下方按钮区。selector 返回数字(基元,引用稳定不多渲)。
  const bgSubagentCount = useStore((s) => (sessionId
    ? Object.values(s.activeAgents || {}).filter((a) => a && a.sessionId === sessionId && !TODO_AGENT_TERMINAL.includes(a.status)).length
    : 0));
  // livePhase 由 App 根的全局活性轮询维护('running'/'idle');'idle'=输出30s无增长≈
  // 不再工作(自然结束无退出码事件,这是唯一可得信号)。无 livePhase(刚起跑)按工作中。
  const bgWorking = useStore((s) => (sessionId
    ? Object.values(s.bgTasks || {}).some((t) => t && t.sessionId === sessionId
        && !TODO_BG_TERMINAL.includes(t.status) && t.livePhase !== 'idle')
    : false));
  // 停止按钮「工作中」判据 = 主会话流在进行 || 本会话有待处理授权卡。服务端已修「子代理后主 agent
  // 续跑过早关流」(chat.js idle 复活守卫),isStreaming 现在能准确反映主流是否在进行(含等前台
  // 子代理、续跑 reattach 期间都保持 true),故不再需要 agentsWorking 兜底。刻意【不含 agentsWorking
  // /bgWorking】:主会话回复完成后即使还有子代理/后台任务在跑,也应显示「发送」让用户继续发消息
  // (对齐 claude desktop:主流完成→可发、主流未完成→入队);且 onStop 停不了后台化子代理 /
  // run_in_background(需进程管理区),那时显示「停止」会误导。
  const hasPendingPerm = useStore((s) => (sessionId ? (s.pendingPermissions || []).some((p) => p.sessionId === sessionId) : false));
  const working = isStreaming || hasPendingPerm;
  const reclaimRemote = async () => {
    if (!sessionId) return;
    try {
      await fetch('/api/remote-control/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    } catch {}
    useStore.getState().setRemoteControl(sessionId, false);
  };

  const draftKey = `cgui-draft:${permKey || 'global'}`;
  const readHistory = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem('cgui-input-history') || '[]');
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x.trim()) : [];
    } catch {
      return [];
    }
  };
  const saveHistoryEntry = (value) => {
    const v = String(value || '').trim();
    if (!v) return;
    const list = readHistory().filter((x) => x !== v);
    list.unshift(v);
    try { localStorage.setItem('cgui-input-history', JSON.stringify(list.slice(0, 100))); } catch {}
  };

  useEffect(() => {
    try { setText(localStorage.getItem(draftKey) || ''); }
    catch { setText(''); }
    setHistoryCursor(-1);
    setEditingResend(false);
    draftBeforeHistoryRef.current = '';
  }, [draftKey]);

  // 串扰#10b:key 变更帧跳过持久化 —— 切会话时本 effect 先于上面的 load effect 引发的
  // rerender 执行,会以【旧 text + 新 key】写一次 localStorage(A 的草稿写进 B 的 key,
  // 随即被 load 覆盖自愈;若两 effect 间卸载/崩溃则残留)。跳过该帧只堵错写,load 后
  // text 的正常变更照常持久化。
  const prevDraftKeyRef = useRef(draftKey);
  useEffect(() => {
    if (prevDraftKeyRef.current !== draftKey) { prevDraftKeyRef.current = draftKey; return; }
    try {
      if (text) localStorage.setItem(draftKey, text);
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, text]);

  // Pane-targeted composer fill ("重新编辑" rollback + queue edit). The event
  // carries targetKey = the originating pane's permKey; only the pane whose key
  // matches fills its composer. Without this guard a fill triggered in ONE split
  // pane wrote into EVERY pane's input box (the "其他会话也被填" bug). Controlled-
  // component setText only — writing textareaRef.value directly desyncs React's
  // value tracker so handleSend's text.trim() sees '' and silently no-ops.
  useEffect(() => {
    const onFill = (e) => {
      const t = e?.detail?.text || '';
      const fillAttach = Array.isArray(e?.detail?.attachments) ? e.detail.attachments : null;
      if (!t && !fillAttach) return;
      const targetKey = e?.detail?.targetKey;
      if (targetKey && targetKey !== permKey) return;
      // append 模式(文件浏览器右键"添加到上下文"):在现有草稿末尾追加,不覆盖。
      // 纯附件回填(t 为空,如截图热键)不动文本框 —— 否则 setText('') 会清掉用户已写的草稿。
      if (e?.detail?.append) setText((prev) => (prev && !/\s$/.test(prev) ? prev + ' ' : prev) + t);
      else if (t) setText(t);
      // 编辑重发:恢复原附件为卡片(缩略图/文件名),可删除、可继续新增,不再是裸 @path 文本。
      // append 模式(如截图热键):在现有附件末尾追加,不覆盖用户已挂的图/文件(按 path 去重)。
      if (fillAttach) {
        if (e?.detail?.appendAttachments) {
          setAttachments((prev) => {
            const seen = new Set(prev.map((a) => a.path));
            return [...prev, ...fillAttach.filter((a) => !seen.has(a.path))];
          });
        } else {
          setAttachments(fillAttach);
        }
      }
      if (e?.detail?.editMode) setEditingResend(true);
      const ta = textareaRef.current;
      if (ta) {
        // Visual flash so the user can't miss the fill.
        ta.classList.add('ring-2', 'ring-accent', 'ring-offset-2');
        setTimeout(() => {
          ta.classList.remove('ring-2', 'ring-accent', 'ring-offset-2');
        }, 1600);
        setTimeout(() => ta.focus(), 0);
      }
    };
    window.addEventListener('cgui:composer-fill', onFill);
    return () => window.removeEventListener('cgui:composer-fill', onFill);
  }, [permKey]);

  // Read a File/Blob as a data URL.
  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const uploadAttachment = async (file) => {
    try {
      // CN-3:把 File 当原始 body 直接发(流式,不经 base64/JSON)——避开 25mb 限制 + 内存膨胀,
      // 大文件也能传。mime 走 Content-Type、文件名走 X-Upload-Name 头。
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Upload-Name': encodeURIComponent(file.name || 'file'),
        },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) {
        confirmDialog('上传失败: ' + (data.error || res.status));
        return;
      }
      // 仅图片生成缩略预览(小);大文件/非图片不读 dataUrl,免内存膨胀。
      const isImage = data.kind === 'image' || file.type.startsWith('image/');
      let preview = null;
      if (isImage) { try { preview = await fileToDataUrl(file); } catch {} }
      setAttachments((prev) => [...prev, {
        kind: data.kind || (isImage ? 'image' : 'text'),
        path: data.path,
        preview,
        name: file.name || data.path.split(/[/\\]+/).pop(),
        bytes: data.bytes,
      }]);
    } catch (err) {
      confirmDialog('上传失败: ' + err.message);
    }
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    // 处理所有文件类型(不只图片):以前只接 image/*,粘贴 PDF/Word/代码等文件时被忽略
    // → OS 退化成把文件路径当纯文本贴进输入框(用户报告的"自动转成路径文本" #3)。
    // 现在所有 kind==='file' 的项都上传为附件,在输入框上方显示缩略图/文件名;普通文本
    // 粘贴(kind==='string')不受影响。
    let handledFile = false;
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) { uploadAttachment(f); handledFile = true; }
      }
    }
    if (handledFile) e.preventDefault();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files || []);
    for (const f of files) {
      uploadAttachment(f);
    }
  };

  const handleFilePick = (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) uploadAttachment(f);
    e.target.value = '';
  };

  const removeAttachment = (path) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  const handleTextChange = (e) => {
    if (!navigatingHistoryRef.current) {
      setHistoryCursor(-1);
      draftBeforeHistoryRef.current = '';
    }
    setText(e.target.value);
    // @ 引用检测:光标前是 `@词`(@ 在行首或空白后)时打开面板;/ 命令面板优先不冲突。
    const caret = e.target.selectionStart ?? e.target.value.length;
    const before = e.target.value.slice(0, caret);
    const m = !e.target.value.startsWith('/') && before.match(/(^|[\s\n])@([^\s@]*)$/);
    if (m) {
      if (!atState) {
        // 打开瞬间快照上下文(cwd/projectHash):优先本窗格会话,回落全局选中项目
        const st = useStore.getState();
        const pane = (st.paneSessions || []).find((x) => x?.sessionId && x.sessionId === sessionId);
        const sess = pane || st.selectedSession;
        atCtxRef.current = {
          cwd: sess?.projectPath || st.selectedProject?.path || '',
          projectHash: sess?.projectHash || st.selectedProject?.hash || '',
        };
        setAtTab('files'); setAtIndex(0); setAtDir('');
      }
      setAtState({ query: m[2], start: caret - m[2].length - 1 });
    } else if (atState) setAtState(null);
  };

  // Refresh slash commands whenever the model/provider may have changed
  // (re-fetch on focus so cc switch picks up without page reload).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      // 项目级命令按当前窗格会话的项目 cwd 扫描(同 @ 引用面板的快照口径:
      // 优先本窗格会话,回落全局选中项目,per-pane 不串扰)
      const st = useStore.getState();
      const pane = (st.paneSessions || []).find((x) => x?.sessionId && x.sessionId === sessionId);
      const cwd = (pane || st.selectedSession)?.projectPath || st.selectedProject?.path || '';
      fetch(`/api/slash-commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)
        .then(r => r.json())
        .then(data => {
          if (cancelled) return;
          setCommands(data.commands || []);
          setProvider(data.provider || 'Anthropic');
          setIsAnthropic(data.isAnthropic !== false);
        })
        .catch(() => {});
    };
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [sessionId]); // 会话切换 → cwd 可能变 → 重取项目级命令

  // Auto-resize textarea. When empty, pin to a single line: an empty textarea's
  // scrollHeight still counts the (long, wrappable) placeholder, so in a narrow
  // split pane the placeholder wraps to 2 lines and inflates the resting height.
  // Only grow to fit real content.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // Use el.value (not React `text`) so mid-IME-composition content — which the
    // DOM holds before onChange commits it to state — still sizes correctly and
    // doesn't snap back to 24px under the caret.
    el.style.height = (el.value ? Math.min(el.scrollHeight, 200) : 24) + 'px';
  }, [text]);

  // Case-insensitive prefix match; rank exact-case matches first.
  const filteredCommands = (() => {
    if (!text.startsWith('/') || text.length === 0) return [];
    const q = text.toLowerCase();
    return commands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .sort((a, b) => {
        const aBlocked = a.requiresAnthropic === 'full' && !isAnthropic;
        const bBlocked = b.requiresAnthropic === 'full' && !isAnthropic;
        if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
        return 0;
      });
  })();

  useEffect(() => {
    setShowCommands(filteredCommands.length > 0 && text.startsWith('/') && text.length > 0);
    setSelectedIndex(0);
    // 含 filteredCommands.length:commands 异步拉取完成时 text 未变,只靠 [text] 不会重跑 →
    // 已输入 / 的情况下列表永远空。count 由 commands/isAnthropic 派生,变化即触发更新。
  }, [text, filteredCommands.length]);

  const handleSend = () => {
    const trimmed = text.trim();
    // Allow send if there's text OR attachments (so "just describe this image" works).
    if (!trimmed && attachments.length === 0) return;
    if (disabled || rcLocked) return;
    // Append attachment paths to the prompt using Claude Code's file-reference
    // shape. It lets the CLI decide whether a path is text, image, PDF, etc.
    const attachmentRefs = attachments.length > 0
      ? '\n\n附件:\n' + attachments.map((a) => (
        `@${a.path}`
      )).join('\n')
      : '';
    const outbound = (trimmed || '请查看这些附件') + attachmentRefs;
    if (trimmed) saveHistoryEntry(trimmed);
    // L3: 气泡显示 trimmed(纯文本)+ 附件卡片;CLI 收 outbound(带 @path)。
    // attachments 经 meta 传到消息记录,MessageBubble 据此渲染缩略图/文件名。
    const meta = attachments.length > 0
      ? { attachments: attachments.map((a) => ({ kind: a.kind, name: a.name, path: a.path, preview: a.preview, bytes: a.bytes })), displayText: trimmed }
      : undefined;
    onSend(outbound, meta ? { meta } : undefined);
    setText('');
    setEditingResend(false);
    setHistoryCursor(-1);
    draftBeforeHistoryRef.current = '';
    setAttachments([]);
    setShowCommands(false);
    setAtState(null);
    try { localStorage.removeItem(draftKey); } catch {}
    textareaRef.current?.focus();
  };

  const selectCommand = (cmd) => {
    if (typeof cmd === 'object') {
      // Block selecting a fully-incompatible slash on a third-party endpoint.
      if (cmd.requiresAnthropic === 'full' && !isAnthropic) return;
      setText(cmd.name + ' ');
    } else {
      setText(cmd + ' ');
    }
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  // ── @ 引用选择器 ──────────────────────────────────────────────
  // 文件 tab 两种模式:
  //  · 无查询 → 按文件浏览器的层级浏览(/api/files/list 列当前层,目录在前;点目录下钻,
  //    「..」返回上级)——全部平铺在大项目里太混乱(用户反馈)。
  //  · 有查询 → 全局模糊搜索(/api/files/search,git ls-files / 递归,后端 15s 缓存)。
  useEffect(() => {
    if (!atState || atTab !== 'files') return;
    const cwd = atCtxRef.current.cwd;
    if (!cwd) { setAtFiles([]); return; }
    const q = atState.query;
    if (!q) {
      let cancelled = false;
      const dirAbs = atDir ? `${cwd}/${atDir}` : cwd;
      fetch(`/api/files/list?path=${encodeURIComponent(dirAbs)}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          const items = (d.entries || []).map((e) => ({
            kind: e.isDir ? 'dir' : 'file',
            name: e.name,
            rel: atDir ? `${atDir}/${e.name}` : e.name,
          }));
          setAtFiles(atDir ? [{ kind: 'up', name: '..', rel: '' }, ...items] : items);
        })
        .catch(() => { if (!cancelled) setAtFiles([]); });
      return () => { cancelled = true; };
    }
    const t = setTimeout(() => {
      fetch(`/api/files/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d) => setAtFiles((d.files || []).map((f) => ({ kind: 'file', name: f, rel: f }))))
        .catch(() => setAtFiles([]));
    }, 180);
    return () => clearTimeout(t);
  }, [atState?.query, atTab, !!atState, atDir]);

  // 会话 tab:store 里当前项目的会话列表,按首条提示词过滤,排除当前会话自己。
  const atSessions = (() => {
    if (!atState || atTab !== 'sessions') return [];
    const q = atState.query.toLowerCase();
    return sessions
      .filter((s) => s.sessionId !== sessionId && !s.archived)
      .filter((s) => !q || (s.firstPrompt || '').toLowerCase().includes(q) || s.sessionId.startsWith(q))
      .slice(0, 20);
  })();
  const atItems = atTab === 'files' ? atFiles : atSessions;
  useEffect(() => { setAtIndex(0); }, [atTab, atState?.query, atDir]);

  // 选中:目录下钻/「..」返回上级(面板不关);文件插 `@相对路径 `;
  // 会话先调 /api/session-ref 生成精简 md 再插 `@绝对路径 `。
  const pickAtItem = async (item) => {
    let insert = '';
    if (atTab === 'files') {
      if (item.kind === 'up') { setAtDir((d) => d.split('/').slice(0, -1).join('/')); return; }
      if (item.kind === 'dir') { setAtDir(item.rel); return; }
      insert = item.rel;
    } else {
      setAtBusy(true);
      try {
        const r = await fetch('/api/session-ref', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: item.sessionId, projectHash: item.projectHash || atCtxRef.current.projectHash }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '生成会话引用失败');
        insert = d.path;
      } catch (e) {
        setAtBusy(false); setAtState(null);
        const { confirmDialog } = await import('../utils/confirmDialog.jsx');
        await confirmDialog('引用会话失败:' + e.message, { confirmText: '知道了' });
        return;
      }
      setAtBusy(false);
    }
    const cur = text;
    const beforeAt = cur.slice(0, atState.start);
    const afterQuery = cur.slice(atState.start + 1 + atState.query.length);
    setText(`${beforeAt}@${insert} ${afterQuery}`);
    setAtState(null);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    // While the IME is composing (typing Chinese/Japanese/Korean via candidates),
    // Enter commits the candidate — it must NOT send the message or pick a slash
    // command, and arrows navigate the candidate list. Let the IME own all keys.
    if (e.nativeEvent?.isComposing || e.key === 'Process' || e.keyCode === 229) return;
    if (showCommands) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && filteredCommands.length > 0)) {
        e.preventDefault();
        selectCommand(filteredCommands[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setShowCommands(false);
        return;
      }
    }

    // @ 引用面板:上下选、Enter 选中、Tab 切文件/会话、Esc 关。
    if (atState) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAtIndex((i) => Math.min(i + 1, Math.max(atItems.length - 1, 0))); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAtIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab') { e.preventDefault(); setAtTab((t) => (t === 'files' ? 'sessions' : 'files')); return; }
      if (e.key === 'Enter' && !e.shiftKey && atItems.length > 0) { e.preventDefault(); if (!atBusy) pickAtItem(atItems[atIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setAtState(null); return; }
    }

    // 编辑重发态下按 Esc:取消本次编辑重发,清空输入并通知上层撤销待回滚(历史
    // 尚未被破坏,所以纯属"反悔",不会丢任何消息)。
    if (e.key === 'Escape' && editingResend) {
      e.preventDefault();
      setText('');
      setEditingResend(false);
      try { localStorage.removeItem(draftKey); } catch {}
      window.dispatchEvent(new CustomEvent('cgui:composer-cancel-edit', { detail: { targetKey: permKey } }));
      textareaRef.current?.blur();
      return;
    }


    // 上键召回排队消息(对齐 Claude Desktop):输入框为空且本会话有排队中的消息时,
    // ArrowUp 把最近入队的一条放回输入框并从队列移除(复用 onEditFromQueue 的出队+回填)。
    // 优先于历史导航——先召回队列,队列空了再翻历史。
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && text.trim() === '') {
      let lastIdx = -1;
      for (let i = queueItems.length - 1; i >= 0; i--) { if (!queueItems[i]?.hidden) { lastIdx = i; break; } }
      if (lastIdx >= 0 && onEditFromQueue) {
        e.preventDefault();
        onEditFromQueue(lastIdx);
        return;
      }
    }

    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = textareaRef.current;
      const atStart = !el || el.selectionStart === 0;
      const atEnd = !el || el.selectionStart === el.value.length;
      const canUseHistory = !text.startsWith('/') && (text.trim() === '' || (e.key === 'ArrowUp' ? atStart : historyCursor >= 0 && atEnd));
      if (canUseHistory) {
        const history = readHistory();
        if (history.length > 0 || historyCursor >= 0) {
          e.preventDefault();
          navigatingHistoryRef.current = true;
          if (e.key === 'ArrowUp') {
            const nextCursor = Math.min(historyCursor + 1, history.length - 1);
            if (historyCursor === -1) draftBeforeHistoryRef.current = text;
            if (nextCursor >= 0) {
              setHistoryCursor(nextCursor);
              setText(history[nextCursor]);
            }
          } else {
            const nextCursor = historyCursor - 1;
            setHistoryCursor(nextCursor);
            setText(nextCursor >= 0 ? history[nextCursor] : draftBeforeHistoryRef.current);
          }
          setTimeout(() => {
            const ta = textareaRef.current;
            if (ta) {
              const pos = ta.value.length;
              ta.setSelectionRange(pos, pos);
            }
            navigatingHistoryRef.current = false;
          }, 0);
          return;
        }
      }
    }

    // 发送:裸 Enter 发送,Shift+Enter 换行(用户要求,标准聊天习惯;Cmd/Ctrl+Enter 仍兼容)。
    // IME 合成期已在本函数顶部 return,中文候选回车不会误发。stopPropagation 阻止冒泡到 window
    // 上的 plan/权限卡片 Enter 监听(否则那个 Enter 会被吃掉去"批准计划")。
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      handleSend();
    }
  };

  return (
    <div>
      {/* Permission popup — sits ABOVE the composer (Claude Desktop style),
          filtered to the active session. No-op when no requests pending. */}
      <PermissionPrompt
        sessionId={sessionId}
        tabIndex={tabIndex}
        onExecutePlan={() => {
          // 批准计划 → 只同步本会话 GUI 档位为 acceptEdits。SDK 引擎下模型在同一回合内
          // 继续执行(approvePlan 已 allow ExitPlanMode + 切活跃 query 档位),无需另起回合。
          // (旧裸 CLI 因 headless plan 无法原进程内续跑才 respawn,迁 SDK 后去掉。)
          setPermissionMode('acceptEdits', permKey);
        }}
      />
      {editingResend && (
        <div className="px-6 pt-3">
          <div className="max-w-[var(--content-max)] mx-auto flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/8 px-3 py-2 text-[12px] text-accent font-body">
            <span className="flex items-center gap-1.5">
              <Pencil size={13} /> 正在编辑重发 · 发送后才会回退到此处，历史尚未改动
            </span>
            <span className="shrink-0 text-[11px] text-ink-faint">按 Esc 取消</span>
          </div>
        </div>
      )}
      {rcLocked && (
        <div className="px-6 pt-3">
          <div className="max-w-[var(--content-max)] mx-auto flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[12px] text-green-800 font-body">
            <span className="flex items-center gap-1.5">
              <Smartphone size={14} /> 已交给手机远程控制 · 输入框已锁定以避免双写
            </span>
            <button
              onClick={reclaimRemote}
              className="shrink-0 px-2 py-1 rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors text-[11px]"
            >
              收回控制
            </button>
          </div>
        </div>
      )}
    <div className="chat-input-shell px-4 py-5">
      <div className="max-w-[var(--content-max)] mx-auto relative">
        {/* Slash command dropdown */}
        {showCommands && (
          <div className="glass-popover absolute bottom-full left-0 right-0 mb-3 max-h-80 overflow-y-auto z-30 animate-glass-rise">
            <div className="px-3 py-2 text-[10px] text-ink-muted uppercase tracking-wider font-body border-b border-white/20 flex items-center justify-between">
              <span>Slash 命令</span>
              <span className="text-ink-ghost">
                {filteredCommands.length} 个 · {provider}{!isAnthropic && ' (cc switch)'}
              </span>
            </div>
            {filteredCommands.slice(0, 50).map((c, i) => {
              const Icon = TYPE_ICONS[c.type] || Terminal;
              const blocked = c.requiresAnthropic === 'full' && !isAnthropic;
              const partial = c.requiresAnthropic === 'partial' && !isAnthropic;
              const interactiveOnly = !!c.interactiveOnly;
              const tipParts = [];
              if (c.note) tipParts.push(c.note);
              if (interactiveOnly) tipParts.push('CLI 仅在交互式终端响应此命令；GUI 内会收到 "isn\'t available in this environment"');
              if (blocked) tipParts.push(`当前端点 ${provider} 不支持此命令`);
              else if (partial) tipParts.push(`当前端点 ${provider} 下行为可能不准`);
              const tip = tipParts.join(' · ') || c.desc;
              return (
                <button
                  key={c.name}
                  onClick={() => selectCommand(c)}
                  disabled={blocked}
                  title={tip}
                  className={`w-full text-left px-3 py-2.5 flex items-center gap-2 transition-colors ${
                    blocked
                      ? 'opacity-40 cursor-not-allowed'
                      : i === selectedIndex ? 'bg-accent/12' : 'hover:bg-black/5'
                  }`}
                >
                  <Icon size={12} className="text-accent shrink-0" />
                  <span className={`text-xs font-mono shrink-0 ${blocked ? 'line-through text-ink-ghost' : 'text-ink-soft'}`}>
                    {c.name}
                  </span>
                  <span className="text-[11px] text-ink-faint font-body truncate flex-1">{c.desc}</span>
                  {interactiveOnly && (
                    <span className="text-[9px] px-1 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono shrink-0" title="仅交互式终端可用">
                      TUI
                    </span>
                  )}
                  {partial && (
                    <span className="text-[9px] px-1 py-0.5 bg-warning/10 text-warning rounded font-mono shrink-0">
                      partial
                    </span>
                  )}
                  {blocked && (
                    <span className="text-[9px] px-1 py-0.5 bg-error/10 text-error rounded font-mono shrink-0">
                      仅订阅
                    </span>
                  )}
                  <span className="text-[9px] px-1 py-0.5 bg-canvas-deep text-ink-ghost rounded font-mono shrink-0">
                    {TYPE_LABELS[c.type] || c.type}
                  </span>
                </button>
              );
            })}
            {filteredCommands.length > 50 && (
              <div className="px-3 py-2 text-[10px] text-ink-faint text-center font-body">
                还有 {filteredCommands.length - 50} 个命令...
              </div>
            )}
          </div>
        )}

        {/* @ 引用选择器:文件 / 会话 两个 tab(Tab 键切换),把选中项作为上下文引用插入输入框 */}
        {atState && (
          <div className="glass-popover absolute bottom-full left-0 right-0 mb-3 max-h-80 overflow-y-auto z-30 animate-glass-rise">
            <div className="px-3 py-2 border-b border-white/20 flex items-center gap-2">
              <AtSign size={11} className="text-accent shrink-0" />
              <button onClick={() => setAtTab('files')}
                className={`text-[11px] px-2 py-0.5 rounded font-body ${atTab === 'files' ? 'bg-accent/15 text-accent' : 'text-ink-faint hover:text-ink'}`}>
                文件
              </button>
              <button onClick={() => setAtTab('sessions')}
                className={`text-[11px] px-2 py-0.5 rounded font-body ${atTab === 'sessions' ? 'bg-accent/15 text-accent' : 'text-ink-faint hover:text-ink'}`}>
                会话
              </button>
              <span className="ml-auto text-[10px] text-ink-ghost font-body">Tab 切换 · Enter 选择/进入</span>
            </div>
            {/* 层级浏览时显示当前所在目录(面包屑) */}
            {atTab === 'files' && !atState.query && atDir && (
              <div className="px-3 py-1 border-b border-white/10 text-[10px] font-mono text-ink-faint truncate">
                {atDir}/
              </div>
            )}
            {atBusy && (
              <div className="px-3 py-3 text-[11px] text-ink-faint font-body flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" />正在生成会话引用...
              </div>
            )}
            {!atBusy && atItems.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-ink-faint font-body">
                {atTab === 'files'
                  ? (atCtxRef.current.cwd ? '没有匹配的文件' : '当前会话无项目目录')
                  : '本项目没有其它可引用的会话'}
              </div>
            )}
            {!atBusy && atTab === 'files' && atFiles.map((f, i) => (
              <button key={f.kind === 'up' ? '..' : f.rel} onClick={() => pickAtItem(f)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${i === atIndex ? 'bg-accent/12' : 'hover:bg-black/5'}`}>
                {f.kind === 'up' ? <CornerLeftUp size={12} className="text-ink-faint shrink-0" />
                  : f.kind === 'dir' ? <Folder size={12} className="text-amber-600 shrink-0" />
                  : <FileText size={12} className="text-accent shrink-0" />}
                <span className="text-[11px] font-mono text-ink-soft truncate">
                  {f.kind === 'up' ? '返回上级' : atState.query ? f.rel : f.name}{f.kind === 'dir' ? '/' : ''}
                </span>
              </button>
            ))}
            {!atBusy && atTab === 'sessions' && atSessions.map((s, i) => (
              <button key={s.sessionId} onClick={() => pickAtItem(s)}
                title="将该会话内容(精简 Markdown)作为上下文引用"
                className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${i === atIndex ? 'bg-accent/12' : 'hover:bg-black/5'}`}>
                <MessagesSquare size={12} className="text-accent shrink-0" />
                <span className="text-[11px] font-body text-ink-soft truncate flex-1">{s.firstPrompt || s.sessionId}</span>
                <span className="text-[9px] text-ink-ghost font-mono shrink-0">{(s.lastActivity || '').slice(5, 16).replace('T', ' ')}</span>
              </button>
            ))}
          </div>
        )}


        {/* CI-4:无视觉 provider 下挂了图片 → 提前提示(后端会剥图,不至于 400,但用户该知道) */}
        {noVision && attachments.some((a) => a.kind === 'image') && (
          <div className="mb-2 px-2 text-[11px] text-amber-700 font-body leading-snug">
            ⚠️ 当前 provider 不支持图片(无视觉能力),发送时图片会被忽略、只发文本/文件；需要看图请切换到支持视觉的 provider。
          </div>
        )}
        {/* Attachments — sit above the composer when present */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 px-2">
            {attachments.map((a) => (
              <div key={a.path} className="relative group/att">
                {a.kind === 'image' ? (
                  <img
                    src={a.preview}
                    alt={a.name}
                    onClick={() => setZoomImage({ src: a.preview, name: a.name, path: a.path })}
                    className="h-16 w-16 object-cover rounded-lg border border-canvas-deep shadow-sm cursor-zoom-in"
                  />
                ) : (
                  <div className="h-16 w-36 rounded-lg border border-canvas-deep bg-canvas-warm shadow-sm px-2 py-2 flex items-center gap-2">
                    <FileText size={18} className="text-accent shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[11px] text-ink font-body truncate" title={a.name}>{a.name}</div>
                      <div className="text-[9px] text-ink-faint font-mono">{Math.ceil((a.bytes || 0) / 1024)} KB</div>
                    </div>
                  </div>
                )}
                <button
                  onClick={() => removeAttachment(a.path)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-canvas-deep text-ink-soft hover:bg-error hover:text-white flex items-center justify-center transition-colors opacity-0 group-hover/att:opacity-100"
                  title="移除"
                >
                  <X size={11} />
                </button>
                {a.kind === 'image' && (
                  <span className="absolute bottom-0 left-0 right-0 text-[9px] text-white bg-black/60 px-1 py-px rounded-b-lg truncate text-center">
                    {a.name}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* #7 图片附件单击放大 */}
        <ImageLightbox src={zoomImage?.src} name={zoomImage?.name} path={zoomImage?.path} onClose={() => setZoomImage(null)} />

        {/* 任务清单 — 紧贴输入框上方(同一列内),作为输入框的附着条而非独立悬浮面板。
            折叠/隐藏/全完成自动折叠见 TodoPanel。key=permKey:折叠/隐藏是组件本地态,按会话
            重挂以免跨会话串扰(每个会话独立的折叠/隐藏状态)。 */}
        <TodoPanel key={permKey || 'global'} todos={todos} plan={plan} isStreaming={isStreaming || agentsWorking || bgWorking} />

        {/* 输入预测(A):回合末模型预测的下一条输入。点击建议文本直接发送;
            铅笔=填入输入框编辑;X=忽略。新回合开始/发送时上层自动清掉。 */}
        {suggestion && !isStreaming && !rcLocked && (
          <div className="mb-2 flex items-center gap-1 animate-fade-in">
            <button
              onClick={() => onSend?.(suggestion)}
              className="group min-w-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent/8 border border-accent/25 hover:bg-accent/15 transition-colors text-left"
              title={`点击发送:${suggestion}`}
            >
              <Sparkles size={11} className="text-accent shrink-0" />
              <span className="text-[11px] text-ink-soft font-body truncate">{suggestion}</span>
            </button>
            <button
              onClick={() => {
                setText(suggestion);
                onDismissSuggestion?.();
                setTimeout(() => textareaRef.current?.focus(), 0);
              }}
              className="shrink-0 p-1.5 rounded-full hover:bg-black/5 text-ink-faint hover:text-accent transition-colors"
              title="填入输入框编辑"
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={() => onDismissSuggestion?.()}
              className="shrink-0 p-1.5 rounded-full hover:bg-black/5 text-ink-faint hover:text-ink transition-colors"
              title="忽略此建议"
            >
              <X size={11} />
            </button>
          </div>
        )}

        {/* 修正批#1b 两行 composer:上行整宽输入框,下行工具行
            [权限模式▾][+附件][旁问⊙] … [发送 | 入队/转后台/停止](桌面/手机同一套)。
            Provider/模型/力度/远程在顶栏;权限按钮文案窄容器自动缩为图标(container query)。 */}
        <div
          className={`chat-composer glass-capsule px-4 pt-2.5 pb-2 ${dragging ? 'ring-2 ring-accent/60' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,text/*,application/pdf,.pdf,.txt,.md,.markdown,.csv,.tsv,.log,.json,.jsonl,.js,.jsx,.ts,.tsx,.css,.html,.xml,.yaml,.yml,.toml,.ini,.sh,.py,.sql,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
            onChange={handleFilePick}
            className="hidden"
          />
          <textarea
            data-tour={paneIsActive ? 'composer' : undefined}
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={rcLocked ? '已交给手机远程控制 · 点上方「收回控制」解锁' : (dragging ? '松开以添加图片、PDF、Office 或文本…' : '输入消息... (/ 打开命令)')}
            disabled={disabled || rcLocked}
            rows={1}
            className="w-full bg-transparent text-[14px] text-ink placeholder-ink-faint resize-none focus:outline-none font-body leading-relaxed py-1 min-h-[28px] max-h-[200px]"
          />
          {/* 修正批#1b:工具行只留 [权限模式][附件][旁问](Provider/模型/力度/远程迁顶栏,
              ⋮ 删除)。cgui-composer-tools = container query 容器:窄了权限按钮自动藏文字
              只留图标(桌面窄分屏与手机同一套自适应,见 index.css)。 */}
          <div className="cgui-composer-tools flex items-center gap-0.5 mt-1">
            <PermissionModeSelector permKey={permKey} tourAnchor={paneIsActive} />
            <button
              type="button"
              data-tour={paneIsActive ? 'attach' : undefined}
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || rcLocked}
              className="shrink-0 h-8 w-8 rounded-full hover:bg-black/5 text-ink-muted hover:text-accent flex items-center justify-center transition-colors disabled:opacity-50"
              title="添加附件（图片、PDF 或文件）"
            >
              <Paperclip size={15} />
            </button>
            {/* 旁问入口:纯图标(全平台,P2.1 去文字);未读角标显示在此。 */}
            {onBtwOpen && (
              <button
                type="button"
                data-tour={paneIsActive ? 'aside' : undefined}
                onClick={onBtwOpen}
                className="shrink-0 h-8 w-8 rounded-full hover:bg-black/5 text-ink-muted hover:text-accent flex items-center justify-center transition-colors relative"
                title="旁问（不打断当前工作、不写入会话历史）"
              >
                <MessagesSquare size={15} />
                {btwUnread > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-accent text-on-accent text-[9px] leading-[15px] text-center font-mono">
                    {btwUnread > 9 ? '9+' : btwUnread}
                  </span>
                )}
              </button>
            )}
            <div className="flex-1 min-w-[8px]" />
            {/* 主流式中:入队(当前消息发送完后自动发出)+ 转后台。仅前台流有意义,故仍看 isStreaming。 */}
            {isStreaming && (
              <>
                <button
                  onClick={handleSend}
                  disabled={!text.trim() && attachments.length === 0}
                  className="shrink-0 h-8 px-3 max-md:px-2.5 rounded-full bg-accent/10 hover:bg-accent/20 text-accent flex items-center justify-center gap-1 transition-colors disabled:opacity-50 text-[11px] font-medium"
                  title="入队（当前消息发送完后自动发出）"
                >
                  <Send size={13} /><span className="max-md:hidden">入队</span>
                </button>
                {onBackground && (
                  <button
                    onClick={onBackground}
                    className="shrink-0 h-8 px-2.5 rounded-md bg-canvas-warm border border-canvas-deep hover:bg-black/5 text-ink-soft flex items-center justify-center transition-colors text-[11px] font-medium"
                    title="本回合转入后台继续运行,完成后自动提示;期间可切换到其它会话"
                  >
                    <ArrowDownToLine size={11} />
                  </button>
                )}
              </>
            )}
            {/* 部件②总闸:回合已结束(!working)且本会话仍有非终态后台子代理/teammate 时,
                与发送键【并列】的独立按钮。刻意不进 working 二态(那是死锁根源):它的显隐不
                影响发送键(仍按有文本可点),空框也绝不"既无停止又灰发送"。主流式期间 working
                为真、本按钮不显,避免把主回合前台子代理算进 N 而误停。 */}
            {!working && bgSubagentCount > 0 && onStopBackground && (
              <button
                onClick={() => onStopBackground(sessionId)}
                className="shrink-0 h-8 px-2.5 rounded-md bg-canvas-warm border border-canvas-deep hover:bg-black/5 text-ink-soft flex items-center justify-center gap-1.5 max-md:gap-0 transition-colors text-[11px] font-medium"
                title="停止本会话所有后台子代理/teammate（保留 run_in_background 长任务）"
              >
                <Square size={11} className="fill-current" />
                <span className="max-md:hidden">停止后台 {bgSubagentCount}</span>
              </button>
            )}
            {/* 停止按钮按「工作中」显示(主流式 / 活跃子代理 / 后台任务 / 待处理授权卡),恒表明仍在
                工作 —— 修复「等子代理或弹权限卡时停止按钮消失」。onStop 实现(停止链路)不动。 */}
            {working ? (
              <button
                onClick={onStop}
                className="shrink-0 h-8 px-3 max-md:px-2.5 rounded-md bg-ink/90 hover:bg-ink text-canvas flex items-center justify-center gap-1.5 max-md:gap-0 transition-colors text-[11px] font-medium"
                title="停止生成"
              >
                <Square size={11} className="fill-current" />
                <span className="max-md:hidden">停止</span>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={(!text.trim() && attachments.length === 0) || disabled || rcLocked}
                className="btn-accent shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
                title="发送"
              >
                {disabled ? (
                  <Loader2 size={14} className="text-white/80 animate-spin" />
                ) : (
                  <Send size={14} className="text-white -mr-0.5" />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Background-streaming indicator. Shows when this session has a
            CLI process still working in the background (user came back to a
            session they had left mid-stream). */}
        {backgroundWorking && (
          <div className="mt-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 flex items-center gap-2 text-[11px] font-body text-amber-900">
            <Loader2 size={11} className="text-amber-700 animate-spin shrink-0" />
            <span className="flex-1">
              这个会话仍在后台工作中 · 新内容会随生成自动追加
            </span>
          </div>
        )}

        {/* Queue indicator + per-item preview + edit/delete + accelerate.
            Q5: 计数排除 hidden 项(计划执行等系统续跑消息)——全是 hidden 时整个指示器不渲染,
            体验对齐 Claude Desktop(批准计划后看不到任何"排队提示")。 */}
        {queueItems.filter((q) => !q.hidden).length > 0 && (
          <div className="mt-2 rounded-lg bg-accent/8 border border-accent/20 text-[11px] font-body overflow-hidden">
            <div className="px-3 py-1.5 flex items-center gap-2 border-b border-accent/15">
              <Send size={11} className="text-accent shrink-0" />
              <span className="text-ink-soft flex-1">
                <b>{queueItems.filter((q) => !q.hidden).length}</b> 条消息已排队 · 当前回复完成后自动发出
              </span>
              {onAccelerate && (
                <button
                  onClick={onAccelerate}
                  className="px-2 py-0.5 rounded bg-accent text-on-accent text-[10px] font-medium hover:bg-accent-hover"
                  title="立即中断当前回复，发出队列中的消息"
                >
                  ⚡ 引导
                </button>
              )}
            </div>
            <ul className="divide-y divide-accent/10">
              {queueItems.map((q, i) => (
                q.hidden ? null : // 隐藏续跑消息(如计划执行)不在队列里显示(#5);保留索引对齐 store
                <li key={`${q.queuedAt}-${i}`} className="px-3 py-1.5 flex items-start gap-2 group hover:bg-accent/5">
                  <span className="text-[10px] text-ink-faint font-mono shrink-0 mt-0.5">#{i + 1}</span>
                  <span className="text-ink-soft flex-1 line-clamp-2 leading-snug" title={q.text}>{q.text}</span>
                  <div className="shrink-0 flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                    {onEditFromQueue && (
                      <button
                        onClick={() => onEditFromQueue(i)}
                        className="p-1 hover:bg-accent/15 rounded"
                        title="取出到输入框重新编辑"
                      >
                        <Pencil size={11} className="text-accent" />
                      </button>
                    )}
                    {onRemoveFromQueue && (
                      <button
                        onClick={() => onRemoveFromQueue(i)}
                        className="p-1 hover:bg-red-100 rounded"
                        title="从队列删除"
                      >
                        <X size={11} className="text-ink-faint hover:text-red-600" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-[10.5px] text-ink-faint mt-2.5 text-center font-body tracking-wide">
          本地运行 · 数据不离开设备
        </p>
      </div>
    </div>
    </div>
  );
}
