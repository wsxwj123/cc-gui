// 把 CHANGELOG.md 渲染成两处 Markdown:README 里的「更新记录」折叠块,以及 GitHub
// Release 正文顶部的当轮更新记录。
//
// 复用 scripts/gen-release-notes.mjs 的 parseChangelog —— CHANGELOG 的解析口径只有一份,
// 这里只负责"解析结果 → Markdown"这一层,不碰 CHANGELOG 本身,也不改 gen-release-notes 行为。
//
// 折叠用 <details>:GitHub 的 Markdown 渲染器只在 <summary> 之后有空行时才把块内内容当
// markdown 渲染,所以下面每个 <details> 内部都严格留空行 —— 这是渲染红线,不是排版偏好。
// <summary> 内部不渲染 markdown,故标题里的 < > & 必须转成实体,否则被当 HTML 标签吃掉。
//
// 用法:
//   node scripts/gen-changelog-md.mjs --readme            按 CHANGELOG 重写 README 标记段
//   node scripts/gen-changelog-md.mjs --readme --assume-tag v0.2.375   本版 tag 还没打时也带链接
//   node scripts/gen-changelog-md.mjs --release 0.2.374   打印单版正文(CI 拼 release body)
//   node scripts/gen-changelog-md.mjs --check             README 标记段与生成结果是否一致
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseChangelog } from './gen-release-notes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_CHANGELOG = join(ROOT, 'CHANGELOG.md');
export const DEFAULT_README = join(ROOT, 'README.md');
export const DEFAULT_REPO = 'wsxwj123/claude-gui';
export const START_MARK = '<!-- CHANGELOG:START -->';
export const END_MARK = '<!-- CHANGELOG:END -->';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// `**标题**:正文` → { title:'标题', body:'正文' };没有加粗开头就整条当正文。
export function splitItem(item) {
  const raw = String(item ?? '').trim();
  const m = raw.match(/^\*\*(.+?)\*\*([\s\S]*)$/);
  if (!m) return { title: '', body: raw };
  return { title: m[1].trim(), body: m[2].trim().replace(/^[:：]\s*/, '').trim() };
}

// 一条 CHANGELOG 条目 → 折叠块或普通列表项。
// 只有"标题 + 正文"才值得折叠:折叠一个没有正文的块,点开是空的,没有意义。
export function renderItem(item) {
  const { title, body } = splitItem(item);
  if (!title) return `- ${body}`;
  if (!body) return `- **${title}**`;
  return `<details><summary>${esc(title)}</summary>\n\n${body}\n\n</details>`;
}

// 分组正文:组名一行(匿名组不输出组名),后接各条目。相邻块之间恰好一个空行。
function renderGroups(entry) {
  const blocks = [];
  for (const g of entry?.groups || []) {
    if (g.title) blocks.push(`**${g.title}**`);
    for (const it of g.items) blocks.push(renderItem(it));
  }
  return blocks.join('\n\n');
}

// 单个版本 → 默认折叠的 <details>。tags 里有 v<version> 时版本号做成 release 链接
// (summary 不渲染 markdown,所以用 <a href> 而不是 []())。
export function renderVersion(entry, { tags = [], repo = DEFAULT_REPO, headingLevel = 3 } = {}) {
  void headingLevel; // 版本本身就是 details,不需要标题层级;参数按接口保留
  const ver = `v${entry.version}`;
  const label = (tags || []).includes(ver)
    ? `<a href="https://github.com/${repo}/releases/tag/${ver}">${ver}</a>`
    : ver;
  const stats = (entry.groups || [])
    .map((g) => ['·', esc(g.title), String(g.items.length), '条'].filter(Boolean).join(' '))
    .join(' ');
  const summary = `<summary><b>${label}</b>${entry.date ? `(${entry.date})` : ''}${stats}</summary>`;
  const body = renderGroups(entry);
  return body
    ? `<details>\n${summary}\n\n${body}\n\n</details>`
    : `<details>\n${summary}\n\n</details>`;
}

// CHANGELOG 全文 → 全部版本的折叠块(新→旧)。limit 为数字时只取最新 N 个。
export function renderAll(text, { tags = [], repo = DEFAULT_REPO, limit } = {}) {
  let entries = parseChangelog(text);
  if (Number.isFinite(limit)) entries = entries.slice(0, limit);
  return entries.map((e) => renderVersion(e, { tags, repo })).join('\n\n');
}

// 指定版本的正文(不含最外层版本 details —— release 页面本身已经是"这一版"的语境)。
// 版本不存在返回空串:CI 不该因为某个 tag 忘了写条目而发布失败。
export function renderRelease(text, version, { repo = DEFAULT_REPO } = {}) {
  void repo; // 条目内不出现 release 链接,参数按接口保留
  const v = String(version ?? '').trim().replace(/^v/, '');
  const entry = parseChangelog(text).find((e) => e.version === v);
  return entry ? renderGroups(entry) : '';
}

// 用生成结果替换 README 两个标记之间的内容(标记行保留,标记与内容之间各留一个空行)。
export function applyReadme(readmeText, generated) {
  const text = String(readmeText ?? '');
  const i = text.indexOf(START_MARK);
  const j = text.indexOf(END_MARK);
  if (i < 0 || j < 0 || j < i) throw new Error('README 缺少 CHANGELOG 标记');
  return `${text.slice(0, i + START_MARK.length)}\n\n${String(generated ?? '').trim()}\n\n${text.slice(j)}`;
}

// 已发布的 tag 决定版本号是否做成链接。拿不到 git(打包产物、浅 clone)就都不加链接。
export function gitTags(cwd = ROOT) {
  try {
    return execFileSync('git', ['tag', '-l', 'v*'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// 把版本号的 release 链接还原成纯文本。
// --check 必须无视链接:发版顺序是"生成 README → commit → 打 tag",tag 一落地本地就
// 多一个 tag,不归一的话 --check 立刻红,而被 tag 的那棵树里本版又永远拿不到链接。
export function normalizeTagLinks(text) {
  return String(text ?? '').replace(/<a href="https:\/\/github\.com\/[^"]*\/releases\/tag\/[^"]*">([^<]*)<\/a>/g, '$1');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  let changelog = '';
  try { changelog = readFileSync(DEFAULT_CHANGELOG, 'utf8'); } catch { changelog = ''; }

  if (args.includes('--release')) {
    const out = renderRelease(changelog, args[args.indexOf('--release') + 1] || '');
    if (out) process.stdout.write(`${out}\n`);
  } else if (args.includes('--check') || args.includes('--readme')) {
    // --assume-tag v0.2.375(可重复):把还没打的 tag 当作已存在,发版脚本在打 tag 之前
    // 跑一次就能让本版带上 release 链接。--check 不看这个参数(链接会被归一掉)。
    const assumed = args
      .map((a, i) => (a === '--assume-tag' ? args[i + 1] : null))
      .filter((v) => v && !v.startsWith('--')); // 末尾缺值、或后面直接跟另一个 flag → 忽略
    const readme = readFileSync(DEFAULT_README, 'utf8');
    let next;
    try {
      next = applyReadme(readme, renderAll(changelog, { tags: [...new Set([...gitTags(), ...assumed])] }));
    } catch (e) {
      console.log(`${e.message} —— 在 README.md 里补上 ${START_MARK} 与 ${END_MARK} 两行`);
      process.exit(1);
    }
    if (args.includes('--check')) {
      if (normalizeTagLinks(next) !== normalizeTagLinks(readme)) {
        console.log('README 更新记录过期,运行 npm run gen:readme-changelog');
        process.exit(1);
      }
    } else if (next === readme) {
      console.log('README 更新记录:未变');
    } else {
      writeFileSync(DEFAULT_README, next);
      console.log(`README 更新记录:已更新 ${parseChangelog(changelog).length} 个版本`);
    }
  } else {
    console.log('用法: node scripts/gen-changelog-md.mjs --readme [--assume-tag <tag>] | --release <version> | --check');
  }
}
