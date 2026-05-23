import React, { useEffect, useState } from 'react';
import { FileText, Edit3, Terminal, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function ChangeItem({ change }) {
  const [expanded, setExpanded] = useState(false);

  const icon = change.type === 'edit' ? Edit3 : change.type === 'write' ? FileText : Terminal;
  const Icon = icon;
  const label = change.type === 'bash'
    ? change.command?.slice(0, 80)
    : change.file?.split('/').pop();
  const detail = change.type === 'bash'
    ? change.command
    : change.file;

  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-canvas-warm/60 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-ink-faint shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-ink-faint shrink-0" />
        )}
        <Icon size={12} className={change.type === 'bash' ? 'text-warning/70' : 'text-accent/60'} shrink-0 />
        <span className="text-xs text-ink-soft font-mono truncate flex-1">{label}</span>
        <span className="text-[10px] text-ink-faint font-mono shrink-0">
          {formatTime(change.timestamp)}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-canvas-deep p-3 space-y-2 animate-fade-in bg-canvas">
          <div className="text-[10px] text-ink-faint font-body">
            类型: {change.type === 'edit' ? '编辑' : change.type === 'write' ? '写入' : '命令'}
          </div>
          <div className="text-[10px] text-ink-muted font-mono break-all">
            {detail}
          </div>
          {change.type === 'edit' && change.oldPreview && (
            <div>
              <div className="text-[10px] text-ink-faint font-body mb-1">旧内容:</div>
              <pre className="text-[11px] bg-canvas-warm border border-canvas-sunken rounded p-2 font-mono text-ink-muted overflow-x-auto max-h-24">
                {change.oldPreview}
              </pre>
            </div>
          )}
          {change.preview && (
            <div>
              <div className="text-[10px] text-ink-faint font-body mb-1">
                {change.type === 'edit' ? '新内容:' : '内容预览:'}
              </div>
              <pre className="text-[11px] bg-canvas-warm border border-canvas-sunken rounded p-2 font-mono text-ink-muted overflow-x-auto max-h-24">
                {change.preview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileChangesPanel({ sessionId, projectHash }) {
  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchChanges = async () => {
    if (!sessionId || !projectHash) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/file-changes?projectHash=${encodeURIComponent(projectHash)}`
      );
      setChanges(await res.json());
    } catch (err) {
      console.error('Failed to fetch file changes:', err);
    }
    setLoading(false);
  };

  useEffect(() => { fetchChanges(); }, [sessionId, projectHash]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw size={14} className="text-ink-faint animate-spin" />
      </div>
    );
  }

  if (changes.length === 0) {
    return (
      <div className="text-xs text-ink-faint font-body py-6 text-center">
        该会话没有文件变更记录
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-ink-faint font-mono">
          {changes.length} 个变更
        </span>
        <button
          onClick={fetchChanges}
          className="text-[10px] text-ink-faint hover:text-ink-muted font-body"
        >
          <RefreshCw size={10} />
        </button>
      </div>
      {changes.map((change, i) => (
        <ChangeItem key={change.uuid || i} change={change} />
      ))}
    </div>
  );
}
