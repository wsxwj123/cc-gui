// r124 接口层验收:根目录 SKILL.md 的仓库能被列出/导入/检查更新,0 个技能不算"全部已装",既有布局零回归。
// 依据只有 .devflow/BRIEF-r124.md 与 .devflow/INTERFACE-r124.md §A/§B/§C;没看实现代码。
// 每条用例自己起一个全新 HOME 的隔离实例(技能目录、来源记录互不串),顺序无关;
// 技能仓库请求经 CGUI_GITHUB_*_BASE 指到 run.sh 起的本地假 GitHub,实例本身挂了断外网预载。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { caseRoot, startInstance, stopAll, req, fake } from './helpers/instance.mjs';
import { fakeApiBase, fakeRawBase, skillDir, skillsDir, listFiles } from './helpers/fixtures.mjs';
import { REPOS, buildTree } from './helpers/repos.mjs';

const SOLO = 'acme/solo-skill';
const soloFiles = REPOS[SOLO].files;

const official = (h, repo) => req(h.base, 'GET', `/api/skills/official?repo=${encodeURIComponent(repo)}`);
const importSkills = (h, body) => req(h.base, 'POST', '/api/skills/import', body);
const idsOf = (json) => (json?.skills ?? []).map((s) => s.id).sort();
/** 起一条用例自己的实例。 */
const boot = (slug) => startInstance(caseRoot(slug), {}, { label: slug });
/** 导入根目录技能并断言导入成功(C2/C5/C8 的共同前置)。 */
async function importSolo(h, extra = {}) {
  const r = await importSkills(h, { repo: SOLO, ids: ['solo-skill'], ...extra });
  expect(r.status, `导入 ${SOLO} 应成功(HTTP 200),实际:${r.text.slice(0, 300)}`).toBe(200);
  expect(r.json?.imported, `imported 应为 ['solo-skill'],实际:${r.text.slice(0, 300)}`).toEqual(['solo-skill']);
  return r.json;
}
/** 检查更新的返回里找某个技能的条目(INTERFACE 只给了 { <id>: {...} } 的形状,容忍包在 updates 里)。 */
const updateEntry = (json, id) => json?.[id] ?? json?.updates?.[id];

test.afterEach(async () => { await stopAll(); });

test.describe('F0 假 GitHub 自证(替身本身得先对)', () => {
  test('F0-a 仓库信息与递归树的形状符合 INTERFACE §B', async () => {
    const info = await req(fakeApiBase(), 'GET', `/repos/${SOLO}`);
    expect(info.status).toBe(200);
    expect(info.json.default_branch).toBe('main');
    const tree = await req(fakeApiBase(), 'GET', `/repos/${SOLO}/git/trees/main?recursive=1`);
    expect(tree.status).toBe(200);
    expect(tree.json.truncated).toBe(false);
    expect(typeof tree.json.sha).toBe('string');
    expect(tree.json.tree.filter((e) => e.type === 'blob').map((e) => e.path).sort()).toEqual(['SKILL.md', 'scripts/run.py', 'templates/a.md']);
  });

  test('F0-b 原始文件逐字节一致;不存在的文件 404', async () => {
    const raw = await req(fakeRawBase(), 'GET', `/${SOLO}/main/SKILL.md`);
    expect(raw.status).toBe(200);
    expect(raw.text).toBe(soloFiles['SKILL.md']);
    const missing = await req(fakeRawBase(), 'GET', `/${SOLO}/main/nope.txt`);
    expect(missing.status).toBe(404);
  });
});

test.describe('B 上游替身生效(公开契约:CGUI_GITHUB_API_BASE / CGUI_GITHUB_RAW_BASE)', () => {
  test('B1 查仓库时请求打到假 GitHub,而不是真 GitHub', async () => {
    const h = await boot('b1-env');
    await fake.resetRequests();
    await official(h, SOLO);
    const hits = (await fake.requests()).filter((r) => r.path.startsWith(`/repos/${SOLO}`));
    expect(hits.length, `假 GitHub 应收到 /repos/${SOLO}… 的请求;被断外网预载拒掉的目标:${JSON.stringify(h.blocked().filter((b) => /github/.test(b)))}`).toBeGreaterThan(0);
    expect(h.blocked().filter((b) => /api\.github\.com|raw\.githubusercontent\.com/.test(b)), '实例不该再去碰真 GitHub').toEqual([]);
  });
});

test.describe('C1 根目录技能被列出', () => {
  test('C1 acme/solo-skill → count 1,唯一一项 id=仓库名、name/description/version 来自根 SKILL.md、installed=false', async () => {
    const h = await boot('c1-list');
    const r = await official(h, SOLO);
    expect(r.status).toBe(200);
    expect(r.json?.error, `不该报错:${r.text.slice(0, 300)}`).toBeUndefined();
    expect(r.json?.count, `count 应为 1:${r.text.slice(0, 300)}`).toBe(1);
    expect(r.json?.skills?.length).toBe(1);
    expect(r.json.skills[0]).toMatchObject({ id: 'solo-skill', name: 'solo-skill', description: '单技能仓库', version: '1.2.0', installed: false });
  });
});

test.describe('C2 根目录技能被导入', () => {
  test('C2-a 导入后 ~/.claude/skills/solo-skill/ 与仓库树一致、逐字节相同、没有 .git、没写到别处', async () => {
    const h = await boot('c2a-import');
    const out = await importSolo(h);
    expect(out.conflicts ?? []).toEqual([]);
    expect(out.failed ?? []).toEqual([]);
    const dir = skillDir(h.home, 'solo-skill');
    expect(listFiles(dir), `落盘文件应与仓库树一致(不含 git 元数据):${dir}`).toEqual(['SKILL.md', 'scripts/run.py', 'templates/a.md']);
    for (const [rel, content] of Object.entries(soloFiles)) {
      expect(fs.readFileSync(path.join(dir, rel)).equals(Buffer.from(content, 'utf8')), `${rel} 内容应与假仓库逐字节一致`).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, '.git')), '不该带 .git 目录').toBe(false);
    expect(fs.readdirSync(skillsDir(h.home)).sort(), '技能目录下只该多出 solo-skill 这一个目录').toEqual(['solo-skill']);
  });

  test('C2-b 导入后本机技能列表里出现 solo-skill,description 为「单技能仓库」', async () => {
    const h = await boot('c2b-local');
    await importSolo(h);
    const r = await req(h.base, 'GET', '/api/skills');
    expect(r.status).toBe(200);
    const item = (r.json?.skills ?? []).find((s) => s.id === 'solo-skill');
    expect(item, `本机列表里应有 solo-skill:${r.text.slice(0, 300)}`).toBeDefined();
    expect(item.description).toBe('单技能仓库');
    expect(item.name).toBe('solo-skill');
  });

  test('C2-c 导入后再查 official,该项 installed=true', async () => {
    const h = await boot('c2c-installed');
    await importSolo(h);
    const r = await official(h, SOLO);
    expect(r.json?.skills?.[0]?.id).toBe('solo-skill');
    expect(r.json.skills[0].installed).toBe(true);
  });
});

test.describe('C3 0 个技能', () => {
  test('C3 acme/no-skills → count 0、skills 空、不是 error', async () => {
    const h = await boot('c3-none');
    const r = await official(h, 'acme/no-skills');
    expect(r.status).toBe(200);
    expect(r.json?.error, `没有技能不等于出错:${r.text.slice(0, 300)}`).toBeUndefined();
    expect(r.json?.count).toBe(0);
    expect(r.json?.skills).toEqual([]);
  });
});

test.describe('C5 来源记录与检查更新', () => {
  test('C5-a 导入后 sources-map 里有 solo-skill,repo 为 acme/solo-skill', async () => {
    const h = await boot('c5a-sources');
    await importSolo(h);
    const r = await req(h.base, 'GET', '/api/skills/sources-map');
    expect(r.status).toBe(200);
    const rec = r.json?.sources?.['solo-skill'];
    expect(rec, `sources-map 应含 solo-skill:${r.text.slice(0, 300)}`).toBeDefined();
    expect(rec.repo).toBe(SOLO);
  });

  test('C5-b 上游没变时检查更新:不报错、含该项、hasUpdate 为 false', async () => {
    const h = await boot('c5b-noupdate');
    await importSolo(h);
    const r = await req(h.base, 'POST', '/api/skills/check-updates', { ids: ['solo-skill'] });
    expect(r.status, `检查更新应 200:${r.text.slice(0, 300)}`).toBe(200);
    expect(r.json?.error).toBeUndefined();
    const entry = updateEntry(r.json, 'solo-skill');
    expect(entry, `返回里应含 solo-skill 的条目:${r.text.slice(0, 300)}`).toBeDefined();
    if (entry && 'hasUpdate' in entry) expect(entry.hasUpdate, `上游未变不该报有更新:${JSON.stringify(entry)}`).toBe(false);
    expect(entry?.error, '该项不该带错误').toBeUndefined();
  });

  test('C5-c 假仓库根树 sha 换掉后检查更新:该项 hasUpdate 为 true', async () => {
    const h = await boot('c5c-update');
    await importSolo(h);
    try {
      const bumped = await fake.setRootSha(SOLO, 'f00d0000000000000000000000000000f00d0000');
      expect(bumped.json?.sha).toBe('f00d0000000000000000000000000000f00d0000');
      const r = await req(h.base, 'POST', '/api/skills/check-updates', { ids: ['solo-skill'] });
      expect(r.status, `检查更新应 200:${r.text.slice(0, 300)}`).toBe(200);
      const entry = updateEntry(r.json, 'solo-skill');
      expect(entry, `返回里应含 solo-skill 的条目:${r.text.slice(0, 300)}`).toBeDefined();
      expect(entry?.hasUpdate, `根树 sha 变了应判有更新:${JSON.stringify(entry)}`).toBe(true);
    } finally {
      await fake.setRootSha(SOLO, null);
    }
  });
});

test.describe('C6 既有布局零回归', () => {
  test('C6-a acme/mixed → 只有 one、two(node_modules 与隐藏目录里的不算)', async () => {
    const h = await boot('c6a-mixed');
    const r = await official(h, 'acme/mixed');
    expect(r.json?.error, r.text.slice(0, 300)).toBeUndefined();
    expect(r.json?.count).toBe(2);
    expect(idsOf(r.json)).toEqual(['one', 'two']);
  });

  test('C6-b acme/dup → 同名只留 1 个 same', async () => {
    const h = await boot('c6b-dup');
    const r = await official(h, 'acme/dup');
    expect(r.json?.error, r.text.slice(0, 300)).toBeUndefined();
    expect(r.json?.count).toBe(1);
    expect(idsOf(r.json)).toEqual(['same']);
  });

  test('C6-c 内置六个源清单不变', async () => {
    const h = await boot('c6c-sources');
    const r = await req(h.base, 'GET', '/api/skills/sources');
    expect(r.status).toBe(200);
    expect((r.json?.sources ?? []).map((s) => s.name)).toEqual(['Anthropic 官方', 'Superpowers', '开源社区 (Composio)', 'Vercel (skills.sh)', 'Hermes (Nous)', 'Garden Skills']);
  });
});

test.describe('C7 根目录 + 子目录并存', () => {
  test('C7 acme/both → count 2,含 both(来自根 SKILL.md)与 child', async () => {
    const h = await boot('c7-both');
    const r = await official(h, 'acme/both');
    expect(r.json?.error, r.text.slice(0, 300)).toBeUndefined();
    expect(r.json?.count).toBe(2);
    expect(idsOf(r.json)).toEqual(['both', 'child']);
    expect(r.json.skills.find((s) => s.id === 'both')).toMatchObject({ description: '根目录技能', version: '1.0.0' });
    expect(r.json.skills.find((s) => s.id === 'child')).toMatchObject({ description: '子目录技能', version: '1.1.0' });
  });
});

test.describe('C8 重名冲突流程对根目录技能照旧适用', () => {
  test('C8-a 本机已有同名目录、不带 overwrite → conflicts 含它,原文件不动、仓库文件不落', async () => {
    const h = await boot('c8a-conflict');
    const dir = skillDir(h.home, 'solo-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'custom.txt'), '用户自己的东西\n');
    const r = await importSkills(h, { repo: SOLO, ids: ['solo-skill'] });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.json?.conflicts).toEqual(['solo-skill']);
    expect(r.json?.imported ?? []).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'custom.txt'), 'utf8')).toBe('用户自己的东西\n');
    expect(fs.existsSync(path.join(dir, 'scripts', 'run.py')), '没确认覆盖之前不得写入仓库文件').toBe(false);
  });

  test('C8-b 带 overwrite:true → 导入成功,自定义文件被清掉,仓库文件落齐', async () => {
    const h = await boot('c8b-overwrite');
    const dir = skillDir(h.home, 'solo-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'custom.txt'), '用户自己的东西\n');
    const out = await importSolo(h, { overwrite: true });
    expect(out.conflicts ?? []).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'custom.txt')), '覆盖后自定义文件不该还在').toBe(false);
    expect(listFiles(dir)).toEqual(['SKILL.md', 'scripts/run.py', 'templates/a.md']);
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe(soloFiles['SKILL.md']);
  });
});

test.describe('N 错误路径与反向用例', () => {
  test('N1 不存在的仓库 → { skills: [], error:<非空文案> }', async () => {
    const h = await boot('n1-unknown');
    const r = await official(h, 'acme/does-not-exist');
    expect(r.status).toBe(200);
    expect(r.json?.skills).toEqual([]);
    expect(typeof r.json?.error).toBe('string');
    expect(r.json.error.length).toBeGreaterThan(0);
    expect(r.json?.count ?? 0).toBe(0);
  });

  test('N2 导入仓库里不存在的 id → 不算导入成功,技能目录里什么都不落', async () => {
    const h = await boot('n2-ghost');
    const r = await importSkills(h, { repo: SOLO, ids: ['ghost'] });
    expect(r.json?.imported ?? [], r.text.slice(0, 300)).not.toContain('ghost');
    expect(fs.existsSync(skillDir(h.home, 'ghost'))).toBe(false);
    expect(fs.readdirSync(skillsDir(h.home))).toEqual([]);
  });

  test('N3 树 sha 自证:假仓库的根树 sha 是稳定值,换掉再还原后与原值一致', async () => {
    const before = (await req(fakeApiBase(), 'GET', `/repos/${SOLO}/git/trees/main?recursive=1`)).json.sha;
    expect(before).toBe(buildTree(SOLO).sha);
    await fake.setRootSha(SOLO, 'abc123');
    expect((await req(fakeApiBase(), 'GET', `/repos/${SOLO}/git/trees/main?recursive=1`)).json.sha).toBe('abc123');
    await fake.setRootSha(SOLO, null);
    expect((await req(fakeApiBase(), 'GET', `/repos/${SOLO}/git/trees/main?recursive=1`)).json.sha).toBe(before);
  });
});
