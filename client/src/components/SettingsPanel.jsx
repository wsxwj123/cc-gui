import React, { useEffect, useState } from 'react';
import { Settings, Save, RefreshCw, AlertCircle, Check, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { openExternalUrl } from '../utils/openExternal.js';
import { confirmDialog } from '../utils/confirmDialog.jsx';
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
        {[['overview', '概览'], ['hooks', 'Hooks'], ['json', 'JSON'], ['storage', '存储'], ['network', '网络']].map(([id, label]) => (
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
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder={cfg.hasPassword ? '••••（留空保持原密码）' : '设置访问密码'}
            className="w-full px-3 py-2 text-[13px] font-body border border-canvas-deep rounded-lg bg-canvas text-ink focus:outline-none focus:border-accent" />
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
        <button onClick={restart} disabled={restarting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body rounded-lg border border-canvas-deep text-ink-soft hover:bg-canvas-warm disabled:opacity-50">
          <RefreshCw size={12} className={restarting ? 'animate-spin' : ''} />{restarting ? '重启中…' : '重启 server'}
        </button>
        {msg && <span className="text-[11px] text-success font-body">{msg}</span>}
        {err && <span className="text-[11px] text-error font-body">{err}</span>}
      </div>
      <p className="text-[10.5px] text-ink-faint font-body">
        配置写入 <span className="font-mono">~/.claude-gui/network.json</span>，重启后生效。
        {cfg.watchdog ? '“重启 server”按钮可直接生效。' : '当前未用守护脚本启动，“重启”按钮不可用——请用项目根目录的 '}{!cfg.watchdog && <span className="font-mono">gui.command</span>}{!cfg.watchdog && ' 启动 GUI。'}
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
    setDl({ status: 'downloading' });
    try {
      const r = await fetch('/api/download-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: asset.url, filename: asset.name }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setDl({ status: 'err', message: d.error || `HTTP ${r.status}` });
        return;
      }
      setDl({ status: 'done', path: d.path, platform: d.platform });
    } catch (e) {
      setDl({ status: 'err', message: e.message || '网络错误' });
    }
  };

  return (
    <div className="text-[12px] bg-amber-50 border border-amber-200 text-amber-900 rounded p-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <span>🎉 新版本可用:</span>
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
                下载中… {target && `· ${target}`} ({Math.round((asset.size || 0) / 1048576)}MB)
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

      {dl.status === 'done' && (
        <div className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2 space-y-1">
          <div>✓ 已下载并打开安装包</div>
          <div className="text-[11px] text-emerald-700">{dl.path}</div>
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

function CcUpdater() {
  // status: idle | checking | ok | err ; updating: false | true
  const [state, setState] = useState({ status: 'idle' });
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetch('/api/claude-version-check').then((r) => r.json()).then((d) => {
      setState({ status: 'idle', ...d });
    }).catch(() => {});
  }, []);

  const check = async () => {
    setState((s) => ({ ...s, status: 'checking' }));
    try {
      const d = await (await fetch('/api/claude-version-check')).json();
      setState({ status: d.error ? 'err' : 'ok', ...d });
    } catch (e) {
      setState((s) => ({ ...s, status: 'err', error: e.message || '网络错误' }));
    }
  };

  const doUpdate = async () => {
    const cmd = state.updateCommand || 'claude update';
    if (!window.confirm(`将打开终端运行【${cmd}】更新 Claude Code 到 v${state.latestVersion}（安装方式：${state.method || '未知'}）。\n请在弹出的终端里查看进度,完成后回来点"检查更新"。确定继续?`)) return;
    setUpdating(true); setResult(null);
    try {
      const d = await (await fetch('/api/claude-update', { method: 'POST' })).json();
      setResult(d);
    } catch (e) {
      setResult({ ok: false, error: e.message || '请求失败' });
    }
    setUpdating(false);
  };

  const doInstall = async () => {
    const cmd = state.installCommand || 'curl -fsSL https://claude.ai/install.sh | bash';
    if (!window.confirm(`将打开终端运行【${cmd}】安装 Claude Code。\n请在弹出的终端里查看进度,完成后回来点"检查更新"。确定继续?`)) return;
    setUpdating(true); setResult(null);
    try {
      const d = await (await fetch('/api/claude-install', { method: 'POST' })).json();
      setResult(d);
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
          <button
            onClick={doInstall}
            disabled={updating}
            className="px-3 py-1.5 text-[12px] bg-amber-700 text-white rounded-md hover:bg-amber-800 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
          >
            {updating ? <><RefreshCw size={12} className="animate-spin" />安装中…</> : <>⬇️ 一键安装</>}
          </button>
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
      {state.status === 'ok' && (
        state.hasUpdate ? (
          <div className="text-[12px] bg-amber-50 border border-amber-200 text-amber-900 rounded p-2.5 space-y-2">
            <div className="flex items-center gap-1.5">
              <span>🎉 Claude Code 新版:</span><b className="font-mono">v{state.latestVersion}</b>
            </div>
            <button
              onClick={doUpdate}
              disabled={updating}
              className="px-3 py-1.5 text-[12px] bg-amber-700 text-white rounded-md hover:bg-amber-800 disabled:opacity-50 flex items-center gap-1.5"
            >
              {updating ? <><RefreshCw size={12} className="animate-spin" />更新中…(claude update)</> : <>⬇️ 一键更新</>}
            </button>
          </div>
        ) : (
          <div className="text-[12px] text-success">✓ 已是最新版本</div>
        )
      )}
      {state.status === 'err' && <div className="text-[12px] text-error">{state.error}</div>}
      {result && (
        result.ok
          ? <div className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">
              ✓ 已在终端启动 <code className="font-mono">{result.command}</code>。完成后点上方"检查更新"确认新版本。
            </div>
          : <div className="text-[12px] text-error">启动失败:{result.error}</div>
      )}
    </div>
  );
}

function OverviewTab({ settings }) {
  const [showEnv, setShowEnv] = useState(false);
  const [showHooks, setShowHooks] = useState(false);
  const [revealed, setRevealed] = useState({});

  const env = settings?.env || {};
  const envKeys = Object.keys(env);
  const hooks = settings?.hooks || {};
  const hookEvents = Object.keys(hooks);
  const hookTotal = Object.values(hooks).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);

  // 敏感值默认打码(KEY/TOKEN/SECRET/PASSWORD),点"显示"可看明文。
  const isSecret = (k) => /KEY|TOKEN|SECRET|PASSWORD|PWD|CREDENTIAL/i.test(k);
  const mask = (v) => { const s = String(v); return s.length <= 8 ? '••••••' : '••••' + s.slice(-4); };

  const rows = [];
  if (settings?.defaultModel || settings?.model) rows.push(['默认模型', settings.defaultModel || settings.model]);
  if (settings?.permissions) rows.push(['权限规则', `${Object.keys(settings.permissions).length} 条`]);
  if (settings?.plugins) rows.push(['插件', `${Object.keys(settings.plugins).length} 个`]);

  const isEmpty = rows.length === 0 && envKeys.length === 0 && hookEvents.length === 0;

  return (
    <div className="space-y-3">
      <UpdateChecker />
      <CcUpdater />
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

      {/* 环境变量 — 默认折叠,展开显示 key=value(敏感值打码,可逐条显示明文) */}
      {envKeys.length > 0 && (
        <div className="border border-canvas-deep rounded-lg overflow-hidden">
          <button onClick={() => setShowEnv((v) => !v)}
            className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-canvas-warm/60 text-left">
            {showEnv ? <ChevronDown size={12} className="text-ink-faint" /> : <ChevronRight size={12} className="text-ink-faint" />}
            <span className="text-xs text-ink-muted font-body flex-1">环境变量</span>
            <span className="text-xs text-ink-soft font-mono">{envKeys.length} 个</span>
          </button>
          {showEnv && (
            <div className="border-t border-canvas-deep divide-y divide-canvas-deep/60">
              {envKeys.map((k) => (
                <div key={k} className="px-3 py-2 flex items-start gap-2">
                  <span className="text-[11px] font-mono text-ink-soft shrink-0 max-w-[45%] break-all">{k}</span>
                  <span className="text-[11px] font-mono text-ink-faint flex-1 break-all text-right">
                    {isSecret(k) && !revealed[k] ? mask(env[k]) : String(env[k])}
                  </span>
                  {isSecret(k) && (
                    <button onClick={() => setRevealed((r) => ({ ...r, [k]: !r[k] }))}
                      className="text-[10px] text-accent hover:underline shrink-0">
                      {revealed[k] ? '隐藏' : '显示'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Hooks — 默认折叠,展开显示每个事件下的命令(只读概览,编辑见 Hooks 标签页) */}
      {hookEvents.length > 0 && (
        <div className="border border-canvas-deep rounded-lg overflow-hidden">
          <button onClick={() => setShowHooks((v) => !v)}
            className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-canvas-warm/60 text-left">
            {showHooks ? <ChevronDown size={12} className="text-ink-faint" /> : <ChevronRight size={12} className="text-ink-faint" />}
            <span className="text-xs text-ink-muted font-body flex-1">Hooks</span>
            <span className="text-xs text-ink-soft font-mono">{hookEvents.length} 事件 · {hookTotal} 条</span>
          </button>
          {showHooks && (
            <div className="border-t border-canvas-deep divide-y divide-canvas-deep/60">
              {hookEvents.map((ev) => (
                <div key={ev} className="px-3 py-2 space-y-1">
                  <div className="text-[11px] font-mono text-ink-soft">{ev}</div>
                  {(hooks[ev] || []).flatMap((g, gi) =>
                    (g.hooks || []).map((h, hi) => (
                      <div key={`${gi}-${hi}`} className="text-[10.5px] font-mono text-ink-faint pl-3 break-all">
                        • {h.command || h.type || JSON.stringify(h)}
                        {g.matcher ? <span className="text-ink-ghost">  (matcher: {g.matcher})</span> : null}
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
