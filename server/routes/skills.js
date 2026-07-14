// CK-4: Skill 市场(多源)。
//   GET  /api/skills              本机 ~/.claude/skills 已安装
//   GET  /api/skills/sources      可导入的源仓库列表
//   GET  /api/skills/official?source=<id>   某源仓库的 skill 列表(缓存 1h)
//   POST /api/skills/import       { source, ids, overwrite } 下载导入;重名跳过/覆盖
//
// 通用 SKILL.md 定位:任意仓库里 `<id>/SKILL.md`、`skills/<id>/SKILL.md`、
// `my-skills/<id>/SKILL.md` 都算一个 skill(id = SKILL.md 的父目录),兼容四个源。
import { Router } from 'express';
import { readdir, readFile, mkdir, writeFile, stat, rm, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const router = Router();
const SKILLS_DIR = join(homedir(), '.claude', 'skills');
// 归档区:与 skills 同父目录(claude 不扫这里→技能停用)。归档=移进来,恢复=移回去。
const ARCHIVE_DIR = join(homedir(), '.claude', 'skills-archive');
// 导入下载的临时目录:放在 ~/.claude 下但**不在 skills/ 内**——claude CLI 只扫 ~/.claude/skills,
// 之前放 skills 内(`.<id>.tmp`)虽躲过 GUI 的 scanLocalSkills,但下载那几秒 claude 本体会把
// 临时目录当成 skill 加载(用户会话冒出 `.xxx.tmp-...` 假 skill)。移出 skills/ 根治;仍在
// ~/.claude 同一文件系统,rename 到 skills/<id> 保持原子。
const IMPORT_TMP_DIR = join(homedir(), '.claude', '.cgui-skill-tmp');
// 启动时清空导入临时目录:它定义上只在单次导入期间存在,进程崩溃/被杀会遗留半成品目录,
// 无其它清理时机 → 长期堆垃圾。fire-and-forget,失败无所谓(下次导入照常)。
rm(IMPORT_TMP_DIR, { recursive: true, force: true }).catch(() => {});
// 排除纯点名(`.`/`..`):否则 join(SKILLS_DIR, '..') = ~/.claude,delete/archive 端点会 rm 掉整个配置目录。
const ID_RE = /^(?!\.+$)[a-zA-Z0-9._-]+$/;
const GH_HEADERS = { 'User-Agent': 'claude-gui-skills', 'Accept': 'application/vnd.github+json' };
const DESC_CAP = 30; // skill 数 ≤ 此值才逐个抓描述(大仓如 Composio 只列名,免打爆网络)

const SOURCES = [
  { id: 'anthropic', name: 'Anthropic 官方', repo: 'anthropics/skills', url: 'https://github.com/anthropics/skills' },
  { id: 'superpowers', name: 'Superpowers', repo: 'obra/superpowers', url: 'https://github.com/obra/superpowers' },
  { id: 'composio', name: '开源社区 (Composio)', repo: 'ComposioHQ/awesome-claude-skills', url: 'https://github.com/ComposioHQ/awesome-claude-skills' },
  // 调研新增(2026-07):vercel/garden 为标准 skills/<id>/ 布局;hermes 的 optional-skills
  // 是两层嵌套,靠 locateSkills 放宽后的任意深度匹配吃到全量。OpenClaw/ClawHub 的市场
  // 是运行时注册表 API 非 GitHub raw,与 loadRepo 模型不符,不接。
  { id: 'vercel', name: 'Vercel (skills.sh)', repo: 'vercel-labs/agent-skills', url: 'https://github.com/vercel-labs/agent-skills' },
  { id: 'hermes', name: 'Hermes (Nous)', repo: 'NousResearch/hermes-agent', url: 'https://github.com/NousResearch/hermes-agent' },
  { id: 'garden', name: 'Garden Skills', repo: 'ConardLi/garden-skills', url: 'https://github.com/ConardLi/garden-skills' },
];

// 先 trim 再剥引号:CRLF 文件行尾是 `"1.0"\r`,若先剥引号则 `["']$` 因 \r 在末尾不命中、只剥前引号。
const cleanVal = (s) => s.trim().replace(/^["']|["']$/g, '');
function parseFrontmatter(content) {
  const out = { name: null, description: null, version: null };
  if (!content || content.slice(0, 3) !== '---') return out;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return out;
  let inMetadata = false; // 仅 metadata: 块内的缩进 version 才算版本(见下)
  // 先去掉所有 \r 再切:CRLF 文件行尾 \r 会让 `.` 不匹配、`$` 不在 \r 前命中 → 顶层 name/version
  // 全解析不到;且闭合围栏 \r\n--- 的 \r 会残留在最后一行末尾(单纯 /\r?\n/ 切不掉它)。
  for (const line of content.slice(3, end).replace(/\r/g, '').split('\n')) {
    const m = line.match(/^(name|description|version):\s*(.*)$/);
    if (m) { out[m[1]] = cleanVal(m[2]); inMetadata = false; continue; }
    const topKey = line.match(/^([A-Za-z_][\w-]*):\s*/); // 顶格 key = 退出 metadata 块
    if (topKey) { inMetadata = topKey[1] === 'metadata'; continue; }
    // Anthropic 官方 skill 把版本嵌在 metadata: 下的缩进 version:;限定块内匹配,
    // 否则 description 折行文本/dependencies 块里的 "version:" 会被误当版本号。
    if (inMetadata && !out.version) {
      const mv = line.match(/^\s+version:\s*(.*)$/);
      if (mv) out.version = cleanVal(mv[1]);
    }
  }
  return out;
}

async function readSkillMd(dir) {
  for (const fn of ['SKILL.md', 'skill.md']) {
    try { return await readFile(join(dir, fn), 'utf-8'); } catch { /* next */ }
  }
  return null;
}

// ── 本机已安装 ────────────────────────────────────────────────────
// CN-1:每次扫 readdir + 逐个读 SKILL.md(上百个技能=上百次文件读),频繁打开面板偏慢。
// 加缓存:按 skills 目录 mtime(增删技能会变)+ 60s TTL(兜底 SKILL.md 内容编辑)。命中即秒返。
let localCache = null; // { mtimeMs, at, skills }
const LOCAL_TTL = 60 * 1000;
async function scanLocalSkills() {
  let entries;
  try { entries = await readdir(SKILLS_DIR, { withFileTypes: true }); } catch { return []; }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'));
  const skills = (await Promise.all(dirs.map(async (e) => {
    const md = await readSkillMd(join(SKILLS_DIR, e.name));
    // 官方约定:技能=目录内含 SKILL.md。无 SKILL.md 的目录(如 8 个技能共用的 _shared 门禁基建、
    // 或用户误建的普通目录)不是技能,直接跳过不列——否则用户会把它当废技能误删,搞坏基建。
    if (!md) return null;
    const fm = parseFrontmatter(md);
    // metaMissing:有 SKILL.md 但 frontmatter 未解析到 name(坏元数据,仍列但打标提示)
    return { id: e.name, name: fm.name || e.name, description: fm.description || '', version: fm.version || null, metaMissing: !fm.name };
  }))).filter(Boolean);
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}
router.get('/skills', async (req, res) => {
  try {
    // CL-1: 与 /api/slash-commands 一致地枚举(列所有子目录,有 SKILL.md 读描述、没有用目录名),
    // 否则"slash 能用、市场扫不到"。
    let mtimeMs = 0;
    try { mtimeMs = (await stat(SKILLS_DIR)).mtimeMs; } catch { return res.json({ skills: [] }); }
    const now = Date.now();
    if (localCache && localCache.mtimeMs === mtimeMs && now - localCache.at < LOCAL_TTL) {
      return res.json({ skills: localCache.skills, cached: true });
    }
    const skills = await scanLocalSkills();
    localCache = { mtimeMs, at: now, skills };
    res.json({ skills });
  } catch (e) {
    res.json({ skills: [], error: e.message });
  }
});

// ── 已归档技能(移出 skills 目录=停用,可恢复)────────────────────
router.get('/skills/archived', async (req, res) => {
  try {
    let entries;
    try { entries = await readdir(ARCHIVE_DIR, { withFileTypes: true }); } catch { return res.json({ skills: [] }); }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'));
    const skills = await Promise.all(dirs.map(async (e) => {
      const fm = parseFrontmatter(await readSkillMd(join(ARCHIVE_DIR, e.name)) || '');
      return { id: e.name, name: fm.name || e.name, description: fm.description || '' };
    }));
    skills.sort((a, b) => a.id.localeCompare(b.id));
    res.json({ skills });
  } catch (e) { res.json({ skills: [], error: e.message }); }
});

// 删除(永久,需重新下载才能恢复)。本机与归档区同名一并清除。
router.post('/skills/delete', async (req, res) => {
  const id = String(req.body?.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: '非法 skill id' });
  try {
    await rm(join(SKILLS_DIR, id), { recursive: true, force: true });
    await rm(join(ARCHIVE_DIR, id), { recursive: true, force: true });
    await forgetSource(id).catch(() => {}); // 清来源:删掉后若用户手写同名技能,不该再被"更新"覆盖
    localCache = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 归档(移到 skills-archive,claude 不再加载,可恢复)
router.post('/skills/archive', async (req, res) => {
  const id = String(req.body?.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: '非法 skill id' });
  try {
    await mkdir(ARCHIVE_DIR, { recursive: true });
    const dest = join(ARCHIVE_DIR, id);
    try { await rm(dest, { recursive: true, force: true }); } catch { /* 覆盖旧同名归档 */ }
    await rename(join(SKILLS_DIR, id), dest);
    localCache = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 恢复(从归档移回 skills)。本机已有同名则拒绝,避免覆盖用户当前版本。
router.post('/skills/restore', async (req, res) => {
  const id = String(req.body?.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: '非法 skill id' });
  try {
    const dest = join(SKILLS_DIR, id);
    try { if ((await stat(dest)).isDirectory()) return res.status(409).json({ error: '本机已存在同名 skill,请先处理' }); } catch { /* 不存在=可恢复 */ }
    await mkdir(SKILLS_DIR, { recursive: true });
    await rename(join(ARCHIVE_DIR, id), dest);
    localCache = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/skills/sources', (req, res) => {
  res.json({ sources: SOURCES.map((s) => ({ id: s.id, name: s.name, url: s.url })) });
});

// ── 源仓库 skill 列表(逐仓库缓存)────────────────────────────────
const repoCache = new Map(); // repo -> { skills, files, branch, at }
const TTL = 60 * 60 * 1000;

// 多 host 适配。Gitee 的 git/trees recursive API 与 GitHub 同构(返回 { tree:[{path,type}] }),
// 只是 base URL 与 raw URL 不同;GitLab 的 tree 分页、shape 不同,暂不支持。host 缺省 github(向后兼容)。
const HOSTS = {
  github: {
    label: 'GitHub', domain: 'github.com',
    api: (repo) => `https://api.github.com/repos/${repo}`,
    tree: (repo, branch) => `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    raw: (repo, branch, path) => `https://raw.githubusercontent.com/${repo}/${branch}/${path}`,
    rateHint: 'GitHub API 限流(60次/小时/IP),请稍后重试或挂代理',
  },
  gitee: {
    label: 'Gitee', domain: 'gitee.com',
    api: (repo) => `https://gitee.com/api/v5/repos/${repo}`,
    tree: (repo, branch) => `https://gitee.com/api/v5/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    raw: (repo, branch, path) => `https://gitee.com/${repo}/raw/${branch}/${path}`,
    rateHint: 'Gitee API 限流,请稍后重试',
  },
};
const hostOf = (h) => HOSTS[h] || HOSTS.github;

// CL-1: 取 host JSON 的健壮封装。网络受限/被拦截时可能返回 HTML 拦截页,直接 r.json() 会抛
// "Unexpected token '<'"(用户报告)。先验 r.ok + content-type,非 JSON 给可读错误而非裸 parse 报错。
async function ghJson(url, hostLabel = 'GitHub') {
  let r;
  try { r = await fetch(url, { headers: GH_HEADERS }); }
  catch (e) { const err = new Error(`无法连接 ${hostLabel}(网络受限?可尝试代理):${e.message}`); err.status = 0; throw err; }
  if (!r.ok) { const e = new Error(`${hostLabel} API ${r.status}`); e.status = r.status; throw e; }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    const e = new Error(`${hostLabel} 未返回 JSON(可能被网络拦截或需代理)`); e.status = 502; throw e;
  }
  return r.json();
}

async function ghDefaultBranch(repo, host = 'github') {
  const h = hostOf(host);
  return (await ghJson(h.api(repo), h.label)).default_branch || 'main';
}

// 从 tree 路径抽 skill。返回 [{ id, root }],root = SKILL.md 父目录的仓库内路径。
// 匹配任意深度(原来只认根层/skills 单层,吃不到 hermes 的 optional-skills/分类/<id>/
// 与 buildwithclaude 的 plugins/*/skills/<id>/ 这类嵌套布局);id = 父目录名,同名冲突
// 先见先得(浅层路径在 git tree 里先出现,官方 skills/ 优先于深层同名)。
function locateSkills(tree) {
  const seen = new Set();
  const out = [];
  for (const t of tree) {
    if (t.type !== 'blob') continue;
    const m = t.path.match(/^(?:(.*)\/)?([^/]+)\/SKILL\.md$/i);
    if (!m) continue;
    // node_modules / 隐藏目录(.agents 等站点自用)不算市场内容
    if (m[1] && /(^|\/)(node_modules|\.[^/]+)(\/|$)/.test(m[1])) continue;
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, root: t.path.replace(/\/SKILL\.md$/i, '') });
  }
  return out;
}

async function loadRepo(repo, branchArg, force = false, host = 'github') {
  // branchArg 指定分支(用户在导入页给了 owner/repo/tree/<branch> 或 owner/repo@branch);
  // 不给则用默认分支。缓存键含 host+分支,否则同仓不同分支/不同 host 互相污染(用户实报:只拉到 main)。
  const h = hostOf(host);
  const branch = (branchArg && String(branchArg).trim()) || await ghDefaultBranch(repo, host);
  const cacheKey = `${host}:${repo}@${branch}`;
  const now = Date.now();
  const c = repoCache.get(cacheKey);
  // force 时绕过缓存:更新按钮必须拿最新 tree,否则 1 小时缓存窗口内清单是旧快照——上游新增的文件
  // 不在清单里(装出残缺技能),上游已删的文件 raw 404(整个更新失败)。清单与 raw 内容必须同快照。
  if (!force && c && now - c.at < TTL) return c;
  const tree = (await ghJson(h.tree(repo, branch), h.label)).tree || [];
  const located = locateSkills(tree);
  located.sort((a, b) => a.id.localeCompare(b.id));
  // 仅小仓库逐个抓描述,大仓只列名
  let skills;
  if (located.length <= DESC_CAP) {
    skills = await Promise.all(located.map(async (s) => {
      let name = s.id, description = '', version = null;
      try {
        const raw = await fetch(h.raw(repo, branch, `${s.root}/SKILL.md`));
        if (raw.ok) { const fm = parseFrontmatter(await raw.text()); name = fm.name || s.id; description = fm.description || ''; version = fm.version || null; }
      } catch { /* 留空 */ }
      return { id: s.id, name, description, version, root: s.root };
    }));
  } else {
    skills = located.map((s) => ({ id: s.id, name: s.id, description: '', version: null, root: s.root }));
  }
  const entry = { skills, files: tree.filter((t) => t.type === 'blob'), branch, at: now, repo, host };
  repoCache.set(cacheKey, entry);
  return entry;
}

// ── skill 来源记录(供"更新")──────────────────────────────────────
// 导入时记 { [id]: { repo, branch, root } },更新按钮据此从原仓库重拉覆盖。
const SOURCES_FILE = join(homedir(), '.claude-gui', 'skill-sources.json');
const BRANCH_RE = /^[\w.\/-]{1,120}$/;
// 写入串行链(opus 审计):sources/repos 都是"整读→改→整写",并发导入/更新各读旧快照、
// 后写覆盖先写 → 来源记录丢失(该 skill 更新按钮消失)。所有 read-modify-write 排进同一条
// promise 链,天然串行;链上错误吞掉不阻塞后续(单次写失败已在各调用点容错)。
let _fileChain = Promise.resolve();
function serialized(fn) {
  const p = _fileChain.then(fn, fn);
  _fileChain = p.catch(() => {});
  return p;
}
async function readSources() {
  try { return JSON.parse(await readFile(SOURCES_FILE, 'utf-8')) || {}; } catch { return {}; }
}
async function writeSources(map) {
  await mkdir(join(SOURCES_FILE, '..'), { recursive: true });
  // 原子写:tmp+rename,避免写到一半崩溃 → JSON 截断 → readSources 静默返 {} → 全部来源记录丢失。
  const tmp = `${SOURCES_FILE}.tmp-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(map, null, 2));
  await rename(tmp, SOURCES_FILE);
}
// 串行化的"合并写入":读最新→合并 patch→写回,避免调用方各持旧快照互相覆盖。
function mergeSources(patch) {
  return serialized(async () => {
    const cur = await readSources();
    Object.assign(cur, patch);
    await writeSources(cur);
  });
}
// 删除某 id 的来源记录(删除技能时调):否则用户之后手写同名技能,前端仍显示"更新"、
// 一点就用旧仓库内容整目录覆盖掉手写版(静默毁掉用户创作)。
function forgetSource(id) {
  return serialized(async () => {
    const cur = await readSources();
    if (!(id in cur)) return;
    delete cur[id];
    await writeSources(cur);
  });
}

// ── 用户导入过的 GitHub 仓库列表(持久化,导入页常驻可选/可删)────────
// 拉取成功即记住,下次打开面板直接点仓库名重进,不用再粘贴地址。
const REPOS_FILE = join(homedir(), '.claude-gui', 'skill-repos.json');
async function readRepos() {
  try { const a = JSON.parse(await readFile(REPOS_FILE, 'utf-8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function writeRepos(list) {
  await mkdir(join(REPOS_FILE, '..'), { recursive: true });
  const tmp = `${REPOS_FILE}.tmp-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(list, null, 2));
  await rename(tmp, REPOS_FILE);
}
async function rememberRepo(repo, branch, host = 'github') {
  const b = branch || '';
  return serialized(async () => {
    const list = await readRepos();
    if (list.some((r) => r.repo === repo && (r.branch || '') === b && (r.host || 'github') === host)) return;
    list.push({ repo, branch: b, host });
    await writeRepos(list);
  });
}

// 共享导入逻辑(/import 与 /update 复用):下载 ids 对应 skill 覆盖到本机,并记来源。
async function doImport(repo, branchArg, ids, overwrite, force = false, host = 'github') {
  const h = hostOf(host);
  const { skills, files, branch } = await loadRepo(repo, branchArg, force, host);
  const byId = new Map(skills.map((s) => [s.id, s]));
  const imported = [], conflicts = [], failed = [], badMeta = []; // badMeta:装入成功但 SKILL.md 元数据解析不到 name
  const sourcesPatch = {}; // 只累积本次新增的来源,收尾 mergeSources 串行合并(防并发覆盖丢记录)
  for (const id of ids) {
    const meta = byId.get(id);
    if (!meta) { failed.push({ id, error: '源仓库无此 skill' }); continue; }
    const dest = join(SKILLS_DIR, id);
    let exists = false;
    try { exists = (await stat(dest)).isDirectory(); } catch { /* 无 */ }
    if (exists && !overwrite) { conflicts.push(id); continue; }
    const blobs = files.filter((f) => f.path === `${meta.root}/SKILL.md` || f.path.startsWith(`${meta.root}/`));
    if (!blobs.length) { failed.push({ id, error: '无文件' }); continue; }
    // 下载到临时目录 → 成功后原子替换。解决两问题:①更新时上游已删的文件不再残留(纯 fetch 只做
    // 增/改、漏"删",git pull 的唯一优势点,靠整目录替换补上);②下载中途失败只丢临时目录、旧 skill
    // 原封不动(避免"更新失败反把能用的删了")。临时目录在 IMPORT_TMP_DIR(skills/ 之外,claude 不扫
    // → 下载期间不会被当成假 skill 加载);仍在 ~/.claude 同一 FS,rename 原子。全新导入半截失败也不留残缺。
    const tmp = join(IMPORT_TMP_DIR, `${id}-${Date.now()}`);
    let dstashed = null; // 旧版本暂存路径(替换失败时回滚)
    try {
      await mkdir(SKILLS_DIR, { recursive: true });   // 新机首次导入 skills/ 可能不存在,否则 rename ENOENT
      await mkdir(IMPORT_TMP_DIR, { recursive: true });
      for (const f of blobs) {
        const rel = f.path.slice(meta.root.length + 1); // 相对 skill 根
        const target = join(tmp, rel);
        await mkdir(join(target, '..'), { recursive: true });
        const raw = await fetch(h.raw(repo, branch, f.path));
        if (!raw.ok) throw new Error(`下载 ${rel} HTTP ${raw.status}`);
        await writeFile(target, Buffer.from(await raw.arrayBuffer()));
      }
      // 原子替换:先把旧版本 rename 到暂存(而非直接 rm),再 rename 新版本就位。
      // 若第二步失败(Win 杀毒/索引器锁目录致 EPERM),回滚旧版本 —— 避免"旧的删了新的没进=技能凭空消失"。
      const existed = await stat(dest).then(() => true).catch(() => false);
      if (existed) { dstashed = `${dest}.old-${Date.now()}`; await rename(dest, dstashed); }
      try {
        await rename(tmp, dest);
      } catch (e) {
        if (dstashed) { await rename(dstashed, dest).catch(() => {}); dstashed = null; } // 回滚,旧 skill 复位
        throw e;
      }
      if (dstashed) { await rm(dstashed, { recursive: true, force: true }).catch(() => {}); dstashed = null; }
      imported.push(id);
      // 导入结果里标出坏元数据(frontmatter 解析不到 name),否则以目录名静默装入用户不知情
      try { if (!parseFrontmatter(await readSkillMd(dest) || '').name) badMeta.push(id); } catch { /* 仅提示,失败不影响导入 */ }
      sourcesPatch[id] = { repo, branch, root: meta.root, host }; // 记来源供"更新"(含 host)
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {}); // 清半成品
      if (dstashed) { await rename(dstashed, dest).catch(() => {}); } // 兜底:任何异常都让旧版本复位
      failed.push({ id, error: e.message });
    }
  }
  if (imported.length) { try { await mergeSources(sourcesPatch); } catch { /* 记录失败不影响导入结果 */ } }
  localCache = null; // 装了新 skill,本机列表缓存失效
  return { imported, conflicts, failed, badMeta };
}

// CQ批次4:除内置 SOURCES 外,支持 ?repo=owner/repo 一键拉任意 GitHub 仓库的 skill 列表。
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const HOST_RE = /^(github|gitee)$/;
router.get('/skills/official', async (req, res) => {
  const repoParam = typeof req.query.repo === 'string' ? req.query.repo.trim() : '';
  const useCustom = REPO_RE.test(repoParam);
  const src = SOURCES.find((s) => s.id === req.query.source) || SOURCES[0];
  const repo = useCustom ? repoParam : src.repo;
  const host = useCustom && HOST_RE.test(String(req.query.host || '')) ? req.query.host : 'github';
  if (repoParam && !useCustom) return res.json({ skills: [], error: 'repo 格式应为 owner/repo' });
  const branchParam = typeof req.query.branch === 'string' && BRANCH_RE.test(req.query.branch.trim()) ? req.query.branch.trim() : '';
  try {
    const { skills, branch } = await loadRepo(repo, branchParam, false, host);
    let installed = new Set();
    try { installed = new Set(await readdir(SKILLS_DIR)); } catch { /* 无目录 */ }
    if (useCustom) { try { await rememberRepo(repo, branchParam, host); } catch { /* 记住失败不影响拉取 */ } }
    res.json({
      source: useCustom ? repo : src.id, repo, branch, host, count: skills.length,
      truncatedDesc: skills.length > DESC_CAP,
      skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description, version: s.version || null, installed: installed.has(s.id) })),
    });
  } catch (e) {
    res.json({ skills: [], error: e.status === 403 ? `${hostOf(host).label} API 限流,请稍后重试或挂代理` : e.message });
  }
});

// 用户导入过的自定义仓库列表(持久化,导入页常驻)。
router.get('/skills/repos', async (req, res) => {
  res.json({ repos: await readRepos() });
});
// 从列表删除一个仓库(不影响已装的 skill,只是不再在导入页常驻)。
router.delete('/skills/repos', async (req, res) => {
  const repo = String(req.body?.repo || '');
  const branch = String(req.body?.branch || '');
  const host = String(req.body?.host || 'github');
  try {
    await serialized(async () => {
      const list = (await readRepos()).filter((r) => !(r.repo === repo && (r.branch || '') === branch && (r.host || 'github') === host));
      await writeRepos(list);
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 导入 ──────────────────────────────────────────────────────────
router.post('/skills/import', async (req, res) => {
  const repoParam = typeof req.body?.repo === 'string' ? req.body.repo.trim() : '';
  const useCustom = REPO_RE.test(repoParam);
  const src = SOURCES.find((s) => s.id === req.body?.source) || SOURCES[0];
  const repo = useCustom ? repoParam : src.repo;
  const host = useCustom && HOST_RE.test(String(req.body?.host || '')) ? req.body.host : 'github';
  if (repoParam && !useCustom) return res.status(400).json({ error: 'repo 格式应为 owner/repo' });
  const branchParam = typeof req.body?.branch === 'string' && BRANCH_RE.test(req.body.branch.trim()) ? req.body.branch.trim() : '';
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((s) => /^[a-zA-Z0-9._-]+$/.test(s)) : [];
  const overwrite = !!req.body?.overwrite;
  if (!ids.length) return res.status(400).json({ error: 'ids 为空' });
  try {
    res.json(await doImport(repo, branchParam, ids, overwrite, false, host));
  } catch (e) {
    res.status(e.status === 403 ? 429 : 500).json({ error: e.status === 403 ? `${hostOf(host).label} API 限流,请稍后重试` : e.message });
  }
});

// 已装 skill 的来源映射 { id: {repo, branch, root} } —— 前端据此对有来源的本机 skill 显示"更新"。
router.get('/skills/sources-map', async (req, res) => {
  res.json({ sources: await readSources() });
});

// ── 检查更新(手动触发,不自动轮询)────────────────────────────────
// 对有来源记录的本机 skill,拉源仓库 SKILL.md 的 frontmatter version 与本机版本纯字符串比对。
// 直拉 raw 单文件(不走 loadRepo 的整仓 tree,免 API 限流);两侧都声明 version 才能判定,
// 任一侧缺 version 返回 hasUpdate:null(未知,前端不亮角标)。
// best-effort:单个拉取失败/超时静默跳过(墙内网络不稳,不报错不阻塞其它技能)。
router.post('/skills/check-updates', async (req, res) => {
  const sources = await readSources();
  const updates = {};
  await Promise.all(Object.entries(sources).map(async ([id, src]) => {
    if (!src?.repo || !src?.root) return;
    const localMd = await readSkillMd(join(SKILLS_DIR, id));
    if (localMd === null) return; // 本机没装(已归档/删除),不检查
    const local = parseFrontmatter(localMd).version;
    try {
      const h = hostOf(src.host || 'github');
      const r = await fetch(h.raw(src.repo, src.branch, `${src.root}/SKILL.md`), { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return;
      const remote = parseFrontmatter(await r.text()).version;
      updates[id] = { local, remote, hasUpdate: local && remote ? local !== remote : null };
    } catch { /* 网络失败静默跳过 */ }
  }));
  res.json({ updates });
});

// 更新单个 skill:按来源记录从原仓库+分支重拉,覆盖本机旧版本。
router.post('/skills/update', async (req, res) => {
  const id = String(req.body?.id || '');
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) return res.status(400).json({ error: '非法 skill id' });
  const sources = await readSources();
  const src = sources[id];
  if (!src?.repo) return res.status(400).json({ error: '该 skill 无来源记录(非从 GitHub/Gitee 仓库导入,无法自动更新)' });
  try {
    // 更新前的 SKILL.md 内容,用于判"其实没更新"(远端无变化则重下的字节与旧的一致)→ 前端显示"无更新"。
    const beforeMd = await readSkillMd(join(SKILLS_DIR, id)) || '';
    const r = await doImport(src.repo, src.branch, [id], true, true, src.host || 'github'); // force:绕过 repoCache 拿最新 tree
    if (r.imported.includes(id)) {
      // 读更新后的 frontmatter version(有则回传,前端弹窗"已更新为 vX")
      const afterMd = await readSkillMd(join(SKILLS_DIR, id)) || '';
      const fm = parseFrontmatter(afterMd);
      const changed = beforeMd !== afterMd;
      return res.json({ ok: true, repo: src.repo, branch: src.branch, host: src.host || 'github', version: fm.version || null, changed });
    }
    return res.status(500).json({ error: r.failed[0]?.error || '更新失败' });
  } catch (e) {
    res.status(e.status === 403 ? 429 : 500).json({ error: e.status === 403 ? 'GitHub API 限流,请稍后重试' : e.message });
  }
});

export default router;
