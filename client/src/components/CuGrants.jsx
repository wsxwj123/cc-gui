import React, { useEffect, useState } from 'react';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { getCuGrantToken } from '../utils/cuGrantToken.js';

// computer use「按应用授权」区块(INTERFACE §D)。挂在 MCPPanel 的桌面操控卡里,
// 仅当 MCP 已注册时渲染。
//
// 两条铁律(INTERFACE §0):
//   I1 状态的唯一真源是服务端:所有写操作成功后用 POST /grants 的响应【整体覆盖】本地状态,
//      不做乐观更新;失败时保留服务端真值 + 行内错误(显示成成功会直接骗到用户)。
//   I3 只碰应用身份(bundleId/name):不读窗口标题、几何、像素。

const TITLE = '应用授权';
const DESC = '只有列在下面的应用才能被查询窗口、点击或输入。授权按 bundleId 逐个生效，撤销立即生效。';
const EMPTY = '尚未授权任何应用。未授权时 window_list 不返回窗口，操控动作返回 CU_APP_NOT_ALLOWED。';
const ADD = '添加应用';
const APPS_NOTE = '当前正在运行、且有 Dock 图标的应用（只读取应用名称与 bundleId，不读取窗口标题、窗口位置或屏幕内容）。';
const APPS_LOADING = '正在读取正在运行的应用…';
const APPS_EMPTY = '没有可列出的一般应用（没有正在运行且带 Dock 图标的应用）；可手动填写 bundleId。';
const APPS_UNAVAILABLE = '运行时尚未就绪（首次调用工具时自动准备）；可直接手动填写 bundleId。';
const SEARCH_PLACEHOLDER = '按名称或 bundleId 筛选';
const REFRESH = '重新拉取';
const MANUAL_TITLE = '手动填写 bundleId';
const CHECK = '校验';
const RESULT_MISSING = '未在系统中找到该 bundleId 对应的应用（可能未安装或拼写有误）。';
const RESULT_UNVERIFIED = '未校验：请先确认 bundleId 与目标应用一致。';
const GRANT = '授权';
const REVOKE = '撤销';
const GRANTED_MARK = '已授权';
const SCOPE_TITLE = '允许主屏全部可见内容';
const SCOPE_DESC = '开启后模型可截取整块屏幕的画面（含未授权应用里显示的内容）并按屏幕坐标定位。它与上面的应用授权相互独立，关闭立即生效。';
// 开启主屏范围是【独立的一档权限】(契约要求独立勾选、按应用授权不隐含全屏授权),所以开启必经确认框;
// 关闭不加摩擦(撤销方向不该有摩擦)。
const SCOPE_CONFIRM = '开启「允许主屏全部可见内容」后，模型可以截取整块屏幕的画面（包括未授权应用里显示的内容），也可以按屏幕坐标定位。这是独立于按应用授权的更高权限，随时可以关闭。';
// 授权对下一个 MCP 动作立即生效,但模型上下文里可能已有一条"未授权"的结论 —— 提示人让它重试,不自动往会话注入任何东西。
const HINT_RETRY = '授权已更新。模型若刚刚得到「未授权」的结论，请让它重试一次；授权对下一个动作立即生效。';
// r154:授权类写入需要 WS 下发的面板凭证;凭证未到(WS 尚未连上)时不发请求。
const NOT_CONNECTED = '尚未连上后台，请稍后重试。';
const HINT_TOKEN_STALE = '如果你正在面板里操作仍看到本提示，请刷新页面或重启应用。';

// C2:前台操控授权(按应用、限时)。与上面的应用授权相互独立,默认关闭。
const FG_LABEL = '允许前台操控';
const FG_EXPIRED = '允许前台操控（已过期）';
const FG_REMAIN = (mins) => `允许前台操控 · 还剩 ${mins} 分钟`;
const FG_NOTE = '后台通道失败时才会用到；会移动真实鼠标并把目标窗口带到前台。';
const FG_CONFIRM = (name) => `开启后 60 分钟内，模型可以在后台通道失败时用前台通道操控「${name}」：会移动真实鼠标、把目标窗口切到前台，可能打断你正在做的事。随时可以关闭，到点也会自动失效。`;
const FG_DESC_SUFFIX = '「允许前台操控」与上面的应用授权相互独立，默认关闭。';

// ── 文案按"应用身份"切(§4.3)──────────────────────────────────────────
// macOS 的应用身份是 bundleId(com.apple.TextEdit),Windows 是 exe 绝对路径(C:\…\notepad.exe)。
// 讲 Dock 图标、讲 bundleId 的措辞在 Windows 上是错的;`bundleId` 那一份**逐字不变**(mac 现状)。
const WORDS = {
  bundleId: { desc: DESC, empty: EMPTY, appsNote: APPS_NOTE, appsEmpty: APPS_EMPTY, appsUnavailable: APPS_UNAVAILABLE,
    searchPlaceholder: SEARCH_PLACEHOLDER, manualTitle: MANUAL_TITLE, manualPlaceholder: 'com.example.app',
    resultMissing: RESULT_MISSING, resultUnverified: RESULT_UNVERIFIED },
  exePath: {
    desc: '只有列在下面的应用才能被查询窗口、点击或输入。授权按 exe 路径逐个生效，撤销立即生效。',
    empty: EMPTY,
    appsNote: '当前正在运行的桌面应用（只读取应用名称与可执行文件路径，不读取窗口标题、窗口位置或屏幕内容）。商店风格应用（「设置」「计算器」等）的窗口由 ApplicationFrameHost.exe 托管、「控制面板」由 explorer.exe 托管，不要授权这两个：授权它们等于放开它们托管的全部窗口。',
    appsEmpty: '没有可列举的桌面应用（没有正在运行且带顶层窗口的程序）；可手动填写 exe 路径。',
    appsUnavailable: '运行时尚未就绪（点卡片上的「准备环境」完成准备）；可直接手动填写 exe 路径。',
    searchPlaceholder: '按名称或路径筛选',
    manualTitle: '手动填写 exe 路径',
    manualPlaceholder: 'C:\\Program Files\\Example\\app.exe',
    resultMissing: '未在系统中找到该路径对应的可执行文件（可能路径有误）。',
    resultUnverified: '未校验：请先确认 exe 路径与目标应用一致。',
  },
};

const byBundleId = (a, b) => (a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0);

export function CuGrants({ runtimeReady, appIdKind = 'bundleId' }) {
  const W = WORDS[appIdKind] || WORDS.bundleId;
  const [grants, setGrants] = useState(null);   // { screenScope, apps } —— 服务端真值
  const [grantErr, setGrantErr] = useState(''); // GET /grants 失败
  const [open, setOpen] = useState(false);       // 候选列表(默认不展开)
  const [apps, setApps] = useState(null);
  const [phase, setPhase] = useState('idle');    // idle | loading | ok | unavailable | error
  const [appsErr, setAppsErr] = useState('');
  const [filter, setFilter] = useState('');
  const [writing, setWriting] = useState('');    // 在途写请求的键(D.3.2:同时只允许一个)
  const [rowErr, setRowErr] = useState(null);    // { scope, message } —— 行内错误(D.3.10)
  const [manualId, setManualId] = useState('');
  const [check, setCheck] = useState(null);      // null | {state:'ok'|'missing', …}
  const [checkErr, setCheckErr] = useState('');
  const [checking, setChecking] = useState(false);
  const [hint, setHint] = useState('');

  const loadGrants = async () => {
    try {
      const r = await fetch('/api/computer-use/grants');
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || d.ok === false) throw new Error(d?.error || `HTTP ${r.status}`);
      setGrants({ screenScope: d.screenScope, apps: Array.isArray(d.apps) ? d.apps : [] });
      setGrantErr('');
    } catch (e) {
      setGrantErr(`授权状态读取失败：${e.message}`);
    }
  };
  useEffect(() => { loadGrants(); }, []);

  const loadApps = async () => {
    setPhase('loading'); setAppsErr('');
    try {
      const r = await fetch('/api/computer-use/apps');
      const d = await r.json().catch(() => null);
      if (!d) throw new Error(`HTTP ${r.status}`);
      if (d.code === 'CU_RUNTIME_UNAVAILABLE') { setApps(null); setPhase('unavailable'); return; }
      if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
      setApps(Array.isArray(d.apps) ? d.apps : []);
      setPhase('ok');
    } catch (e) {
      setApps(null); setAppsErr(String(e.message || e)); setPhase('error');
    }
  };

  const postGrant = async (payload, scope) => {
    if (writing) return false;
    // r154:正向意图(授权应用 / 开启主屏范围)服务端要求面板凭证;纯撤销不需要,取不到凭证也照常发
    // (撤销方向永远安全,且保留出事时的撤权路径)。
    const token = getCuGrantToken();
    // C2:开前台也是扩权(要凭证);关前台是降权(不需要,保留撤权路径)。
    const positive = payload.foreground === true || (payload.foreground !== false && ((payload.bundleId && payload.granted !== false) || payload.screenScope === true));
    if (positive && !token) {
      setRowErr({ scope, message: NOT_CONNECTED }); setHint('');
      return false; // 不发请求:没有凭证必然 403,发了也只是多一次失败
    }
    setWriting(scope); setRowErr(null); setHint('');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-CGUI-Grant-Token'] = token;
      const r = await fetch('/api/computer-use/grants', {
        method: 'POST', headers,
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || d.ok === false) {
        const msg = d?.error || `HTTP ${r.status}`;
        // 面板持有的凭证与服务端不一致(多半是服务重启而页面没重连上):提示刷新/重启
        throw new Error(d?.code === 'CU_GRANT_FORBIDDEN' ? `${msg}${HINT_TOKEN_STALE}` : msg);
      }
      setGrants({ screenScope: d.screenScope, apps: Array.isArray(d.apps) ? d.apps : [] });
      if (payload.granted === true || payload.screenScope === true) setHint(HINT_RETRY);
      return true;
    } catch (e) {
      setRowErr({ scope, message: `操作失败：${e.message}` });
      await loadGrants(); // 失败后回到服务端真值 —— 绝不把失败显示成成功
      return false;
    } finally {
      setWriting('');
    }
  };

  const rowError = (scope) => (rowErr && rowErr.scope === scope
    ? <div data-testid="cu-grant-error" className="text-[10.5px] text-error font-body leading-snug mt-0.5">{rowErr.message}</div>
    : null);

  const rows = [...(grants?.apps || [])].sort(byBundleId);
  const grantedIds = new Set(rows.map((a) => a.bundleId));
  const q = filter.trim().toLowerCase();
  const visible = phase === 'ok'
    ? [...(apps || [])]
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.bundleId.toLowerCase().includes(q))
      .sort(byBundleId)
    : [];
  const scopeOn = grants?.screenScope?.granted === true;

  const toggleAdd = () => {
    const next = !open;
    setOpen(next);
    if (next && phase === 'idle') loadApps(); // 展开才拉;不在挂载时预取(D.3.4)
  };

  const toggleScope = async () => {
    if (writing) return;
    if (!scopeOn) {
      const ok = await confirmDialog(SCOPE_CONFIRM, { danger: true, confirmText: '允许', testId: 'cu-screen-scope-confirm' });
      if (!ok) return; // 取消 → 状态与 grants.screenScope 都不变
    }
    await postGrant({ screenScope: !scopeOn }, 'screen');
  };

  // C2:前台操控授权。开:确认框 + 60 分钟;关:直接撤销,不加摩擦。
  const toggleForeground = async (a) => {
    if (writing) return;
    if (a.foreground && a.foreground.granted === true) {
      await postGrant({ bundleId: a.bundleId, foreground: false }, 'list');
      return;
    }
    const msg = FG_CONFIRM(a.name || a.bundleId);
    const ok = await confirmDialog(msg, { danger: true, confirmText: '允许', testId: 'cu-foreground-confirm' });
    if (!ok) return;
    await postGrant({ bundleId: a.bundleId, foreground: true, foregroundMinutes: 60 }, 'list');
  };

  const fgLabel = (a) => {
    const fg = a.foreground || {};
    if (fg.granted === true) {
      const mins = Math.max(0, Math.ceil((Date.parse(fg.expiresAt) - Date.now()) / 60_000));
      return FG_REMAIN(mins);
    }
    return fg.expiresAt ? FG_EXPIRED : FG_LABEL;
  };

  const checkManual = async () => {
    const id = manualId.trim();
    if (!id || checking) return;
    setChecking(true); setCheck(null); setCheckErr('');
    try {
      const r = await fetch(`/api/computer-use/app-info?bundleId=${encodeURIComponent(id)}`);
      const d = await r.json().catch(() => null);
      if (!d) throw new Error(`HTTP ${r.status}`);
      if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
      setCheck(d.installed ? { state: 'ok', name: d.name, path: d.path } : { state: 'missing' });
    } catch (e) {
      // 校验本身不可用(如运行时未就绪):如实说,不假装"未安装" —— 也绝不 disable 授权按钮(D.4)
      setCheckErr(String(e.message || e));
    } finally {
      setChecking(false);
    }
  };

  const manualState = check?.state || 'unverified';

  return (
    <div data-testid="cu-grants" className="mt-2 pt-2 border-t border-canvas-deep">
      <div className="flex items-center justify-between">
        <div data-testid="cu-grants-title" className="text-[11.5px] text-ink font-body font-medium">{TITLE}</div>
        <button type="button" data-testid="cu-grant-add" aria-expanded={open} onClick={toggleAdd} disabled={!!writing}
          className="px-2 py-1 rounded-md text-[10px] text-ink-muted hover:bg-canvas border border-canvas-deep font-body transition-colors disabled:opacity-50">
          {ADD}
        </button>
      </div>
      <div data-testid="cu-grants-desc" className="text-[10.5px] text-ink-faint font-body leading-snug mt-0.5">{W.desc}{FG_DESC_SUFFIX}</div>

      {grantErr && <div data-testid="cu-grants-error" className="text-[10.5px] text-error font-body leading-snug mt-1.5">{grantErr}</div>}
      <div data-testid="cu-grants-list" className="mt-1.5">
        {/* 空态只在拿到服务端真值之后才显示:加载中闪一下"尚未授权"会把有授权的情况说成没有 */}
        {grants && !grantErr && rows.length === 0 && (
          <div data-testid="cu-grants-empty" className="text-[10.5px] text-ink-faint font-body leading-snug">{W.empty}</div>
        )}
        {rows.map((a) => (
          <div key={a.bundleId} data-testid="cu-grant-row" data-bundle-id={a.bundleId}
            className="flex items-center gap-2 py-1 text-[10.5px] font-body">
            <span className="text-ink truncate">{a.name}</span>
            <span className="text-ink-faint font-mono truncate">{a.bundleId}</span>
            {a.grantedAt && <span className="text-ink-faint shrink-0">{new Date(a.grantedAt).toLocaleString()}</span>}
            <button type="button" data-testid="cu-grant-foreground" data-bundle-id={a.bundleId} disabled={!!writing}
              onClick={() => toggleForeground(a)}
              className={`ml-auto px-2 py-0.5 rounded-md text-[10px] font-body transition-colors disabled:opacity-50 shrink-0 ${
                a.foreground && a.foreground.granted ? 'text-accent bg-accent/10 hover:bg-accent/20' : 'text-ink-muted hover:bg-canvas border border-canvas-deep'}`}>
              {fgLabel(a)}
            </button>
            <button type="button" data-testid="cu-grant-revoke" data-bundle-id={a.bundleId} disabled={!!writing}
              onClick={() => postGrant({ bundleId: a.bundleId, granted: false }, 'list')}
              className="px-2 py-0.5 rounded-md text-[10px] text-error hover:bg-error/10 font-body transition-colors disabled:opacity-50 shrink-0">
              {REVOKE}
            </button>
          </div>
        ))}
        {rowError('list')}
        {rows.length > 0 && (
          <div data-testid="cu-grant-foreground-note" className="text-[10.5px] text-ink-faint font-body leading-snug mt-1">{FG_NOTE}</div>
        )}
      </div>
      {hint && <div data-testid="cu-grant-hint" className="text-[10.5px] text-ink-muted font-body leading-snug mt-1">{hint}</div>}

      {open && (
        <div className="mt-2 pt-2 border-t border-canvas-deep">
          <div data-testid="cu-apps-note" className="text-[10.5px] text-ink-faint font-body leading-snug">{W.appsNote}</div>
          {/* 请求在途时先按卡上已知的运行时状态说话(status 是卡片挂载时读的,可能已过期;
              请求回来一律以服务端响应为准)。 */}
          {phase === 'loading' && (runtimeReady === false ? (
            <div data-testid="cu-apps-unavailable" className="text-[10.5px] text-ink-faint font-body leading-snug mt-1">{W.appsUnavailable}</div>
          ) : (
            <div data-testid="cu-apps-loading" className="text-[10.5px] text-ink-faint font-body leading-snug mt-1">{APPS_LOADING}</div>
          ))}
          {phase === 'unavailable' && (
            <div data-testid="cu-apps-unavailable" className="text-[10.5px] text-ink-faint font-body leading-snug mt-1">{W.appsUnavailable}</div>
          )}
          {phase === 'error' && (
            <div data-testid="cu-apps-error" className="text-[10.5px] text-error font-body leading-snug mt-1">读取应用列表失败：{appsErr}</div>
          )}
          <div className="flex items-center gap-1.5 mt-1.5">
            <input data-testid="cu-app-search" value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder={W.searchPlaceholder}
              className="flex-1 min-w-0 bg-canvas border border-canvas-deep rounded-md px-2 py-1 text-[10.5px] text-ink font-body placeholder:text-ink-faint outline-none focus:border-accent" />
            <button type="button" data-testid="cu-apps-refresh" onClick={loadApps} disabled={phase === 'loading'}
              className="px-2 py-1 rounded-md text-[10px] text-ink-muted hover:bg-canvas border border-canvas-deep font-body transition-colors disabled:opacity-50 shrink-0">
              {REFRESH}
            </button>
          </div>
          <div className="mt-1">
            {phase === 'ok' && (apps || []).length === 0 && (
              <div data-testid="cu-apps-empty" className="text-[10.5px] text-ink-faint font-body leading-snug">{W.appsEmpty}</div>
            )}
            {phase === 'ok' && (apps || []).length > 0 && visible.length === 0 && (
              <div className="text-[10.5px] text-ink-faint font-body leading-snug">没有匹配「{filter}」的应用。</div>
            )}
            {visible.map((a) => {
              // 有服务端授权名单时以它为准(POST 响应覆盖后行立即变已授权,不关闭列表允许连续授权)
              const granted = grants ? grantedIds.has(a.bundleId) : a.granted === true;
              return (
                <div key={a.bundleId} data-testid="cu-app-option" data-bundle-id={a.bundleId} data-granted={granted ? 'true' : 'false'}
                  className="flex items-center gap-2 py-1 text-[10.5px] font-body">
                  <span className="text-ink truncate">{a.name}</span>
                  <span className="text-ink-faint font-mono truncate">{a.bundleId}</span>
                  {granted ? (
                    <span data-testid="cu-app-granted-mark" className="ml-auto text-[10px] text-success shrink-0">{GRANTED_MARK}</span>
                  ) : (
                    <button type="button" data-testid="cu-app-grant" data-bundle-id={a.bundleId} disabled={!!writing}
                      onClick={() => postGrant({ bundleId: a.bundleId, name: a.name, granted: true }, 'apps')}
                      className="ml-auto px-2 py-0.5 rounded-md text-[10px] text-ink-muted hover:bg-canvas border border-canvas-deep font-body transition-colors disabled:opacity-50 shrink-0">
                      {GRANT}
                    </button>
                  )}
                </div>
              );
            })}
            {rowError('apps')}
          </div>

          <div className="mt-2 pt-2 border-t border-canvas-deep">
            <div data-testid="cu-manual-title" className="text-[10.5px] text-ink-muted font-body">{W.manualTitle}</div>
            <div className="flex items-center gap-1.5 mt-1">
              <input data-testid="cu-manual-input" value={manualId}
                onChange={(e) => { setManualId(e.target.value); setCheck(null); setCheckErr(''); }}
                placeholder={W.manualPlaceholder}
                className="flex-1 min-w-0 bg-canvas border border-canvas-deep rounded-md px-2 py-1 text-[10.5px] text-ink font-mono outline-none focus:border-accent" />
              <button type="button" data-testid="cu-manual-check" onClick={checkManual} disabled={checking || !manualId.trim()}
                className="px-2 py-1 rounded-md text-[10px] text-ink-muted hover:bg-canvas border border-canvas-deep font-body transition-colors disabled:opacity-50 shrink-0">
                {CHECK}
              </button>
              {/* 校验不是授权的前置条件(runtimeReady=false 时校验本就不可用,disable 会把首次使用卡死):
                  警示靠文案 + 已授权列表恒显示 bundleId + 撤销零摩擦(D.4)。 */}
              <button type="button" data-testid="cu-manual-grant" disabled={!manualId.trim() || !!writing}
                onClick={() => { const id = manualId.trim(); postGrant({ bundleId: id, ...(check?.state === 'ok' && check.name ? { name: check.name } : {}), granted: true }, 'manual'); }}
                className="px-2 py-1 rounded-md bg-accent text-on-accent text-[10px] font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 shrink-0">
                {GRANT}
              </button>
            </div>
            {manualId.trim() && (
              <div data-testid="cu-manual-result" data-state={manualState}
                className={`text-[10.5px] font-body leading-snug mt-1 ${manualState === 'ok' ? 'text-ink-muted' : 'text-ink-faint'}`}>
                {manualState === 'ok' ? `已安装：${check.name}（${check.path}）`
                  : manualState === 'missing' ? W.resultMissing : W.resultUnverified}
              </div>
            )}
            {checkErr && (
              <div data-testid="cu-manual-error" className="text-[10.5px] text-error font-body leading-snug mt-0.5">
                校验不可用:{checkErr}
              </div>
            )}
            {rowError('manual')}
          </div>
        </div>
      )}

      <div className="mt-2.5 pt-2 border-t border-canvas-deep">
        <div className="flex items-start gap-2">
          {/* role=switch 而不是 input[type=checkbox]:面板的 Esc 逻辑会截住落在 INPUT 上的按键
              (沿用 SettingsPanel 生成式界面开关的先例)。 */}
          <button type="button" data-testid="cu-screen-scope-toggle" role="switch" aria-checked={scopeOn}
            onClick={toggleScope} disabled={!!writing || !grants}
            className={`mt-0.5 shrink-0 w-9 h-5 rounded-full transition-colors relative ${scopeOn ? 'bg-accent' : 'bg-ink-faint/30'} disabled:opacity-50`}>
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${scopeOn ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
          <div className="min-w-0">
            <div data-testid="cu-screen-scope-title" className="text-[11px] text-ink font-body font-medium">{SCOPE_TITLE}</div>
            <div data-testid="cu-screen-scope-state" className="text-[10px] text-ink-faint font-body leading-snug">
              {!grants ? '' : scopeOn ? `已开启（${new Date(grants.screenScope?.grantedAt || Date.now()).toLocaleString()} 起）` : '已关闭'}
            </div>
          </div>
        </div>
        <div data-testid="cu-screen-scope-desc" className="text-[10.5px] text-ink-faint font-body leading-snug mt-1">{SCOPE_DESC}</div>
        {rowError('screen')}
      </div>
    </div>
  );
}
