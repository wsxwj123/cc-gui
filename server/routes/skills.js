// CK-4: Skill 市场。
//   GET  /api/skills            列出本机 ~/.claude/skills 下已安装的 skill(名称+描述)
//   GET  /api/skills/official   列出 anthropics/skills 官方仓库的 skill(缓存 1h)
//   POST /api/skills/import     从官方仓库导入指定 skill;重名按 overwrite 跳过/覆盖
//
// 不碰任何现有功能 —— 纯新增读写 ~/.claude/skills/。
import { Router } from 'express';
import { readdir, readFile, mkdir, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const router = Router();
const SKILLS_DIR = join(homedir(), '.claude', 'skills');
const REPO = 'anthropics/skills';
const BRANCH = 'main';
const GH_HEADERS = { 'User-Agent': 'claude-gui-skills', 'Accept': 'application/vnd.github+json' };

// 从 SKILL.md 的 YAML frontmatter 抽 name / description。只做最朴素的逐行解析,
// 够用(官方 + 本机 skill 都是 `key: value` 一行式 frontmatter)。
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
    try { return await readFile(join(dir, fn), 'utf-8'); } catch { /* try next */ }
  }
  return null;
}

// ── 本机已安装 skill ──────────────────────────────────────────────
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
      if (!md) continue; // 没 SKILL.md 的目录不是 skill
      const fm = parseFrontmatter(md);
      skills.push({ id, name: fm.name || id, description: fm.description || '' });
    }
    skills.sort((a, b) => a.id.localeCompare(b.id));
    res.json({ skills });
  } catch (e) {
    res.json({ skills: [], error: e.message });
  }
});

// ── 官方仓库 skill(缓存整棵 tree + 描述 1h)────────────────────────
let officialCache = null;   // { skills:[{id,name,description}], tree:[{path,type}] }
let officialAt = 0;
const OFFICIAL_TTL = 60 * 60 * 1000;

async function fetchTree() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, { headers: GH_HEADERS });
  if (!r.ok) { const e = new Error(`GitHub API ${r.status}`); e.status = r.status; throw e; }
  const d = await r.json();
  return Array.isArray(d.tree) ? d.tree : [];
}

async function loadOfficial() {
  const now = Date.now();
  if (officialCache && now - officialAt < OFFICIAL_TTL) return officialCache;
  const tree = await fetchTree();
  // skills/<id>/SKILL.md → 每个就是一个官方 skill
  const ids = tree
    .filter((t) => t.type === 'blob' && /^skills\/[^/]+\/SKILL\.md$/i.test(t.path))
    .map((t) => t.path.split('/')[1]);
  const skills = await Promise.all(ids.map(async (id) => {
    let description = '', name = id;
    try {
      const raw = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/skills/${id}/SKILL.md`);
      if (raw.ok) { const fm = parseFrontmatter(await raw.text()); name = fm.name || id; description = fm.description || ''; }
    } catch { /* 描述拿不到就留空,不阻塞列表 */ }
    return { id, name, description };
  }));
  skills.sort((a, b) => a.id.localeCompare(b.id));
  officialCache = { skills, tree };
  officialAt = now;
  return officialCache;
}

router.get('/skills/official', async (req, res) => {
  try {
    const { skills } = await loadOfficial();
    // 标注本机是否已装(同名 id 即视为已装)
    let installed = new Set();
    try { installed = new Set(await readdir(SKILLS_DIR)); } catch { /* 无目录 */ }
    res.json({ skills: skills.map((s) => ({ ...s, installed: installed.has(s.id) })) });
  } catch (e) {
    res.json({ skills: [], error: e.status === 403 ? 'GitHub API 限流(60次/小时/IP),请稍后重试或挂代理' : e.message });
  }
});

// ── 导入 ──────────────────────────────────────────────────────────
// body: { ids: string[], overwrite?: boolean }
// 返回: { imported, skipped, conflicts, failed } —— conflicts 是「已存在且未选覆盖」的 id,
// 前端据此弹窗让用户选跳过/覆盖后(overwrite:true)重新调一次。
router.post('/skills/import', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((s) => /^[a-zA-Z0-9._-]+$/.test(s)) : [];
  const overwrite = !!req.body?.overwrite;
  if (!ids.length) return res.status(400).json({ error: 'ids 为空' });
  try {
    const { tree } = await loadOfficial();
    const imported = [], skipped = [], conflicts = [], failed = [];
    for (const id of ids) {
      const dest = join(SKILLS_DIR, id);
      let exists = false;
      try { exists = (await stat(dest)).isDirectory(); } catch { /* 不存在 */ }
      if (exists && !overwrite) { conflicts.push(id); continue; }
      // 该 skill 目录下的所有文件(blob),保持子目录结构
      const files = tree.filter((t) => t.type === 'blob' && t.path.startsWith(`skills/${id}/`));
      if (!files.length) { failed.push({ id, error: '官方仓库无此 skill' }); continue; }
      try {
        for (const f of files) {
          const rel = f.path.slice('skills/'.length); // <id>/<...>
          const target = join(SKILLS_DIR, rel);
          await mkdir(join(target, '..'), { recursive: true });
          const raw = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${f.path}`);
          if (!raw.ok) throw new Error(`下载 ${rel} 失败 HTTP ${raw.status}`);
          const buf = Buffer.from(await raw.arrayBuffer());
          await writeFile(target, buf);
        }
        imported.push(id);
      } catch (e) {
        failed.push({ id, error: e.message });
      }
    }
    res.json({ imported, skipped, conflicts, failed });
  } catch (e) {
    res.status(e.status === 403 ? 429 : 500).json({ error: e.status === 403 ? 'GitHub API 限流,请稍后重试' : e.message });
  }
});

export default router;
