// r151b 跨会话消息(一期)—— 转发:助手回复操作行的按钮 + 转发对话框(接口文件 X.3.4「转发」)。
// 对话框自挂载到 body(同 confirmDialog 的做法):不随回复气泡卸载重挂(流式 → 落盘会换 key)丢掉输入,分屏时也只有一个。
// 来源会话在打开那一刻记下(这条回复所在的会话),发送只用它,不读"当前选中会话"。
// 接口调用都在 utils/xsession.js,这里只管界面。
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Send, X, Check } from './Icon.jsx';
import {
  useXsEnabled, isXsId, listXsTargets, forwardXsMessage, xsUtf8Bytes, XS_BODY_MAX_BYTES, XS_MAX_TARGETS,
} from '../utils/xsession.js';

const STATE_TEXT = { running: '运行中', idle: '空闲', stopped: '未运行' };
const DELIVERED_TEXT = '已送达，等待对方会话里确认处理';
const SEARCH_DEBOUNCE_MS = 250;

/** 这条回复气泡里选中的文字(选区两端都在气泡内才算);没有返回 ''。 */
function selectionWithin(el) {
  if (!el || typeof window === 'undefined' || typeof window.getSelection !== 'function') return '';
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
  if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return '';
  const text = sel.toString();
  return text.trim() ? text : '';
}

function ForwardDialog({ initialBody, fromSessionId, onClose }) {
  const [body, setBody] = useState(initialBody);
  const [query, setQuery] = useState('');
  const [list, setList] = useState(null); // null = 读取中
  const [listError, setListError] = useState('');
  const [picked, setPicked] = useState([]); // [{ sessionId, title, project }],按点选先后
  const [limitHint, setLimitHint] = useState(false);
  const [sending, setSending] = useState(false);
  // { ok:true, rows:[{ sessionId, title }] } | { ok:false, error, bad:[{ sessionId, title }] }
  const [result, setResult] = useState(null);

  const bytes = xsUtf8Bytes(body);
  const tooLarge = bytes > XS_BODY_MAX_BYTES;
  const badIds = result && !result.ok ? new Set(result.bad.map((t) => t.sessionId)) : null;
  const canSend = !sending && picked.length > 0 && body.trim() !== '' && !tooLarge;

  // Esc 关闭。document 冒泡阶段监听 + stopPropagation:这次 Esc 不再冒到 window 上的会话级监听(生成中 Esc 即停)。
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 目标列表:打开时立即取一次;搜索框输入停顿后再取。alive 挡住过期的应答。
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      const r = await listXsTargets({ query, exclude: fromSessionId });
      if (!alive) return;
      setList(r.ok ? r.sessions : []);
      setListError(r.ok ? '' : r.error);
    }, query.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, fromSessionId]);

  const toggleTarget = (s) => {
    if (sending) return;
    if (picked.some((t) => t.sessionId === s.sessionId)) {
      setPicked(picked.filter((t) => t.sessionId !== s.sessionId));
      setLimitHint(false);
      return;
    }
    if (picked.length >= XS_MAX_TARGETS) { setLimitHint(true); return; }
    setPicked([...picked, { sessionId: s.sessionId, title: s.title || s.sessionId.slice(0, 8), project: s.project || '' }]);
  };

  const send = async () => {
    if (!canSend) return;
    const targets = picked;
    const titleOf = new Map(targets.map((t) => [t.sessionId, t.title]));
    setSending(true);
    setResult(null);
    const r = await forwardXsMessage({ to: targets.map((t) => t.sessionId), body, fromSessionId });
    setSending(false);
    if (r.ok) {
      setResult({
        ok: true,
        rows: r.messages.map((m) => {
          const sid = m && m.to && m.to.sessionId;
          const title = (m && m.to && typeof m.to.title === 'string' && m.to.title) || titleOf.get(sid) || String(sid || '').slice(0, 8);
          return { sessionId: sid, title };
        }),
      });
      setPicked([]);
      setLimitHint(false);
      return;
    }
    // 整次被拒、一条没发:对话框不关,出错的目标在结果区、已选与列表里都标出来
    setResult({ ok: false, error: r.error, bad: r.targets.map((sid) => ({ sessionId: sid, title: titleOf.get(sid) || sid.slice(0, 8) })) });
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 px-4 animate-fade-in">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="转发到其它会话"
        data-testid="xs-forward-dialog"
        className="w-[min(560px,calc(var(--app-w,100vw)-2rem))] max-h-[calc(var(--app-h,100dvh)-4rem)] flex flex-col rounded-panel bg-canvas border border-canvas-deep shadow-popover animate-glass-rise"
      >
        <div className="shrink-0 flex items-center gap-2 px-5 pt-4 pb-2">
          <Send size={14} className="text-ink-faint" />
          <div className="flex-1 text-[13px] text-ink font-body font-medium">转发到其它会话</div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-canvas-warm" title="关闭" aria-label="关闭">
            <X size={14} className="text-ink-faint" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-3 space-y-3">
          <div>
            <textarea
              data-testid="xs-forward-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              aria-label="转发的内容"
              className="w-full resize-y bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2 text-[12px] text-ink font-body leading-relaxed focus:outline-none focus:border-accent/40"
            />
            <div className="mt-1 flex justify-end">
              <span data-testid="xs-forward-size" className={`text-[10.5px] font-mono ${tooLarge ? 'text-error' : 'text-ink-faint'}`}>
                {`${bytes} / ${XS_BODY_MAX_BYTES} 字节`}
              </span>
            </div>
          </div>

          <div>
            <input
              data-testid="xs-forward-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={100}
              placeholder="按标题或目录名筛选会话"
              aria-label="筛选目标会话"
              className="w-full bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-1.5 text-[12px] text-ink placeholder-ink-faint font-body focus:outline-none focus:border-accent/40"
            />
            <div className="mt-1.5 flex items-center gap-2 text-[10.5px] font-body">
              <span className="text-ink-faint">{`已选 ${picked.length} / ${XS_MAX_TARGETS}`}</span>
              {limitHint && <span className="text-error">{`最多 ${XS_MAX_TARGETS} 个目标`}</span>}
            </div>
            {picked.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {picked.map((t) => (
                  <span key={t.sessionId} className={`inline-flex items-center gap-1 max-w-full pl-2 pr-1 py-0.5 rounded-full border border-canvas-deep text-[10.5px] font-body ${badIds && badIds.has(t.sessionId) ? 'text-error' : 'text-ink-muted'}`}>
                    <span className="truncate max-w-[180px]">{t.title}</span>
                    <button type="button" onClick={() => toggleTarget(t)} disabled={sending} className="p-0.5 rounded hover:bg-canvas-warm" aria-label={`取消选择 ${t.title}`}>
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="mt-1.5 border border-canvas-deep rounded-lg divide-y divide-canvas-deep/60 max-h-56 overflow-y-auto">
              {list === null && <div className="px-3 py-2 text-[11px] text-ink-faint font-body">正在读取会话列表…</div>}
              {list !== null && listError && <div className="px-3 py-2 text-[11px] text-error font-body">{listError}</div>}
              {list !== null && !listError && list.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-ink-faint font-body">没有可转发的会话</div>
              )}
              {(list || []).map((s) => {
                const on = picked.some((t) => t.sessionId === s.sessionId);
                const bad = !!(badIds && badIds.has(s.sessionId));
                return (
                  <button
                    key={s.sessionId}
                    type="button"
                    data-testid="xs-forward-target"
                    data-session-id={s.sessionId}
                    aria-pressed={on}
                    aria-invalid={bad ? 'true' : undefined}
                    data-error={bad ? '1' : undefined}
                    onClick={() => toggleTarget(s)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${on ? 'bg-accent/10' : 'hover:bg-canvas-warm'}`}
                  >
                    <span className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center ${on ? 'bg-accent border-accent text-on-accent' : 'border-canvas-deep'}`}>
                      {on && <Check size={10} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[12px] font-body ${bad ? 'text-error' : 'text-ink'}`}>{s.title}</span>
                      <span className="block truncate text-[10.5px] text-ink-faint font-body">{s.project}</span>
                    </span>
                    <span className="shrink-0 text-[10.5px] text-ink-faint font-body">{STATE_TEXT[s.state] || ''}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {result && (
          <div data-testid="xs-forward-result" role="status" className="shrink-0 max-h-40 overflow-y-auto px-5 py-2 border-t border-canvas-deep text-[11.5px] font-body space-y-0.5">
            {result.ok ? result.rows.map((row, i) => (
              <div key={`${row.sessionId}-${i}`} className="text-ink">{`${row.title}：${DELIVERED_TEXT}`}</div>
            )) : (
              <>
                <div className="text-error">{result.error}</div>
                {result.bad.length > 0 && <div className="text-error">{`出错的目标：${result.bad.map((t) => t.title).join('、')}`}</div>}
                <div className="text-ink-muted">本次未发出任何消息。</div>
              </>
            )}
          </div>
        )}

        <div className="shrink-0 flex justify-end gap-2 px-5 py-3 border-t border-canvas-deep">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-[12px] text-ink-muted hover:bg-canvas-warm font-body transition-colors">
            关闭
          </button>
          <button
            type="button"
            data-testid="xs-forward-send"
            onClick={send}
            disabled={!canSend}
            className="px-3 py-1.5 rounded-md text-[12px] font-body transition-colors bg-accent hover:bg-accent/90 text-on-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}

let closeCurrent = null; // 同一时刻只开一个对话框

/** 打开转发对话框。body:预填的正文;fromSessionId:来源会话(列表排除它、请求带上它;不是会话 id 时都不带)。 */
export function openXsForwardDialog({ body, fromSessionId }) {
  if (typeof document === 'undefined') return;
  if (closeCurrent) closeCurrent();
  const host = document.createElement('div');
  // 模态让行标记(同 confirmDialog):面板页在 document 捕获阶段的 Esc / 点击监听见到它就不动手
  host.dataset.cguiConfirm = '1';
  document.body.appendChild(host);
  const root = createRoot(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (closeCurrent === close) closeCurrent = null;
    root.unmount();
    host.remove();
  };
  closeCurrent = close;
  root.render(
    <ForwardDialog
      initialBody={typeof body === 'string' ? body : ''}
      fromSessionId={isXsId(fromSessionId) ? fromSessionId : null}
      onClose={close}
    />
  );
}

/**
 * 助手回复操作行的转发按钮。总开关关着、或这条回复不属于已落盘的会话(流式中的临时回复)时不渲染 ——
 * 关着时宿主 TurnBubble 的输出与改动前逐字相同。
 * 选区在按下时取,并阻止按下的默认行为(不动选区、不夺焦点);键盘触发没有按下事件,点击时再取一次。
 */
export function XsForwardButton({ text, sessionId, bubbleRef }) {
  const enabled = useXsEnabled();
  const grabbed = useRef(null);
  if (!enabled || !isXsId(sessionId)) return null;
  const selectionNow = () => selectionWithin(bubbleRef && bubbleRef.current);
  return (
    <button
      type="button"
      data-testid="xs-forward-btn"
      onMouseDown={(e) => { grabbed.current = selectionNow(); e.preventDefault(); }}
      onClick={() => {
        const selected = grabbed.current !== null ? grabbed.current : selectionNow();
        grabbed.current = null;
        openXsForwardDialog({ body: selected || text || '', fromSessionId: sessionId });
      }}
      className="p-1 hover:bg-canvas-deep rounded"
      title="转发到其它会话"
      aria-label="转发到其它会话"
    >
      <Send size={12} className="text-ink-faint" />
    </button>
  );
}
