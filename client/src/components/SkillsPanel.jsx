// CK-4: Skill 市场面板。
// 上半:本机已安装 skill(~/.claude/skills)。下半:anthropics/skills 官方市场,
// 可逐个导入或一键全部导入;重名时弹内联横幅让用户选跳过/覆盖(Tauri 禁原生 confirm)。
import { useState, useEffect, useCallback } from 'react';
import { Sparkles, Download, Check, Loader2, RefreshCw, AlertTriangle, CloudDownload } from 'lucide-react';

export function SkillsPanel() {
  const [local, setLocal] = useState([]);
  const [official, setOfficial] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(null);          // null | 'all' | <skillId>
  const [conflicts, setConflicts] = useState(null); // string[] 待用户裁决的重名 id
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const [l, o] = await Promise.all([
        fetch('/api/skills').then((r) => r.json()),
        fetch('/api/skills/official').then((r) => r.json()),
      ]);
      setLocal(l.skills || []);
      setOfficial(o.skills || []);
      if (o.error) setErr(o.error);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const runImport = async (ids, overwrite, tag) => {
    if (!ids.length) return;
    setBusy(tag); setNotice('');
    try {
      const r = await fetch('/api/skills/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, overwrite }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '导入失败');
      if (!overwrite && d.conflicts?.length) {
        setConflicts(d.conflicts);                  // 弹横幅让用户裁决
        if (d.imported?.length) setNotice(`已导入 ${d.imported.length} 个新 skill`);
      } else {
        const parts = [];
        if (d.imported?.length) parts.push(`导入 ${d.imported.length}`);
        if (d.failed?.length) parts.push(`失败 ${d.failed.length}`);
        setNotice(parts.join(' · ') || '完成');
        setConflicts(null);
      }
      await load();
    } catch (e) { setNotice('错误: ' + e.message); }
    setBusy(null);
  };

  const notInstalled = official.filter((s) => !s.installed);

  return (
    <div className="px-4 py-4 space-y-5 overflow-y-auto h-full">
      {/* 已安装 */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
          <Sparkles size={11} />已安装 Skill
          <span className="text-ink-ghost font-mono normal-case tracking-normal">{local.length}</span>
          <button onClick={load} disabled={loading} className="ml-auto p-1 text-ink-faint hover:text-ink rounded disabled:opacity-40" title="刷新">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </h3>
        {local.length > 0 ? (
          <div className="space-y-2">
            {local.map((s) => (
              <div key={s.id} className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium font-body text-ink truncate" title={s.id}>{s.name}</span>
                </div>
                {s.description && <div className="text-[11px] text-ink-muted font-body mt-1 line-clamp-2">{s.description}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-ink-faint font-body py-3 text-center bg-canvas-warm border border-canvas-deep rounded-lg">
            ~/.claude/skills 下没有 skill
          </div>
        )}
      </div>

      {/* 官方市场 */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-1 flex items-center gap-1.5">
          <CloudDownload size={11} />官方 Skill 市场
          <span className="text-ink-ghost font-mono normal-case tracking-normal">anthropics/skills</span>
        </h3>
        <div className="text-[10px] text-ink-faint font-body mb-3 leading-snug">
          Anthropic 官方维护。导入即写入 ~/.claude/skills,新会话生效。重名会询问跳过或覆盖。
        </div>

        {err && (
          <div className="text-[11px] text-error bg-error/10 border border-error/20 rounded px-2 py-1.5 mb-2 break-all">{err}</div>
        )}
        {notice && (
          <div className="text-[11px] text-ink-soft bg-canvas-deep/60 border border-canvas-deep rounded px-2 py-1.5 mb-2">{notice}</div>
        )}

        {/* 重名裁决横幅 */}
        {conflicts && conflicts.length > 0 && (
          <div className="text-[11px] bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 mb-2">
            <div className="flex items-center gap-1.5 text-amber-700 font-medium mb-1">
              <AlertTriangle size={12} />{conflicts.length} 个 skill 已存在
            </div>
            <div className="text-ink-muted font-mono break-all mb-2">{conflicts.join(', ')}</div>
            <div className="text-ink-muted mb-2">覆盖会用官方版替换本机同名 skill(本机改动会丢失)。</div>
            <div className="flex items-center gap-2">
              <button onClick={() => { setConflicts(null); setNotice('已跳过重名 skill'); }}
                className="px-2.5 py-1 rounded text-[11px] font-medium border border-canvas-deep text-ink-soft hover:bg-canvas-deep">跳过</button>
              <button onClick={() => runImport(conflicts, true, 'all')} disabled={busy === 'all'}
                className="px-2.5 py-1 rounded text-[11px] font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 flex items-center gap-1">
                {busy === 'all' && <Loader2 size={11} className="animate-spin" />}覆盖
              </button>
            </div>
          </div>
        )}

        <button
          onClick={() => runImport(notInstalled.map((s) => s.id), false, 'all')}
          disabled={loading || busy === 'all' || notInstalled.length === 0}
          className="w-full mb-2 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-[12px] font-medium hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
          {busy === 'all' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {notInstalled.length === 0 ? '官方 skill 已全部安装' : `一键导入全部(${notInstalled.length})`}
        </button>

        {loading ? (
          <div className="text-xs text-ink-faint font-body py-6 text-center flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" />加载官方市场…
          </div>
        ) : (
          <div className="space-y-2">
            {official.map((s) => (
              <div key={s.id} className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium font-body text-ink truncate flex-1" title={s.id}>{s.name}</span>
                  {s.installed ? (
                    <button onClick={() => runImport([s.id], true, s.id)} disabled={busy === s.id}
                      className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-canvas-deep text-ink-faint hover:text-ink hover:bg-canvas-deep flex items-center gap-1 disabled:opacity-50"
                      title="已安装 — 点击用官方版覆盖">
                      {busy === s.id ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} className="text-success" />}已装·覆盖
                    </button>
                  ) : (
                    <button onClick={() => runImport([s.id], false, s.id)} disabled={busy === s.id}
                      className="shrink-0 text-[10px] px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 flex items-center gap-1 disabled:opacity-50">
                      {busy === s.id ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}导入
                    </button>
                  )}
                </div>
                {s.description && <div className="text-[11px] text-ink-muted font-body mt-1 line-clamp-2">{s.description}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
