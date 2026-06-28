// CK-4: Skill 市场。两个选项卡 —— 「本机」展示 ~/.claude/skills 已装;「导入」从多个
// 源仓库(Anthropic / Superpowers / 开源社区 / 科研)拉取并导入,重名内联横幅选跳过/覆盖。
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Download, Check, Loader2, RefreshCw, AlertTriangle, CloudDownload, ExternalLink, Copy, Search } from 'lucide-react';
import { copyText } from '../utils/clipboard.js';

// CM-1:复制技能名(用 /<name> 经 slash 命令加载)。图标按钮,复制后短暂打勾。
function SkillCopyBtn({ name }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async (e) => { e.stopPropagation(); if (await copyText(name)) { setDone(true); setTimeout(() => setDone(false), 1200); } }}
      title={`复制技能名「${name}」—— 输入框里用 /${name} 加载`}
      className="shrink-0 p-1 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors">
      {done ? <Check size={12} className="text-success" /> : <Copy size={12} />}
    </button>
  );
}

export function SkillsPanel() {
  const [tab, setTab] = useState('local');            // 'local' | 'import'
  const [local, setLocal] = useState([]);
  const [loadingLocal, setLoadingLocal] = useState(true);
  const [query, setQuery] = useState('');             // CM-1 本机 skill 搜索(名称+描述)

  const [sources, setSources] = useState([]);
  const [source, setSource] = useState('anthropic');
  const [official, setOfficial] = useState([]);
  const [officialMeta, setOfficialMeta] = useState({});
  const [loadingOff, setLoadingOff] = useState(false);
  const [offErr, setOffErr] = useState('');
  // CQ批次4:粘贴任意 GitHub 仓库导入。customRepo=输入框,activeRepo=已加载的自定义仓库(null=用内置源)。
  const [customRepo, setCustomRepo] = useState('');
  const [activeRepo, setActiveRepo] = useState(null);

  const [busy, setBusy] = useState(null);             // null | 'all' | <skillId>
  const [conflicts, setConflicts] = useState(null);
  const [notice, setNotice] = useState('');

  const loadLocal = useCallback(async () => {
    setLoadingLocal(true);
    try { const d = await (await fetch('/api/skills')).json(); setLocal(d.skills || []); }
    catch { /* 忽略 */ }
    setLoadingLocal(false);
  }, []);

  const loadOfficial = useCallback(async (srcId, repo) => {
    setLoadingOff(true); setOffErr(''); setConflicts(null);
    try {
      const url = repo
        ? `/api/skills/official?repo=${encodeURIComponent(repo)}`
        : `/api/skills/official?source=${encodeURIComponent(srcId)}`;
      const d = await (await fetch(url)).json();
      setOfficial(d.skills || []);
      setOfficialMeta({ count: d.count, repo: d.repo, truncatedDesc: d.truncatedDesc });
      if (d.error) setOffErr(d.error);
    } catch (e) { setOffErr(e.message); }
    setLoadingOff(false);
  }, []);

  // 解析 owner/repo 或 GitHub 地址 → 加载该仓库的 skill 列表。
  const loadCustomRepo = useCallback(() => {
    const m = customRepo.trim().match(/(?:github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git|\/.*)?$/i);
    if (!m) { setOffErr('请输入 owner/repo 或 GitHub 仓库地址'); return; }
    const repo = m[1];
    setActiveRepo(repo);
    loadOfficial(null, repo);
  }, [customRepo, loadOfficial]);

  useEffect(() => { loadLocal(); }, [loadLocal]);
  useEffect(() => {
    fetch('/api/skills/sources').then((r) => r.json()).then((d) => setSources(d.sources || [])).catch(() => {});
  }, []);
  useEffect(() => { if (tab === 'import' && !activeRepo) loadOfficial(source); }, [tab, source, activeRepo, loadOfficial]);

  const runImport = async (ids, overwrite, tag) => {
    if (!ids.length) return;
    setBusy(tag); setNotice('');
    try {
      const r = await fetch('/api/skills/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(activeRepo ? { repo: activeRepo, ids, overwrite } : { source, ids, overwrite }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '导入失败');
      if (!overwrite && d.conflicts?.length) {
        setConflicts(d.conflicts);
        if (d.imported?.length) setNotice(`已导入 ${d.imported.length} 个新 skill`);
      } else {
        const parts = [];
        if (d.imported?.length) parts.push(`导入 ${d.imported.length}`);
        if (d.failed?.length) parts.push(`失败 ${d.failed.length}`);
        setNotice(parts.join(' · ') || '完成');
        setConflicts(null);
      }
      await Promise.all([activeRepo ? loadOfficial(null, activeRepo) : loadOfficial(source), loadLocal()]);
    } catch (e) { setNotice('错误: ' + e.message); }
    setBusy(null);
  };

  const notInstalled = official.filter((s) => !s.installed);
  // CM-1:本机 skill 按关键词过滤(名称 + 描述,大小写不敏感)
  const filteredLocal = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return local;
    return local.filter((s) => `${s.id} ${s.name} ${s.description}`.toLowerCase().includes(q));
  }, [local, query]);
  const tabBtn = (id, label, count) => (
    <button onClick={() => setTab(id)}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body rounded-lg transition-colors ${
        tab === id ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink hover:bg-canvas-deep'}`}>
      {label}{typeof count === 'number' && <span className="font-mono opacity-70">{count}</span>}
    </button>
  );

  return (
    <div className="px-4 py-4 space-y-4 overflow-y-auto h-full">
      <div className="flex items-center gap-1.5">
        {tabBtn('local', '本机 Skill', local.length)}
        {tabBtn('import', '导入', null)}
        <button onClick={tab === 'local' ? loadLocal : () => (activeRepo ? loadOfficial(null, activeRepo) : loadOfficial(source))} disabled={loadingLocal || loadingOff}
          className="ml-auto p-1.5 text-ink-faint hover:text-ink rounded disabled:opacity-40" title="刷新">
          <RefreshCw size={13} className={(loadingLocal || loadingOff) ? 'animate-spin' : ''} />
        </button>
      </div>

      {tab === 'local' ? (
        <>
          {/* CM-1 搜索框:按名称 + 描述检索 */}
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-ghost" />
            <input
              type="text" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索技能（名称 / 描述）..."
              className="w-full bg-canvas border border-canvas-deep rounded-lg pl-8 pr-3 py-1.5 text-xs text-ink placeholder-ink-ghost focus:outline-none focus:border-accent/40 font-body" />
          </div>
          {filteredLocal.length > 0 ? (
            <div className="space-y-2">
              {filteredLocal.map((s) => (
                <div key={s.id} className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium font-body text-ink truncate flex-1" title={s.id}>{s.name}</span>
                    <SkillCopyBtn name={s.id} />
                  </div>
                  {s.description && <div className="text-[11px] text-ink-muted font-body mt-1 line-clamp-2">{s.description}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-ink-faint font-body py-6 text-center bg-canvas-warm border border-canvas-deep rounded-lg">
              {loadingLocal ? '加载中…' : query.trim() ? `没有匹配「${query.trim()}」的技能` : '~/.claude/skills 下没有 skill'}
            </div>
          )}
        </>
      ) : (
        <>
          {/* 源选择(内置源点了即清掉自定义仓库,回到内置源模式) */}
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s) => (
              <button key={s.id} onClick={() => { setActiveRepo(null); setCustomRepo(''); setSource(s.id); }}
                className={`px-2.5 py-1 text-[11px] font-body rounded-md border transition-colors ${
                  !activeRepo && source === s.id ? 'border-accent text-accent bg-accent/10' : 'border-canvas-deep text-ink-muted hover:text-ink'}`}>
                {s.name}
              </button>
            ))}
          </div>
          {/* CQ批次4:粘贴任意 GitHub 仓库一键导入其全部 skill */}
          <div className="flex gap-1.5">
            <input
              type="text" value={customRepo}
              onChange={(e) => setCustomRepo(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); loadCustomRepo(); } }}
              placeholder="GitHub 仓库:owner/repo 或完整地址"
              className="flex-1 min-w-0 bg-canvas border border-canvas-deep rounded-md px-2 py-1 text-[11px] text-ink placeholder-ink-ghost focus:outline-none focus:border-accent/40 font-mono" />
            <button onClick={loadCustomRepo} disabled={loadingOff || !customRepo.trim()}
              className="shrink-0 px-2.5 py-1 rounded-md bg-accent text-white text-[11px] font-body hover:bg-accent-hover disabled:opacity-50">
              拉取仓库
            </button>
          </div>
          {activeRepo ? (
            <div className="flex items-center gap-2 text-[10px] text-ink-faint font-mono">
              <span className="text-accent">仓库:{activeRepo}</span>
              <button onClick={() => { setActiveRepo(null); setCustomRepo(''); }} className="text-ink-faint hover:text-ink underline">返回内置源</button>
            </div>
          ) : sources.find((s) => s.id === source)?.url && (
            <a href={sources.find((s) => s.id === source).url} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-ink-faint hover:text-accent font-mono">
              <ExternalLink size={10} />{officialMeta.repo || sources.find((s) => s.id === source).url}
            </a>
          )}

          {offErr && <div className="text-[11px] text-error bg-error/10 border border-error/20 rounded px-2 py-1.5 break-all">{offErr}</div>}
          {notice && <div className="text-[11px] text-ink-soft bg-canvas-deep/60 border border-canvas-deep rounded px-2 py-1.5">{notice}</div>}
          {officialMeta.truncatedDesc && (
            <div className="text-[10px] text-ink-faint font-body">该源 skill 较多,仅列名称(不预取描述);导入后可在本机查看。</div>
          )}

          {/* 重名裁决 */}
          {conflicts && conflicts.length > 0 && (
            <div className="text-[11px] bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              <div className="flex items-center gap-1.5 text-amber-700 font-medium mb-1"><AlertTriangle size={12} />{conflicts.length} 个 skill 已存在</div>
              <div className="text-ink-muted font-mono break-all mb-2">{conflicts.join(', ')}</div>
              <div className="text-ink-muted mb-2">覆盖会用此源版本替换本机同名 skill(本机改动会丢失)。</div>
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

          <button onClick={() => runImport(notInstalled.map((s) => s.id), false, 'all')}
            disabled={loadingOff || busy === 'all' || notInstalled.length === 0}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-[12px] font-medium hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {busy === 'all' ? <Loader2 size={13} className="animate-spin" /> : <CloudDownload size={13} />}
            {loadingOff ? '加载中…' : notInstalled.length === 0 ? '此源已全部安装' : `一键导入全部(${notInstalled.length})`}
          </button>

          {loadingOff ? (
            <div className="text-xs text-ink-faint font-body py-6 text-center flex items-center justify-center gap-2"><Loader2 size={14} className="animate-spin" />加载…</div>
          ) : (
            <div className="space-y-2">
              {official.map((s) => (
                <div key={s.id} className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium font-body text-ink truncate flex-1" title={s.id}>{s.name}</span>
                    <SkillCopyBtn name={s.id} />
                    {s.installed ? (
                      <button onClick={() => runImport([s.id], true, s.id)} disabled={busy === s.id}
                        className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-canvas-deep text-ink-faint hover:text-ink hover:bg-canvas-deep flex items-center gap-1 disabled:opacity-50" title="已安装 — 点击覆盖">
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
        </>
      )}
    </div>
  );
}
