import React, { useEffect, useState } from 'react';
import { Settings, Save, RefreshCw, AlertCircle, Check, Plus, Trash2, ChevronDown, ChevronRight, Palette, Type } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';

const HOOK_EVENTS = [
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse',
  'Stop', 'SubagentStop', 'Notification',
];

export function SettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [rawJson, setRawJson] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('overview'); // overview | hooks | json | storage | appearance

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettings(data);
      setRawJson(JSON.stringify(data, null, 2));
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  useEffect(() => { fetchSettings(); }, []);

  // Persist either an arbitrary object (Hooks tab) or the raw JSON (JSON tab).
  const save = async (next) => {
    setSaving(true); setError(null);
    try {
      const body = next !== undefined ? next : JSON.parse(rawJson);
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setSettings(data); setRawJson(JSON.stringify(data, null, 2));
      setSaved(true); setTimeout(() => setSaved(false), 1800);
    } catch (err) { setError(err.message); }
    setSaving(false);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><RefreshCw size={16} className="text-ink-faint animate-spin" /></div>;
  }

  return (
    <div className="px-4 py-4 space-y-4 overflow-y-auto h-full">
      <div className="flex items-center gap-1 border-b border-canvas-deep -mx-4 px-4 pb-2">
        {[['overview', '概览'], ['appearance', '外观'], ['hooks', 'Hooks'], ['json', 'JSON'], ['storage', '存储']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`text-[11px] px-2.5 py-1 rounded font-body transition-colors ${tab === id ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:text-ink'}`}>
            {label}
          </button>
        ))}
        <button onClick={fetchSettings} className="ml-auto p-1 text-ink-faint hover:text-ink" title="重新加载">
          <RefreshCw size={12} />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-error bg-error-subtle rounded-lg p-2.5">
          <AlertCircle size={13} /><span className="font-body">{error}</span>
        </div>
      )}

      {tab === 'overview' && <OverviewTab settings={settings} />}
      {tab === 'hooks' && (
        <HooksTab settings={settings} onSave={save} saving={saving} saved={saved} />
      )}
      {tab === 'json' && (
        <JsonTab rawJson={rawJson} setRawJson={setRawJson} onSave={() => save()}
          onReset={() => { setRawJson(JSON.stringify(settings, null, 2)); setError(null); }}
          saving={saving} saved={saved} />
      )}
      {tab === 'storage' && <StorageTab />}
      {tab === 'appearance' && <AppearanceTab />}
    </div>
  );
}

// Font scale slider + theme preset picker. Both are persisted in the store
// and applied via document.documentElement attributes.
//
// Each preset carries its real palette so the picker card can self-preview:
// bg = panel background, fg = body text, mute = secondary text, accent = primary
// brand, border = card edge. The card renders WITH these colors, so a dark
// theme's card actually looks dark — no more lying mini-swatches on a beige
// background.
const THEME_PRESETS = [
  // ── Light themes ──────────────────────────────────────────
  { id: '', name: '系统默认', desc: 'Apple 系统蓝（浅色）', tone: 'light',
    bg: '#ECEFF5', bg2: '#DADFE9', fg: '#0B0B0F', mute: '#8A8C93', accent: '#0A84FF', border: '#E4E8F0' },
  { id: 'github-light', name: 'GitHub Light', desc: '纯白 + GitHub 品牌蓝', tone: 'light',
    bg: '#F6F8FA', bg2: '#EAEEF2', fg: '#24292F', mute: '#57606A', accent: '#0969DA', border: '#D0D7DE' },
  { id: 'claude-warm', name: 'Claude Warm', desc: 'Claude 品牌橙 + 暖米色', tone: 'light',
    bg: '#F2EDE3', bg2: '#E2DBCC', fg: '#1A1A1A', mute: '#9A8F89', accent: '#D97757', border: '#EBE5D8' },
  { id: 'flexoki-light', name: 'Flexoki Light', desc: 'Obsidian 米纸 + 钴蓝', tone: 'light',
    bg: '#F2F0E5', bg2: '#E6E4D9', fg: '#100F0F', mute: '#6F6E69', accent: '#205EA6', border: '#CECDC3' },
  { id: 'rose-pine-dawn', name: 'Rose Pine Dawn', desc: '薰衣草米白 + 松木蓝', tone: 'light',
    bg: '#FFFAF3', bg2: '#F2E9E1', fg: '#575279', mute: '#797593', accent: '#31748F', border: '#DFDAD9' },
  { id: 'solarized-light', name: 'Solarized Light', desc: '奶油米 + 蓝青（科技复古）', tone: 'light',
    bg: '#F5EFD6', bg2: '#EEE8D5', fg: '#586E75', mute: '#839496', accent: '#268BD2', border: '#C8C2A6' },
  { id: 'gruvbox-light', name: 'Gruvbox Light', desc: '暖米黄 + 复古橄榄棕', tone: 'light',
    bg: '#F2E5BC', bg2: '#EBDBB2', fg: '#3C3836', mute: '#7C6F64', accent: '#076678', border: '#D5C4A1' },
  { id: 'everforest-light', name: 'Everforest Light', desc: '浅草绿 + 森林绿（护眼）', tone: 'light',
    bg: '#F4F0D9', bg2: '#EFEBD4', fg: '#5C6A72', mute: '#829181', accent: '#8DA101', border: '#BDC3AF' },
  { id: 'tokyonight-day', name: 'Tokyonight Day', desc: '灰蓝白 + 电光蓝（现代）', tone: 'light',
    bg: '#D5D6DB', bg2: '#C8C9CE', fg: '#3760BF', mute: '#737A8C', accent: '#2E7DE9', border: '#B3B5BE' },
  { id: 'kanagawa-lotus', name: 'Kanagawa Lotus', desc: '暖陶土 + 深靛蓝（日式）', tone: 'light',
    bg: '#EAE4D7', bg2: '#E3DCD2', fg: '#54433A', mute: '#7E6B5A', accent: '#2D4F67', border: '#C9BFB1' },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', desc: '柔和米灰 + 钴蓝（浅色）', tone: 'light',
    bg: '#E6E9EF', bg2: '#CCD0DA', fg: '#4C4F69', mute: '#8C8FA1', accent: '#1E66F5', border: '#DCE0E8' },

  // ── Dark themes ───────────────────────────────────────────
  { id: 'opencode-dark', name: 'OpenCode Dark', desc: 'OpenCode 暗色（蜜桃橙）', tone: 'dark',
    bg: '#141414', bg2: '#050505', fg: '#EEEEEE', mute: '#808080', accent: '#FAB283', border: '#1E1E1E' },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', desc: '柔和暗紫 + 天空蓝高亮', tone: 'dark',
    bg: '#313244', bg2: '#181825', fg: '#CDD6F4', mute: '#A6ADC8', accent: '#89B4FA', border: '#45475A' },
  { id: 'tokyonight', name: 'Tokyo Night', desc: '深蓝紫 + 柔和蓝高亮', tone: 'dark',
    bg: '#1E2030', bg2: '#16161E', fg: '#C8D3F5', mute: '#737AA2', accent: '#82AAFF', border: '#222436' },
  { id: 'kanagawa', name: 'Kanagawa', desc: '日式浮世绘暗（米黄+蓝）', tone: 'dark',
    bg: '#2A2A37', bg2: '#16161D', fg: '#DCD7BA', mute: '#957FB8', accent: '#7E9CD8', border: '#363646' },
  { id: 'dracula', name: 'Dracula', desc: '经典高对比 + 紫罗兰主色', tone: 'dark',
    bg: '#383A4A', bg2: '#21222C', fg: '#F8F8F2', mute: '#BFBFB8', accent: '#BD93F9', border: '#44475A' },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', desc: '复古终端暖暗（米黄+橙）', tone: 'dark',
    bg: '#3C3836', bg2: '#1D2021', fg: '#EBDBB2', mute: '#A89984', accent: '#FE8019', border: '#504945' },
  { id: 'nord', name: 'Nord', desc: '北欧冷色（青蓝灰）', tone: 'dark',
    bg: '#3B4252', bg2: '#242933', fg: '#ECEFF4', mute: '#8B95A7', accent: '#88C0D0', border: '#434C5E' },
  { id: 'everforest-dark', name: 'Everforest Dark', desc: '森林暗 + 鼠尾草绿', tone: 'dark',
    bg: '#374145', bg2: '#232A2E', fg: '#D3C6AA', mute: '#9DA9A0', accent: '#A7C080', border: '#475258' },
  { id: 'rosepine', name: 'Rose Pine', desc: '玫瑰松（蓝绿 + 紫罗兰）', tone: 'dark',
    bg: '#1F1D2E', bg2: '#131019', fg: '#E0DEF4', mute: '#908CAA', accent: '#9CCFD8', border: '#26233A' },
];

function AppearanceTab() {
  const uiFontScale = useStore((s) => s.uiFontScale);
  const setUiFontScale = useStore((s) => s.setUiFontScale);
  const cguiTheme = useStore((s) => s.cguiTheme);
  const setCguiTheme = useStore((s) => s.setCguiTheme);

  return (
    <div className="space-y-5">
      {/* ── Font scale ───────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Type size={13} className="text-ink-muted" />
          <span className="text-[12px] text-ink font-body font-medium">界面字体大小</span>
          <span className="ml-auto text-[11px] text-ink-faint font-mono">{Math.round(uiFontScale * 100)}%</span>
        </div>
        <div className="flex items-center gap-3 px-1">
          <span className="text-[10px] text-ink-faint">A</span>
          <input
            type="range"
            min="0.8"
            max="1.5"
            step="0.05"
            value={uiFontScale}
            onChange={(e) => setUiFontScale(parseFloat(e.target.value))}
            className="flex-1 accent-accent"
          />
          <span className="text-[14px] text-ink-faint">A</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setUiFontScale(1)}
            className="text-[10px] text-ink-muted hover:text-ink underline-offset-2 hover:underline"
          >重置为 100%</button>
          <span className="text-[10px] text-ink-faint">· 用 document.zoom 实现，所有元素一起缩放</span>
        </div>
      </div>

      {/* ── Theme preset ─────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Palette size={13} className="text-ink-muted" />
          <span className="text-[12px] text-ink font-body font-medium">配色主题</span>
        </div>
        <div className="grid grid-cols-1 gap-2">
          {/* 浅色组标题 */}
          <div className="text-[10px] uppercase tracking-widest text-ink-faint font-body px-1 mt-1">
            浅色 / Light
          </div>
          {THEME_PRESETS.filter((t) => t.tone === 'light').map((t) => {
            const active = (cguiTheme || '') === t.id;
            return (
              <button
                key={t.id || 'default'}
                onClick={() => setCguiTheme(t.id)}
                style={{
                  backgroundColor: t.bg,
                  color: t.fg,
                  borderColor: active ? t.accent : t.border,
                  borderWidth: active ? 2 : 1,
                  boxShadow: active ? `0 0 0 3px ${t.accent}22` : 'none',
                }}
                className="text-left px-3 py-2.5 rounded-lg border flex items-center gap-3 transition-all hover:brightness-110"
              >
                {/* Real preview strip: accent bar + canvas-sunken + ink swatch.
                    Width-weighted so the brand color reads loudest. */}
                <div className="flex gap-1 shrink-0 items-stretch">
                  <div className="w-6 h-9 rounded" style={{ background: t.accent }} />
                  <div className="w-3 h-9 rounded" style={{ background: t.bg2 }} />
                  <div className="w-3 h-9 rounded" style={{ background: t.fg, opacity: 0.85 }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div style={{ color: t.fg }} className="text-[12px] font-body font-medium leading-tight">{t.name}</div>
                  <div style={{ color: t.mute }} className="text-[10px] font-body leading-tight mt-0.5">{t.desc}</div>
                </div>
                {active && <Check size={14} style={{ color: t.accent }} className="shrink-0" />}
              </button>
            );
          })}
          {/* 深色组标题 */}
          <div className="text-[10px] uppercase tracking-widest text-ink-faint font-body px-1 mt-3">
            深色 / Dark
          </div>
          {THEME_PRESETS.filter((t) => t.tone === 'dark').map((t) => {
            const active = (cguiTheme || '') === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setCguiTheme(t.id)}
                style={{
                  backgroundColor: t.bg,
                  color: t.fg,
                  borderColor: active ? t.accent : t.border,
                  borderWidth: active ? 2 : 1,
                  boxShadow: active ? `0 0 0 3px ${t.accent}22` : 'none',
                }}
                className="text-left px-3 py-2.5 rounded-lg border flex items-center gap-3 transition-all hover:brightness-110"
              >
                <div className="flex gap-1 shrink-0 items-stretch">
                  <div className="w-6 h-9 rounded" style={{ background: t.accent }} />
                  <div className="w-3 h-9 rounded" style={{ background: t.bg2 }} />
                  <div className="w-3 h-9 rounded" style={{ background: t.fg, opacity: 0.85 }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div style={{ color: t.fg }} className="text-[12px] font-body font-medium leading-tight">{t.name}</div>
                  <div style={{ color: t.mute }} className="text-[10px] font-body leading-tight mt-0.5">{t.desc}</div>
                </div>
                {active && <Check size={14} style={{ color: t.accent }} className="shrink-0" />}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-ink-faint font-body px-1 leading-relaxed">
          色值取自 opencode 主题 JSON 与 Claude Code CLI。卡片本身即为预览，
          点击立即生效。整套界面（侧边栏、标题、滚动条）都会跟随切换。
        </p>
      </div>
    </div>
  );
}

// Lists .jsonl.bak backups created by /trim and /strip-thinking. Each row
// pairs a backup file with the session's first user prompt so the user can
// recognize what they're about to delete. Total size is shown up top.
function StorageTab() {
  const [data, setData] = useState({ items: [], totalBytes: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };
  const fmtTime = (ms) => {
    try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); }
    catch { return ''; }
  };

  const fetchList = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/bak-files');
      const d = await r.json();
      setData(d);
    } catch {}
    setLoading(false);
  };
  useEffect(() => { fetchList(); }, []);

  const deleteOne = async (item) => {
    setBusy(true);
    try {
      await fetch('/api/bak-files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ projectHash: item.projectHash, sessionId: item.sessionId }] }),
      });
      await fetchList();
    } catch {}
    setBusy(false);
  };

  const deleteAll = async () => {
    if (!confirm(`确定清理全部 ${data.items.length} 个 .bak 备份？将释放 ${fmtBytes(data.totalBytes)}。`)) return;
    setBusy(true);
    try {
      await fetch('/api/bak-files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      await fetchList();
    } catch {}
    setBusy(false);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><RefreshCw size={16} className="text-ink-faint animate-spin" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-ink-faint font-body leading-relaxed bg-canvas-warm border border-canvas-deep rounded-lg p-2.5">
        每次"回滚 / 切换模型剥离思考块"前会写一份 <code className="font-mono">&lt;sid&gt;.jsonl.bak</code> 备份。删除会话不会自动删 .bak，长期积累在此手动清理。<strong className="text-amber-700">删除后不可恢复。</strong>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-ink-muted font-body">
          共 <span className="font-mono text-ink">{data.items.length}</span> 个备份 · 占用 <span className="font-mono text-ink">{fmtBytes(data.totalBytes)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchList} disabled={busy}
            className="text-[11px] px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-canvas-warm font-body inline-flex items-center gap-1">
            <RefreshCw size={11} /> 刷新
          </button>
          <button onClick={deleteAll} disabled={busy || data.items.length === 0}
            className="text-[11px] px-2.5 py-1 rounded bg-error/10 text-error hover:bg-error/15 font-body inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed">
            <Trash2 size={11} /> 全部清理
          </button>
        </div>
      </div>

      {data.items.length === 0 ? (
        <p className="text-xs text-ink-faint font-body py-6 text-center">没有 .bak 备份文件</p>
      ) : (
        <div className="bg-canvas-warm border border-canvas-deep rounded-lg divide-y divide-canvas-deep">
          {data.items.map((it) => (
            <div key={`${it.projectHash}/${it.sessionId}`} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-ink font-body truncate flex items-center gap-1.5">
                  {it.orphan && <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-700 border border-amber-200 font-mono shrink-0">孤儿</span>}
                  <span className="truncate">{it.title}</span>
                </div>
                <div className="text-[10px] text-ink-faint font-mono mt-0.5">
                  {it.sessionId.slice(0, 8)} · {fmtTime(it.mtimeMs)}
                </div>
              </div>
              <div className="text-[11px] text-ink-muted font-mono shrink-0">{fmtBytes(it.size)}</div>
              <button onClick={() => deleteOne(it)} disabled={busy}
                className="p-1 rounded hover:bg-error/10 text-ink-faint hover:text-error shrink-0"
                title="删除此备份">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OverviewTab({ settings }) {
  const rows = [];
  if (settings?.defaultModel || settings?.model) rows.push(['默认模型', settings.defaultModel || settings.model]);
  if (settings?.env) rows.push(['环境变量', `${Object.keys(settings.env).length} 个`]);
  if (settings?.hooks) {
    const total = Object.values(settings.hooks).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
    rows.push(['Hooks', `${Object.keys(settings.hooks).length} 事件 · ${total} 条`]);
  }
  if (settings?.permissions) rows.push(['权限规则', `${Object.keys(settings.permissions).length} 条`]);
  if (settings?.plugins) rows.push(['插件', `${Object.keys(settings.plugins).length} 个`]);
  if (!rows.length) return <p className="text-xs text-ink-faint font-body py-6 text-center">settings.json 为空</p>;
  return (
    <div className="bg-canvas-warm border border-canvas-deep rounded-lg divide-y divide-canvas-deep">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between px-3 py-2.5">
          <span className="text-xs text-ink-muted font-body">{k}</span>
          <span className="text-xs text-ink-soft font-mono">{v}</span>
        </div>
      ))}
    </div>
  );
}

function HooksTab({ settings, onSave, saving, saved }) {
  const [hooks, setHooks] = useState(settings?.hooks || {});
  const [open, setOpen] = useState({});
  const [adding, setAdding] = useState(null); // event name being added to
  const [newCmd, setNewCmd] = useState('');
  const [newMatcher, setNewMatcher] = useState('');

  // Re-sync if settings reloaded externally
  useEffect(() => { setHooks(settings?.hooks || {}); }, [settings]);

  const persist = (next) => {
    setHooks(next);
    onSave({ ...settings, hooks: next });
  };

  const removeHook = (event, groupIdx, cmdIdx) => {
    if (!confirm('删除这条 hook？')) return;
    const next = { ...hooks };
    const groups = [...(next[event] || [])];
    const group = { ...groups[groupIdx] };
    group.hooks = (group.hooks || []).filter((_, i) => i !== cmdIdx);
    if (!group.hooks.length) groups.splice(groupIdx, 1);
    else groups[groupIdx] = group;
    if (groups.length) next[event] = groups; else delete next[event];
    persist(next);
  };

  const addHook = (event) => {
    if (!newCmd.trim()) return;
    const next = { ...hooks };
    next[event] = [
      ...(next[event] || []),
      { matcher: newMatcher, hooks: [{ type: 'command', command: newCmd }] },
    ];
    persist(next);
    setAdding(null); setNewCmd(''); setNewMatcher('');
  };

  const events = [...new Set([...Object.keys(hooks), ...HOOK_EVENTS])];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] text-ink-faint">
        <span className="font-body">{Object.keys(hooks).length} 个事件已配置 hook</span>
        {saving && <span className="font-mono">保存中…</span>}
        {saved && <span className="font-mono text-success">已保存</span>}
      </div>
      {events.map((event) => {
        const groups = hooks[event] || [];
        const count = groups.reduce((n, g) => n + (g.hooks?.length || 0), 0);
        const isOpen = open[event];
        return (
          <div key={event} className="border border-canvas-deep rounded-lg overflow-hidden">
            <button onClick={() => setOpen({ ...open, [event]: !isOpen })}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-canvas-warm/60 text-left">
              {isOpen ? <ChevronDown size={11} className="text-ink-faint" /> : <ChevronRight size={11} className="text-ink-faint" />}
              <span className="text-xs font-mono text-ink-soft flex-1">{event}</span>
              <span className="text-[10px] text-ink-faint font-mono">{count}</span>
            </button>
            {isOpen && (
              <div className="border-t border-canvas-deep px-3 py-2 space-y-1.5">
                {groups.map((g, gi) => (
                  (g.hooks || []).map((h, ci) => (
                    <div key={`${gi}-${ci}`} className="flex items-start gap-2 group">
                      {g.matcher && (
                        <span className="chip font-mono shrink-0 mt-0.5" title="matcher">{g.matcher}</span>
                      )}
                      <code className="flex-1 text-[10.5px] text-ink-muted font-mono break-all leading-snug">{h.command}</code>
                      <button onClick={() => removeHook(event, gi, ci)}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-error/15 rounded shrink-0"
                        title="删除">
                        <Trash2 size={11} className="text-error" />
                      </button>
                    </div>
                  ))
                ))}
                {adding === event ? (
                  <div className="space-y-1.5 pt-1.5 border-t border-canvas-deep">
                    <input value={newMatcher} onChange={(e) => setNewMatcher(e.target.value)}
                      placeholder="matcher (可选，如 Bash, '' 匹配全部)"
                      className="w-full bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-[11px] font-mono" />
                    <textarea value={newCmd} onChange={(e) => setNewCmd(e.target.value)}
                      placeholder="shell 命令"
                      className="w-full h-16 bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-[11px] font-mono resize-none" />
                    <div className="flex gap-1.5">
                      <button onClick={() => addHook(event)} disabled={!newCmd.trim()}
                        className="btn-accent text-[11px] px-2.5 py-1">添加</button>
                      <button onClick={() => { setAdding(null); setNewCmd(''); setNewMatcher(''); }}
                        className="text-[11px] px-2.5 py-1 text-ink-muted hover:text-ink">取消</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setAdding(event)}
                    className="text-[10px] text-accent hover:underline flex items-center gap-1 font-body">
                    <Plus size={11} /> 新增 hook
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function JsonTab({ rawJson, setRawJson, onSave, onReset, saving, saved }) {
  return (
    <div className="space-y-3">
      <textarea value={rawJson} onChange={(e) => setRawJson(e.target.value)}
        spellCheck={false}
        className="w-full h-[60vh] bg-canvas-warm border border-canvas-deep rounded-lg p-3 text-xs font-mono text-ink-soft resize-none focus:outline-none focus:border-accent/40 leading-relaxed" />
      <div className="flex gap-2">
        <button onClick={onSave} disabled={saving}
          className="btn-accent flex items-center gap-1.5 px-3 py-1.5 text-xs">
          {saved ? <Check size={12} /> : <Save size={12} />}
          {saved ? '已保存' : saving ? '保存中…' : '保存'}
        </button>
        <button onClick={onReset}
          className="px-3 py-1.5 bg-canvas-warm text-ink-faint text-xs font-body rounded-lg hover:text-ink-muted">重置</button>
      </div>
    </div>
  );
}
