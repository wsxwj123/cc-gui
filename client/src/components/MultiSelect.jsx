// 通用批量多选删除。提炼自文件浏览器已验证的范式(FileExplorerPanel selMode/selected/batchDelete):
//   进入多选模式 → 列表项出现勾选框 → 「删除所选(N)」→ confirmDialog 危险确认 → 并发调各自单删端点。
// 后端零改动:各面板传入自己的 deleteOne(id)=>Promise(纯后端调用、失败 throw),删完由调用方统一刷新一次。
import { useState, useCallback } from 'react';
import { CheckSquare, Square } from 'lucide-react';
import { confirmDialog } from '../utils/confirmDialog.jsx';

export function useMultiSelect() {
  const [selMode, setSelMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false); // 批量删除进行中:防二次点击重复触发
  const toggle = useCallback((id) => {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  const enter = useCallback(() => setSelMode(true), []);
  const exit = useCallback(() => { setSelMode(false); setSelected(new Set()); }, []);
  // deleteOne(id)=>Promise 必须是纯后端调用、失败时 throw;删完统一由调用方刷新列表。
  // 返回 { total, ok, failed:[{id,error}] } 供调用方提示,取消/空选返回 null。
  const runDelete = useCallback(async (deleteOne, { noun = '项', nameOf } = {}) => {
    if (busy) return null;
    const ids = [...selected];
    if (!ids.length) return null;
    const labels = ids.map((id) => (nameOf ? nameOf(id) : id));
    const preview = labels.slice(0, 8).join('\n') + (labels.length > 8 ? `\n…等共 ${labels.length} 个` : '');
    if (!(await confirmDialog(`删除所选 ${ids.length} ${noun}?\n\n${preview}\n\n删除后不可恢复。`, { danger: true, confirmText: '删除' }))) return null;
    setBusy(true);
    const results = await Promise.allSettled(ids.map((id) => deleteOne(id)));
    setBusy(false);
    exit();
    const failed = results
      .map((r, i) => ({ r, id: ids[i] }))
      .filter((x) => x.r.status === 'rejected')
      .map((x) => ({ id: x.id, error: String(x.r.reason?.message || x.r.reason || '失败') }));
    return { total: ids.length, ok: ids.length - failed.length, failed };
  }, [busy, selected, exit]);
  return { selMode, selected, busy, count: selected.size, toggle, enter, exit, runDelete };
}

// 多选模式触发按钮(放面板工具栏)。
export function SelModeToggle({ selMode, onToggle, size = 13, className = '' }) {
  return (
    <button onClick={onToggle} title={selMode ? '退出多选' : '多选(批量删除)'}
      className={`p-1 rounded ${selMode ? 'text-accent bg-accent/10' : 'text-ink-faint hover:text-ink'} ${className}`}>
      <CheckSquare size={size} />
    </button>
  );
}

// 多选工具条:「已选 N · 删除所选 / 取消」。放列表顶部。
export function BatchBar({ count, busy, onDelete, onExit, noun = '项' }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-canvas-warm border-b border-canvas-deep shrink-0">
      <span className="text-[11px] font-body text-ink flex-1">已选 {count} {noun}(点条目勾选)</span>
      <button onClick={onDelete} disabled={!count || busy}
        className="text-[11px] px-2 py-0.5 rounded bg-red-600 text-white disabled:opacity-40 hover:bg-red-700">{busy ? '删除中…' : '删除所选'}</button>
      <button onClick={onExit} disabled={busy}
        className="text-[11px] px-2 py-0.5 rounded border border-canvas-deep text-ink-muted hover:bg-canvas-deep disabled:opacity-40">取消</button>
    </div>
  );
}

// 列表项勾选框(selMode 下显示在项目左侧)。
export function SelCheckbox({ checked, onClick, size = 14, className = '' }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`shrink-0 ${checked ? 'text-accent' : 'text-ink-faint hover:text-ink-muted'} ${className}`}>
      {checked ? <CheckSquare size={size} /> : <Square size={size} />}
    </button>
  );
}
