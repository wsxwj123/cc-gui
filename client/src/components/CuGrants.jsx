import React, { useEffect, useState } from 'react';
import { confirmDialog } from '../utils/confirmDialog.jsx';

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

const byBundleId = (a, b) => (a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0);

export function CuGrants({ runtimeReady }) {
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
    setWriting(scope); setRowErr(null); setHint('');
    try {
      const r = await fetch('/api/computer-use/grants', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || d.ok === false) throw new Error(d?.error || `HTTP ${r.status}`);
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
      <div data-testid="cu-grants-desc" className="text-[10.5px] text-ink-faint font-body leading-snug mt-0.5">{DESC}</div>

      {grantErr && <div data-testid="cu-grants-error" className="text-[10.5px] text-error font-body leading-snug mt-1.5">{grantErr}</div>}
      <div data-testid="cu-grants-list" className="mt-1.5">
        {/* 空态只在拿到服务端真值之后才显示:加载中闪一下"尚未授权"会把有授权的情况说成没有 */}
        {grants && !grantErr && rows.length === 0 && (
          <div data-testid="cu-grants-empty" className="text-[10.5px] text-ink-faint font-body leading-snug">{EMPTY}</div>
        )}
        {rows.map((a) => (
          <div key={a.bundleId} data-testid="cu-grant-row" data-bundle-id={a.bundleId}
            className="flex items-center gap-2 py-1 text-[10.5px] font-body">
            <span className="text-ink truncate">{a.name}</span>
            <span className="text-ink-faint font-mono truncate">{a.bundleId}</span>
            {a.grantedAt && <span className="text-ink-faint shrink-0">{new Date(a.grantedAt).toLocaleString()}</span>}
            <button type="button" data-testid="cu-grant-revoke" data-bundle-id={a.bundleId} disabled={!!writing}
              onClick={() => postGrant({ bundleId: a.bundleId, granted: false }, 'list')}
              className="ml-auto px-2 py-0.5 rounded-md text-[10px] text-error hover:bg-error/10 font-body transition-colors disabled:opacity-50 shrink-0">
              {REVOKE}
            </button>
          </div>
        ))}
        {rowError('list')}
      </div>
      {hint && <div data-testid="cu-grant-hint" className="text-[10.5px] text-ink-muted font-body leading-snug mt-1">{hint}</div>}

      {open && (
        <div className="mt-2 pt-2 border-t border-canvas-deep">
          <div data-testid="cu-apps-note" className="text-[10.5px] text-ink-faint font-body leading-snug">{APPS_NOTE}</div>
          {/* 请求在途时先按卡上已知的运行时状态说话(status 是卡片挂载时读的,可能已过期;
              请求回来一律以服务端响应为准)。 */}
          {phase === 'loading' && (runtimeReady === false ? (
            <div data-testid="cu-apps-unavailable" className="text-[10.5px] text-ink-faint font-body leading-snug mt-1">{APPS_UNAVAILABLE}</div>
          ) : (
            <div data-testid="cu-apps-loading" className="text-[10.5px] text-ink-faint font-body leading-snug mt-1">{APPS_LOADING}</div>
          ))}
          {phase === 'unavailable' && (
            <div data-testid="cu-apps-unavailable" className="text-[10.5px] text-ink-faint font-body leading-snug mt-1">{APPS_UNAVAILABLE}</div>
          )}
          {phase === 'error' && (
            <div data-testid="cu-apps-error" className="text-[10.5px] text-error font-body leading-snug mt-1">读取应用列表失败：{appsErr}</div>
          )}
          <div className="flex items-center gap-1.5 mt-1.5">
            <input data-testid="cu-app-search" value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder={SEARCH_PLACEHOLDER}
              className="flex-1 min-w-0 bg-canvas border border-canvas-deep rounded-md px-2 py-1 text-[10.5px] text-ink font-body placeholder:text-ink-faint outline-none focus:border-accent" />
            <button type="button" data-testid="cu-apps-refresh" onClick={loadApps} disabled={phase === 'loading'}
              className="px-2 py-1 rounded-md text-[10px] text-ink-muted hover:bg-canvas border border-canvas-deep font-body transition-colors disabled:opacity-50 shrink-0">
              {REFRESH}
            </button>
          </div>
          <div className="mt-1">
            {phase === 'ok' && (apps || []).length === 0 && (
              <div data-testid="cu-apps-empty" className="text-[10.5px] text-ink-faint font-body leading-snug">{APPS_EMPTY}</div>
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
            <div data-testid="cu-manual-title" className="text-[10.5px] text-ink-muted font-body">{MANUAL_TITLE}</div>
            <div className="flex items-center gap-1.5 mt-1">
              <input data-testid="cu-manual-input" value={manualId}
                onChange={(e) => { setManualId(e.target.value); setCheck(null); setCheckErr(''); }}
                placeholder="com.example.app"
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
                  : manualState === 'missing' ? RESULT_MISSING : RESULT_UNVERIFIED}
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
