import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Folder, FolderOpen, File, RefreshCw, AlertCircle, ChevronRight, ChevronDown, FileText, Image as ImageIcon, ArrowLeft } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { useResizable, Splitter } from '../hooks/useResizable.jsx';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

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
  const secondarySession = useStore((s) => s.secondarySession);
  const splitMode = useStore((s) => s.splitMode);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const selectedProject = useStore((s) => s.selectedProject);
  const activeSession = splitMode && activeTabIndex === 1 ? secondarySession : selectedSession;
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
  const e = ext(preview.name || '');
  const isImage = IMAGE_EXT.has(e);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-1.5 border-b border-canvas-deep bg-canvas-warm/60 flex items-center gap-2 shrink-0">
        {isImage ? <ImageIcon size={11} className="text-ink-faint" /> : <FileText size={11} className="text-ink-faint" />}
        <span className="text-[11px] font-mono text-ink truncate flex-1" title={preview.path}>{preview.name}</span>
        <span className="text-[10px] text-ink-faint font-mono shrink-0">
          {fmtSize(preview.size || 0)}{preview.truncated ? ' · 已截断' : ''}
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        {preview.binary ? (
          isImage ? (
            <div className="p-3 flex items-center justify-center">
              <img
                src={`/api/files/read?path=${encodeURIComponent(preview.path)}&raw=1`}
                alt={preview.name}
                onError={(ev) => { ev.target.style.display = 'none'; }}
                className="max-w-full max-h-[300px] object-contain rounded border border-canvas-deep"
              />
              <div className="text-[11px] text-ink-faint">二进制图片（点开原文件查看）</div>
            </div>
          ) : (
            <div className="px-3 py-4 text-[11px] text-ink-faint">
              二进制文件 · 不渲染预览
            </div>
          )
        ) : e === 'md' || e === 'markdown' ? (
          <div className="px-3 py-2">
            <MarkdownRenderer content={preview.content || ''} />
          </div>
        ) : (
          <pre className="px-3 py-2 text-[11px] font-mono text-ink whitespace-pre overflow-x-auto">
            {preview.content || ''}
          </pre>
        )}
      </div>
    </div>
  );
}
