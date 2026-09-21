// r124:技能仓库导入——根目录放 SKILL.md 的单技能仓库(BRIEF-r124 R1/R2/R4/R5;INTERFACE-r124 §B/§C)。
// 用户实报:yjz211/vivid-figures-skill 这类仓库被说成「此源已全部安装」,实际扫出 0 条、什么都没装。
// 这里只测纯函数层 + 内容锁(端到端在 tests/acceptance/r124-skill-root):
//   ① 根级识别  ② 子目录优先  ③ 既有布局零回归  ④ 仓库名 → id  ⑤ 空 root 的三种路径拼接
//   ⑥ 上游替身环境变量(默认值 / 覆盖 / Gitee 不受影响)  ⑦ 检查更新的假值判断与顶层 sha(内容锁)
//   ⑧ 面板 0 条不写「此源已全部安装」(内容锁)
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// skills.js 模块加载期会清 ~/.claude/.cgui-skill-tmp、绑定 SKILLS_DIR:先把 HOME 指到沙箱,不碰真实 ~/.claude。
const REAL_HOME = process.env.HOME;
const REAL_PROFILE = process.env.USERPROFILE;
const home = await mkdtemp(join(tmpdir(), 'cgui-r124-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
// 替身环境变量若被外层 shell 带进来,默认值断言会失真:先清掉,测完不用还原(进程即退)。
delete process.env.CGUI_GITHUB_API_BASE;
delete process.env.CGUI_GITHUB_RAW_BASE;

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n += 1; };
const blob = (path) => ({ path, type: 'blob', sha: `b-${path}` });
const dir = (path) => ({ path, type: 'tree', sha: `t-${path}` });

let failure = null;
try {
  const { locateSkills, mdPath, inRoot, relTo, repoNameOf, ghApiBase, ghRawBase, hostOf } = await import('../../server/routes/skills.js');

  // ① 根级识别:根目录 SKILL.md → 一个技能,id = 仓库名,root = ''(R1)
  {
    const tree = [blob('SKILL.md'), dir('scripts'), blob('scripts/run.py'), dir('templates'), blob('templates/a.md')];
    eq(locateSkills(tree, 'solo-skill'), [{ id: 'solo-skill', root: '' }], '① 根 SKILL.md 算一个技能:id=仓库名,root 为空串');
    eq(locateSkills(tree), [], '① 不传仓库名(旧调用形态)时根级不识别,与改前一致');
    eq(locateSkills([blob('skill.MD')], 'x'), [{ id: 'x', root: '' }], '① 文件名大小写不敏感(与子目录匹配同口径)');
    eq(locateSkills([blob('README.md'), blob('src/a.js')], 'no-skills'), [], '① 没有 SKILL.md 就是 0 条(C3)');
    eq(locateSkills([blob('SKILL.md.txt'), blob('docs/SKILL.md.bak')], 'x'), [], '① 只认恰好叫 SKILL.md 的文件');
    eq(locateSkills([{ path: 'SKILL.md', type: 'tree' }], 'x'), [], '① 只看 blob(叫 SKILL.md 的目录不算)');
  }

  // ② 根级与子目录并存 / 同 id 时子目录优先(C7 + PLAN"先见先得不被根级抢占")
  {
    eq(locateSkills([blob('SKILL.md'), blob('skills/both/SKILL.md')], 'both'), [{ id: 'both', root: 'skills/both' }], '② 同 id 时子目录优先,根级不加');
    eq(locateSkills([blob('SKILL.md'), blob('skills/child/SKILL.md')], 'both'),
      [{ id: 'child', root: 'skills/child' }, { id: 'both', root: '' }], '② 并存时两个都在;根级放最后,子目录条目的位置不变');
  }

  // ③ 既有布局零回归(R5 / C6):任意深度、node_modules 与隐藏目录排除、同名先见先得
  {
    const tree = [blob('README.md'), blob('skills/one/SKILL.md'), blob('skills/one/scripts/x.sh'), blob('deep/cat/two/SKILL.md'),
      blob('node_modules/x/SKILL.md'), blob('.agents/y/SKILL.md')];
    eq(locateSkills(tree, 'mixed'), [{ id: 'one', root: 'skills/one' }, { id: 'two', root: 'deep/cat/two' }], '③ 子目录布局与排除规则不变');
    eq(locateSkills([blob('skills/same/SKILL.md'), blob('other/same/SKILL.md')], 'dup'), [{ id: 'same', root: 'skills/same' }], '③ 同名先见先得不变');
    eq(locateSkills([blob('alpha/SKILL.md'), blob('beta/SKILL.md')], 'two-skills'), [{ id: 'alpha', root: 'alpha' }, { id: 'beta', root: 'beta' }], '③ <id>/SKILL.md 单层布局不变');
  }

  // ④ 仓库名 → id:去 .git 后缀;非法名不当 id(落盘路径 join(SKILLS_DIR, id) 不能逃出 skills/)
  {
    eq(repoNameOf('acme/solo-skill'), 'solo-skill', '④ 取 owner/repo 的 repo 部分');
    eq(repoNameOf('acme/solo-skill.git'), 'solo-skill', '④ 去掉 .git 后缀');
    eq(repoNameOf('acme/My.Skill_v2'), 'My.Skill_v2', '④ 点、下划线、大小写原样保留');
    eq(locateSkills([blob('SKILL.md')], '..'), [], '④ 纯点名不能当 id');
    eq(locateSkills([blob('SKILL.md')], ''), [], '④ 空仓库名不识别根级');
  }

  // ⑤ 空 root 的三种路径拼接(PLAN:`${root}/SKILL.md`、startsWith(`${root}/`)、slice(root.length+1) 对空串都会错)
  {
    eq(mdPath(''), 'SKILL.md', '⑤ 根级 SKILL.md 路径不带前导斜杠');
    eq(mdPath('skills/one'), 'skills/one/SKILL.md', '⑤ 子目录路径不变');
    ok(inRoot('', 'SKILL.md') && inRoot('', 'scripts/run.py') && inRoot('', 'skills/child/SKILL.md'), '⑤ root 为空串时整个仓库树都属于它(R2:导入全部文件)');
    ok(inRoot('skills/one', 'skills/one/SKILL.md') && inRoot('skills/one', 'skills/one/scripts/x.sh'), '⑤ 子目录 root:目录内文件属于它');
    ok(!inRoot('skills/one', 'skills/one-b/SKILL.md') && !inRoot('skills/one', 'README.md') && !inRoot('skills/one', 'skills/one'), '⑤ 子目录 root:同前缀兄弟目录、仓库其它文件、目录本身都不属于它');
    eq(relTo('', 'scripts/run.py'), 'scripts/run.py', '⑤ 根级相对路径 = 仓库内路径(不吃首字符)');
    eq(relTo('', 'SKILL.md'), 'SKILL.md', '⑤ 根级 SKILL.md 落在技能目录顶层');
    eq(relTo('skills/one', 'skills/one/scripts/x.sh'), 'scripts/x.sh', '⑤ 子目录相对路径不变');
  }

  // ⑥ 上游替身:不设即官方地址;设了就用(末尾斜杠去掉);每次调用时读;Gitee 不受影响(INTERFACE §B)
  {
    eq(ghApiBase(), 'https://api.github.com', '⑥ API 默认值');
    eq(ghRawBase(), 'https://raw.githubusercontent.com', '⑥ RAW 默认值');
    eq(hostOf('github').api('acme/solo-skill'), 'https://api.github.com/repos/acme/solo-skill', '⑥ 默认下 api 地址与改前一致');
    eq(hostOf('github').tree('acme/solo-skill', 'main'), 'https://api.github.com/repos/acme/solo-skill/git/trees/main?recursive=1', '⑥ 默认下 tree 地址与改前一致');
    eq(hostOf('github').raw('acme/solo-skill', 'main', 'SKILL.md'), 'https://raw.githubusercontent.com/acme/solo-skill/main/SKILL.md', '⑥ 默认下 raw 地址与改前一致');
    process.env.CGUI_GITHUB_API_BASE = 'http://127.0.0.1:6801/';
    process.env.CGUI_GITHUB_RAW_BASE = 'http://127.0.0.1:6802';
    eq(ghApiBase(), 'http://127.0.0.1:6801', '⑥ 覆盖生效,末尾斜杠去掉');
    eq(hostOf('github').api('acme/solo-skill'), 'http://127.0.0.1:6801/repos/acme/solo-skill', '⑥ 仓库信息走替身');
    eq(hostOf('github').tree('acme/solo-skill', 'main'), 'http://127.0.0.1:6801/repos/acme/solo-skill/git/trees/main?recursive=1', '⑥ 树走替身');
    eq(hostOf('github').raw('acme/solo-skill', 'main', 'scripts/run.py'), 'http://127.0.0.1:6802/acme/solo-skill/main/scripts/run.py', '⑥ 原始文件走替身');
    eq(hostOf('gitee').api('a/b'), 'https://gitee.com/api/v5/repos/a/b', '⑥ Gitee 不受替身影响');
    eq(hostOf('gitee').raw('a/b', 'master', 'SKILL.md'), 'https://gitee.com/a/b/raw/master/SKILL.md', '⑥ Gitee raw 不受替身影响');
    delete process.env.CGUI_GITHUB_API_BASE;
    delete process.env.CGUI_GITHUB_RAW_BASE;
    eq(hostOf('github').api('a/b'), 'https://api.github.com/repos/a/b', '⑥ 删掉环境变量立即回到默认(调用时读,不是加载时读)');
  }

  // ⑦ 检查更新(R4)内容锁:root 为空串不能被当成"没有来源";根的 sha 取树接口顶层 sha
  {
    const src = await readFile(new URL('../../server/routes/skills.js', import.meta.url), 'utf8');
    ok(src.includes("if (!src?.repo || typeof src?.root !== 'string') continue;"), '⑦ 检查更新按类型判 root,不按假值判');
    ok(!src.includes('!src?.root'), '⑦ 旧的假值判断不复活');
    eq((src.match(/dirShas\[''\] = treeRes\.sha/g) || []).length, 2, '⑦ loadRepo 与 check-updates 都把顶层 sha 记为根的 sha');
    ok(src.includes("sourcesPatch[id] = { repo, branch, root: meta.root, host, sha: dirShas[meta.root] || null };"), '⑦ 来源记录行不变(r71 内容锁),根级靠 dirShas[\'\'] 命中');
    ok(!/`\$\{(?:s|meta|src)\.root\}\/SKILL\.md`/.test(src) && !/\.root\.length \+ 1/.test(src) && !/startsWith\(`\$\{meta\.root\}\/`\)/.test(src), '⑦ 三种会对空串出错的拼法在源码里不再出现');
    ok(/const rel = relTo\(meta\.root, f\.path\)/.test(src) && /files\.filter\(\(f\) => inRoot\(meta\.root, f\.path\)\)/.test(src), '⑦ 导入的文件筛选与相对路径都走小函数');
  }

  // ⑧ 面板(R3)内容锁:0 条不写「此源已全部安装」;两句既有文案逐字不变
  {
    const panel = await readFile(new URL('../../client/src/components/SkillsPanel.jsx', import.meta.url), 'utf8');
    ok(/const marketNoneFound = !loadingOff && offSettled && !isAllSources && official\.length === 0;/.test(panel), '⑧ 0 条判定:单个源下、加载完成、列表为空');
    ok(/const offSettled = !!offErr \|\| officialMeta\.count !== undefined;/.test(panel), '⑧ "加载完成"看是否报错或拿到过 count,首帧不算 0 条');
    ok(/\{marketNoneFound \? \(/.test(panel), '⑧ 0 条时不渲染一键导入按钮');
    ok(/这个仓库里没有找到技能\(SKILL\.md\)/.test(panel), '⑧ 说明文字含「没有找到技能」与「SKILL.md」');
    ok(panel.includes("notInstalled.length === 0 ? '此源已全部安装' : `一键导入全部(${notInstalled.length})`"), '⑧ 「此源已全部安装」/「一键导入全部(N)」文案与判定逐字不变');
  }
} catch (e) { failure = e; } finally {
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_PROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_PROFILE;
}
if (failure) throw failure;
console.log(`check-r124-skill-root-import: ${n} 条断言全通过(临时 HOME 隔离,未碰真实 ~/.claude;不联网)`);
