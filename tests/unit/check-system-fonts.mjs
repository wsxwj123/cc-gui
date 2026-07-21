#!/usr/bin/env node
// 字体枚举纯逻辑自检:css 解析(预设 vs 系统族名回退)/去重(系统与内置重名不重复)/
// 分组置顶(收藏组保序 → 内置组 → 系统组)/搜索过滤。DOM 相关(canvas 探测/
// queryLocalFonts)不在此测——那部分靠真浏览器实测。
import assert from 'node:assert/strict';
import {
  FONT_OPTIONS, readingFontCss, buildFontEntries, groupFonts,
} from '../../client/src/utils/systemFonts.js';

// ── readingFontCss:预设 id 命中 css;非预设当系统族名回退 ──
assert.equal(readingFontCss('newsreader'), "'Newsreader', Georgia, serif", '预设 id 返回其 css');
assert.equal(readingFontCss('mono'), "'JetBrains Mono', ui-monospace, monospace", '预设 mono');
assert.equal(readingFontCss('PingFang SC'), '"PingFang SC", system-ui, sans-serif', '系统族名回退带兜底');
assert.equal(readingFontCss('未安装的字体'), '"未安装的字体", system-ui, sans-serif', '未知值不抛,当族名');

// ── buildFontEntries:内置全保留 + 系统追加 + 去重 + 排序 ──
const entries = buildFontEntries(['PingFang SC', 'Menlo', 'Georgia', 'Georgia', 'Times New Roman', 'Songti SC']);
const builtins = entries.filter((e) => e.group === 'builtin');
const systems = entries.filter((e) => e.group === 'system');
assert.equal(builtins.length, FONT_OPTIONS.length, '内置 5 种全保留');
// Georgia / Times New Roman 与内置同名 → 系统组去重掉;重复的 Georgia 也去重
assert.deepEqual(systems.map((e) => e.name), ['Menlo', 'PingFang SC', 'Songti SC'], '系统组去内置重名+去重复+按名排序');
assert.equal(systems[0].css, '"Menlo", system-ui, sans-serif', '系统条目 css 用族名');
assert.equal(systems[0].key, 'Menlo', '系统条目 key = 族名');

// ── groupFonts:收藏置顶保序 → 内置 → 系统;收藏优先于分组 ──
const favs = ['PingFang SC', 'sans']; // 一个系统族 + 一个内置 id,故意乱序验保序
const g = groupFonts(entries, favs, '');
assert.deepEqual(g.favorites.map((e) => e.key), ['PingFang SC', 'sans'], '收藏组按收藏添加顺序,不按分组');
assert.ok(!g.builtins.some((e) => e.key === 'sans'), '已收藏的内置不再出现在内置组');
assert.ok(!g.systems.some((e) => e.key === 'PingFang SC'), '已收藏的系统字体不再出现在系统组');
assert.equal(g.builtins.length, FONT_OPTIONS.length - 1, '内置组 = 全部内置减去被收藏的 1 个');

// ── groupFonts:搜索过滤(匹配 name 或 key,大小写不敏感) ──
const s = groupFonts(entries, [], 'song');
assert.deepEqual(s.systems.map((e) => e.name), ['Songti SC'], '搜索 song 命中 Songti SC');
assert.equal(s.builtins.length, 0, '搜索 song 不命中任何内置');
const s2 = groupFonts(entries, [], '等宽');
assert.deepEqual(s2.builtins.map((e) => e.id || e.key), ['mono'], '中文 name 也可搜(等宽→mono)');
const s3 = groupFonts(entries, ['PingFang SC'], 'ping');
assert.deepEqual(s3.favorites.map((e) => e.key), ['PingFang SC'], '搜索同时作用于收藏组');

console.log('check-system-fonts: OK');
