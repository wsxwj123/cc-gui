// 把仓库根的 CHANGELOG.md 切成前端能按需读的 JSON —— 应用内「更新说明」弹窗的数据源。
//
// 为什么在构建期切、而不是运行时拉 GitHub Release:
//   弹窗只需要"本次装的这一版做了什么",这份内容在打包那一刻就完全确定,没有任何理由
//   放到运行时去问网络。切进 bundle 后墙内/断网/GitHub 限流全部与这条路径无关。
//   (GitHub Release body 只喂 Tauri updater,与本弹窗无关。)
//
// 产物(全部进仓,构建不产生脏 diff —— 见下面的内容哈希跳过):
//   client/src/generated/release-notes/index.json        [{ version, date }] 新→旧,轻量
//   client/src/generated/release-notes/<version>.json    单版正文 { version, date, groups }
//   client/src/generated/release-notes/_source-hash.json { hash } 源文件哈希,用于跳过重写
//
// 用法: node scripts/gen-release-notes.mjs [CHANGELOG.md 路径] [输出目录]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_CHANGELOG = join(ROOT, 'CHANGELOG.md');
export const DEFAULT_OUT_DIR = join(ROOT, 'client', 'src', 'generated', 'release-notes');
const INDEX_FILE = 'index.json';
const HASH_FILE = '_source-hash.json';

// `## 0.2.313`、`## v0.2.313`、`## 0.2.313 (2026-08-19)`、`## 0.2.313 — 2026-08-19` 都收。
// 不匹配的二级标题(如文件开头的说明段落标题)不属于任何版本,直接丢弃,不抛错。
const VERSION_HEADING = /^##\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)\b(.*)$/;
const DATE_IN_HEADING = /(\d{4}-\d{2}-\d{2})/;
const GROUP_HEADING = /^###\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;

// 语义化版本降序比较(新的排前面)。预发布后缀只参与字符串兜底比较,够用。
export function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < 3; i++) {
    const na = Number(pa[i]) || 0;
    const nb = Number(pb[i]) || 0;
    if (na !== nb) return nb - na;
  }
  return String(b).localeCompare(String(a));
}

// CHANGELOG 文本 → [{ version, date, groups:[{ title, items:[string] }] }],新→旧。
// 容错口径(任何一条都不许抛):空文件/无版本标题 → []; 缺 `###` 分组 → 落进 title:''
// 的匿名组; 版本号格式异常的二级标题 → 整段忽略; 同版本重复出现 → 保留首次。
export function parseChangelog(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const entries = [];
  let cur = null;
  let group = null;
  const openGroup = (title) => {
    group = { title, items: [] };
    cur.groups.push(group);
  };
  for (const line of lines) {
    const vh = line.match(VERSION_HEADING);
    if (vh) {
      cur = { version: vh[1], date: (vh[2].match(DATE_IN_HEADING) || [])[1] || null, groups: [] };
      group = null;
      entries.push(cur);
      continue;
    }
    if (/^##\s/.test(line)) { cur = null; group = null; continue; } // 非版本的二级标题 → 离开当前版本
    if (!cur) continue;
    const gh = line.match(GROUP_HEADING);
    if (gh) { openGroup(gh[1].trim()); continue; }
    const b = line.match(BULLET);
    if (!b) continue;
    const item = b[1].trim();
    if (!item) continue;
    if (!group) openGroup(''); // 缺分组标题:条目照收,渲染时不显组名
    group.items.push(item);
  }
  const seen = new Set();
  return entries
    .filter((e) => { if (seen.has(e.version)) return false; seen.add(e.version); return true; })
    .map((e) => ({ ...e, groups: e.groups.filter((g) => g.items.length) }))
    .sort((a, b) => compareVersions(a.version, b.version));
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// 切片并落盘。返回 { skipped, versions, written }。
// 内容哈希跳过:源文件没变就一个字节都不重写 —— 否则每次 build 都会让产物 mtime/内容
// 抖动出脏 diff(产物是进仓的)。force:true 可绕过(测试用)。
export function generate({ changelogPath = DEFAULT_CHANGELOG, outDir = DEFAULT_OUT_DIR, force = false } = {}) {
  let text = '';
  try { text = readFileSync(changelogPath, 'utf8'); } catch { text = ''; } // 缺文件 = 空 index,不炸构建
  const hash = sha256(text);
  const hashPath = join(outDir, HASH_FILE);
  const indexPath = join(outDir, INDEX_FILE);
  if (!force && existsSync(hashPath) && existsSync(indexPath)) {
    try {
      if (JSON.parse(readFileSync(hashPath, 'utf8')).hash === hash) {
        return { skipped: true, versions: JSON.parse(readFileSync(indexPath, 'utf8')).map((v) => v.version), written: [] };
      }
    } catch { /* 哈希文件坏了 → 照常重写 */ }
  }
  const entries = parseChangelog(text);
  mkdirSync(outDir, { recursive: true });
  const written = [];
  const keep = new Set([INDEX_FILE, HASH_FILE]);
  for (const e of entries) {
    const name = `${e.version}.json`;
    keep.add(name);
    writeFileSync(join(outDir, name), `${JSON.stringify(e, null, 2)}\n`);
    written.push(name);
  }
  // 清掉 CHANGELOG 里已不存在的版本(否则被删版本的 chunk 永远留在 bundle 里)。
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.json') && !keep.has(f)) rmSync(join(outDir, f));
  }
  writeFileSync(indexPath, `${JSON.stringify(entries.map((e) => ({ version: e.version, date: e.date })), null, 2)}\n`);
  writeFileSync(hashPath, `${JSON.stringify({ hash }, null, 2)}\n`);
  written.push(INDEX_FILE, HASH_FILE);
  return { skipped: false, versions: entries.map((e) => e.version), written };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const r = generate({
    changelogPath: process.argv[2] || DEFAULT_CHANGELOG,
    outDir: process.argv[3] || DEFAULT_OUT_DIR,
  });
  console.log(r.skipped
    ? `release-notes: 源未变,跳过(${r.versions.length} 版)`
    : `release-notes: 生成 ${r.versions.length} 版 → ${r.versions.slice(0, 3).join(', ')}${r.versions.length > 3 ? ' …' : ''}`);
}
