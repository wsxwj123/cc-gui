// r124 · 假 GitHub 上预置的仓库(INTERFACE-r124 §C 点名的那几个 + 两个同构补充)。
// 依据只有 .devflow/BRIEF-r124.md 与 .devflow/INTERFACE-r124.md;没看实现代码。
// 每个文件都只有几十字节;内容在这里定义一次,假 GitHub 照此发、用例照此比(逐字节)。
import crypto from 'node:crypto';

/** 标准 frontmatter 的 SKILL.md。 */
export const skillMd = (name, description, version, body = '') =>
  `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\n---\n${body}`;

export const REPOS = {
  // C1/C2/C5/C8:单技能仓库,SKILL.md 直接放在根目录,另有配套目录
  'acme/solo-skill': {
    files: {
      'SKILL.md': skillMd('solo-skill', '单技能仓库', '1.2.0', '# solo\n根目录技能。\n'),
      'scripts/run.py': 'print("solo run")\n',
      'templates/a.md': '# 模板 A\n',
    },
  },
  // C3:一个技能都没有
  'acme/no-skills': {
    files: {
      'README.md': '# 没有技能的仓库\n',
      'src/a.js': 'export const a = 1;\n',
    },
  },
  // C4:两个 <id>/SKILL.md
  'acme/two-skills': {
    files: {
      'alpha/SKILL.md': skillMd('alpha', '技能甲', '0.1.0'),
      'beta/SKILL.md': skillMd('beta', '技能乙', '0.2.0'),
    },
  },
  // C4 的"只装一个"分支用(与 two-skills 同构、id 不同:两条界面用例不共享已装状态)
  'acme/two-skills-b': {
    files: {
      'gamma/SKILL.md': skillMd('gamma', '技能丙', '0.3.0'),
      'delta/SKILL.md': skillMd('delta', '技能丁', '0.4.0'),
    },
  },
  // C6:既有布局 + 该排除的目录
  'acme/mixed': {
    files: {
      'README.md': '# mixed\n',
      'skills/one/SKILL.md': skillMd('one', '技能一', '1.0.0'),
      'skills/one/scripts/x.sh': 'echo one\n',
      'deep/cat/two/SKILL.md': skillMd('two', '技能二', '2.0.0'),
      'node_modules/x/SKILL.md': skillMd('x', '不该被扫到', '0.0.1'),
      '.agents/y/SKILL.md': skillMd('y', '隐藏目录不该被扫到', '0.0.1'),
    },
  },
  // C6:同名先见先得
  'acme/dup': {
    files: {
      'skills/same/SKILL.md': skillMd('same', '先见先得', '1.0.0'),
      'other/same/SKILL.md': skillMd('same', '后见的重名', '9.9.9'),
    },
  },
  // C7:根目录 + 子目录并存
  'acme/both': {
    files: {
      'SKILL.md': skillMd('both', '根目录技能', '1.0.0'),
      'skills/child/SKILL.md': skillMd('child', '子目录技能', '1.1.0'),
    },
  },
};

export const DEFAULT_BRANCH = 'main';
export const repoNames = () => Object.keys(REPOS);
export const filesOf = (repo) => REPOS[repo]?.files ?? null;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
/** 与 git 同口径的 blob sha:sha1("blob <len>\0<content>")。 */
export const blobSha = (content) => {
  const buf = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};

/**
 * 按 GitHub `git/trees/<ref>?recursive=1` 的形状造树:目录(type tree)与文件(type blob)都列,
 * 路径按字节序;根树 sha 由全部内容决定(测试可通过假 GitHub 的控制口另换一个值)。
 */
export function buildTree(repo) {
  const files = filesOf(repo);
  if (!files) return null;
  const dirs = new Set();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  const entries = [];
  for (const d of dirs) {
    const inside = Object.keys(files).filter((f) => f.startsWith(`${d}/`)).sort();
    entries.push({ path: d, mode: '040000', type: 'tree', sha: sha1(`tree:${d}:${inside.map((f) => blobSha(files[f])).join(',')}`) });
  }
  for (const [p, content] of Object.entries(files)) {
    entries.push({ path: p, mode: '100644', type: 'blob', sha: blobSha(content), size: Buffer.byteLength(content, 'utf8') });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const rootSha = sha1(`root:${repo}:${entries.map((e) => `${e.path}=${e.sha}`).join('|')}`);
  return { sha: rootSha, entries };
}
