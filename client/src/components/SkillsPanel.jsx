// CK-4: Skill 市场。两个选项卡 —— 「本机」展示 ~/.claude/skills 已装;「导入」从多个
// 源仓库(Anthropic / Superpowers / 开源社区 / 科研)拉取并导入,重名内联横幅选跳过/覆盖。
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Download, Check, Loader2, RefreshCw, AlertTriangle, CloudDownload, ExternalLink, Copy, Search, Archive, Trash2, RotateCcw, X } from './Icon.jsx';
import { useMultiSelect, SelModeToggle, BatchBar, SelCheckbox } from './MultiSelect.jsx';
import { copyText } from '../utils/clipboard.js';
import { confirmDialog } from '../utils/confirmDialog.jsx';

// CM-1:复制技能调用名。纯图标按钮(斜杠名与条目真名常重复,文本移入 tooltip),点击复制,复制后短暂打勾。
function SkillCopyBtn({ name }) {
  const [done, setDone] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <button
      onClick={async (e) => { e.stopPropagation(); if (await copyText(`/${name}`)) { clearTimeout(timerRef.current); setDone(true); timerRef.current = setTimeout(() => setDone(false), 1200); } }}
      title={`复制调用命令「/${name}」—— 在输入框输入 /${name} 即可调用该技能`}
      className="shrink-0 flex items-center px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors">
      {done ? <Check size={11} className="text-success shrink-0" /> : <Copy size={11} className="shrink-0" />}
    </button>
  );
}

export function SkillsPanel() {
  const [tab, setTab] = useState('local');            // 'local' | 'import' | 'archived'
  const ms = useMultiSelect();
  const [local, setLocal] = useState([]);
  const [loadingLocal, setLoadingLocal] = useState(true);
  const [archived, setArchived] = useState([]);
  const [manageBusy, setManageBusy] = useState(null); // 归档/删除/恢复进行中的 skill id
  const [query, setQuery] = useState('');             // CM-1 本机 skill 搜索(名称+描述)

  const [sources, setSources] = useState([]);
  const [savedRepos, setSavedRepos] = useState([]);   // 用户导入过的自定义仓库(持久化,可点重进/删除)
  const [source, setSource] = useState('anthropic');
  const [official, setOfficial] = useState([]);
  const [officialMeta, setOfficialMeta] = useState({});
  const [loadingOff, setLoadingOff] = useState(false);
  const [offErr, setOffErr] = useState('');
  // r67:GitHub 令牌。匿名 API 60 次/小时且按出口 IP 计,共享代理出口配额常年打满 → 列表恒空。
  // 后端解析顺序 env → 手动填入(pat)→ gh 命令行登录态;这里只展示来源,令牌值永不回传前端。
  const [ghTokenSource, setGhTokenSource] = useState(null); // 'env' | 'pat' | 'gh' | null(未配置)
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMsg, setTokenMsg] = useState('');
  // CQ批次4:粘贴任意 GitHub 仓库导入。customRepo=输入框,activeRepo=已加载的自定义仓库(null=用内置源)。
  const [customRepo, setCustomRepo] = useState('');
  const [activeRepo, setActiveRepo] = useState(null);
  const [activeBranch, setActiveBranch] = useState('');   // #2 自定义仓库的指定分支('' = 默认分支)
  const [activeHost, setActiveHost] = useState('github'); // 自定义仓库所在 host:github | gitee
  const [sourcesMap, setSourcesMap] = useState({});       // #3 已装 skill 的来源 { id: {repo, branch} }
  const [sourcesReadError, setSourcesReadError] = useState(false); // 来源记录文件读取失败(≠ 没有记录)
  const [updateInfo, setUpdateInfo] = useState({});       // 检查更新结果 { id: {local, remote, hasUpdate} }
  const [checkingUpd, setCheckingUpd] = useState(false);

  const [busy, setBusy] = useState(() => new Set()); // 进行中的导入/更新集合:'all' | <skillId>(可并发,互不禁用)
  const busyAdd = (tag) => setBusy((p) => { const n = new Set(p); n.add(tag); return n; });
  const busyDel = (tag) => setBusy((p) => { if (!p.has(tag)) return p; const n = new Set(p); n.delete(tag); return n; });
  const [conflicts, setConflicts] = useState(null);
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState(null);     // 展开完整简介的行:'local:<id>' | 'off:<id>' | 'arch:<id>'

  const loadLocal = useCallback(async () => {
    setLoadingLocal(true);
    try { const d = await (await fetch('/api/skills')).json(); setLocal(d.skills || []); }
    catch { /* 忽略 */ }
    // #3 同时拉来源映射(哪些本机 skill 是从 GitHub 仓库导入的 → 显示"更新")
    try {
      const s = await (await fetch('/api/skills/sources-map')).json();
      setSourcesMap(s.sources || {}); setSourcesReadError(!!s.readError);
    } catch { /* 忽略 */ }
    setLoadingLocal(false);
  }, []);

  // 检查更新(手动触发):后端对有来源记录的技能拉源 SKILL.md 的 version 与本机比对,
  // 有更新的在更新按钮上亮角标,无更新显示"已是最新",缺版本号无法比对的不标。
  const checkUpdates = useCallback(async () => {
    setCheckingUpd(true); setNotice('');
    try {
      const d = await (await fetch('/api/skills/check-updates', { method: 'POST' })).json();
      const u = d.updates || {};
      setUpdateInfo(u);
      const vals = Object.values(u);
      const n = vals.filter((x) => x.hasUpdate === true).length;
      const unknown = vals.filter((x) => x.hasUpdate === null).length;
      setNotice(n
        ? `检查完成:${n} 个技能有新版本(更新按钮已标出)`
        : `检查完成:未发现新版本${unknown ? `(${unknown} 个未声明版本号,无法比对)` : ''}`);
    } catch (e) { setNotice('错误: ' + e.message); }
    setCheckingUpd(false);
  }, []);

  // #3 更新单个 skill:从记录的来源仓库+分支重拉覆盖。
  const updateSkill = useCallback(async (id) => {
    setManageBusy(id); setNotice('');
    try {
      const r = await fetch('/api/skills/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '更新失败');
      await loadLocal();
      // 已更新到最新 → 清掉该技能的"有新版本"标记
      setUpdateInfo((p) => { if (!(id in p)) return p; const n = { ...p }; delete n[id]; return n; });
      setManageBusy(null); // 更新已完成,先停 spinner 再弹窗(否则用户不点弹窗则按钮无限转)
      // 远端无变化(重下内容与旧的一致)→ 明确显示"无更新",不再误报"已更新为 vX"。
      await confirmDialog(
        d.changed === false
          ? `「${id}」已是最新,无更新\n(来源 ${d.repo}${d.branch ? '@' + d.branch : ''})`
          : d.version
            ? `「${id}」已更新为 v${d.version}\n(来源 ${d.repo}${d.branch ? '@' + d.branch : ''})`
            : `「${id}」已更新到最新\n(来源 ${d.repo}${d.branch ? '@' + d.branch : ''};该 skill 未声明版本号)`,
        { confirmText: '知道了' },
      );
    } catch (e) { setNotice('错误: ' + e.message); }
    setManageBusy(null);
  }, [loadLocal]);

  const loadArchived = useCallback(async () => {
    try { const d = await (await fetch('/api/skills/archived')).json(); setArchived(d.skills || []); }
    catch { /* 忽略 */ }
  }, []);

  // 归档 / 删除 / 恢复。删除需二次确认(不可逆,需重新下载)。
  const manageSkill = useCallback(async (action, id) => {
    if (action === 'delete') {
      const ok = await confirmDialog(`删除技能「${id}」?\n\n将永久移除 ~/.claude/skills/${id},需重新下载才能恢复。`, { danger: true, confirmText: '删除' });
      if (!ok) return false;
    }
    setManageBusy(id); setNotice('');
    let done = false;
    try {
      const r = await fetch(`/api/skills/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '操作失败');
      setNotice({ archive: `已归档「${id}」—— 已停用,可在「已归档」区恢复`, delete: `已删除「${id}」`, restore: `已恢复「${id}」` }[action]);
      await Promise.all([loadLocal(), loadArchived()]);
      done = true;
    } catch (e) { setNotice('错误: ' + e.message); }
    setManageBusy(null);
    return done;
  }, [loadLocal, loadArchived]);

  // 批量删除本机已装 skill:并发调各自 POST /skills/delete(纯后端,失败 throw),删完统一刷新。
  const delOne = (id) => fetch('/api/skills/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    .then(async (r) => { if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || '删除失败'); } });
  const onBatchDelete = async () => {
    const res = await ms.runDelete(delOne, { noun: '个技能', nameOf: (id) => local.find((s) => s.id === id)?.name || id });
    if (res) { setNotice(res.failed.length ? `已删 ${res.ok}/${res.total} 个,${res.failed.length} 个失败` : `已删除 ${res.ok} 个技能`); loadLocal(); loadArchived(); }
  };
  // 导入页批量删除:仅作用于该源/仓库里「已装」的技能(同一单删端点并发),删完刷新源列表+本机+归档。
  const onBatchDeleteImport = async () => {
    const res = await ms.runDelete(delOne, { noun: '个已装技能', nameOf: (id) => official.find((s) => s.id === id)?.name || id });
    if (res) {
      setNotice(res.failed.length ? `已删 ${res.ok}/${res.total} 个,${res.failed.length} 个失败` : `已删除 ${res.ok} 个技能`);
      await Promise.all([activeRepo ? loadOfficial(null, activeRepo, activeBranch, activeHost) : loadOfficial(source), loadLocal(), loadArchived()]);
    }
  };

  const loadOfficial = useCallback(async (srcId, repo, branch, host) => {
    setLoadingOff(true); setOffErr(''); setConflicts(null);
    try {
      const url = repo
        ? `/api/skills/official?repo=${encodeURIComponent(repo)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}${host && host !== 'github' ? `&host=${host}` : ''}`
        : `/api/skills/official?source=${encodeURIComponent(srcId)}`;
      const d = await (await fetch(url)).json();
      setOfficial(d.skills || []);
      setOfficialMeta({ count: d.count, repo: d.repo, branch: d.branch, truncatedDesc: d.truncatedDesc });
      if (d.error) setOffErr(d.error);
    } catch (e) { setOffErr(e.message); }
    setLoadingOff(false);
  }, []);

  // r67:GitHub 令牌状态/保存/清除。保存成功后重拉当前列表(限流报错的加载不会进后端缓存,重拉即带令牌生效)。
  const loadTokenStatus = useCallback(async () => {
    try { const d = await (await fetch('/api/skills/github-token')).json(); setGhTokenSource(d.source || null); } catch { /* 忽略 */ }
  }, []);
  const saveToken = async () => {
    const t = tokenInput.trim();
    if (!t || tokenBusy) return;
    setTokenBusy(true); setTokenMsg('');
    try {
      const r = await fetch('/api/skills/github-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '保存失败');
      setTokenInput(''); setTokenOpen(false);
      setGhTokenSource(d.source || 'pat');
      setNotice('GitHub 令牌已保存,仅存本机');
      if (activeRepo) loadOfficial(null, activeRepo, activeBranch, activeHost); else loadOfficial(source);
    } catch (e) { setTokenMsg(e.message); }
    setTokenBusy(false);
  };
  const clearToken = async () => {
    if (tokenBusy) return;
    setTokenBusy(true); setTokenMsg('');
    try {
      const r = await fetch('/api/skills/github-token', { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '清除失败');
      setGhTokenSource(d.source || null);
    } catch (e) { setTokenMsg(e.message); }
    setTokenBusy(false);
  };

  // 持久化仓库列表:加载、打开、删除。(声明在 loadCustomRepo 之前,避免依赖数组 TDZ)
  const loadSavedRepos = useCallback(async () => {
    try { const d = await (await fetch('/api/skills/repos')).json(); setSavedRepos(d.repos || []); } catch { /* 忽略 */ }
  }, []);
  const openSavedRepo = useCallback((r) => {
    const host = r.host || 'github';
    setActiveRepo(r.repo); setActiveBranch(r.branch || ''); setActiveHost(host); setCustomRepo('');
    loadOfficial(null, r.repo, r.branch || '', host);
  }, [loadOfficial]);
  const deleteSavedRepo = useCallback(async (r) => {
    try {
      await fetch('/api/skills/repos', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: r.repo, branch: r.branch || '', host: r.host || 'github' }),
      });
    } catch { /* 忽略 */ }
    await loadSavedRepos();
  }, [loadSavedRepos]);

  // 解析 owner/repo、owner/repo@branch、或 GitHub/Gitee 地址(含 /tree/<branch>)→ 加载该仓库/分支的 skill。
  const loadCustomRepo = useCallback(() => {
    const raw = customRepo.trim();
    // 识别 host:gitee.com → gitee,github.com 或裸 owner/repo → github。其它完整 URL(gitlab 等)明确拒,
    // 否则兜底 regex 会把 `xxx.com/owner` 误当 owner/repo 拿去请求得到误导性 404。
    let host = 'github';
    if (/(^|\/\/|\.)gitee\.com\//i.test(raw)) host = 'gitee';
    else if (/^https?:\/\//i.test(raw) && !/(^|\/\/|\.)github\.com\//i.test(raw)) {
      setOffErr('仅支持 GitHub 与 Gitee 仓库'); return;
    }
    const domain = host === 'gitee' ? 'gitee\\.com' : 'github\\.com';
    let repo = '', branch = '';
    let m = raw.match(new RegExp(`${domain}\\/([\\w.-]+\\/[\\w.-]+?)(?:\\.git)?\\/tree\\/([\\w./-]+?)\\/?$`, 'i')); // …/tree/<branch>
    if (m) { repo = m[1]; branch = m[2]; }
    else if ((m = raw.match(/^([\w.-]+\/[\w.-]+?)@([\w.\/-]+)$/))) { repo = m[1]; branch = m[2]; } // owner/repo@branch
    else if ((m = raw.match(new RegExp(`(?:${domain}\\/)?([\\w.-]+\\/[\\w.-]+?)(?:\\.git|\\/.*)?$`, 'i')))) { repo = m[1]; }
    if (!repo) { setOffErr('请输入 owner/repo、owner/repo@分支 或 GitHub/Gitee 仓库地址(可含 /tree/分支)'); return; }
    setActiveRepo(repo);
    setActiveBranch(branch);
    setActiveHost(host);
    loadOfficial(null, repo, branch, host).then(() => loadSavedRepos()); // 拉取成功后端已记住,刷新常驻列表
  }, [customRepo, loadOfficial, loadSavedRepos]);

  useEffect(() => { loadLocal(); loadArchived(); }, [loadLocal, loadArchived]);
  // 切 tab / 切源 / 切仓库复位多选:选中集是 id 集合,换列表后残留 id 会误删新列表外的技能。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { ms.exit(); }, [tab, source, activeRepo, activeBranch, activeHost]);
  useEffect(() => {
    fetch('/api/skills/sources').then((r) => r.json()).then((d) => setSources(d.sources || [])).catch(() => {});
    loadSavedRepos();
  }, [loadSavedRepos]);
  useEffect(() => { if (tab === 'import' && !activeRepo) loadOfficial(source); }, [tab, source, activeRepo, loadOfficial]);
  useEffect(() => { if (tab === 'import') loadTokenStatus(); }, [tab, loadTokenStatus]); // r67:进导入页才查令牌状态(后端有 5 分钟缓存)

  const runImport = async (ids, overwrite, tag, isUpdate = false) => {
    if (!ids.length) return;
    busyAdd(tag); setNotice('');
    try {
      const r = await fetch('/api/skills/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(activeRepo ? { repo: activeRepo, branch: activeBranch, host: activeHost, ids, overwrite } : { source, ids, overwrite }),
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
        busyDel(tag); // 先停 spinner 再弹窗(否则用户不点弹窗则按钮无限转)
        const names = (d.imported || []).map((x) => (typeof x === 'string' ? x : x.id || x.name)).filter(Boolean);
        // 失败详情:后端 failed[] 每项带 error,弹窗逐条列出(最多 5 条防长列表,超出计数说明)。
        const failDetail = d.failed?.length
          ? `\n\n失败详情:\n${d.failed.slice(0, 5).map((f) => `· ${f.id}:${f.error || '未知错误'}`).join('\n')}${d.failed.length > 5 ? `\n· …及其余 ${d.failed.length - 5} 个(略)` : ''}`
          : '';
        // 坏元数据说明:装入成功但 SKILL.md 未解析到名称(列表以目录名显示并打「元数据缺失」标)。
        const badMetaNote = d.badMeta?.length
          ? `\n\n注意:「${d.badMeta.slice(0, 5).join('、')}${d.badMeta.length > 5 ? ` 等 ${d.badMeta.length} 个` : ''}」的 SKILL.md 未解析到名称(frontmatter 缺失或格式有误),已按目录名装入`
          : '';
        // 与技能更新/插件操作一致:导入/更新成功弹窗(此前仅面板内小字,面板外看不到)。
        // 更新覆盖路径(已装·可更新覆盖)一律弹,给"已更新覆盖"专属文案,不再误报"已导入"。
        if (isUpdate) {
          await confirmDialog(
            d.imported?.length
              ? `已用最新版本覆盖技能「${names.join('、') || ids.join('、')}」${badMetaNote}`
              : (d.failed?.length ? `更新失败:${(d.failed[0]?.error) || '未知错误'}` : `「${ids.join('、')}」无变化`),
            { confirmText: '知道了' },
          );
        } else if (d.imported?.length) {
          await confirmDialog(
            `已导入 ${d.imported.length} 个技能${d.failed?.length ? `,${d.failed.length} 个失败` : ''}${names.length ? `\n(${names.slice(0, 8).join('、')})` : ''}`
              + `\n\n在输入框输入 /技能名 即可调用(如 /${names[0] || ids[0]})${failDetail}${badMetaNote}`,
            { confirmText: '知道了' },
          );
        } else if (d.failed?.length) {
          // 全部失败:此前只有面板小字"失败 N",不给原因;弹窗逐条列出 id+error。
          await confirmDialog(`导入失败 ${d.failed.length} 个技能${failDetail}`, { confirmText: '知道了' });
        }
      }
      await Promise.all([activeRepo ? loadOfficial(null, activeRepo, activeBranch, activeHost) : loadOfficial(source), loadLocal()]);
    } catch (e) { setNotice('错误: ' + e.message); }
    busyDel(tag);
  };

  const notInstalled = official.filter((s) => !s.installed);
  const installedIds = official.filter((s) => s.installed).map((s) => s.id); // 导入页多选/全选的可选集
  const hasSources = Object.keys(sourcesMap).length > 0; // 有来源记录 = 能比对更新
  // CM-1:本机 skill 按关键词过滤(名称 + 描述,大小写不敏感)。
  // 检查更新后把"有新版本"的置顶(stable sort,组内保持原序),免得用户逐条翻找。
  const filteredLocal = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q ? local.filter((s) => `${s.id} ${s.name} ${s.description}`.toLowerCase().includes(q)) : local;
    if (Object.values(updateInfo).some((u) => u?.hasUpdate)) {
      list = [...list].sort((a, b) => (updateInfo[b.id]?.hasUpdate ? 1 : 0) - (updateInfo[a.id]?.hasUpdate ? 1 : 0));
    }
    return list;
  }, [local, query, updateInfo]);
  const tabBtn = (id, label, count) => (
    <button onClick={() => setTab(id)}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body rounded-lg transition-colors ${
        tab === id ? 'bg-accent text-on-accent' : 'text-ink-muted hover:text-ink hover:bg-canvas-deep'}`}>
      {label}{typeof count === 'number' && <span className="font-mono opacity-70">{count}</span>}
    </button>
  );

  return (
    <div className="px-4 py-4 space-y-4 overflow-y-auto h-full">
      <div className="flex items-center gap-1.5">
        {tabBtn('local', '本机 Skill', local.length)}
        {tabBtn('import', '导入', null)}
        {tabBtn('archived', '已归档', archived.length)}
        <div className="ml-auto flex items-center gap-1">
          {((tab === 'local' && local.length > 0) || (tab === 'import' && installedIds.length > 0)) &&
            <SelModeToggle selMode={ms.selMode} onToggle={() => (ms.selMode ? ms.exit() : ms.enter())} size={13} />}
          <button onClick={tab === 'local' ? loadLocal : tab === 'archived' ? loadArchived : () => (activeRepo ? loadOfficial(null, activeRepo, activeBranch, activeHost) : loadOfficial(source))} disabled={loadingLocal || loadingOff}
            className="p-1.5 text-ink-faint hover:text-ink rounded disabled:opacity-40" title="刷新">
            <RefreshCw size={13} className={(loadingLocal || loadingOff) ? 'animate-spin' : ''} />
          </button>
        </div>
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
          {/* 手动检查更新:仅对有来源记录(从 GitHub/Gitee 导入)的技能有效,不自动轮询。
              无来源记录时按钮置灰而非隐藏 —— 隐藏会让用户以为本机根本没有"检查更新"这个功能,
              title 说明为什么不可用(以及来源记录读取失败这一种故障)。 */}
          <button onClick={checkUpdates} disabled={checkingUpd || !!manageBusy || !hasSources}
            title={hasSources ? undefined : (sourcesReadError
              ? '来源记录文件读取失败,当前无法比对更新。'
              : '仅通过导入页安装的技能有来源记录,可比对更新。手动安装或同步的技能无来源记录。')}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-body rounded-md border border-canvas-deep text-ink-muted hover:text-ink hover:bg-canvas-deep transition-colors disabled:opacity-50">
            {checkingUpd ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            检查更新(比对来源仓库的版本号)
          </button>
          {notice && <div className="text-[11px] text-ink-soft bg-canvas-deep/60 border border-canvas-deep rounded px-2 py-1.5">{notice}</div>}
          {ms.selMode && <BatchBar count={ms.count} busy={ms.busy} onDelete={onBatchDelete} onExit={ms.exit} noun="个技能"
            allIds={filteredLocal.map((s) => s.id)} onSetAll={ms.setAll} selectedSet={ms.selected} />}
          {filteredLocal.length > 0 ? (
            <div className="space-y-2">
              {filteredLocal.map((s) => (
                <div key={s.id} onClick={() => (ms.selMode ? ms.toggle(s.id) : setExpanded((p) => p === `local:${s.id}` ? null : `local:${s.id}`))}
                  className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 cursor-pointer" title="点击展开/收起完整简介">
                  <div className="flex items-center gap-2">
                    {ms.selMode && <SelCheckbox checked={ms.selected.has(s.id)} onClick={() => ms.toggle(s.id)} />}
                    <span className="text-xs font-medium font-body text-ink truncate flex-1" title={s.id}>{s.name}</span>
                    {s.metaMissing && (
                      <span className="shrink-0 text-[9px] px-1 py-px bg-amber-500/10 text-amber-600 border border-amber-500/30 rounded font-body"
                        title="SKILL.md 缺失或 frontmatter 未解析到名称,当前以目录名显示;claude 可能无法正确识别该技能">
                        元数据缺失
                      </span>
                    )}
                    {s.version && <span className="shrink-0 text-[10px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono">v{s.version}</span>}
                    <SkillCopyBtn name={s.id} />
                    {sourcesMap[s.id]?.repo && (() => {
                      const u = updateInfo[s.id]; // 检查更新结果:true=有新版本(亮角标) false=已是最新 null/无=未比对
                      return (
                        <>
                          {u?.hasUpdate === false && <span className="shrink-0 text-[9px] text-ink-faint font-body">已是最新</span>}
                          <button onClick={(e) => { e.stopPropagation(); updateSkill(s.id); }} disabled={!!manageBusy}
                            title={u?.hasUpdate
                              ? `有新版本 v${u.remote}(本机 v${u.local})—— 点击从 ${sourcesMap[s.id].repo} 更新`
                              : `从来源更新 —— ${sourcesMap[s.id].repo}${sourcesMap[s.id].branch ? '@' + sourcesMap[s.id].branch : ''},覆盖本机旧版本`}
                            className={`relative shrink-0 p-1 rounded hover:bg-accent/10 disabled:opacity-50 ${u?.hasUpdate ? 'text-accent' : 'text-ink-faint hover:text-accent'}`}>
                            {manageBusy === s.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                            {u?.hasUpdate === true && <span className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-accent" />}
                          </button>
                        </>
                      );
                    })()}
                    {!ms.selMode && (<>
                    <button onClick={(e) => { e.stopPropagation(); manageSkill('archive', s.id); }} disabled={!!manageBusy}
                      title="归档 —— 移出加载目录停用,可在「已归档」恢复"
                      className="shrink-0 p-1 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep disabled:opacity-50">
                      {manageBusy === s.id ? <Loader2 size={12} className="animate-spin" /> : <Archive size={12} />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); manageSkill('delete', s.id); }} disabled={!!manageBusy}
                      title="删除 —— 永久移除,需重新下载"
                      className="shrink-0 p-1 rounded text-ink-faint hover:text-error hover:bg-error/10 disabled:opacity-50">
                      <Trash2 size={12} />
                    </button>
                    </>)}
                  </div>
                  {s.description && <div className={`text-[11px] text-ink-muted font-body mt-1 ${expanded === `local:${s.id}` ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{s.description}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-ink-faint font-body py-6 text-center bg-canvas-warm border border-canvas-deep rounded-lg space-y-3">
              <div>{loadingLocal ? '加载中…' : query.trim() ? `没有匹配「${query.trim()}」的技能` : '~/.claude/skills 下没有 skill'}</div>
              {/* 空态 CTA:直接进「导入」页从市场装,不让用户面对死胡同 */}
              {!loadingLocal && !query.trim() && (
                <button onClick={() => setTab('import')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-on-accent text-[12px] font-medium hover:bg-accent/90 transition-colors">
                  <CloudDownload size={13} />从市场导入技能
                </button>
              )}
            </div>
          )}
        </>
      ) : tab === 'archived' ? (
        <>
          {notice && <div className="text-[11px] text-ink-soft bg-canvas-deep/60 border border-canvas-deep rounded px-2 py-1.5">{notice}</div>}
          <div className="text-[10px] text-ink-faint font-body">归档的技能已移出加载目录,claude 不再使用;恢复后重新生效。</div>
          {archived.length > 0 ? (
            <div className="space-y-2">
              {archived.map((s) => (
                <div key={s.id} onClick={() => setExpanded((p) => p === `arch:${s.id}` ? null : `arch:${s.id}`)}
                  className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 cursor-pointer" title="点击展开/收起完整简介">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium font-body text-ink-muted truncate flex-1" title={s.id}>{s.name}</span>
                    <button onClick={(e) => { e.stopPropagation(); manageSkill('restore', s.id); }} disabled={!!manageBusy}
                      className="shrink-0 text-[10px] px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 flex items-center gap-1 disabled:opacity-50">
                      {manageBusy === s.id ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}恢复
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); manageSkill('delete', s.id); }} disabled={!!manageBusy}
                      title="彻底删除归档"
                      className="shrink-0 p-1 rounded text-ink-faint hover:text-error hover:bg-error/10 disabled:opacity-50">
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {s.description && <div className={`text-[11px] text-ink-muted font-body mt-1 ${expanded === `arch:${s.id}` ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{s.description}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-ink-faint font-body py-6 text-center bg-canvas-warm border border-canvas-deep rounded-lg">没有已归档的技能</div>
          )}
        </>
      ) : (
        <>
          {/* 源选择(内置源点了即清掉自定义仓库,回到内置源模式) */}
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s) => (
              <button key={s.id} onClick={() => { setActiveRepo(null); setActiveBranch(''); setCustomRepo(''); setSource(s.id); }}
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
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing && e.keyCode !== 229) { e.preventDefault(); loadCustomRepo(); } }}
              placeholder="owner/repo、@分支、或 GitHub/Gitee 仓库地址(含 /tree/分支)"
              className="flex-1 min-w-0 bg-canvas border border-canvas-deep rounded-md px-2 py-1 text-[11px] text-ink placeholder-ink-ghost focus:outline-none focus:border-accent/40 font-mono" />
            <button onClick={loadCustomRepo} disabled={loadingOff || !customRepo.trim()}
              className="shrink-0 px-2.5 py-1 rounded-md bg-accent text-on-accent text-[11px] font-body hover:bg-accent-hover disabled:opacity-50">
              拉取仓库
            </button>
          </div>
          {/* 导入过的仓库常驻列表(持久化):点仓库名重进,× 从列表删除(不影响已装 skill) */}
          {savedRepos.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {savedRepos.map((r) => {
                const rhost = r.host || 'github';
                const label = `${r.repo}${r.branch ? '@' + r.branch : ''}`;
                const active = activeRepo === r.repo && (activeBranch || '') === (r.branch || '') && activeHost === rhost;
                return (
                  <span key={`${rhost}:${label}`}
                    className={`inline-flex items-center gap-1 pl-2 pr-1 py-1 text-[11px] font-mono rounded-md border transition-colors ${
                      active ? 'border-accent text-accent bg-accent/10' : 'border-canvas-deep text-ink-muted'}`}>
                    {rhost === 'gitee' && <span className="text-[9px] px-1 rounded bg-red-500/15 text-red-500 shrink-0">Gitee</span>}
                    <button onClick={() => openSavedRepo(r)} className="hover:text-accent max-w-[180px] truncate" title={`打开 ${rhost === 'gitee' ? 'Gitee: ' : ''}${label}`}>{label}</button>
                    <button onClick={() => deleteSavedRepo(r)} title="从列表删除(不删已装 skill)"
                      className="p-0.5 rounded text-ink-faint hover:text-error hover:bg-error/10"><X size={11} /></button>
                  </span>
                );
              })}
            </div>
          )}
          {activeRepo ? (
            <div className="flex items-center gap-2 text-[10px] text-ink-faint font-mono">
              <span className="text-accent">{activeHost === 'gitee' ? 'Gitee ' : ''}仓库:{activeRepo}{(officialMeta.branch || activeBranch) ? `@${officialMeta.branch || activeBranch}` : ''}</span>
              <button onClick={() => { setActiveRepo(null); setActiveBranch(''); setActiveHost('github'); setCustomRepo(''); }} className="text-ink-faint hover:text-ink underline">返回内置源</button>
            </div>
          ) : sources.find((s) => s.id === source)?.url && (
            <a href={sources.find((s) => s.id === source).url} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-ink-faint hover:text-accent font-mono">
              <ExternalLink size={10} />{officialMeta.repo || sources.find((s) => s.id === source).url}
            </a>
          )}

          {/* r67:GitHub 令牌一行状态 + 按需展开输入。填入后 GitHub 接口配额 60 次/小时/IP → 5000 次/小时/令牌。 */}
          <div className="text-[10px] text-ink-faint font-body flex items-center gap-1.5 flex-wrap">
            <span>
              GitHub 令牌:{ghTokenSource
                ? ({ env: '已配置(环境变量)', pat: '已配置(手动填入)', gh: '已配置(自动使用 gh 命令行登录态)' }[ghTokenSource] || '已配置')
                : '未配置(匿名接口限 60 次/小时,按出口 IP 计,共享代理易被打满)'}
            </span>
            {ghTokenSource === 'pat' ? (
              <button onClick={clearToken} disabled={tokenBusy} className="underline hover:text-error disabled:opacity-50">清除</button>
            ) : (
              <button onClick={() => { setTokenOpen((v) => !v); setTokenMsg(''); }} className="underline hover:text-accent">
                {tokenOpen ? '收起' : '填入令牌'}
              </button>
            )}
            {tokenMsg && !tokenOpen && <span className="text-error">{tokenMsg}</span>}
          </div>
          {tokenOpen && ghTokenSource !== 'pat' && (
            <div className="space-y-1">
              <div className="flex gap-1.5">
                <input
                  type="password" value={tokenInput} autoComplete="off"
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing) { e.preventDefault(); saveToken(); } }}
                  placeholder="粘贴 GitHub 令牌(仅需 public_repo 读权限)"
                  className="flex-1 min-w-0 bg-canvas border border-canvas-deep rounded-md px-2 py-1 text-[11px] text-ink placeholder-ink-ghost focus:outline-none focus:border-accent/40 font-mono" />
                <button onClick={saveToken} disabled={tokenBusy || !tokenInput.trim()}
                  className="shrink-0 px-2.5 py-1 rounded-md bg-accent text-on-accent text-[11px] font-body hover:bg-accent-hover disabled:opacity-50">
                  {tokenBusy ? '验证中…' : '保存'}
                </button>
              </div>
              <div className="text-[10px] text-ink-faint font-body">令牌在 github.com → Settings → Developer settings → Personal access tokens 生成,仅保存在本机配置目录;若本机已安装并登录 gh 命令行工具则无需填写。</div>
              {tokenMsg && <div className="text-[10px] text-error font-body">{tokenMsg}</div>}
            </div>
          )}
          {offErr && <div className="text-[11px] text-error bg-error/10 border border-error/20 rounded px-2 py-1.5 break-all">{offErr}</div>}
          {notice && <div className="text-[11px] text-ink-soft bg-canvas-deep/60 border border-canvas-deep rounded px-2 py-1.5">{notice}</div>}
          {/* 批量删除该源里已装的技能:未装项不可选(没有可删的东西) */}
          {ms.selMode && <BatchBar count={ms.count} busy={ms.busy} onDelete={onBatchDeleteImport} onExit={ms.exit} noun="个已装技能"
            allIds={installedIds} onSetAll={ms.setAll} selectedSet={ms.selected} />}
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
                <button onClick={() => runImport(conflicts, true, 'all')} disabled={busy.has('all')}
                  className="px-2.5 py-1 rounded text-[11px] font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 flex items-center gap-1">
                  {busy.has('all') && <Loader2 size={11} className="animate-spin" />}覆盖
                </button>
              </div>
            </div>
          )}

          <button onClick={() => runImport(notInstalled.map((s) => s.id), false, 'all')}
            disabled={loadingOff || busy.size > 0 || notInstalled.length === 0 || ms.selMode}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-on-accent text-[12px] font-medium hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {busy.has('all') ? <Loader2 size={13} className="animate-spin" /> : <CloudDownload size={13} />}
            {loadingOff ? '加载中…' : notInstalled.length === 0 ? '此源已全部安装' : `一键导入全部(${notInstalled.length})`}
          </button>

          {loadingOff ? (
            <div className="text-xs text-ink-faint font-body py-6 text-center flex items-center justify-center gap-2"><Loader2 size={14} className="animate-spin" />加载…</div>
          ) : (
            <div className="space-y-2">
              {official.map((s) => (
                <div key={s.id} onClick={() => (ms.selMode ? (s.installed && ms.toggle(s.id)) : setExpanded((p) => p === `off:${s.id}` ? null : `off:${s.id}`))}
                  className={`bg-canvas-warm border border-canvas-deep rounded-lg p-3 cursor-pointer ${ms.selMode && !s.installed ? 'opacity-40' : ''}`}
                  title={ms.selMode ? (s.installed ? '点击勾选' : '未安装,无可删除') : '点击展开/收起完整简介'}>
                  <div className="flex items-center gap-2">
                    {ms.selMode && s.installed && <SelCheckbox checked={ms.selected.has(s.id)} onClick={() => ms.toggle(s.id)} />}
                    <span className="text-xs font-medium font-body text-ink truncate flex-1" title={s.id}>{s.name}</span>
                    {s.version && <span className="shrink-0 text-[10px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono">v{s.version}</span>}
                    <SkillCopyBtn name={s.id} />
                    {ms.selMode ? null : s.installed ? (
                      <>
                      <button onClick={(e) => { e.stopPropagation(); runImport([s.id], true, s.id, true); }} disabled={busy.has(s.id) || busy.has('all')}
                        className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-canvas-deep text-ink-faint hover:text-ink hover:bg-canvas-deep flex items-center gap-1 disabled:opacity-50" title="已安装 — 点击用该源最新版本覆盖">
                        {busy.has(s.id) ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} className="text-success" />}已装·可更新覆盖
                      </button>
                      <button onClick={async (e) => {
                          e.stopPropagation();
                          if (await manageSkill('delete', s.id)) { activeRepo ? loadOfficial(null, activeRepo, activeBranch, activeHost) : loadOfficial(source); }
                        }} disabled={!!manageBusy || busy.has(s.id) || busy.has('all')}
                        className="shrink-0 p-1 rounded text-ink-faint hover:text-error hover:bg-canvas-deep disabled:opacity-50" title="删除本机已装的该技能(永久移除,需重新下载)">
                        {manageBusy === s.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                      </button>
                      </>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); runImport([s.id], false, s.id); }} disabled={busy.has(s.id) || busy.has('all')}
                        className="shrink-0 text-[10px] px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 flex items-center gap-1 disabled:opacity-50">
                        {busy.has(s.id) ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}导入
                      </button>
                    )}
                  </div>
                  {s.description && <div className={`text-[11px] text-ink-muted font-body mt-1 ${expanded === `off:${s.id}` ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{s.description}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
