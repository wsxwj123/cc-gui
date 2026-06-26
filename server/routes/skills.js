// CK-4: Skill 市场(多源)。
//   GET  /api/skills              本机 ~/.claude/skills 已安装
//   GET  /api/skills/sources      可导入的源仓库列表
//   GET  /api/skills/official?source=<id>   某源仓库的 skill 列表(缓存 1h)
//   POST /api/skills/import       { source, ids, overwrite } 下载导入;重名跳过/覆盖
//
// 通用 SKILL.md 定位:任意仓库里 `<id>/SKILL.md`、`skills/<id>/SKILL.md`、
// `my-skills/<id>/SKILL.md` 都算一个 skill(id = SKILL.md 的父目录),兼容四个源。
import { Router } from 'express';
import { readdir, readFile, mkdir, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const router = Router();
const SKILLS_DIR = join(homedir(), '.claude', 'skills');
const GH_HEADERS = { 'User-Agent': 'claude-gui-skills', 'Accept': 'application/vnd.github+json' };
const DESC_CAP = 30; // skill 数 ≤ 此值才逐个抓描述(大仓如 Composio 只列名,免打爆网络)

const SOURCES = [
  { id: 'anthropic', name: 'Anthropic 官方', repo: 'anthropics/skills', url: 'https://github.com/anthropics/skills' },
  { id: 'superpowers', name: 'Superpowers', repo: 'obra/superpowers', url: 'https://github.com/obra/superpowers' },
  { id: 'composio', name: '开源社区 (Composio)', repo: 'ComposioHQ/awesome-claude-skills', url: 'https://github.com/ComposioHQ/awesome-claude-skills' },
  { id: 'skillforge', name: '科研 (SkillForge)', repo: 'Yuna-Nexus/skillforge', url: 'https://github.com/Yuna-Nexus/skillforge' },
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
router.get('/skills', async (req, res) => {
  try {
    let names;
    try { names = await readdir(SKILLS_DIR); } catch { return res.json({ skills: [] }); }
    const skills = [];
    for (const id of names) {
      if (id.startsWith('.')) continue;
      const dir = join(SKILLS_DIR, id);
      try { if (!(await stat(dir)).isDirectory()) continue; } catch { continue; }
      const md = await readSkillMd(dir);
      if (!md) continue;
      const fm = parseFrontmatter(md);
      skills.push({ id, name: fm.name || id, description: fm.description || '' });
    }
    skills.sort((a, b) => a.id.localeCompare(b.id));
    res.json({ skills });
  } catch (e) {
    res.json({ skills: [], error: e.message });
  }
});

router.get('/skills/sources', (req, res) => {
  res.json({ sources: SOURCES.map((s) => ({ id: s.id, name: s.name, url: s.url })) });
});

// ── 源仓库 skill 列表(逐仓库缓存)────────────────────────────────
const repoCache = new Map(); // repo -> { skills, files, branch, at }
const TTL = 60 * 60 * 1000;

async function ghDefaultBranch(repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: GH_HEADERS });
  if (!r.ok) { const e = new Error(`GitHub API ${r.status}`); e.status = r.status; throw e; }
  return (await r.json()).default_branch || 'main';
}

// 从 tree 路径抽 skill。返回 [{ id, root }],root = SKILL.md 父目录的仓库内路径。
function locateSkills(tree) {
  const seen = new Set();
  const out = [];
  for (const t of tree) {
    if (t.type !== 'blob') continue;
    const m = t.path.match(/^(?:(?:skills|my-skills)\/)?([^/]+)\/SKILL\.md$/i);
    if (!m) continue;
    const id = m[1];
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
  const tr = await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, { headers: GH_HEADERS });
  if (!tr.ok) { const e = new Error(`GitHub API ${tr.status}`); e.status = tr.status; throw e; }
  const tree = (await tr.json()).tree || [];
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

router.get('/skills/official', async (req, res) => {
  const src = SOURCES.find((s) => s.id === req.query.source) || SOURCES[0];
  try {
    const { skills, branch } = await loadRepo(src.repo);
    let installed = new Set();
    try { installed = new Set(await readdir(SKILLS_DIR)); } catch { /* 无目录 */ }
    res.json({
      source: src.id, repo: src.repo, branch, count: skills.length,
      truncatedDesc: skills.length > DESC_CAP,
      skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description, installed: installed.has(s.id) })),
    });
  } catch (e) {
    res.json({ skills: [], error: e.status === 403 ? 'GitHub API 限流(60次/小时/IP),请稍后重试或挂代理' : e.message });
  }
});

// ── 导入 ──────────────────────────────────────────────────────────
router.post('/skills/import', async (req, res) => {
  const src = SOURCES.find((s) => s.id === req.body?.source) || SOURCES[0];
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((s) => /^[a-zA-Z0-9._-]+$/.test(s)) : [];
  const overwrite = !!req.body?.overwrite;
  if (!ids.length) return res.status(400).json({ error: 'ids 为空' });
  try {
    const { skills, files, branch } = await loadRepo(src.repo);
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
          const raw = await fetch(`https://raw.githubusercontent.com/${src.repo}/${branch}/${f.path}`);
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
