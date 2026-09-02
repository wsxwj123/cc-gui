import { useState, useRef, useEffect } from 'react';
import {
  detectAtQuery,
  applyAtInsert,
  parentDir,
  filterAtSessions,
  fetchDirEntries,
  searchProjectFiles,
  createSessionRef,
} from '../utils/atRef.js';

// `@` 引用选择器的状态机(会话内输入框与首页输入框共用同一份实现)。
// 取数与条目形态都在 utils/atRef.js:层级浏览走 fetchDirEntries(内部 mapDirEntries(),
// 子目录首行补「返回上级」),模糊搜索走 searchProjectFiles(内部 mapSearchFiles())。
// 会话列表由调用方作为入参给(两边不同源:会话内是全局槽,首页是所选项目的槽)。
//
// 入参:cwd / projectHash(打开面板瞬间快照,避免浏览中途换根)、sessions、
// excludeSessionId(会话内排除自己,首页为 null)、text / setText、inputRef。
export function useAtRef({ cwd, projectHash, sessions, excludeSessionId = null, text, setText, inputRef }) {
  const [atState, setAtState] = useState(null); // null | { query, start } start = '@' 在 text 中的下标
  const [atTab, setAtTab] = useState('files');  // 'files' | 'sessions'
  const [atFiles, setAtFiles] = useState([]);   // [{ kind:'up'|'dir'|'file', name, rel }]
  const [atDir, setAtDir] = useState('');       // 层级浏览中的当前相对目录('' = 项目根)
  const [atIndex, setAtIndex] = useState(0);
  const [atBusy, setAtBusy] = useState(false);  // 会话引用生成中
  const atCtxRef = useRef({ cwd: '', projectHash: '' });

  // 文件 tab 两种模式:
  //  · 无查询 → 层级浏览(列当前层,目录在前;点目录下钻,「..」返回上级)
  //    ——全部平铺在大项目里太混乱(用户反馈)。
  //  · 有查询 → 180ms 防抖后全局模糊搜索。
  useEffect(() => {
    if (!atState || atTab !== 'files') return;
    const ctxCwd = atCtxRef.current.cwd;
    if (!ctxCwd) { setAtFiles([]); return; }
    const q = atState.query;
    if (!q) {
      let cancelled = false;
      fetchDirEntries(ctxCwd, atDir)
        .then((items) => { if (!cancelled) setAtFiles(items); })
        .catch(() => { if (!cancelled) setAtFiles([]); });
      return () => { cancelled = true; };
    }
    let cancelled = false;
    const t = setTimeout(() => {
      searchProjectFiles(ctxCwd, q)
        .then((items) => { if (!cancelled) setAtFiles(items); })
        .catch(() => { if (!cancelled) setAtFiles([]); });
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [atState?.query, atTab, !!atState, atDir]);

  const atSessions = (!atState || atTab !== 'sessions')
    ? []
    : filterAtSessions(sessions, atState.query, excludeSessionId);
  const atItems = atTab === 'files' ? atFiles : atSessions;
  useEffect(() => { setAtIndex(0); }, [atTab, atState?.query, atDir]);

  // 选中:目录下钻/「..」返回上级(面板不关);文件插 `@相对路径 `;
  // 会话先生成精简 md 再插 `@绝对路径 `。
  const pick = async (item) => {
    if (!item || !atState) return;
    let insert = '';
    if (atTab === 'files') {
      if (item.kind === 'up') { setAtDir((d) => parentDir(d)); return; }
      if (item.kind === 'dir') { setAtDir(item.rel); return; }
      insert = item.rel;
    } else {
      setAtBusy(true);
      try {
        insert = await createSessionRef(item.sessionId, item.projectHash || atCtxRef.current.projectHash);
      } catch (e) {
        setAtBusy(false); setAtState(null);
        const { confirmDialog } = await import('../utils/confirmDialog.jsx');
        await confirmDialog('引用会话失败:' + e.message, { confirmText: '知道了' });
        return;
      }
      setAtBusy(false);
    }
    setText(applyAtInsert(text, atState, insert));
    setAtState(null);
    inputRef?.current?.focus();
  };

  // 输入变化:光标前是 `@词` 就开面板(打开瞬间快照上下文并复位 tab/高亮/目录)。
  const onTextChange = (value, caret) => {
    const next = detectAtQuery(value, caret);
    if (next) {
      if (!atState) {
        atCtxRef.current = { cwd: cwd || '', projectHash: projectHash || '' };
        setAtTab('files'); setAtIndex(0); setAtDir('');
      }
      setAtState(next);
    } else if (atState) setAtState(null);
  };

  // 上下选、Enter 选中、Tab 切文件/会话、Esc 关。返回 true = 这次按键已被面板消费。
  const keyDown = (e) => {
    if (!atState) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); setAtIndex((i) => Math.min(i + 1, Math.max(atItems.length - 1, 0))); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setAtIndex((i) => Math.max(i - 1, 0)); return true; }
    if (e.key === 'Tab') { e.preventDefault(); setAtTab((t) => (t === 'files' ? 'sessions' : 'files')); return true; }
    if (e.key === 'Enter' && !e.shiftKey && atItems.length > 0) { e.preventDefault(); if (!atBusy) pick(atItems[atIndex]); return true; }
    // 同斜杠菜单:关面板的 Esc 不得穿透到全局停止(React 合成事件的 stopPropagation
    // 只在 React 树内生效,原生事件仍会冒泡到 window → 必须停原生事件本身)。
    if (e.key === 'Escape') { e.preventDefault(); e.nativeEvent?.stopImmediatePropagation?.(); setAtState(null); return true; }
    return false;
  };

  const close = () => setAtState(null);

  return {
    open: !!atState,
    tab: atTab,
    dir: atDir,
    index: atIndex,
    items: atItems,
    files: atFiles,
    sessions: atSessions,
    busy: atBusy,
    cwd: atCtxRef.current.cwd,
    onTextChange,
    keyDown,
    pick,
    close,
    panelProps: {
      open: !!atState,
      tab: atTab,
      onTab: setAtTab,
      query: atState?.query || '',
      dir: atDir,
      busy: atBusy,
      items: atItems,
      files: atFiles,
      sessions: atSessions,
      index: atIndex,
      cwd: atCtxRef.current.cwd,
      onPick: pick,
    },
  };
}
