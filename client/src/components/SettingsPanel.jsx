import React, { useEffect, useState, useRef } from 'react';
import { Settings, Save, RefreshCw, AlertCircle, Check, Plus, Trash2, ChevronDown, ChevronRight, ShieldCheck, ShieldAlert, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { openExternalUrl } from '../utils/openExternal.js';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { useStore } from '../stores/sessionStore.js';
import EnvCheckPanel from './EnvCheckPanel.jsx';

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
  const [tab, setTab] = useState('overview'); // overview | hooks | json | storage

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`加载设置失败 (HTTP ${res.status})`);
      const data = await res.json();
      setSettings(data);
      setRawJson(JSON.stringify(data, null, 2));
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  useEffect(() => { fetchSettings(); }, []);

  // CJ-2:从顶栏「更新」按钮 / 弹窗"前往更新"跳转过来 → 切到 overview 并滚动高亮对应更新区
  // (gui-update / cc-update)。window.__cguiSettingsJump 兜底:点击早于本面板挂载时从这读。
  useEffect(() => {
    const go = (section) => {
      if (!section) return;
      setTab('overview');
      setTimeout(() => {
        const el = document.getElementById(section);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-accent', 'ring-offset-2', 'rounded-lg');
        setTimeout(() => el.classList.remove('ring-2', 'ring-accent', 'ring-offset-2'), 2000);
      }, 80);
    };
    if (window.__cguiSettingsJump) { const s = window.__cguiSettingsJump; window.__cguiSettingsJump = null; go(s); }
    const onJump = (e) => { window.__cguiSettingsJump = null; go(e?.detail?.section); };
    window.addEventListener('cgui:settings-jump', onJump);
    return () => window.removeEventListener('cgui:settings-jump', onJump);
  }, []);

  // Persist either an arbitrary object (Hooks tab) or the raw JSON (JSON tab).
  const save = async (next) => {
    setSaving(true); setError(null);
    try {
      let body;
      if (next !== undefined) {
        body = next;
      } else {
        try { body = JSON.parse(rawJson); }
        catch { throw new Error('JSON 格式错误，请检查后再保存'); }
      }
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
        {[['overview', '概览'], ['env', '环境'], ['hooks', 'Hooks'], ['json', '原始配置'], ['storage', '存储'], ['network', '网络']].map(([id, label]) => (
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

      {tab === 'overview' && <OverviewTab settings={settings} onSave={save} saving={saving} />}
      {tab === 'env' && <EnvCheckPanel asModal={false} />}
      {tab === 'hooks' && (
        <HooksTab settings={settings} onSave={save} saving={saving} saved={saved} />
      )}
      {tab === 'json' && (
        <JsonTab rawJson={rawJson} setRawJson={setRawJson} onSave={() => save()}
          onReset={() => { setRawJson(JSON.stringify(settings, null, 2)); setError(null); }}
          saving={saving} saved={saved} />
      )}
      {tab === 'storage' && <StorageTab />}
      {tab === 'network' && <NetworkTab />}
    </div>
  );
}

// Network access controls — toggle LAN binding (0.0.0.0) + custom port. Writes
// ~/.claude-gui/network.json; takes effect on next server start (no runtime
// relisten). No auth is added — access control is delegated to the network layer
// (tailscale/LAN) per the user's explicit choice, so a red warning is shown.
function NetworkTab() {
  const [cfg, setCfg] = useState(null);
  const [lanOn, setLanOn] = useState(false);
  const [port, setPort] = useState(6677);
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const load = async () => {
    try {
      const r = await fetch('/api/network');
      const d = await r.json();
      setCfg(d); setLanOn(d.host === '0.0.0.0'); setPort(d.port);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true); setErr(null); setMsg(null);
    try {
      const body = { host: lanOn ? '0.0.0.0' : '127.0.0.1', port: Number(port) };
      if (password) body.password = password;
      const r = await fetch('/api/network', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '保存失败');
      setPassword('');
      setMsg('已保存，重启后生效。'); load();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  // One-tap restart via the gui.command watchdog. Polls /api/network until the
  // server answers again, then reloads (so the new binding/cookie state applies).
  const restart = async () => {
    setRestarting(true); setErr(null); setMsg(null);
    try {
      const r = await fetch('/api/restart', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '重启失败');
      setMsg('正在重启…');
      // Server exits ~250ms later; watchdog relaunches. Poll for it to come back.
      let tries = 0;
      const tick = async () => {
        tries++;
        try {
          const p = await fetch('/api/network', { cache: 'no-store' });
          if (p.ok) { window.location.reload(); return; }
        } catch {}
        if (tries < 40) setTimeout(tick, 500);
        else { setRestarting(false); setErr('重启超时，请手动检查 server'); }
      };
      setTimeout(tick, 1200);
    } catch (e) { setErr(e.message); setRestarting(false); }
  };

  if (!cfg) return <div className="py-8 flex justify-center"><RefreshCw size={14} className="animate-spin text-ink-faint" /></div>;
  const lanAddr = cfg.lanIps?.[0] ? `http://${cfg.lanIps[0]}:${port}` : null;
  const needPassword = lanOn && !cfg.hasPassword && !password;

  return (
    <div className="space-y-4">
      {cfg.defaultPassword && (
        <div className="flex items-start gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5 font-body leading-relaxed">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-600" />
          <span>当前用的是<b>默认密码 123456</b>（为开箱即用的局域网访问预设）。这是弱密码，同一局域网内任何人都可能用它访问并控制你的 Claude——<b>请立刻在下方改成强密码</b>。若只在本机用，可取消下方「局域网访问」勾选并重启回到仅本机。</span>
        </div>
      )}
      <div className="text-[11px] text-ink-muted font-body">
        当前绑定：<span className="font-mono text-ink">{cfg.host}:{cfg.port}</span>
        <span className="ml-2">{cfg.lanMode ? '（局域网可访问）' : '（仅本机）'}</span>
        {cfg.hasPassword && <span className="ml-2 text-success">· 已设访问密码</span>}
      </div>

      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={lanOn} onChange={(e) => setLanOn(e.target.checked)} className="mt-0.5" />
        <div>
          <div className="text-[13px] text-ink font-body font-medium">{lanOn ? '局域网访问：开启（绑定 0.0.0.0）' : '开启局域网访问（绑定 0.0.0.0）'}</div>
          <div className="text-[11px] text-ink-faint font-body">关闭=保存后回到仅本机 127.0.0.1；开启后同局域网 / Tailscale 设备（含手机）凭密码访问下方地址。</div>
        </div>
      </label>

      {lanOn && (
        <div className="space-y-1.5">
          <div className="text-[12px] text-ink-soft font-body">
            访问密码 {cfg.hasPassword ? <span className="text-ink-faint">（已设置，留空＝不修改）</span> : <span className="text-error">（必填，至少 4 位）</span>}
          </div>
          <div className="relative">
            <input type={showPwd ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={cfg.hasPassword ? '••••（留空保持原密码）' : '设置访问密码'}
              className="w-full px-3 py-2 pr-10 text-[13px] font-body border border-canvas-deep rounded-lg bg-canvas text-ink focus:outline-none focus:border-accent" />
            <button type="button" onClick={() => setShowPwd((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-faint hover:text-ink"
              title={showPwd ? '隐藏密码' : '显示密码'}>
              {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-[12px] text-ink-soft font-body">端口</span>
        <input type="number" min={1024} max={65535} value={port} onChange={(e) => setPort(e.target.value)}
          className="w-24 px-2 py-1 text-[12px] font-mono border border-canvas-deep rounded bg-canvas text-ink" />
      </div>

      {lanOn && lanAddr && (
        <div className="text-[11px] text-ink-muted font-body">
          局域网地址：<span className="font-mono text-accent">{lanAddr}</span>
          {cfg.lanIps.length > 1 && <span className="text-ink-faint"> （共 {cfg.lanIps.length} 个网卡，按需选用）</span>}
        </div>
      )}

      {lanOn && (
        <div className="flex items-start gap-2 text-[11px] text-ink-soft bg-canvas-warm rounded-lg p-2.5 font-body leading-relaxed">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-accent" />
          <span>外部访问需密码登录；本机 127.0.0.1 始终免密。注意裸局域网 HTTP 下密码为明文传输——<b>优先走 Tailscale（已加密），勿暴露到公网或公共 WiFi</b>。</span>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={save} disabled={saving || needPassword}
          className="btn-accent flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body disabled:opacity-50">
          <Save size={12} />{saving ? '保存中…' : '保存'}
        </button>
        <button onClick={restart} disabled={restarting || !cfg.canRestart}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body rounded-lg border border-canvas-deep text-ink-soft hover:bg-canvas-warm disabled:opacity-50">
          <RefreshCw size={12} className={restarting ? 'animate-spin' : ''} />{restarting ? '重启中…' : '重启 / 应用绑定'}
        </button>
        {msg && <span className="text-[11px] text-success font-body">{msg}</span>}
        {err && <span className="text-[11px] text-error font-body">{err}</span>}
      </div>
      <p className="text-[10.5px] text-ink-faint font-body">
        配置写入 <span className="font-mono">~/.claude-gui/network.json</span>。
        {cfg.canRestart
          ? '点「重启 / 应用绑定」即可生效：GUI 双击启动走运行时切换（不重启进程，页面会自动刷新重连），命令行守护脚本走整进程重启。注：GUI 双击启动下改「端口」需重装应用才生效（只切换局域网开关可即时生效）。'
          : '当前未用守护脚本或 GUI 启动，「重启」不可用——请用项目根目录的 gui.command 启动 GUI。'}
      </p>
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
    if (!(await confirmDialog(`确定清理全部 ${data.items.length} 个 .bak 备份？将释放 ${fmtBytes(data.totalBytes)}。`, { danger: true }))) return;
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
        <b>这是什么：</b>当你"回滚一条对话"、或"切换模型时去掉历史里的思考块"时，系统会先把这条会话的原始记录存一份备份（<code className="font-mono">.jsonl.bak</code>），万一改坏了能恢复。
        <br /><b>删了有什么影响：</b>只会让你<b>没法再撤销那一次回滚/去思考块</b>，<b>不影响正常聊天</b>，也不会丢当前对话——纯粹是清磁盘空间。删了不可恢复，但绝大多数情况用不上，可放心清理。
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

// 自动选当前平台对应的安装包资产。
// 优先用 serverPlatform(后端 process.platform)— Tauri WebView2/WKWebView 的
// navigator.userAgent 在某些版本被改写过,光靠前端 UA 容易 miss。serverPlatform
// 是 Node 报告的 'darwin' / 'win32' / 'linux',绝对可靠。
function pickAssetForPlatform(assets, serverPlatform) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  // 优先 serverPlatform,fallback 到 UA(老 server 没传 serverPlatform 时)
  let platform = serverPlatform;
  if (!platform) {
    const ua = (navigator.userAgent || '').toLowerCase();
    if (ua.includes('mac')) platform = 'darwin';
    else if (ua.includes('windows') || (navigator.platform || '').toLowerCase().includes('win')) platform = 'win32';
  }
  if (platform === 'darwin') return assets.find((a) => /\.dmg$/i.test(a.name)) || null;
  if (platform === 'win32') {
    return assets.find((a) => /x64-setup\.exe$/i.test(a.name))
        || assets.find((a) => /\.exe$/i.test(a.name))
        || assets.find((a) => /\.msi$/i.test(a.name)) || null;
  }
  return null;
}

// 把 serverPlatform + asset 文件名翻译成人类可读的"目标系统"标签,
// 让按钮文字明确告知用户下载的是哪个平台版本(避免 Intel Mac 用户误装 ARM 包等)。
function describeAssetTarget(asset, serverPlatform) {
  if (!asset) return null;
  const name = (asset.name || '').toLowerCase();
  if (serverPlatform === 'darwin' || /\.dmg$/.test(name)) {
    if (name.includes('aarch64') || name.includes('arm64')) return 'Mac · Apple Silicon (M 芯片)';
    if (name.includes('x86_64') || name.includes('x64')) return 'Mac · Intel';
    return 'Mac';
  }
  if (serverPlatform === 'win32' || /\.(exe|msi)$/.test(name)) {
    const installer = /\.msi$/.test(name) ? 'MSI 安装包' : '安装程序';
    if (name.includes('x64')) return `Windows · x64 · ${installer}`;
    if (name.includes('arm64')) return `Windows · ARM64 · ${installer}`;
    return `Windows · ${installer}`;
  }
  if (serverPlatform === 'linux') return 'Linux';
  return null;
}

function UpdateAvailable({ state }) {
  // status: idle | downloading | done | err
  const [dl, setDl] = useState({ status: 'idle' });
  const asset = pickAssetForPlatform(state.assets, state.serverPlatform);
  const target = describeAssetTarget(asset, state.serverPlatform);

  const startDownload = async () => {
    if (!asset) return;
    setDl({ status: 'downloading', percent: 0, received: 0, total: asset.size || 0 });
    try {
      const r = await fetch('/api/download-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: asset.url, filename: asset.name }),
      });
      // CJ-1:成功路径是 NDJSON 流(逐行 progress/done/error);早期校验失败仍是普通 JSON。
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.includes('ndjson')) {
        const d = await r.json().catch(() => ({}));
        setDl({ status: 'err', message: d.error || `HTTP ${r.status}` });
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '', final = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'progress') {
            const pct = ev.total > 0 ? Math.min(100, Math.round((ev.received / ev.total) * 100)) : 0;
            setDl({ status: 'downloading', percent: pct, received: ev.received, total: ev.total });
          } else if (ev.type === 'done') final = { status: 'done', path: ev.path, platform: ev.platform };
          else if (ev.type === 'error') final = { status: 'err', message: ev.error };
        }
      }
      setDl(final || { status: 'err', message: '下载中断' });
    } catch (e) {
      setDl({ status: 'err', message: e.message || '网络错误' });
    }
  };

  return (
    <div className="text-[12px] bg-amber-50 border border-amber-200 text-amber-900 rounded p-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <span>新版本可用:</span>
        <b className="font-mono">v{state.latestVersion}</b>
        {state.publishedAt && (
          <span className="text-amber-700 text-[11px]">
            ({new Date(state.publishedAt).toLocaleDateString()})
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {asset && dl.status !== 'done' && (
          <button
            onClick={startDownload}
            disabled={dl.status === 'downloading'}
            className="px-3 py-1.5 text-[12px] bg-amber-700 text-white rounded-md hover:bg-amber-800 disabled:opacity-50 flex items-center gap-1.5"
            title={`将下载 ${asset.name} 到 ~/Downloads 并自动启动安装`}
          >
            {dl.status === 'downloading' ? (
              <>
                <RefreshCw size={12} className="animate-spin" />
                下载中… {dl.percent || 0}%
              </>
            ) : (
              <>
                ⬇️ 一键下载并安装
                {target && <span className="font-normal opacity-90 ml-0.5">· {target}</span>}
                <span className="font-mono text-[11px] opacity-80">({Math.round((asset.size || 0) / 1048576)}MB)</span>
              </>
            )}
          </button>
        )}
        <button
          onClick={(e) => { e.preventDefault(); openExternalUrl(state.htmlUrl); }}
          className="text-accent underline text-[12px] bg-transparent border-0 cursor-pointer p-0"
        >
          手动查看 Release
        </button>
      </div>

      {/* CJ-1:下载进度条 */}
      {dl.status === 'downloading' && (
        <div className="space-y-1">
          <div className="h-2 w-full rounded-full bg-amber-200 overflow-hidden">
            <div className="h-full bg-amber-600 transition-all duration-150" style={{ width: `${dl.percent || 0}%` }} />
          </div>
          <div className="text-[11px] text-amber-700 font-mono">
            {dl.percent || 0}% · {Math.round((dl.received || 0) / 1048576)}/{Math.round((dl.total || 0) / 1048576)}MB
          </div>
        </div>
      )}

      {dl.status === 'done' && (
        <div className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2 space-y-1">
          <div>✓ 已下载并打开安装包</div>
          <div className="text-[11px] text-emerald-700 break-all">{dl.path}</div>
          <div className="text-[11px] text-ink-muted">
            {dl.platform === 'darwin'
              ? '把弹出的「Claude GUI.app」拖到「应用程序」即可。装完关闭旧版,运行新版。'
              : dl.platform === 'win32'
              ? 'SmartScreen 提示时点「更多信息 → 仍要运行」。装完关闭旧版,运行新版。'
              : '装完关闭旧版,运行新版。'}
          </div>
        </div>
      )}

      {dl.status === 'err' && (
        <div className="text-[12px] text-error">下载失败:{dl.message}</div>
      )}

      {!asset && (
        <div className="text-[11px] text-amber-700">
          ⚠️ 没找到当前平台的安装包,请点上方链接手动下载。
        </div>
      )}
    </div>
  );
}

function UpdateChecker() {
  // status: idle(只显示版本) | checking | ok(有最新版本信息) | err
  const [state, setState] = useState({ status: 'idle', currentVersion: null });

  // 进面板时只读当前版本(避免每次开设置都打 GitHub API);用户点按钮才真比对。
  useEffect(() => {
    fetch('/api/version-check').then((r) => r.json()).then((d) => {
      setState((s) => ({ ...s, currentVersion: d.currentVersion }));
    }).catch(() => {});
  }, []);

  const check = async () => {
    setState((s) => ({ ...s, status: 'checking' }));
    try {
      const r = await fetch('/api/version-check');
      const d = await r.json();
      if (d.error) setState({ status: 'err', currentVersion: d.currentVersion, message: d.error });
      else setState({ status: 'ok', ...d });
    } catch (e) {
      setState((s) => ({ ...s, status: 'err', message: e.message || '网络错误' }));
    }
  };

  return (
    <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] text-ink-faint font-body uppercase tracking-wider">当前版本</div>
          <div className="text-[14px] font-mono text-ink mt-0.5">
            {state.currentVersion ? `v${state.currentVersion}` : '加载中…'}
          </div>
          {/* Q1: 界面 bundle 版本(构建时烤入)。与服务端不一致 = 当前页面是旧前端,标红示警 */}
          {typeof __BUILD_VERSION__ !== 'undefined' && (
            <div className={`text-[11px] font-mono mt-0.5 ${state.currentVersion && state.currentVersion !== __BUILD_VERSION__ ? 'text-error font-bold' : 'text-ink-faint'}`}>
              界面 v{__BUILD_VERSION__}
              {state.currentVersion && state.currentVersion !== __BUILD_VERSION__ && ' ⚠️ 与服务端不一致'}
            </div>
          )}
        </div>
        <button
          onClick={check}
          disabled={state.status === 'checking'}
          className="px-3 py-1.5 text-[12px] bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
        >
          <RefreshCw size={12} className={state.status === 'checking' ? 'animate-spin' : ''} />
          {state.status === 'checking' ? '检查中…' : '检查更新'}
        </button>
      </div>
      {state.status === 'ok' && (
        state.hasUpdate ? (
          <UpdateAvailable state={state} />
        ) : (
          <div className="text-[12px] text-success">✓ 已是最新版本</div>
        )
      )}
      {state.status === 'err' && (
        <div className="text-[12px] text-error">检查失败:{state.message}</div>
      )}
    </div>
  );
}

// 安装方式中文标签(检测结果 method → 展示名)。brew 版本滞后,不作为切换目标。
const METHOD_LABEL = { npm: 'npm', native: '官方安装器', brew: 'Homebrew(版本滞后)', unknown: '未知' };

function CcUpdater() {
  // status: idle | checking | ok | err ; updating: false | true
  const [state, setState] = useState({ status: 'idle' });
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState(null);
  const [logLines, setLogLines] = useState([]);   // CN-2 更新实时日志
  const [installs, setInstalls] = useState(null); // 机器上检测到的所有 claude 安装(null=未加载)

  const loadInstalls = async () => {
    try { setInstalls((await (await fetch('/api/claude-installs')).json()).installs || []); }
    catch { setInstalls([]); }
  };

  useEffect(() => {
    fetch('/api/claude-version-check').then((r) => r.json()).then((d) => {
      // 已装但查询出错(如 npm registry 失败)时标 err 让错误可见;未装时走安装按钮分支。
      // BI-3: 挂载时已拿到 hasUpdate/latestVersion,直接置 ok 让"一键更新"按钮立即显示,
      // 不再要求用户先点"检查更新"(更新弹窗"前往更新"落到设置页即见一键更新)。
      setState({ status: d.installed === false ? 'idle' : (d.error ? 'err' : 'ok'), ...d });
    }).catch(() => {});
    // 不论是否检测到安装都拉安装列表:原生/npm 切换按钮常驻,未装态也要能显示"未安装"。
    loadInstalls();
  }, []);

  // 切换 GUI 用哪个 claude(不重装)。path 空串=回到自动优先级。切完重刷列表 + 版本徽章。
  const switchActive = async (path) => {
    setUpdating(true);
    try {
      const r = await fetch('/api/claude-active', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'HTTP ' + r.status); }
      await loadInstalls();
      await check();
    } catch (e) {
      setResult({ ok: false, error: e.message || '切换失败' });
    }
    setUpdating(false);
  };

  const check = async () => {
    setState((s) => ({ ...s, status: 'checking' }));
    try {
      const d = await (await fetch('/api/claude-version-check')).json();
      setState({ status: d.error ? 'err' : 'ok', ...d });
    } catch (e) {
      setState((s) => ({ ...s, status: 'err', error: e.message || '网络错误' }));
    }
    // 检查更新同时重扫安装列表(此前只在挂载时扫一次 → 终端里刚装完 npm 版,
    // 点"检查更新"版本变了但切换区不出现,用户报告的"没有切换按钮"根因)。
    loadInstalls();
  };

  // 常驻的「原生版/npm 版」按钮:点击时先重扫安装列表(覆盖刚在终端装完、挂载时
  // 快照还没有它的场景),该方式已装→直接切换;未装→走安装流程(确认后开终端)。
  const clickMethod = async (m) => {
    setUpdating(true);
    let fresh = Array.isArray(installs) ? installs : [];
    try { fresh = (await (await fetch('/api/claude-installs')).json()).installs || []; } catch {}
    setInstalls(fresh);
    setUpdating(false);
    const list = fresh.filter((i) => i.method === m);
    if (list.find((i) => i.active)) return;                    // 已是当前使用
    if (list.length > 0) { await switchActive(list[0].path); return; }
    await doInstall(m, state.installed !== false);
  };

  // CN-2:在 GUI 内更新并实时显示进度(流式 NDJSON),不用开外部终端。
  const doUpdate = async () => {
    const cmd = state.updateCommand || 'claude upgrade';
    if (!(await confirmDialog(`将在应用内运行【${cmd}】更新 Claude Code 到 v${state.latestVersion}（安装方式：${state.method || '未知'}），进度实时显示在下方。\n（墙内需已开系统代理;若卡住可点"改用终端"。）确定继续?`))) return;
    setUpdating(true); setResult(null); setLogLines([]);
    try {
      const r = await fetch('/api/claude-update/stream', { method: 'POST' });
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const ln of lines) {
          if (!ln.trim()) continue;
          let ev; try { ev = JSON.parse(ln); } catch { continue; }
          if (ev.type === 'log') setLogLines((p) => [...p.slice(-200), ev.line]);
          else if (ev.type === 'start') setLogLines((p) => [...p, `$ ${ev.command}`]);
          else if (ev.type === 'error') setResult({ ok: false, error: ev.error });
          else if (ev.type === 'done') {
            setResult(ev.code === 0
              ? { ok: true, done: true }
              : { ok: false, error: `命令退出码 ${ev.code}（见下方日志)` });
            // 更新成功后让顶栏红色「更新」按钮立刻重查并熄灭(原来要重启 GUI 才消)。
            if (ev.code === 0) window.dispatchEvent(new CustomEvent('cgui:recheck-updates'));
          }
        }
      }
    } catch (e) {
      setResult({ ok: false, error: e.message || '请求失败' });
    }
    setUpdating(false);
  };

  // 兜底:headless 卡住(如 npm -g 需 sudo)时改用外部终端。
  const doUpdateTerminal = async () => {
    setUpdating(true); setResult(null);
    try { setResult(await (await fetch('/api/claude-update', { method: 'POST' })).json()); }
    catch (e) { setResult({ ok: false, error: e.message || '请求失败' }); }
    setUpdating(false);
  };

  // 装后自动重扫:安装在外部终端跑,GUI 不知道何时完成 → 每 5s 重扫安装列表(最长 3 分钟),
  // 一旦目标方式出现就自动切换过去 + 刷新版本徽章,用户装完回来"已经好了"。
  const pollRef = useRef(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);
  const pollForInstall = (method) => {
    if (pollRef.current) clearInterval(pollRef.current);
    let tries = 0;
    pollRef.current = setInterval(async () => {
      if (++tries > 36) { clearInterval(pollRef.current); pollRef.current = null; return; }
      let list = [];
      try { list = (await (await fetch('/api/claude-installs')).json()).installs || []; } catch { return; }
      const hit = list.find((i) => i.method === method);
      if (!hit) return;
      clearInterval(pollRef.current); pollRef.current = null;
      setInstalls(list);
      if (!hit.active) await switchActive(hit.path); else await check();
      setResult({ ok: true, installedMethod: method });
    }, 5000);
  };

  const doInstall = async (method = 'npm', isSwitch = false) => {
    // npm:需 Node ≥ 20(此 GUI 后端就是 node 跑的,故本机必有),认 HTTP_PROXY 代理、终端有进度。
    // native:官方安装器,自包含不依赖 node,从 claude.ai 拉。
    // isSwitch:已装状态下换一种安装方式(复用同一安装端点,以目标方式重装、接管 claude 命令)。
    const label = method === 'npm'
      ? 'npm install -g @anthropic-ai/claude-code(需 Node ≥ 20)'
      : '官方安装器(irm claude.ai/install.ps1 | iex / curl claude.ai/install.sh | bash)';
    const msg = isSwitch
      ? `将打开终端以【${label}】重新安装 Claude Code,把安装方式从「${METHOD_LABEL[state.method] || state.method || '未知'}」切换为「${METHOD_LABEL[method]}」。\n安装需联网访问 npm / claude.ai —— 墙内请先开代理(Clash 等开启系统代理)。\n完成后回来点"检查更新"重新识别;若仍显示旧方式,是 PATH 里旧安装更靠前所致(旧的不会被自动删除)。确定继续?`
      : `将打开终端运行【${label}】安装 Claude Code。\n安装需联网访问 npm / claude.ai —— 墙内请先开代理(Clash 等开启系统代理)。\n请在弹出的终端里查看进度,完成后回来点"检查更新"。确定继续?`;
    if (!(await confirmDialog(msg))) return;
    setUpdating(true); setResult(null);
    try {
      const d = await (await fetch('/api/claude-install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method }),
      })).json();
      setResult(d);
      if (d.ok) pollForInstall(method); // 装完自动检测到并切换,不用手点"检查更新"
    } catch (e) {
      setResult({ ok: false, error: e.message || '请求失败' });
    }
    setUpdating(false);
  };

  return (
    <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] text-ink-faint font-body uppercase tracking-wider">
            Claude Code CLI{state.method && state.installed !== false ? ` · ${state.method}` : ''}
          </div>
          <div className="text-[14px] font-mono text-ink mt-0.5">
            {state.installed === false ? '未安装' : state.currentVersion ? `v${state.currentVersion}` : '加载中…'}
          </div>
        </div>
        {state.installed === false ? (
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={() => doInstall('npm')}
              disabled={updating}
              className="px-3 py-1.5 text-[12px] bg-amber-700 text-white rounded-md hover:bg-amber-800 disabled:opacity-50 flex items-center gap-1.5"
            >
              {updating ? <RefreshCw size={12} className="animate-spin" /> : '⬇️'} npm 安装
            </button>
            <button
              onClick={() => doInstall('native')}
              disabled={updating}
              className="px-3 py-1.5 text-[12px] border border-amber-700/50 text-amber-800 rounded-md hover:bg-amber-50 disabled:opacity-50 flex items-center gap-1.5"
            >
              官方安装器
            </button>
          </div>
        ) : (
          <button
            onClick={check}
            disabled={state.status === 'checking' || updating}
            className="px-3 py-1.5 text-[12px] bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
          >
            <RefreshCw size={12} className={state.status === 'checking' ? 'animate-spin' : ''} />
            {state.status === 'checking' ? '检查中…' : '检查更新'}
          </button>
        )}
      </div>
      {state.installed === false && (
        <div className="text-[11px] text-ink-faint leading-snug">
          <b>npm</b>:走 npm 源、终端有下载进度,需 Node ≥ 20(此 GUI 已在用 Node,故必有)。
          <b>官方安装器</b>:自包含二进制、不依赖 Node。两者都需联网,墙内请先开代理(Clash 等<b>开启系统代理</b>)。
        </div>
      )}
      {state.status === 'ok' && (
        state.hasUpdate ? (
          <div className="text-[12px] bg-amber-50 border border-amber-200 text-amber-900 rounded p-2.5 space-y-2">
            <div className="flex items-center gap-1.5">
              <span>Claude Code 新版:</span><b className="font-mono">v{state.latestVersion}</b>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={doUpdate}
                disabled={updating}
                className="px-3 py-1.5 text-[12px] bg-amber-700 text-white rounded-md hover:bg-amber-800 disabled:opacity-50 flex items-center gap-1.5"
              >
                {updating ? <><RefreshCw size={12} className="animate-spin" />更新中…</> : <>⬇️ 一键更新</>}
              </button>
              <button onClick={doUpdateTerminal} disabled={updating}
                className="text-[11px] text-amber-800/80 hover:text-amber-900 underline disabled:opacity-50"
                title="若应用内更新卡住(如 npm 需 sudo),改用外部终端">改用终端</button>
            </div>
          </div>
        ) : (
          <div className="text-[12px] text-success">✓ 已是最新版本</div>
        )
      )}
      {state.status === 'err' && <div className="text-[12px] text-error">{state.error}</div>}
      {/* 使用哪个 Claude:原生版/npm 版两个按钮常驻(不论是否安装)。点击时先重扫一遍
          安装列表(覆盖"刚在终端装完回来点"的场景):该方式已装→直接切换;未装→确认后打开
          终端安装。下方仍列出检测到的全部安装(brew/多处并存时可精确钉选某一处)。 */}
      <div className="border-t border-canvas-deep/60 pt-2 space-y-1.5">
        <div className="text-[11px] text-ink-muted font-body">
          使用哪个 Claude{Array.isArray(installs) && installs.length > 0 && (
            <span className="text-ink-faint">(检测到 {installs.length} 处安装)</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {[['native', '原生版(官方安装器)'], ['npm', 'npm 版']].map(([m, label]) => {
            const list = Array.isArray(installs) ? installs.filter((i) => i.method === m) : [];
            const it = list.find((i) => i.active) || list[0] || null;
            const isActive = !!(it && it.active);
            return (
              <button key={m} disabled={updating} onClick={() => clickMethod(m)}
                className={`px-2.5 py-2 text-left rounded-md border transition-colors disabled:opacity-50 ${isActive ? 'bg-accent/10 border-accent/40 cursor-default' : 'bg-canvas-warm border-canvas-deep hover:border-accent/40'}`}>
                <span className="block text-[11.5px] font-body text-ink">{label}</span>
                <span className={`block text-[10px] font-body mt-0.5 ${isActive ? 'text-accent' : it ? 'text-ink-muted' : 'text-ink-faint'}`}>
                  {isActive ? `当前使用${it.version ? ` · v${it.version}` : ''}`
                    : it ? `已安装${it.version ? ` v${it.version}` : ''} · 点击切换`
                    : '未安装 · 点击安装'}
                </span>
              </button>
            );
          })}
        </div>
        {Array.isArray(installs) && installs.length > 0 && (
          <div className="space-y-1">
            {installs.map((it) => {
              const label = METHOD_LABEL[it.method] || it.method || '未知';
              return (
                <button key={it.path} disabled={updating || it.active} onClick={() => switchActive(it.path)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left rounded-md border transition-colors ${it.active ? 'bg-accent/10 border-accent/40 cursor-default' : 'bg-canvas-warm border-canvas-deep hover:border-accent/40 disabled:opacity-50'}`}>
                  <span className={`shrink-0 w-3.5 h-3.5 rounded-full border grid place-items-center ${it.active ? 'border-accent' : 'border-ink-faint'}`}>
                    {it.active && <span className="w-2 h-2 rounded-full bg-accent" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-[11.5px] font-body text-ink">{label}{it.version ? ` · v${it.version}` : ''}{it.active ? ' · 当前' : ''}</span>
                    <span className="block text-[10px] font-mono text-ink-faint truncate">{it.path}</span>
                  </span>
                  {!it.active && <span className="shrink-0 text-[10.5px] text-accent font-body">切换</span>}
                </button>
              );
            })}
          </div>
        )}
        <div className="text-[10.5px] text-ink-faint font-body leading-snug">
          切换只是让 GUI 改用另一处已装的 claude(<b>不重装、不下载</b>),立即对聊天/子代理/MCP 生效。
          更新提示只针对当前使用的版本;另一版本过时不提示。
        </div>
      </div>
      {/* CN-2 实时进度日志 */}
      {(updating || logLines.length > 0) && (
        <pre className="text-[10px] leading-snug font-mono text-ink-soft bg-canvas border border-canvas-deep rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
          {logLines.length ? logLines.join('\n') : '启动中…'}{updating && <span className="animate-pulse"> ▌</span>}
        </pre>
      )}
      {result && (
        result.ok
          ? <div className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2 break-words">
              {result.installedMethod
                ? <>✓ 检测到 {result.installedMethod === 'npm' ? 'npm 版' : '原生版'}安装完成,已自动切换使用。</>
                : result.done
                ? <>✓ 更新完成。点上方"检查更新"确认新版本。</>
                : <>✓ 已在终端启动 <code className="font-mono break-all">{result.command}</code>。安装完成后会自动检测并切换(约 5 秒内)。</>}
            </div>
          : <div className="text-[12px] text-error">更新失败:{result.error}</div>
      )}
    </div>
  );
}

// P1: 关闭行为 — 点窗口关闭按钮时 询问/最小化/退出。写 ~/.claude-gui/close-behavior.json,
// Tauri Rust 在 CloseRequested 时读同一文件,保存即生效(无需重启)。仅桌面壳有意义,
// 浏览器(6677 页)关标签页不受此控制,但选项保留显示无妨。
function CloseBehaviorPicker() {
  const [behavior, setBehavior] = useState('ask');
  useEffect(() => {
    fetch('/api/prefs/close-behavior').then((r) => r.json())
      .then((d) => setBehavior(d.behavior || 'ask')).catch(() => {});
  }, []);
  const save = (b) => {
    setBehavior(b);
    fetch('/api/prefs/close-behavior', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ behavior: b }),
    }).catch(() => {});
  };
  return (
    <div className="rounded-lg border border-canvas-deep bg-canvas-warm/40 p-3">
      <div className="text-[12px] font-medium text-ink font-body mb-1.5">关闭窗口时(桌面版)</div>
      <div className="flex items-center gap-2">
        {[['ask', '每次询问'], ['minimize', '最小化'], ['quit', '完全退出']].map(([v, label]) => (
          <button key={v} onClick={() => save(v)}
            className={`px-2.5 py-1 text-[11px] rounded-md font-body transition-colors ${behavior === v ? 'bg-accent text-white' : 'bg-canvas-warm text-ink-muted hover:text-ink border border-canvas-deep'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="text-[10.5px] text-ink-faint font-body mt-1.5">完全退出会结束后台服务(6677)及其全部子进程;最小化保持后台运行</div>
    </div>
  );
}

// macOS 完全磁盘访问(FDA)状态卡。仅 macOS 渲染(端点返回 platform 判断)。
// 主动 probe(readdir ~/Downloads)拿真实授权态:能读=已授权,读不了=未授权→红色
// 提示 + 一键打开系统设置。持久自签后授权跨 build 存活,但首次/异常仍需用户操作。
function FullDiskAccessCard() {
  const [status, setStatus] = useState(null); // { platform, canReadDownloads }
  const [checking, setChecking] = useState(true);

  const check = async () => {
    setChecking(true);
    try {
      const r = await fetch('/api/system/permission-status?probe=1');
      setStatus(await r.json());
    } catch { setStatus({ platform: 'unknown' }); }
    setChecking(false);
  };
  useEffect(() => { check(); }, []);

  const openSettings = () => { fetch('/api/system/open-fda-settings', { method: 'POST' }).catch(() => {}); };

  // 非 macOS 不显示(Windows/Linux 无 TCC)。加载中也不显示,避免闪烁。
  if (!status || status.platform !== 'darwin') return null;
  const granted = status.canReadDownloads === true;

  return (
    <div className={`border rounded-lg overflow-hidden ${granted ? 'border-canvas-deep' : 'border-amber-300/60'}`}>
      <div className={`flex items-center gap-2.5 px-3 py-2.5 ${granted ? 'bg-canvas-warm' : 'bg-amber-50'}`}>
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${granted ? 'bg-emerald-100' : 'bg-amber-100'}`}>
          {granted ? <ShieldCheck size={15} className="text-emerald-600" /> : <ShieldAlert size={15} className="text-amber-700" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-ink font-body">完全磁盘访问 (FDA)</div>
          <div className="text-[11px] text-ink-faint font-body">
            {checking ? '检测中…' : granted ? '已授权,Claude 可读取受保护目录' : '未授权,Claude 读取 Desktop/Documents/Downloads 会失败'}
          </div>
        </div>
        <button onClick={check} disabled={checking} className="p-1 text-ink-faint hover:text-ink shrink-0" title="重新检测">
          <RefreshCw size={12} className={checking ? 'animate-spin' : ''} />
        </button>
      </div>
      {!granted && !checking && (
        <div className="border-t border-amber-200/60 px-3 py-2.5 space-y-2 bg-amber-50/40">
          <ol className="list-decimal list-inside space-y-0.5 text-[11px] text-ink-muted font-body">
            <li>点下方按钮打开 系统设置 → 完全磁盘访问</li>
            <li>点 <span className="px-1 rounded bg-canvas-deep font-mono text-[10px]">+</span> 选 <span className="font-mono text-[10px]">/Applications/Claude GUI.app</span></li>
            <li>打开开关,完全退出本 app 后重新打开</li>
          </ol>
          <button onClick={openSettings}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-white bg-accent hover:bg-accent/90 rounded-md transition-colors">
            <ExternalLink size={12} /> 打开系统设置
          </button>
        </div>
      )}
    </div>
  );
}

// 取值可枚举的已知变量 → 下拉选项(当前值不在列表时并入,防止自定义值被吞)。
// 布尔类 CLI 惯例 0/1;ENABLE_TOOL_SEARCH 官方用 true/false;effort 档位与 ChatInput
// 的 EFFORT_LEVELS 对齐。不在表里的(如 ANTHROPIC_MODEL 自由模型 id)仍是文本框。
const ENV_VALUE_OPTIONS = {
  CLAUDE_CODE_EFFORT_LEVEL: ['low', 'medium', 'high', 'xhigh', 'max'],
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: ['1', '0'],
  DISABLE_AUTOUPDATER: ['1', '0'],
  DISABLE_TELEMETRY: ['1', '0'],
  DISABLE_ERROR_REPORTING: ['1', '0'],
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: ['1', '0'],
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: ['1', '0'],
  ENABLE_TOOL_SEARCH: ['true', 'false'],
};

// 环境变量行内编辑:每项可改值/删除,底部可新增。改完(失焦/回车/选下拉/删除/新增)即把
// 整个 env 对象 PUT 回 settings.json(浅合并整体替换 env,删除项自然消失)。父组件
// 保存后回传新 settings → env 身份变化 → 重置草稿。敏感值默认密文,点眼睛看明文再改。
function EnvEditor({ env, onSave, saving }) {
  const isSecret = (k) => /KEY|TOKEN|SECRET|PASSWORD|PWD|CREDENTIAL/i.test(k);
  const [draft, setDraft] = useState(env);
  const [revealed, setRevealed] = useState({});
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { setDraft(env); }, [env]);

  const commit = (nextEnv) => { setErr(''); onSave?.({ env: nextEnv }); };
  const saveValue = (k) => { if (draft[k] !== env[k]) commit({ ...env, [k]: draft[k] }); };
  const removeKey = async (k) => {
    if (!(await confirmDialog(`删除环境变量 ${k}?`, { danger: true }))) return;
    const next = { ...env }; delete next[k]; commit(next);
  };
  const addKey = () => {
    const k = newKey.trim();
    if (!k) return;
    if (k in env) { setErr(`${k} 已存在`); return; }
    commit({ ...env, [k]: newVal }); setNewKey(''); setNewVal('');
  };

  return (
    <div className="border-t border-canvas-deep">
      {Object.keys(draft).length === 0 && (
        <div className="px-3 py-2.5 text-[11px] text-ink-faint font-body">暂无环境变量,可在下方新增。</div>
      )}
      <div className="divide-y divide-canvas-deep/60">
        {Object.keys(draft).map((k) => (
          <div key={k} className="px-3 py-2 flex items-center gap-2">
            <span className="text-[11px] font-mono text-ink-soft shrink-0 max-w-[42%] break-all">{k}</span>
            {ENV_VALUE_OPTIONS[k] ? (
              <select
                value={draft[k] ?? ''}
                onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, [k]: v })); commit({ ...env, [k]: v }); }}
                disabled={saving}
                className="flex-1 min-w-0 text-[11px] font-mono bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-ink focus:border-accent outline-none">
                {/* 当前值不在预设列表时并入,避免自定义值被吞 */}
                {(ENV_VALUE_OPTIONS[k].includes(draft[k]) ? ENV_VALUE_OPTIONS[k] : [draft[k], ...ENV_VALUE_OPTIONS[k]]).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : (
            <input
              type={isSecret(k) && !revealed[k] ? 'password' : 'text'}
              value={draft[k] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
              onBlur={() => saveValue(k)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              disabled={saving}
              className="flex-1 min-w-0 text-[11px] font-mono bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-ink focus:border-accent outline-none" />
            )}
            {isSecret(k) && (
              <button onClick={() => setRevealed((r) => ({ ...r, [k]: !r[k] }))}
                className="text-ink-faint hover:text-ink shrink-0" title={revealed[k] ? '隐藏' : '显示'}>
                {revealed[k] ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            )}
            <button onClick={() => removeKey(k)} disabled={saving}
              className="text-ink-faint hover:text-error shrink-0" title="删除">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="px-3 py-2 flex items-center gap-2 border-t border-canvas-deep/60">
        <input value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())}
          placeholder="新变量名" disabled={saving}
          className="w-[42%] text-[11px] font-mono bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-ink focus:border-accent outline-none" />
        <input value={newVal} onChange={(e) => setNewVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addKey(); }}
          placeholder="值" disabled={saving}
          className="flex-1 min-w-0 text-[11px] font-mono bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-ink focus:border-accent outline-none" />
        <button onClick={addKey} disabled={saving || !newKey.trim()}
          className="text-accent hover:text-accent/80 disabled:opacity-40 shrink-0" title="新增">
          <Plus size={14} />
        </button>
      </div>
      {err && <div className="px-3 pb-2 text-[11px] text-error font-body">{err}</div>}
    </div>
  );
}


// 缓存优化开关(CLI --exclude-dynamic-system-prompt-sections)。作用:把每轮变化的动态段
// (工作目录 / auto-memory / git 状态)移出系统提示、改注入首条用户消息,使系统提示保持静态。
// 会话常驻进程(#26):回合结束后 CLI 进程保活,同会话下一条消息直接复用 —— 免掉每回合
// 冷启动(claude 二进制 + 配置 + 全部 MCP server,实测约 5 秒)。模型/思考强度/provider
// 等任何配置变化都会自动重开新进程,行为与关闭时一致。
function PersistentChatToggle() {
  const on = useStore((s) => s.persistentChat);
  const setOn = useStore((s) => s.setPersistentChat);
  return (
    <div className="bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink font-body font-medium">会话常驻进程</div>
        <div className="text-[10.5px] text-ink-faint font-body">回合结束后保留 CLI 进程,同一会话的下一条消息直接复用,省掉每回合的进程冷启动与 MCP 重启(约 5 秒),响应更快、第三方缓存更稳。切换模型/思考强度/provider 时自动重开进程。空闲 15 分钟自动回收</div>
      </div>
      <button onClick={() => setOn(!on)}
        className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${on ? 'bg-accent' : 'bg-ink-faint/30'}`}
        title={on ? '已开启' : '已关闭'}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}

function ExcludeDynamicPromptToggle() {
  const val = useStore((s) => s.excludeDynamicSystemPrompt); // 'auto' | true | false
  const setVal = useStore((s) => s.setExcludeDynamicSystemPrompt);
  return (
    <div className="bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink font-body font-medium">缓存优化</div>
        <div className="text-[10.5px] text-ink-faint font-body">把每轮变化的动态段(工作目录、auto-memory、git 状态)移出系统提示、改注入首条用户消息,使系统提示保持静态,提升第三方 provider 的前缀缓存命中、降低费用。「自动」= 第三方 provider 开启、官方渠道关闭(官方无需开启)</div>
      </div>
      <div className="shrink-0 flex items-center gap-1">
        {[['auto', '自动'], [true, '开'], [false, '关']].map(([v, label]) => (
          <button key={String(v)} onClick={() => setVal(v)}
            className={`px-2 py-1 text-[11px] rounded-md font-body transition-colors ${val === v ? 'bg-accent text-white' : 'bg-canvas-warm text-ink-muted hover:text-ink border border-canvas-deep'}`}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// 自动压缩窗口(settings.json 的 autoCompactWindow,单位 token;官方配置项,CLI 范围
// 100000–1000000)。上下文占用逼近该窗口时 CLI 自动压缩历史。置空 = 恢复 CLI 默认
// (按模型自动决定)。注:环境变量 CLAUDE_CODE_AUTO_COMPACT_WINDOW 若已设置会覆盖此项。
const AUTO_COMPACT_OPTIONS = [
  { value: '',        label: '默认(按模型自动)' },
  { value: '100000',  label: '100K token' },
  { value: '150000',  label: '150K token' },
  { value: '200000',  label: '200K token' },
  { value: '300000',  label: '300K token' },
  { value: '500000',  label: '500K token' },
  { value: '1000000', label: '1M token' },
];
function AutoCompactWindowSelect({ settings, onSave, saving }) {
  const raw = settings?.autoCompactWindow;
  const current = (typeof raw === 'number' && Number.isFinite(raw)) ? String(raw) : '';
  // 当前值不在预设内(用户手改过 JSON)时并入,避免下拉把它吞掉。
  const opts = AUTO_COMPACT_OPTIONS.some((o) => o.value === current)
    ? AUTO_COMPACT_OPTIONS
    : [{ value: current, label: `${current} token(自定义)` }, ...AUTO_COMPACT_OPTIONS];
  return (
    <div className="bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink font-body font-medium">自动压缩窗口</div>
        <div className="text-[10.5px] text-ink-faint font-body">上下文占用逼近该 token 窗口时,CLI 自动压缩会话历史。调大则更晚触发、保留更多上下文,调小则更早压缩。置为默认时按模型自动决定。若环境变量 CLAUDE_CODE_AUTO_COMPACT_WINDOW 已设置,则以环境变量为准。<span className="text-ink-muted">参考:200K 窗口模型选 150K–180K、1M 窗口模型选 800K–900K,给压缩留出余量</span></div>
      </div>
      <select
        value={current}
        onChange={(e) => { const v = e.target.value; onSave?.({ autoCompactWindow: v ? Number(v) : null }); }}
        disabled={saving}
        className="shrink-0 text-[11px] font-mono bg-canvas-base border border-canvas-deep rounded px-2 py-1 text-ink focus:border-accent outline-none">
        {opts.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    </div>
  );
}

// 轻量快速模型(env.ANTHROPIC_SMALL_FAST_MODEL):CLI 用它跑非核心小任务 —— 生成会话
// 标题、后台压缩摘要等。默认与主模型同族的小号(如 haiku),设成更便宜/更快的模型可省钱提速,
// 不影响正式对话质量。置空 = 交回 CLI 默认。写法同 EnvEditor:整块替换 env,空值删除该键。
function SmallFastModelInput({ env, onSave, saving }) {
  const current = env?.ANTHROPIC_SMALL_FAST_MODEL || '';
  const [draft, setDraft] = useState(current);
  useEffect(() => { setDraft(current); }, [current]);
  const commit = () => {
    const v = draft.trim();
    if (v === current) return;
    const next = { ...env };
    if (v) next.ANTHROPIC_SMALL_FAST_MODEL = v; else delete next.ANTHROPIC_SMALL_FAST_MODEL;
    onSave?.({ env: next });
  };
  return (
    <div className="bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink font-body font-medium">轻量快速模型</div>
        <div className="text-[10.5px] text-ink-faint font-body">CLI 用它跑非核心小任务(生成会话标题、后台压缩摘要等),不影响正式对话。设成更便宜或更快的模型可省钱提速。置空恢复 CLI 默认。第三方 provider 需填该中转支持的模型 id。</div>
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        disabled={saving}
        placeholder="默认"
        className="shrink-0 w-44 text-[11px] font-mono bg-canvas-base border border-canvas-deep rounded px-2 py-1 text-ink focus:border-accent outline-none" />
    </div>
  );
}

// 对话区背景设置(③):纯色 / 本地图片 / 本地视频,附遮罩不透明度滑杆。
// 状态存 store.chatBackground(localStorage 全局持久化);文件经 POST /api/backgrounds
// 上传到 ~/.claude-gui/backgrounds/,客户端只持有服务端生成的文件名。
function ChatBackgroundCard() {
  const bg = useStore((s) => s.chatBackground);
  const setBg = useStore((s) => s.setChatBackground);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  const mask = Math.min(100, Math.max(0, Number(bg?.maskOpacity ?? 40)));

  // 换背景/恢复默认前删除服务端旧文件,避免孤儿文件堆积。
  const deleteFile = async (file) => {
    if (!file) return;
    try { await fetch(`/api/backgrounds/${encodeURIComponent(file)}`, { method: 'DELETE' }); } catch {}
  };

  const pickFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // 允许重复选同一文件
    if (!f) return;
    setErr('');
    if (f.size > 50 * 1024 * 1024) { setErr('文件超过 50MB 上限'); return; }
    setUploading(true);
    try {
      const res = await fetch('/api/backgrounds', {
        method: 'POST',
        headers: {
          'Content-Type': f.type || 'application/octet-stream',
          'X-Upload-Name': encodeURIComponent(f.name),
        },
        body: f,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `上传失败(HTTP ${res.status})`);
      const old = bg?.file;
      setBg({ kind: data.kind, file: data.file, color: bg?.color || '', maskOpacity: mask });
      await deleteFile(old);
    } catch (e2) {
      setErr(e2.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const setColor = (color) => {
    // 选择纯色即切换到纯色模式;已有媒体文件时先删除。
    const old = bg?.file;
    setBg({ kind: 'color', color, file: '', maskOpacity: mask });
    if (old) deleteFile(old);
  };

  const reset = async () => {
    if (!(await confirmDialog('恢复默认背景？已上传的背景文件将被删除。', { danger: true }))) return;
    const old = bg?.file;
    setBg(null);
    setErr('');
    await deleteFile(old);
  };

  const KIND_LABEL = { color: '纯色', image: '图片', video: '视频' };

  return (
    <div className="bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2.5 space-y-2.5">
      <div>
        <div className="text-xs text-ink font-body font-medium">对话区背景</div>
        <div className="text-[10.5px] text-ink-faint font-body">
          设置对话消息区的背景:纯色、本地图片(png/jpg/gif/webp)或本地视频(mp4/webm),文件不超过 50MB。
          遮罩不透明度控制主题底色覆盖在背景上的比例,数值越高文字越易读。默认状态不修改现有外观。
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-ink-muted font-body">当前:{bg?.kind ? KIND_LABEL[bg.kind] || bg.kind : '默认'}</span>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted font-body cursor-pointer">
          纯色
          <input
            type="color"
            value={bg?.color || '#f0ebe0'}
            onChange={(e) => setColor(e.target.value)}
            className="w-6 h-6 p-0 border border-canvas-deep rounded cursor-pointer bg-transparent"
          />
        </label>
        <label className={`text-[11px] px-2 py-1 rounded border border-canvas-deep font-body cursor-pointer hover:border-accent ${uploading ? 'opacity-50 pointer-events-none' : 'text-ink-muted'}`}>
          {uploading ? '上传中…' : '选择图片/视频'}
          <input type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.mp4,.webm" className="hidden" onChange={pickFile} disabled={uploading} />
        </label>
        {bg?.kind && (
          <button onClick={reset} className="text-[11px] px-2 py-1 rounded border border-canvas-deep text-ink-muted font-body hover:text-error hover:border-error/50">
            恢复默认
          </button>
        )}
      </div>
      {bg?.kind && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-muted font-body shrink-0">遮罩不透明度</span>
          <input
            type="range" min="0" max="100" step="5" value={mask}
            onChange={(e) => setBg({ ...bg, maskOpacity: Number(e.target.value) })}
            className="flex-1 accent-[var(--color-accent)]"
          />
          <span className="text-[11px] text-ink-soft font-mono w-9 text-right">{mask}%</span>
        </div>
      )}
      {err && <div className="text-[11px] text-error font-body">{err}</div>}
    </div>
  );
}

function OverviewTab({ settings, onSave, saving }) {
  const [showEnv, setShowEnv] = useState(false);

  const env = settings?.env || {};
  const envKeys = Object.keys(env);
  // hooks 的查看/编辑在独立的 Hooks 标签页,概览不再重复展示;这里只用事件数判断概览是否为空。
  const hookEvents = Object.keys(settings?.hooks || {});

  const rows = [];
  if (settings?.defaultModel || settings?.model) rows.push(['默认模型', settings.defaultModel || settings.model]);
  if (settings?.permissions) rows.push(['权限规则', `${Object.keys(settings.permissions).length} 条`]);
  if (settings?.plugins) rows.push(['插件', `${Object.keys(settings.plugins).length} 个`]);

  const isEmpty = rows.length === 0 && envKeys.length === 0 && hookEvents.length === 0;

  return (
    <div className="space-y-3">
      <div id="gui-update"><UpdateChecker /></div>
      <div id="cc-update"><CcUpdater /></div>
      <FullDiskAccessCard />
      <CloseBehaviorPicker />
      <PersistentChatToggle />
      <ExcludeDynamicPromptToggle />
      <AutoCompactWindowSelect settings={settings} onSave={onSave} saving={saving} />
      <SmallFastModelInput env={env} onSave={onSave} saving={saving} />
      <ChatBackgroundCard />
      {rows.length > 0 && (
        <div className="bg-canvas-warm border border-canvas-deep rounded-lg divide-y divide-canvas-deep">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between px-3 py-2.5">
              <span className="text-xs text-ink-muted font-body">{k}</span>
              <span className="text-xs text-ink-soft font-mono">{v}</span>
            </div>
          ))}
        </div>
      )}

      {/* 环境变量 — 默认折叠;展开后每项可改值/删除,底部可新增。改完即写回 settings.json 的 env */}
      <div className="border border-canvas-deep rounded-lg overflow-hidden">
        <button onClick={() => setShowEnv((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-canvas-warm/60 text-left">
          {showEnv ? <ChevronDown size={12} className="text-ink-faint" /> : <ChevronRight size={12} className="text-ink-faint" />}
          <span className="text-xs text-ink-muted font-body flex-1">环境变量</span>
          <span className="text-xs text-ink-soft font-mono">{envKeys.length} 个</span>
        </button>
        {showEnv && <EnvEditor env={env} onSave={onSave} saving={saving} />}
      </div>

      {isEmpty && <p className="text-xs text-ink-faint font-body py-4 text-center">settings.json 为空</p>}
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
    // Guard: if settings failed to load (null), spreading it would persist ONLY
    // hooks and wipe the rest of settings.json. Bail rather than corrupt.
    if (!settings) return;
    onSave({ ...settings, hooks: next });
  };

  const removeHook = async (event, groupIdx, cmdIdx) => {
    if (!(await confirmDialog('删除这条 hook？', { danger: true }))) return;
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
      <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5 font-body leading-snug space-y-1">
        <div>⚠️ 这是 <code className="font-mono">~/.claude/settings.json</code> 全文。保存=覆盖此处显示的所有字段;你<b>没看到/不小心删掉</b>的 hooks/mcpServers/enabledPlugins 也会丢。</div>
        <div>编辑前先点右上角刷新,避免和「切 provider」/模型选择器的写入冲突(会用旧值覆盖新值)。一般场景建议用 概览/Hooks 等专用 tab,不直接动这里。</div>
      </div>
      <textarea value={rawJson} onChange={(e) => setRawJson(e.target.value)}
        spellCheck={false}
        className="w-full h-[55vh] bg-canvas-warm border border-canvas-deep rounded-lg p-3 text-xs font-mono text-ink-soft resize-none focus:outline-none focus:border-accent/40 leading-relaxed" />
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
