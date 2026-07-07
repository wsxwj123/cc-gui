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
const ID_RE = /^[a-zA-Z0-9._-]+$/;
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

function parseFrontmatter(content) {
  const out = { name: null, description: null };
  if (!content || content.slice(0, 3) !== '---') return out;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return out;
  for (const line of content.slice(3, end).split('\n')) {
    const m = line.match(/^(name|description):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
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
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const skills = await Promise.all(dirs.map(async (e) => {
    const md = await readSkillMd(join(SKILLS_DIR, e.name));
    const fm = md ? parseFrontmatter(md) : {};
    return { id: e.name, name: fm.name || e.name, description: fm.description || '' };
  }));
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
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
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

// CL-1: 取 GitHub JSON 的健壮封装。Windows 网络受限/被拦截时 GitHub 可能返回 HTML
// 拦截页,直接 r.json() 会抛 "Unexpected token '<'... not valid JSON"(用户报告)。
// 这里先验 r.ok + content-type,非 JSON 给可读错误而非裸 parse 报错。
async function ghJson(url) {
  let r;
  try { r = await fetch(url, { headers: GH_HEADERS }); }
  catch (e) { const err = new Error(`无法连接 GitHub(网络受限?可尝试代理):${e.message}`); err.status = 0; throw err; }
  if (!r.ok) { const e = new Error(`GitHub API ${r.status}`); e.status = r.status; throw e; }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    const e = new Error('GitHub 未返回 JSON(可能被网络拦截或需代理)'); e.status = 502; throw e;
  }
  return r.json();
}

async function ghDefaultBranch(repo) {
  return (await ghJson(`https://api.github.com/repos/${repo}`)).default_branch || 'main';
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

async function loadRepo(repo) {
  const now = Date.now();
  const c = repoCache.get(repo);
  if (c && now - c.at < TTL) return c;
  const branch = await ghDefaultBranch(repo);
  const tree = (await ghJson(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`)).tree || [];
  const located = locateSkills(tree);
  located.sort((a, b) => a.id.localeCompare(b.id));
  // 仅小仓库逐个抓描述,大仓只列名
  let skills;
  if (located.length <= DESC_CAP) {
    skills = await Promise.all(located.map(async (s) => {
      let name = s.id, description = '';
      try {
        const raw = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${s.root}/SKILL.md`);
        if (raw.ok) { const fm = parseFrontmatter(await raw.text()); name = fm.name || s.id; description = fm.description || ''; }
      } catch { /* 留空 */ }
      return { id: s.id, name, description, root: s.root };
    }));
  } else {
    skills = located.map((s) => ({ id: s.id, name: s.id, description: '', root: s.root }));
  }
  const entry = { skills, files: tree.filter((t) => t.type === 'blob'), branch, at: now, repo };
  repoCache.set(repo, entry);
  return entry;
}

// CQ批次4:除内置 SOURCES 外,支持 ?repo=owner/repo 一键拉任意 GitHub 仓库的 skill 列表。
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
router.get('/skills/official', async (req, res) => {
  const repoParam = typeof req.query.repo === 'string' ? req.query.repo.trim() : '';
  const useCustom = REPO_RE.test(repoParam);
  const src = SOURCES.find((s) => s.id === req.query.source) || SOURCES[0];
  const repo = useCustom ? repoParam : src.repo;
  if (repoParam && !useCustom) return res.json({ skills: [], error: 'repo 格式应为 owner/repo' });
  try {
    const { skills, branch } = await loadRepo(repo);
    let installed = new Set();
    try { installed = new Set(await readdir(SKILLS_DIR)); } catch { /* 无目录 */ }
    res.json({
      source: useCustom ? repo : src.id, repo, branch, count: skills.length,
      truncatedDesc: skills.length > DESC_CAP,
      skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description, installed: installed.has(s.id) })),
    });
  } catch (e) {
    res.json({ skills: [], error: e.status === 403 ? 'GitHub API 限流(60次/小时/IP),请稍后重试或挂代理' : e.message });
  }
});

// ── 导入 ──────────────────────────────────────────────────────────
router.post('/skills/import', async (req, res) => {
  const repoParam = typeof req.body?.repo === 'string' ? req.body.repo.trim() : '';
  const useCustom = REPO_RE.test(repoParam);
  const src = SOURCES.find((s) => s.id === req.body?.source) || SOURCES[0];
  const repo = useCustom ? repoParam : src.repo;
  if (repoParam && !useCustom) return res.status(400).json({ error: 'repo 格式应为 owner/repo' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((s) => /^[a-zA-Z0-9._-]+$/.test(s)) : [];
  const overwrite = !!req.body?.overwrite;
  if (!ids.length) return res.status(400).json({ error: 'ids 为空' });
  try {
    const { skills, files, branch } = await loadRepo(repo);
    const byId = new Map(skills.map((s) => [s.id, s]));
    const imported = [], conflicts = [], failed = [];
    for (const id of ids) {
      const meta = byId.get(id);
      if (!meta) { failed.push({ id, error: '源仓库无此 skill' }); continue; }
      const dest = join(SKILLS_DIR, id);
      let exists = false;
      try { exists = (await stat(dest)).isDirectory(); } catch { /* 无 */ }
      if (exists && !overwrite) { conflicts.push(id); continue; }
      const blobs = files.filter((f) => f.path === `${meta.root}/SKILL.md` || f.path.startsWith(`${meta.root}/`));
      if (!blobs.length) { failed.push({ id, error: '无文件' }); continue; }
      try {
        for (const f of blobs) {
          const rel = f.path.slice(meta.root.length + 1); // 相对 skill 根
          const target = join(SKILLS_DIR, id, rel);
          await mkdir(join(target, '..'), { recursive: true });
          const raw = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${f.path}`);
          if (!raw.ok) throw new Error(`下载 ${rel} HTTP ${raw.status}`);
          await writeFile(target, Buffer.from(await raw.arrayBuffer()));
        }
        imported.push(id);
      } catch (e) { failed.push({ id, error: e.message }); }
    }
    res.json({ imported, conflicts, failed });
  } catch (e) {
    res.status(e.status === 403 ? 429 : 500).json({ error: e.status === 403 ? 'GitHub API 限流,请稍后重试' : e.message });
  }
});

export default router;
