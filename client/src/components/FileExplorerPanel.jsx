import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Folder, FolderOpen, File, RefreshCw, AlertCircle, ChevronRight, ChevronDown, FileText, Image as ImageIcon, ArrowLeft, ExternalLink, Film, Pencil, Save, Undo2, Redo2, X, Check } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { useResizable, Splitter } from '../hooks/useResizable.jsx';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac']);

function rawUrl(path) {
  return `/api/files/read?path=${encodeURIComponent(path)}&raw=1`;
}

// Open a file with the OS default app (Finder/Explorer double-click behaviour).
async function openWithDefaultApp(path) {
  try {
    await fetch('/api/files/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  } catch {}
}

function ext(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}
function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * Tree-style file explorer with click-to-preview. Sandboxed to the current
 * session's projectPath (server-side enforced under $HOME).
 *
 * Layout: top half = tree, bottom half = preview pane. Resizable would be
 * nice but cramped right-side panels don't need it.
 */
export function FileExplorerPanel() {
  // Follow the active pane in split mode so the tree reflects whichever
  // session has focus. Falls back to selectedSession / selectedProject in
  // single-pane mode.
  const selectedSession = useStore((s) => s.selectedSession);
  const paneSessions = useStore((s) => s.paneSessions);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const selectedProject = useStore((s) => s.selectedProject);
  // Follow whichever pane has focus (multi-pane: 0..5), falling back to pane 0.
  const activeSession = paneSessions?.[activeTabIndex] || selectedSession;
  const rootPath = activeSession?.projectPath || selectedProject?.path || '';

  // Map<absPath, { entries, loading, error }> — cached so re-expand is instant.
  const [dirs, setDirs] = useState({});
  const [expanded, setExpanded] = useState(() => new Set([rootPath].filter(Boolean)));
  const [selectedFile, setSelectedFile] = useState(null);
  const [preview, setPreview] = useState(null); // { path, content, size, binary, truncated, loading, error }
  // Top tree pane height (px). Bottom preview takes the remainder. Dragable
  // splitter sits between them. Persists across sessions.
  const [treeHeight, onSplitDrag] = useResizable({
    initial: 280, min: 100, max: 600, axis: 'y', storageKey: 'cgui-files-tree-h',
  });

  const fetchDir = useCallback(async (path) => {
    setDirs((prev) => ({ ...prev, [path]: { ...(prev[path] || {}), loading: true, error: null } }));
    try {
      const r = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `${r.status}`);
      setDirs((prev) => ({ ...prev, [path]: { entries: d.entries || [], loading: false, error: null } }));
    } catch (e) {
      setDirs((prev) => ({ ...prev, [path]: { entries: [], loading: false, error: e.message } }));
    }
  }, []);

  // Load root + reset when project changes.
  useEffect(() => {
    if (!rootPath) return;
    setDirs({});
    setExpanded(new Set([rootPath]));
    setSelectedFile(null);
    setPreview(null);
    fetchDir(rootPath);
  }, [rootPath, fetchDir]);

  const toggle = (path, isDir) => {
    if (!isDir) return;
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else {
        n.add(path);
        if (!dirs[path]) fetchDir(path);
      }
      return n;
    });
  };

  const openFile = useCallback(async (entry) => {
    setSelectedFile(entry.path);
    setPreview({ path: entry.path, loading: true, name: entry.name, size: entry.size });
    try {
      const r = await fetch(`/api/files/read?path=${encodeURIComponent(entry.path)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `${r.status}`);
      setPreview({ ...d, name: entry.name, loading: false });
    } catch (e) {
      setPreview({ path: entry.path, name: entry.name, loading: false, error: e.message });
    }
  }, []);

  if (!rootPath) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-ink-faint font-body">
        请先选择一个会话或项目
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tree pane (height controlled by splitter) */}
      <div style={{ height: treeHeight }} className="shrink-0 overflow-y-auto px-1 py-2 border-b border-canvas-deep">
        <div className="flex items-center justify-between px-3 mb-2">
          <span className="text-[10px] text-ink-faint font-mono truncate" title={rootPath}>
            {rootPath.split('/').slice(-2).join('/')}
          </span>
          <button
            onClick={() => fetchDir(rootPath)}
            className="p-1 text-ink-faint hover:text-ink rounded"
            title="刷新"
          ><RefreshCw size={11} /></button>
        </div>
        <TreeNode
          path={rootPath}
          name={rootPath.split('/').slice(-1)[0] || '/'}
          depth={0}
          isDir
          isRoot
          expanded={expanded}
          dirs={dirs}
          toggle={toggle}
          openFile={openFile}
          selectedFile={selectedFile}
        />
      </div>

      {/* Draggable splitter */}
      <Splitter onMouseDown={onSplitDrag} axis="y" />

      {/* Preview pane (fills remaining space) */}
      <div className="flex-1 min-h-[80px] flex flex-col bg-canvas-sunken/40">
        {!preview ? (
          <div className="flex-1 flex items-center justify-center text-[11px] text-ink-faint font-body">
            点击左侧文件查看预览
          </div>
        ) : (
          <PreviewBody preview={preview} />
        )}
      </div>
    </div>
  );
}

function TreeNode({ path, name, depth, isDir, isRoot, expanded, dirs, toggle, openFile, selectedFile }) {
  const isOpen = expanded.has(path);
  const dir = dirs[path];
  const isSelected = selectedFile === path;
  return (
    <div>
      <div
        onClick={() => isDir ? toggle(path, true) : openFile({ path, name, size: 0 })}
        className={`flex items-center gap-1 px-2 py-0.5 rounded cursor-pointer text-[12px] font-body select-none ${
          isSelected ? 'bg-accent/15 text-accent' : 'hover:bg-canvas-warm text-ink'
        }`}
        style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
        title={path}
      >
        {isDir ? (
          <>
            {isOpen ? <ChevronDown size={11} className="shrink-0 text-ink-faint" /> : <ChevronRight size={11} className="shrink-0 text-ink-faint" />}
            {isOpen ? <FolderOpen size={12} className="shrink-0 text-amber-600" /> : <Folder size={12} className="shrink-0 text-amber-600" />}
          </>
        ) : (
          <>
            <span className="w-[11px] shrink-0" />
            <File size={12} className="shrink-0 text-ink-faint" />
          </>
        )}
        <span className="truncate flex-1">{name}</span>
      </div>
      {isDir && isOpen && dir && (
        <>
          {dir.loading && (
            <div className="text-[10px] text-ink-faint px-3 py-1" style={{ paddingLeft: `${1.5 + depth * 0.9}rem` }}>
              加载中…
            </div>
          )}
          {dir.error && (
            <div className="text-[10px] text-red-600 px-3 py-1 flex items-center gap-1" style={{ paddingLeft: `${1.5 + depth * 0.9}rem` }}>
              <AlertCircle size={10} />{dir.error}
            </div>
          )}
          {dir.entries?.map((e) => (
            <TreeNode
              key={e.path}
              path={e.path}
              name={e.name}
              depth={depth + 1}
              isDir={e.isDir}
              expanded={expanded}
              dirs={dirs}
              toggle={toggle}
              openFile={openFile}
              selectedFile={selectedFile}
            />
          ))}
        </>
      )}
    </div>
  );
}

function PreviewBody({ preview }) {
  const e = ext(preview.name || '');
  const isImage = IMAGE_EXT.has(e);
  const isVideo = VIDEO_EXT.has(e);
  const isAudio = AUDIO_EXT.has(e);
  const isMedia = isImage || isVideo || isAudio;
  // Truncated files can't be edited — saving would write back only the first
  // 256KB and silently destroy the tail.
  const editable = !isMedia && !preview.binary && !preview.truncated && !preview.loading && !preview.error;
  const isMarkdown = e === 'md' || e === 'markdown';

  const [editing, setEditing] = useState(false);
  // Undo/redo history of the textarea value. Bursts within 400ms collapse into
  // one entry so a word's worth of typing isn't 20 undo steps.
  const [hist, setHist] = useState({ stack: [''], ptr: 0 });
  const [savedValue, setSavedValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const lastEditAt = useRef(0);

  const value = hist.stack[hist.ptr];
  const dirty = editing && value !== savedValue;

  // Reset everything when a different file is opened, or content arrives.
  useEffect(() => {
    const c = preview.content || '';
    setEditing(false);
    setHist({ stack: [c], ptr: 0 });
    setSavedValue(c);
    setSaveErr(null);
  }, [preview.path, preview.content]);

  const pushValue = useCallback((next) => {
    setHist((h) => {
      const now = Date.now();
      const coalesce = now - lastEditAt.current < 400 && h.ptr === h.stack.length - 1;
      lastEditAt.current = now;
      if (coalesce) {
        const stack = h.stack.slice(0, h.ptr + 1);
        stack[h.ptr] = next;
        return { stack, ptr: h.ptr };
      }
      const stack = h.stack.slice(0, h.ptr + 1);
      stack.push(next);
      return { stack, ptr: stack.length - 1 };
    });
  }, []);

  const undo = useCallback(() => setHist((h) => h.ptr > 0 ? { ...h, ptr: h.ptr - 1 } : h), []);
  const redo = useCallback(() => setHist((h) => h.ptr < h.stack.length - 1 ? { ...h, ptr: h.ptr + 1 } : h), []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await fetch('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: preview.path, content: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `${r.status}`);
      setSavedValue(value);
    } catch (err) {
      setSaveErr(err.message);
    } finally {
      setSaving(false);
    }
  }, [preview.path, value]);

  if (preview.loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] text-ink-faint">
        <RefreshCw size={12} className="animate-spin mr-1.5" /> 读取中…
      </div>
    );
  }
  if (preview.error) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] text-red-600 gap-1.5">
        <AlertCircle size={12} />{preview.error}
      </div>
    );
  }
  const HeaderIcon = isVideo || isAudio ? Film : isImage ? ImageIcon : FileText;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-1.5 border-b border-canvas-deep bg-canvas-warm/60 flex items-center gap-2 shrink-0">
        <HeaderIcon size={11} className="text-ink-faint shrink-0" />
        <span className="text-[11px] font-mono text-ink truncate flex-1" title={preview.path}>
          {preview.name}{dirty ? ' ·' : ''}
        </span>
        <span className="text-[10px] text-ink-faint font-mono shrink-0">
          {fmtSize(preview.size || 0)}{preview.truncated ? ' · 已截断' : ''}
        </span>
        {editing ? (
          <>
            <button onClick={undo} disabled={hist.ptr === 0}
              className="p-1 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep disabled:opacity-30 disabled:hover:bg-transparent shrink-0"
              title="撤回"><Undo2 size={12} /></button>
            <button onClick={redo} disabled={hist.ptr >= hist.stack.length - 1}
              className="p-1 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep disabled:opacity-30 disabled:hover:bg-transparent shrink-0"
              title="重做"><Redo2 size={12} /></button>
            <button onClick={save} disabled={!dirty || saving}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-accent hover:bg-accent/10 disabled:opacity-40 disabled:hover:bg-transparent shrink-0"
              title="保存到磁盘">
              {saving ? <RefreshCw size={10} className="animate-spin" /> : <Save size={10} />}保存
            </button>
            <button onClick={() => { setEditing(false); setHist({ stack: [savedValue], ptr: 0 }); }}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep shrink-0"
              title="取消编辑"><X size={10} />取消</button>
          </>
        ) : (
          <>
            {editable && (
              <button onClick={() => setEditing(true)}
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors shrink-0"
                title="编辑此文件"><Pencil size={10} />编辑</button>
            )}
            <button
              onClick={() => openWithDefaultApp(preview.path)}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors shrink-0"
              title="用系统默认应用打开"
            >
              <ExternalLink size={10} />用默认App打开
            </button>
          </>
        )}
      </div>
      {saveErr && (
        <div className="px-3 py-1 text-[10px] text-red-600 bg-red-500/5 border-b border-canvas-deep flex items-center gap-1 shrink-0">
          <AlertCircle size={10} />保存失败：{saveErr}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {editing ? (
          <textarea
            value={value}
            onChange={(ev) => pushValue(ev.target.value)}
            onKeyDown={(ev) => {
              const mod = ev.metaKey || ev.ctrlKey;
              if (mod && ev.key === 's') { ev.preventDefault(); if (dirty && !saving) save(); }
              else if (mod && !ev.shiftKey && ev.key === 'z') { ev.preventDefault(); undo(); }
              else if (mod && (ev.key === 'y' || (ev.shiftKey && ev.key === 'z'))) { ev.preventDefault(); redo(); }
            }}
            spellCheck={false}
            className="w-full h-full min-h-[200px] px-3 py-2 text-[11px] font-mono leading-5 text-ink bg-canvas resize-none focus:outline-none"
          />
        ) : isImage ? (
          <div className="p-3 flex items-center justify-center">
            <img
              src={rawUrl(preview.path)}
              alt={preview.name}
              className="max-w-full max-h-[400px] object-contain rounded border border-canvas-deep"
            />
          </div>
        ) : isVideo ? (
          <div className="p-3 flex items-center justify-center">
            <video src={rawUrl(preview.path)} controls className="max-w-full max-h-[400px] rounded border border-canvas-deep" />
          </div>
        ) : isAudio ? (
          <div className="p-3">
            <audio src={rawUrl(preview.path)} controls className="w-full" />
          </div>
        ) : preview.binary ? (
          <div className="px-3 py-4 text-[11px] text-ink-faint">
            二进制文件 · 不渲染预览（用默认App打开查看）
          </div>
        ) : isMarkdown ? (
          <div className="px-3 py-2">
            <MarkdownRenderer content={preview.content || ''} />
          </div>
        ) : (
          (() => {
            // Both columns MUST derive from the SAME normalized line array.
            // A CRLF file leaves a stray `\r` at each line end; the content
            // <pre> renders those `\r` as extra visual breaks while the gutter
            // (plain numbers) does not, so the columns drift and numbers land
            // on the wrong rows. Splitting on /\r?\n/ and re-joining with \n
            // keeps the two columns line-for-line identical.
            const lines = (preview.content || '').split(/\r?\n/);
            return (
              <div className="flex text-[11px] font-mono leading-5 min-w-0">
                {/* Line-number gutter — fixed on the left while the code column
                    scrolls horizontally (VS Code behaviour). */}
                <pre className="px-2 py-2 text-right text-ink-ghost select-none border-r border-canvas-deep bg-canvas-warm/40 shrink-0">
                  {lines.map((_, i) => i + 1).join('\n')}
                </pre>
                <pre className="px-3 py-2 text-ink whitespace-pre overflow-x-auto flex-1">
                  {lines.join('\n')}
                </pre>
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}
