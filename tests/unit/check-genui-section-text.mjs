#!/usr/bin/env node
// r66 单测:genui 常驻教学层(注入每次 GUI 会话系统提示的那一小段)。
//   t1 文本锁 —— 围栏教 cgui-ui;44 类【从真相源 guard.ts 派生】双向比对;
//               r67 起还有字段速查:签名【从真相源 SKILL.md 派生】做子集比对,
//               两处字段名漂移就红(t1-f);
//               未移植能力(panel/append/render_ui/validate_dsh_ui)一律不得出现;
//               secrets 禁令必须在场;体量不得膨胀。
//   t2 接线锁 —— 开关开→append 带教学段(且拼在既有 append 之后,不覆盖);关→不带。
//               走 chat.js 导出的真函数,不是复刻。
//   t3 复用键 —— genui 计入 chatCompatKey(开/关不同 key;缺省 = 开)。
//   t4 只服务 GUI —— 教学段常量在 server/ 里只被 chat.js import,
//               composeGenuiAppend 只有一个调用点(GUI spawn 块);bots 拿不到。
//
// 变异哨兵(逐条实际验证过红):
//   ① composeGenuiAppend 删掉 `genui === false` 门控(恒注入) → t2-b 红
//   ② chatCompatKey 的 return 体删掉 genui 字段 → t3 红
//   ③ 教学段里补回上游的 panel / "append":true / render_ui 段落 → t1-c 红
//   ④ guard.ts 的 GENUI_NODE_TYPES 增删一个 type 而教学段不跟 → t1-b 红
//   ⑤ 把 composeGenuiAppend 也接到第二处(bots 侧)调用 → t4-b 红
//   ⑥ 速查段把 keyvalue 的 pairs 写回 items → t1-f(a) 红(实测:keyvalue.items)
//   ⑦ 速查段把 code 的 lang 写成 language → t1-f(a) 红(实测:code.language)
//   ⑧ 删掉速查段里 quiz 那一行 → t1-f(c) 红(实测:quiz)
// Run: node tests/unit/check-genui-section-text.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const { GENUI_SECTION_TEXT } = await import('../../server/utils/genui-section.js');
const TEXT = GENUI_SECTION_TEXT;

// ── t1-a 围栏语法:教的是 cgui-ui,且给了一个可照抄的最小例子 ─────────────
{
  assert.match(TEXT, /```cgui-ui\n/, 't1-a: 必须含一个 cgui-ui 围栏示例(模型照抄的就是它)');
  assert.match(TEXT, /"items"/, 't1-a: 例子里要出现 items —— 根对象的唯一必填字段');
  // dsh-ui 只是渲染端的兼容别名。教它 = 模型会去写一个本仓文档里根本不存在的标记。
  assert.ok(!TEXT.includes('dsh-ui'), 't1-a: 不得教 dsh-ui(仅渲染端兼容,不是我们的对外标记)');
  assert.ok(!/dsh/i.test(TEXT), 't1-a: 整段不该残留任何 dsh 字样(移植痕迹)');
}

// ── t1-b 类型白名单:从真相源派生双向比对,不许在这里硬编码第二份 44 类 ────
// 真相源 = 渲染守卫实际放行的集合。教学段少写一类 = 模型不会用它;多写一类 =
// 模型写了却被静默丢弃。两个方向都必须红。
{
  const guard = read('client', 'src', 'genui', 'upstream', 'guard.ts');
  const setBody = guard.match(/GENUI_NODE_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(setBody, 't1-b: 没能在 guard.ts 里找到 GENUI_NODE_TYPES —— 真相源挪窝了,先修本测试的取法');
  const truth = new Set([...setBody[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));
  assert.equal(truth.size, 44, `t1-b: guard.ts 白名单应为 44 类,实得 ${truth.size}(契约 §2 变了就同步教学段与本行)`);

  // 教学段里的清单行形如 `- 布局：text · row · col`,类型后可带 `（说明）`。
  const listBlock = TEXT.slice(0, TEXT.indexOf('\n规则：'));
  assert.ok(listBlock.length > 0, 't1-b: 教学段必须有「规则：」把类型清单与行为规则分开');
  const listed = new Set();
  for (const line of listBlock.split('\n')) {
    const m = line.match(/^- [^：]+：(.+)$/);
    if (!m) continue;
    for (const tok of m[1].split('·')) listed.add(tok.replace(/（[\s\S]*$/, '').trim());
  }
  const missing = [...truth].filter((t) => !listed.has(t));
  const extra = [...listed].filter((t) => !truth.has(t));
  assert.deepEqual(missing, [], `t1-b: 教学段漏了这些 type(模型将永远不会用):${missing.join(',')}`);
  assert.deepEqual(extra, [], `t1-b: 教学段写了守卫不认的 type(模型写了会被丢弃):${extra.join(',')}`);
  assert.equal(listed.size, 44, `t1-b: 教学段应列 44 类,实得 ${listed.size}`);
  // 文案里那句"44 种"也得跟着真相源走,别留个对不上的数字
  assert.ok(TEXT.includes(`${truth.size} 种`), `t1-b: 正文里的类型数量应写 ${truth.size} 种`);
}

// ── t1-c 未移植的能力一个都不许教(教了 = 模型调用不存在的东西) ──────────
{
  for (const [bad, why] of [
    ['"panel":true', '面板 dock 未移植'],
    ['"append":true', '面板追加未移植'],
    ['render_ui', '该工具未移植'],
    ['validate_dsh_ui', '该校验工具未移植 —— 正因为没有它,JSON 合法性才要模型自查'],
    ['toolview', '工具行卡片未移植'],
  ]) {
    assert.ok(!TEXT.includes(bad), `t1-c: 教学段不得出现 ${bad}(${why})`);
  }
  // "panel" 单词本身也不该出现(上游那段整体删掉,不是删一半)
  assert.ok(!/\bpanel\b/i.test(TEXT), 't1-c: panel 段落必须整体删掉');
}

// ── t1-d 必须保留的几条(删了就是回到"能用但会闯祸/不会用")────────────────
{
  // secrets 禁令:安全红线,任何精简都不得砍它
  assert.ok(TEXT.includes('密码') && /API\s*Key/i.test(TEXT) && TEXT.includes('令牌'),
    't1-d: secrets 禁令必须保留(不索取密码 / API Key / 令牌)');
  assert.ok(TEXT.includes('password'), 't1-d: 要点明 inputType:"password" 的值不会外发');
  // 触发时机:没有它模型知道语法也不会主动用 = 整个功能还是形同虚设
  assert.ok(TEXT.includes('结构化'), 't1-d: 要写清什么时候该用(结构化优于纯文本)');
  assert.ok(TEXT.includes('纯问答'), 't1-d: 也要写清什么时候不该用');
  // 没有 validate 工具了,JSON 合法性只能靠模型自查 + 坏围栏降级
  assert.ok(TEXT.includes('降级'), 't1-d: 要说明坏围栏降级为代码块(替代已删的 validate 工具)');
  // action 语义 + 回传形态
  assert.ok(TEXT.includes('[genui-action]'), 't1-d: 必须点明用户操作以 [genui-action] 开头的消息回传');
  assert.ok(TEXT.includes('禁用态'), 't1-d: 必须点明无 action 的按钮是禁用态');
  assert.ok(TEXT.includes('持久化'), 't1-d: durable state 一句');
  assert.ok(TEXT.includes('卷子模式'), 't1-d: 卷子模式一句');
  // 规模上限:用本仓 guard 的真实数字(契约 §1.3),别照抄上游
  assert.ok(TEXT.includes('200 节点') && TEXT.includes('8 层'), 't1-d: 规模上限用本仓真实数字');
  // 结尾指向技能:字段细节不在这里,靠它兜
  assert.ok(TEXT.includes('cgui-ui 技能'), 't1-d: 要指向 cgui-ui 技能查字段细节');
}

// ── t1-e 体量:每回合每会话都在烧 token,只许放"不放就出错"的东西 ──────────
// r67 加了字段速查(~2.4KB):不给字段名模型就猜,猜错 = 整节点被静默丢弃。
// 速查段单独设上限,防止有人把技能里的取值全集/示例一路抄回常驻段。
{
  const bytes = Buffer.byteLength(TEXT, 'utf8');
  assert.ok(bytes < 5600, `t1-e: 教学段 ${bytes} 字节,超了 5600 —— 细节该进技能不该进常驻注入`);
  assert.ok(bytes > 1200, `t1-e: 教学段只有 ${bytes} 字节,大概率被截断/写漏了`);
  const cheatBytes = Buffer.byteLength(TEXT.slice(TEXT.indexOf('\n字段速查')), 'utf8');
  assert.ok(cheatBytes < 2600, `t1-e: 字段速查段 ${cheatBytes} 字节,超了 2600 —— 只留必填+易错字段,装饰性可选字段留给技能`);
}

// ── t1-f 字段速查:签名从 SKILL.md 真相源派生比对,不许写第二份字段定义 ─────
// r67 根因:r66 只列了 44 个类型名。用户首条真机消息 20 节点里 4 个因字段名猜错
// 被【整节点丢弃】(3×code 写成 {language,content}、1×keyvalue 写成 {items:[…]})。
// 字段定义的唯一真相源是内置技能 SKILL.md;这里只钉"速查段写的字段在 SKILL.md
// 里确实是该类型的字段",两处任何一侧改名都会红。
{
  // `"字段名":` —— 签名里的键。枚举值(如 "16:9|4:3")首字符非字母,不会误命中。
  const fieldsOf = (s) => new Set([...s.matchAll(/"([A-Za-z][A-Za-z0-9]*)"\s*:/g)].map((m) => m[1]));

  // 真相源:SKILL.md 的组件签名块。块头形如 `- keyvalue：` / `- row / col：`,
  // 续行(缩进)属于同一块,顶格非签名行结束该块。
  const skill = read('server', 'assets', 'builtin-skills', 'cgui-ui', 'SKILL.md');
  const truth = new Map();
  let cur = null;
  for (const line of skill.split('\n')) {
    const head = line.match(/^- ([a-z0-9][a-z0-9 /-]*)：/);
    if (head) {
      cur = head[1].split('/').map((t) => t.trim()).filter(Boolean);
      for (const t of cur) if (!truth.has(t)) truth.set(t, new Set());
    } else if (!/^\s/.test(line)) {
      cur = null; // 顶格的表格/标题/正文 = 上一个签名块到此为止
    }
    if (!cur) continue;
    for (const f of fieldsOf(line)) for (const t of cur) truth.get(t).add(f);
  }
  assert.ok(truth.has('code') && truth.has('keyvalue'),
    't1-f: 没能从 SKILL.md 解析出组件签名 —— 真相源格式变了,先修本测试的取法再说');

  // 速查段:每行 `- <类型> {签名}`,可用 · / ； 并列多个类型。
  const cheat = TEXT.slice(TEXT.indexOf('\n字段速查'));
  const seen = new Map();
  for (const line of cheat.split('\n')) {
    if (!line.startsWith('- ')) continue;
    for (const chunk of line.slice(2).split(/[·；]/)) {
      const at = chunk.indexOf('{');
      if (at < 0) continue; // 纯说明(如 divider / spacer 无其余字段)
      const names = (chunk.slice(0, at).match(/[a-z][a-z0-9-]*/g) || []).filter((w) => truth.has(w));
      if (!names.length) continue;
      for (const f of fieldsOf(chunk.slice(at))) {
        for (const n of names) seen.set(n, (seen.get(n) || new Set()).add(f));
      }
    }
  }

  // (a) 主锁:速查段的每个字段都必须是 SKILL.md 里该类型的字段
  const drift = [];
  for (const [type, fields] of seen) {
    for (const f of fields) if (!truth.get(type).has(f)) drift.push(`${type}.${f}`);
  }
  assert.deepEqual(drift, [],
    `t1-f: 速查段这些字段在 SKILL.md 的对应类型里不存在(教了模型一个会被丢弃的字段名):${drift.join(', ')}`);

  // (b) 本次实锤踩坑的两个签名必须在场,且写的是正确那一版
  assert.ok(seen.get('code')?.has('lang') && seen.get('code')?.has('code'),
    't1-f: code 必须给出 lang/code 签名(用户实测 3 个 code 节点因写成 language/content 被丢弃)');
  assert.ok(seen.get('keyvalue')?.has('pairs'),
    't1-f: keyvalue 必须给出 pairs 签名(用户实测因写成 items 被丢弃)');
  assert.ok(!/"language"\s*:/.test(cheat) && !/"content"\s*:\s*""\}\s*（是 lang/.test(cheat),
    't1-f: 速查段不得把错字段名写成签名形态(模型会照抄)');

  // (c) 覆盖:除了没有字段可写的 divider/spacer,44 类都得有签名。
  //     新增类型只进类型清单不进速查 = 又回到"模型只能猜字段"的老问题。
  const guard = read('client', 'src', 'genui', 'upstream', 'guard.ts');
  const all = [...guard.match(/GENUI_NODE_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/)[1]
    .matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  const NO_FIELDS = new Set(['divider', 'spacer']); // 只有 type,没什么可写错的
  const uncovered = all.filter((t) => !NO_FIELDS.has(t) && !seen.has(t));
  assert.deepEqual(uncovered, [],
    `t1-f: 这些 type 在速查段里没有签名(模型只能猜字段名):${uncovered.join(',')}`);
}

// ── t2 接线锁:走 chat.js 的真函数(复刻一份等于测一条线上不存在的路径) ────
{
  const { composeGenuiAppend, composeAppendSystemPrompt } = await import('../../server/routes/chat.js');
  const planOnly = composeAppendSystemPrompt(undefined); // 既有 append(规划引导)

  // (a) 开着:教学段在场,且既有 append 原样保留在前面 —— 拼接不覆盖
  const on = composeGenuiAppend(planOnly, undefined); // 不传 = 开(老客户端不传该字段)
  assert.ok(on.startsWith(planOnly), 't2-a: 既有 append 必须原样在前(覆盖它会弄丢规划引导)');
  assert.ok(on.includes(TEXT), 't2-a: 开着时教学段必须完整拼进去');
  assert.equal(composeGenuiAppend(planOnly, true), on, 't2-a: 显式 true 与缺省一致');

  // (b) 关掉:教学段一个字都不进 —— 这就是 r64 成功标准 7 的兑现处
  const off = composeGenuiAppend(planOnly, false);
  assert.equal(off, planOnly, 't2-b: 关掉后 append 必须回到"只有既有内容"');
  assert.ok(!off.includes('cgui-ui'), 't2-b: 关掉后不得残留任何围栏教学(变异哨兵①:删门控这里红)');

  // (c) 用户超长 append 不得把定长教学段挤成半句(截断只作用于用户那半)
  const huge = composeGenuiAppend('x'.repeat(20000), true);
  assert.ok(huge.endsWith(TEXT), 't2-c: 教学段必须完整收尾,不能被 8000 截断切一半');
  assert.ok(huge.startsWith('x'.repeat(8000)) && !huge.includes('x'.repeat(8001)),
    't2-c: 用户 append 仍按 8000 截断(既有行为不变)');

  // (d) 源码守卫:调用点确实接上去了,且 genui 从请求体一路传到复用键
  const chat = read('server', 'routes', 'chat.js');
  assert.match(chat, /const fullAppend = composeGenuiAppend\(appendText, genui\);/,
    't2-d: spawn 块必须用 composeGenuiAppend 组装 append');
  assert.match(chat, /append: fullAppend/, 't2-d: systemPrompt.append 取的是拼好的那份');
  assert.match(chat, /^\s*genui,$/m, 't2-d: genui 必须从 req.body 解构出来');
  // 前端门控通道:store 的 genuiRender 随请求体上来(不开旁路,仍走唯一发送入口)
  const app = read('client', 'src', 'App.jsx');
  assert.match(app, /genui: useStore\.getState\(\)\.genuiRender !== false,/,
    't2-d: 前端必须把渲染开关随 /api/chat 请求体发上来');
}

// ── t3 复用键:开关必须计入,否则翻完开关复用旧进程 = 开关是摆设 ───────────
{
  const { chatCompatKey } = await import('../../server/routes/chat.js');
  const base = {
    workingDir: '/tmp/proj', effort: null, appendSystemPrompt: '', promptSuggestions: false,
    excludeDynamicSystemPrompt: 'auto', globalRead: true, dirs: ['/'], maxBudgetUsd: null,
  };
  assert.notEqual(chatCompatKey({ ...base, genui: true }), chatCompatKey({ ...base, genui: false }),
    't3: 开/关必须是不同 key(变异哨兵②:删 key 里的 genui 字段这里红)');
  assert.equal(chatCompatKey({ ...base }), chatCompatKey({ ...base, genui: true }),
    't3: 缺省 = 开(老客户端不传该字段时不该白白重建进程)');
  assert.equal(chatCompatKey({ ...base, genui: undefined }), chatCompatKey({ ...base, genui: true }),
    't3: undefined 同缺省');
  // 调用点真的把 genui 传进去了(单测能构造参数,但线上路径漏传照样不红)
  assert.match(read('server', 'routes', 'chat.js'), /const reuseKey = chatCompatKey\(\{[\s\S]{0,400}?\n\s*genui,\n\s*\}\);/,
    't3: POST /chat 的 reuseKey 计算必须把 genui 传进去');
}

// ── t4 只服务 GUI 会话:bots 绝不能带上这段(Telegram/微信渲染不了围栏) ────
{
  // (a) 教学段常量在 server/ 里只允许 chat.js import
  const importers = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|mjs|cjs)$/.test(name)) continue;
      const src = readFileSync(p, 'utf8');
      if (/from '.*genui-section\.js'/.test(src)) importers.push(p.slice(ROOT.length + 1));
    }
  };
  walk(join(ROOT, 'server'));
  assert.deepEqual(importers, ['server/routes/chat.js'],
    `t4-a: 教学段只许 chat.js 引用(GUI 会话路径),实得:${importers.join(', ')}`);

  // (b) composeGenuiAppend 只有一个调用点。多一处 = 有人把它接到了别的 spawn 路径上
  //     (bots.local.js 是本机私有文件、不在公开仓,所以这里钉的是"全仓只有一个调用点",
  //      比只 grep bots 更强 —— 任何新增的非 GUI spawn 路径都会红)。
  const calls = [];
  const walkAll = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walkAll(p); continue; }
      if (!/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(name)) continue;
      if (p.includes(join('tests', 'unit'))) continue; // 本测试自己会调
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (/composeGenuiAppend\(/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !/export function/.test(line)) {
          calls.push(`${p.slice(ROOT.length + 1)}: ${line.trim()}`);
        }
      }
    }
  };
  walkAll(join(ROOT, 'server'));
  walkAll(join(ROOT, 'client', 'src'));
  assert.equal(calls.length, 1,
    `t4-b: composeGenuiAppend 应只有 GUI spawn 一个调用点(变异哨兵⑤),实得 ${calls.length} 处:\n${calls.join('\n')}`);
  assert.ok(calls[0].startsWith('server/routes/chat.js:'), `t4-b: 唯一调用点应在 chat.js,实得 ${calls[0]}`);
}

console.log('✓ check-genui-section-text: t1 文本锁(44 类派生比对/裁剪/保留/体量) / t2 接线 / t3 复用键 / t4 仅 GUI —— 全通过');
