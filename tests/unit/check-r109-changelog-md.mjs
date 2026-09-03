// r109:CHANGELOG.md → README「更新记录」折叠块 / GitHub Release 正文。
// 钉住的核心不变量:
//   1) 折叠只给"标题 + 正文"的条目 —— 折叠一个空块没有意义;
//   2) <summary> 内不渲染 markdown,尖括号必须转实体,否则被当 HTML 标签吞掉;
//   3) <details>/<summary> 之后必须有空行,否则 GitHub 不渲染块内 markdown(渲染红线);
//   4) README 标记段必须与当前 CHANGELOG 同步(改了 CHANGELOG 忘跑生成 → 红)。
// Run: node tests/unit/check-r109-changelog-md.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  splitItem, renderItem, renderVersion, renderAll, renderRelease, applyReadme,
  START_MARK, END_MARK, DEFAULT_REPO,
} from '../../scripts/gen-changelog-md.mjs';

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { n++; assert.deepEqual(a, b, msg); };

const SCRIPT = fileURLToPath(new URL('../../scripts/gen-changelog-md.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const run = (args) => {
  const r = { code: 0, out: '' };
  try {
    r.out = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    r.code = e.status ?? 1;
    r.out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  return r;
};

const FIXTURE = `# 更新说明

说明段落。

## 0.9.1 (2026-01-02)

### 新增

- **带标题的条目**:这里是正文,含 <script> 与 a & b。
- **只有标题**
- 没有加粗标题的短条目

### 修复

- **另一条**:正文二。

## 0.9.0

- 匿名组里的条目
`;

// ── t1 splitItem:三种形态 ─────────────────────────────────────────────────
{
  eq(splitItem('**标题**:正文'), { title: '标题', body: '正文' }, 't1: 中文冒号被吃掉一个');
  eq(splitItem('**标题**: 正文'), { title: '标题', body: '正文' }, 't1: 英文冒号 + 空白');
  eq(splitItem('**标题**'), { title: '标题', body: '' }, 't1: 只有标题 → body 空');
  eq(splitItem('普通条目'), { title: '', body: '普通条目' }, 't1: 无加粗开头 → 整条当正文');
  eq(splitItem('**标题**::双冒号'), { title: '标题', body: ':双冒号' }, 't1: 只去掉一个冒号');
  eq(splitItem(''), { title: '', body: '' }, 't1: 空串不抛');
  eq(splitItem(null), { title: '', body: '' }, 't1: null 不抛');
  // 行内有加粗但不在开头 → 不当标题(否则 "支持 **粗体** 的说明" 会被切成标题)
  eq(splitItem('前缀 **粗体** 后缀').title, '', 't1: 加粗不在开头就不算标题');
}

// ── t2 renderItem:折叠 / 不折叠 / 实体转义 ────────────────────────────────
{
  const folded = renderItem('**标题**:正文');
  eq(folded, '<details><summary>标题</summary>\n\n正文\n\n</details>', 't2: 标题+正文 → 折叠块');
  ok(/<\/summary>\n\n/.test(folded), 't2: <summary> 之后必须空行(GitHub 才渲染块内 markdown)');
  ok(/\n\n<\/details>$/.test(folded), 't2: </details> 之前必须空行');
  eq(renderItem('**只有标题**'), '- **只有标题**', 't2: 无正文不折叠(点开是空的没有意义)');
  eq(renderItem('短条目'), '- 短条目', 't2: 无标题 → 普通列表项');

  const escaped = renderItem('**含 <b> 与 a & b 的标题**:正文里的 <script> 原样保留');
  ok(escaped.includes('<summary>含 &lt;b&gt; 与 a &amp; b 的标题</summary>'),
    't2: summary 里 < > & 转实体(summary 不渲染 markdown,裸尖括号会被当标签吞掉)');
  ok(escaped.includes('正文里的 <script> 原样保留'), 't2: 正文保持 markdown 原文,不转义');
  ok(renderItem('**带 `代码` 的标题**:正文').includes('<summary>带 `代码` 的标题</summary>'),
    't2: summary 里的反引号原样保留(不渲染成 code,但也不该被改写)');
}

// ── t3 renderVersion:summary 统计 / tag 链接 / 空行 ───────────────────────
{
  const v091 = { version: '0.9.1', date: '2026-01-02', groups: [{ title: '新增', items: ['a'] }, { title: '修复', items: ['x', 'y'] }] };
  const v090 = { version: '0.9.0', date: null, groups: [{ title: '', items: ['匿名'] }] };
  const noTag = renderVersion(v091, { tags: [] });
  ok(noTag.startsWith('<details>\n<summary><b>v0.9.1</b>(2026-01-02)· 新增 1 条 · 修复 2 条</summary>\n\n'),
    't3: summary 统计按 groups 顺序,版本号无 tag 时是纯文本');
  const withTag = renderVersion(v091, { tags: ['v0.9.0', 'v0.9.1'] });
  ok(withTag.includes(`<a href="https://github.com/${DEFAULT_REPO}/releases/tag/v0.9.1">v0.9.1</a>`),
    't3: tag 存在 → 版本号做成 release 链接(用 <a>,summary 不渲染 markdown 的 [](  ))');
  ok(!withTag.includes('[v0.9.1]'), 't3: 不许用 markdown 链接语法');
  ok(renderVersion(v090, { tags: [] }).includes('<summary><b>v0.9.0</b>· 1 条</summary>'),
    't3: 无日期不带括号;匿名组统计不出现组名、不留双空格');
  ok(renderVersion(v091, { tags: [] }).includes('\n\n**新增**\n\n'), 't3: 组名单独一行,前后各一个空行');
  ok(renderVersion(v091, { tags: [] }).endsWith('\n\n</details>'), 't3: 版本块以空行 + </details> 收尾');
  eq(renderVersion({ version: '1.0.0', date: null, groups: [] }, {}),
    '<details>\n<summary><b>v1.0.0</b></summary>\n\n</details>', 't3: 空版本不产生连续空行');
}

// ── t4 renderAll:顺序 / limit ─────────────────────────────────────────────
{
  const all = renderAll(FIXTURE, { tags: [] });
  ok(all.indexOf('v0.9.1') < all.indexOf('v0.9.0'), 't4: 新版在前(沿用 parseChangelog 的排序)');
  eq((all.match(/<summary><b>/g) || []).length, 2, 't4: 两个版本各一个外层 summary');
  ok(/<\/details>\n\n<details>\n<summary><b>v0\.9\.0/.test(all), 't4: 版本之间恰好一个空行');
  const one = renderAll(FIXTURE, { tags: [], limit: 1 });
  eq((one.match(/<summary><b>/g) || []).length, 1, 't4: limit=1 只渲染最新一版');
  ok(!one.includes('v0.9.0'), 't4: limit 截掉旧版本');
  eq(renderAll('', { tags: [] }), '', 't4: 空 CHANGELOG → 空串,不抛');
}

// ── t5 renderRelease:单版正文,不含最外层版本 details ─────────────────────
{
  const body = renderRelease(FIXTURE, '0.9.1');
  ok(body.startsWith('**新增**'), 't5: 直接从分组开始');
  ok(!body.includes('<b>v0.9.1</b>'), 't5: 不含最外层版本 summary(release 页面已经是这一版的语境)');
  ok(body.includes('<details><summary>带标题的条目</summary>'), 't5: 条目仍然折叠');
  eq(renderRelease(FIXTURE, 'v0.9.1'), body, 't5: 版本号可带 v 前缀');
  eq(renderRelease(FIXTURE, '9.9.9'), '', 't5: 版本不存在 → 空串(CI 不因缺条目失败)');
  eq(renderRelease(FIXTURE, ''), '', 't5: 空版本号 → 空串');
}

// ── t6 applyReadme:替换 / 缺标记抛错 ──────────────────────────────────────
{
  const readme = `# T\n\n${START_MARK}\n\n旧内容\n\n${END_MARK}\n\n## 尾部\n`;
  const next = applyReadme(readme, '新内容');
  eq(next, `# T\n\n${START_MARK}\n\n新内容\n\n${END_MARK}\n\n## 尾部\n`, 't6: 只换标记之间,标记行与前后文保留');
  ok(!next.includes('旧内容'), 't6: 旧内容被清掉');
  eq(applyReadme(applyReadme(readme, 'x'), 'x'), applyReadme(readme, 'x'), 't6: 幂等');
  assert.throws(() => applyReadme('# 没有标记', 'x'), /README 缺少 CHANGELOG 标记/, 't6: 缺标记抛错'); n++;
  assert.throws(() => applyReadme(`${START_MARK}\n无结束标记`, 'x'), /README 缺少 CHANGELOG 标记/, 't6: 只有开始标记也抛'); n++;
  assert.throws(() => applyReadme(`${END_MARK}\n${START_MARK}`, 'x'), /README 缺少 CHANGELOG 标记/, 't6: 标记顺序反了也抛'); n++;
}

// ── t7 CLI:--check 对当前仓库必须过;--release 打印单版正文 ────────────────
{
  const check = run(['--check']);
  eq(check.code, 0, `t7: 仓库 README 标记段必须与 CHANGELOG 同步(不同步就跑 npm run gen:readme-changelog)\n${check.out}`);

  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const rel = run(['--release', pkgVersion]);
  eq(rel.code, 0, 't7: --release 退出码 0');
  ok(rel.out.includes('<details>'), `t7: --release ${pkgVersion} 输出含折叠块`);
  ok(!rel.out.includes(`<b>v${pkgVersion}</b>`), 't7: --release 不含最外层版本 summary');
  eq(run(['--release', '99.99.99']).out, '', 't7: 不存在的版本 → 空输出,退出码 0');
  eq(run(['--release', '99.99.99']).code, 0, 't7: 不存在的版本不让 CI 红');
}

// ── t8 README 现状:标记段存在且渲染红线成立 ───────────────────────────────
{
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  ok(readme.includes('## 六、更新记录'), 't8: README 有「六、更新记录」一节');
  const seg = readme.slice(readme.indexOf(START_MARK), readme.indexOf(END_MARK));
  ok(seg.includes('<details>'), 't8: 标记段里有折叠块');
  // summary 里不许出现未转义的尖括号(除自身的 <b>/<a> 标签)
  const bad = [...seg.matchAll(/<summary>([\s\S]*?)<\/summary>/g)]
    .map((m) => m[1].replace(/<\/?b>/g, '').replace(/<a href="[^"]*">/g, '').replace(/<\/a>/g, ''))
    .filter((s) => /[<>]/.test(s));
  eq(bad, [], 't8: summary 内无未转义尖括号');
  const lines = seg.split('\n');
  const noBlank = lines.filter((l, i) => /<\/summary>\s*$/.test(l) && lines[i + 1] !== '');
  eq(noBlank, [], 't8: 每个 </summary> 之后都有空行(GitHub 渲染红线)');
  eq((seg.match(/<details/g) || []).length, (seg.match(/<\/details>/g) || []).length, 't8: details 开闭配对');
}

// ── t9 生成是纯函数:同输入同输出,且不写仓库文件 ───────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'cgui-r109-'));
  const f = join(dir, 'README.md');
  writeFileSync(f, `${START_MARK}\n\nx\n\n${END_MARK}\n`);
  const a = renderAll(FIXTURE, { tags: ['v0.9.1'] });
  const b = renderAll(FIXTURE, { tags: ['v0.9.1'] });
  eq(a, b, 't9: 同输入同输出(README 才不会每次 build 抖出脏 diff)');
  writeFileSync(f, applyReadme(readFileSync(f, 'utf8'), a));
  ok(readFileSync(f, 'utf8').includes('v0.9.1'), 't9: applyReadme 结果可直接落盘');
}

console.log(`check-r109-changelog-md: all passed (${n} 条断言)`);
