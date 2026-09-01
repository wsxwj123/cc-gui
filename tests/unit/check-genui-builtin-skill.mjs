#!/usr/bin/env node
// r64 M11 单测:内置技能的三态 + 装/卸端点(INTERFACE §4.2 / §4.3)。
// HOME 隔离(mkdtemp),**绝不碰真实 ~/.claude**;端口取 OS 临时口(listen(0),真实端口从 server.address() 读回)。
//
//   t0 临时 HOME 隔离自证(写入真的落在沙箱里,真实 HOME 一个字节没动)
//   t1 三态现读:未安装 → 安装 → 已安装 → 归档 → 已归档 → 恢复 → 已安装
//   t2 已存在一律不覆盖(用户改过的 SKILL.md 必须原样保留)
//   t3 幂等:归档源已不在 = 目标已达成,回 ok 不报错、不误删旧归档
//   t4 错误契约:恢复时同名已存在 → 409 且不覆盖;非法 id → 400;装不进去 → 状态仍"未安装"
//
// 变异哨兵(逐条实际验证过红):
//   ① install 去掉"已存在跳过"改成无条件 writeFile → t2 红
//   ② archive 去掉源缺失早退(退回裸 rename) → t3 红(500 而非 200,且旧归档被误删)
//   ③ builtinSkillState 把 archived 也算成 installed → t1 红
//   ④ install 失败分支返回 state:'installed' → t4 红
// Run: node tests/unit/check-genui-builtin-skill.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const isWin = process.platform === 'win32';

const REAL_HOME = process.env.HOME;
const REAL_PROFILE = process.env.USERPROFILE;
const home = await mkdtemp(join(tmpdir(), 'cgui-genui-skill-'));
process.env.HOME = home;          // POSIX 上 os.homedir() 优先读 $HOME
process.env.USERPROFILE = home;   // Windows 读 %USERPROFILE%,不同设沙箱失效
// 必须先于 import:skills.js 的 SKILLS_DIR/ARCHIVE_DIR 是模块加载期绑定的常量。

const express = (await import('express')).default;
const skillsRoutes = (await import('../../server/routes/skills.js')).default;

const ID = 'cgui-ui';
const SKILLS = join(home, '.claude', 'skills');
const ARCHIVE = join(home, '.claude', 'skills-archive');
const MD = join(SKILLS, ID, 'SKILL.md');

const app = express();
app.use(express.json());
app.use('/api', skillsRoutes);
const server = await new Promise((res, rej) => {
  const s = app.listen(0, '127.0.0.1', () => res(s));
  s.once('error', rej);
});
const B = `http://127.0.0.1:${server.address().port}/api`;
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const post = async (p, body) => {
  const r = await fetch(B + p, body === undefined
    ? { method: 'POST' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const state = async () => (await get(`/skills/builtin/${ID}`)).body.state;
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

let failure = null;
try {
  // ── t0 临时 HOME 隔离自证 ────────────────────────────────────────────
  // 这条先跑:后面每一步都在写文件,若路径常量没落进沙箱,等于本单测在改用户的真实配置。
  ok(homedir() === home, `t0: os.homedir() 必须落在沙箱(实际 ${homedir()})`);
  ok(!(await exists(SKILLS)), 't0: 沙箱起点是干净的,还没有 skills 目录');
  const realSkill = join(REAL_HOME || '/nonexistent', '.claude', 'skills', ID);
  const realSkillBefore = await exists(realSkill);

  // ── t1 三态现读 + 一整圈状态流转 ────────────────────────────────────
  ok(await state() === 'missing', 't1: 起点是未安装');
  const inst = await post(`/skills/builtin/${ID}/install`);
  ok(inst.status === 200 && inst.body.state === 'installed', `t1: 安装应 200/installed(实际 ${inst.status}/${inst.body.state})`);
  ok(await state() === 'installed', 't1: 装完现读磁盘是已安装');
  const md = await readFile(MD, 'utf8');
  ok(md.includes('cgui-ui'), 't1: 装进去的是内置 SKILL.md 正文');
  ok(/^---[\s\S]*?name:\s*cgui-ui[\s\S]*?---/.test(md), 't1: SKILL.md 必须有 name 为 cgui-ui 的 frontmatter,否则 claude 不认这个技能');
  ok(!md.includes('validate_dsh_ui') && !md.includes('panel:true'),
    't1: 改写时必须删掉 CC-GUI 没有的上游内容(validate_dsh_ui 工具 / panel:true 常驻面板)');

  // 隔离自证的另一半:装完了,真实 HOME 那边状态没有任何变化
  ok((await exists(realSkill)) === realSkillBefore, 't0: 装到沙箱不得改动真实 HOME 下的同名技能');

  ok((await post('/skills/archive', { id: ID })).status === 200, 't1: 归档应 200');
  ok(await state() === 'archived', 't1: 归档后是已归档');
  ok(!(await exists(join(SKILLS, ID))) && await exists(join(ARCHIVE, ID)),
    't1: 归档 = 移出 claude 会扫的目录(这才是"模型不再被教")');
  ok((await post('/skills/restore', { id: ID })).status === 200, 't1: 恢复应 200');
  ok(await state() === 'installed', 't1: 恢复后回到已安装');

  // ── t2 已存在不覆盖 ─────────────────────────────────────────────────
  await writeFile(MD, '用户自己改过的内容-DO-NOT-OVERWRITE');
  const again = await post(`/skills/builtin/${ID}/install`);
  ok(again.status === 200 && again.body.state === 'installed', 't2: 已装时再点安装回"已安装",不报错');
  ok(again.body.skipped === true, 't2: 应显式标出这次没写盘');
  ok((await readFile(MD, 'utf8')).includes('DO-NOT-OVERWRITE'),
    't2: 已存在一律不覆盖 —— 用户可能改过这份文件,覆盖等于销毁用户数据');
  // 已归档时点安装同样不该把归档区的那份顶掉(否则用户停用的改动版被内置版偷偷换回)
  await post('/skills/archive', { id: ID });
  const whileArchived = await post(`/skills/builtin/${ID}/install`);
  ok(whileArchived.body.state === 'archived' && whileArchived.body.skipped === true,
    't2: 已归档时点安装回"已归档",不重新写一份到 skills/');
  ok((await readFile(join(ARCHIVE, ID, 'SKILL.md'), 'utf8')).includes('DO-NOT-OVERWRITE'),
    't2: 归档区里用户改过的那份原样保留');

  // ── t3 归档幂等:源已被手动删掉 ─────────────────────────────────────
  await post('/skills/restore', { id: ID });                    // 先回到已安装
  ok(await state() === 'installed', 't3: 前置——回到已安装');
  await mkdir(join(ARCHIVE, 'unrelated-skill'), { recursive: true });
  await writeFile(join(ARCHIVE, 'unrelated-skill', 'SKILL.md'), '别人的归档');
  await rm(join(SKILLS, ID), { recursive: true, force: true }); // 绕过界面直接删
  const gone = await post('/skills/archive', { id: ID });
  ok(gone.status === 200 && gone.body.ok === true,
    `t3: 归档时源已不在 = 目标已达成,必须 200 不报错(实际 ${gone.status})`);
  ok(await state() === 'missing', 't3: 之后现读是未安装(不谎称已归档)');
  ok(await exists(join(ARCHIVE, 'unrelated-skill', 'SKILL.md')), 't3: 空归档不得波及归档区里别的技能');

  // ── t4 错误契约 ─────────────────────────────────────────────────────
  await post(`/skills/builtin/${ID}/install`);
  await post('/skills/archive', { id: ID });
  ok(await state() === 'archived', 't4: 前置——已归档');
  await mkdir(join(SKILLS, ID), { recursive: true });
  await writeFile(MD, '别人的同名技能-MINE');
  const conflict = await post('/skills/restore', { id: ID });
  ok(conflict.status === 409, `t4: 恢复时本机已有同名 → 拒绝(实际 ${conflict.status})`);
  ok(/已存在|同名/.test(conflict.body.error || ''), 't4: 拒绝要给人话原因');
  ok((await readFile(MD, 'utf8')).includes('MINE'), 't4: 拒绝就不能覆盖对方的文件');

  // 非法 id 必须挡在 ID_RE 上。注:`..` 这种写法在 HTTP 客户端就被 URL 规范化吃掉了
  // (`/skills/builtin/..` 会塌成 `/skills`),测不到本路由;用带编码斜杠的 id 才真送得到。
  ok((await get('/skills/builtin/a%2Fb')).status === 400, 't4: 非法 id(带路径分隔符)必须 400');
  ok((await post('/skills/builtin/a%2Fb/install')).status === 400, 't4: 安装端点同样挡非法 id');
  const noSuch = await post('/skills/builtin/not-a-builtin-skill/install');
  ok(noSuch.status === 404 && noSuch.body.state === 'missing',
    't4: 安装包里没有的内置技能 → 404 且状态仍是未安装');

  // 安装失败(目标目录不可写):必须显式失败 + 状态保持"未安装",不得显示成功
  if (!isWin && process.getuid?.() !== 0) {
    await rm(join(SKILLS, ID), { recursive: true, force: true });
    await rm(join(ARCHIVE, ID), { recursive: true, force: true });
    await chmod(SKILLS, 0o500);
    try {
      const denied = await post(`/skills/builtin/${ID}/install`);
      ok(denied.status >= 400, `t4: 写不进去必须报错(实际 ${denied.status})`);
      ok(/失败|无法|权限|denied|EACCES/i.test(denied.body.error || ''), 't4: 失败原因要能看懂');
      ok(denied.body.state === 'missing', 't4: 装失败了状态必须仍是"未安装",不能显示成功');
    } finally { await chmod(SKILLS, 0o700); }
  }
} catch (e) { failure = e; } finally {
  server.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_PROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_PROFILE;
}
if (failure) throw failure;
console.log(`✓ check-genui-builtin-skill: ${n} 条断言全通过(临时 HOME 隔离,未碰真实 ~/.claude)`);
