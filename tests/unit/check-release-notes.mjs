// r17-2:更新后弹窗展示本次更新内容。
// 数据流:CHANGELOG.md →(构建期)scripts/gen-release-notes.mjs 切片 →
//        client/src/generated/release-notes/*.json 打进 bundle →(运行时)本地 import。
// 全程不联网 —— 弹窗要的内容在打包那一刻就完全确定,没理由到运行时去问 GitHub。
// Run: node tests/unit/check-release-notes.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChangelog, compareVersions, generate, DEFAULT_CHANGELOG, DEFAULT_OUT_DIR } from '../../scripts/gen-release-notes.mjs';

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { n++; assert.deepEqual(a, b, msg); };
const src = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
// 只剥整行注释与块注释:注释里为解释"为什么不用 localStorage"必然出现该词,
// 断言要看的是代码里有没有真的用它。
// 必须先剥整行 //(注释里出现的 `xxx/*.json` 会被当成块注释开头,吞掉后面整段代码),再剥块注释。
const code = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const FIXTURE = `# 更新说明

说明段落,不属于任何版本。

## 0.9.1 (2026-01-02)

### 新增

- 甲功能
- 乙功能

### 修复

- 丙 bug

## 0.9.0

### 修复

- 丁 bug
`;

// ── t1 解析:结构 / 分组 / 日期 / 顺序(新→旧) ───────────────────────────────
{
  const e = parseChangelog(FIXTURE);
  eq(e.map((x) => x.version), ['0.9.1', '0.9.0'], 't1: 版本按新→旧');
  eq(e[0].date, '2026-01-02', 't1: 标题里的日期被取出');
  eq(e[1].date, null, 't1: 没写日期就是 null');
  eq(e[0].groups.map((g) => g.title), ['新增', '修复'], 't1: 组名照抄 CHANGELOG,不写死枚举');
  eq(e[0].groups[0].items, ['甲功能', '乙功能'], 't1: 组内条目');
  eq(e[1].groups, [{ title: '修复', items: ['丁 bug'] }], 't1: 第二版正文不串到第一版');
  // 文件里顺序写反也要按语义化版本排回来
  const rev = parseChangelog('## 0.9.0\n\n- 老\n\n## 0.9.1\n\n- 新\n');
  eq(rev.map((x) => x.version), ['0.9.1', '0.9.0'], 't1: 源文件乱序也按 semver 降序输出');
  eq(parseChangelog('## 0.10.0\n- a\n## 0.9.0\n- b\n').map((x) => x.version), ['0.10.0', '0.9.0'], 't1: 10 > 9 走数值比较不是字典序');
  ok(compareVersions('1.0.0', '0.9.9') < 0, 't1: compareVersions 降序语义');
}

// ── t2 容错:空文件 / 无版本 / 缺分组标题 / 版本号异常 / 重复版本 —— 一律不抛 ──
{
  eq(parseChangelog(''), [], 't2: 空文件 → 空 index');
  eq(parseChangelog(null), [], 't2: null → 空 index');
  eq(parseChangelog('随便一段没有任何标题的文本'), [], 't2: 无版本标题 → 空 index');
  eq(parseChangelog('## 未发布\n\n- 什么东西\n').length, 0, 't2: 版本号格式异常的二级标题整段忽略');
  const noGroup = parseChangelog('## 1.2.3\n\n- 直接写条目没有分组标题\n');
  eq(noGroup[0].groups, [{ title: '', items: ['直接写条目没有分组标题'] }], 't2: 缺分组标题落进匿名组');
  eq(parseChangelog('## 1.2.3\n- a\n## 1.2.3\n- b\n').length, 1, 't2: 同版本重复只保留首次');
  eq(parseChangelog('## 1.2.3\n\n### 空组\n\n## 1.2.2\n- x\n')[1].groups.length, 1, 't2: 空组被剔除、后续版本照常解析');
}

// ── t3 生成:产物结构 / 内容哈希跳过 / 孤儿清理 ─────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'cgui-relnotes-'));
  const cl = join(dir, 'CHANGELOG.md');
  const out = join(dir, 'out');
  writeFileSync(cl, FIXTURE);

  const r1 = generate({ changelogPath: cl, outDir: out });
  eq(r1.skipped, false, 't3: 首次生成不跳过');
  eq(r1.versions, ['0.9.1', '0.9.0'], 't3: 返回版本列表');
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  eq(index, [{ version: '0.9.1', date: '2026-01-02' }, { version: '0.9.0', date: null }], 't3: index 只有 version/date,轻量');
  const one = JSON.parse(readFileSync(join(out, '0.9.1.json'), 'utf8'));
  eq(one.version, '0.9.1', 't3: 单版 JSON 带版本号');
  eq(one.groups[0], { title: '新增', items: ['甲功能', '乙功能'] }, 't3: 单版 JSON 带分组正文');
  ok(existsSync(join(out, '0.9.0.json')), 't3: 每个版本一个文件(可按需 code-split)');

  // 内容哈希跳过:源没变 → 第二次一个字节都不重写(产物进仓,否则每次 build 都脏 diff)
  const before = readdirSync(out).map((f) => [f, statSync(join(out, f)).mtimeMs]);
  const r2 = generate({ changelogPath: cl, outDir: out });
  eq(r2.skipped, true, 't3: 源未变 → skipped');
  eq(r2.written, [], 't3: 源未变 → 一个文件都不写');
  const after = readdirSync(out).map((f) => [f, statSync(join(out, f)).mtimeMs]);
  eq(after, before, 't3: 源未变 → 所有产物 mtime 不动');

  // 源变了就重写,并清掉 CHANGELOG 里已不存在的版本
  writeFileSync(cl, '## 0.9.1 (2026-01-02)\n\n### 新增\n\n- 只剩这一版\n');
  const r3 = generate({ changelogPath: cl, outDir: out });
  eq(r3.skipped, false, 't3: 源变了 → 重写');
  ok(!existsSync(join(out, '0.9.0.json')), 't3: 被删版本的产物同步清掉,不留孤儿 chunk');
  eq(JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')).length, 1, 't3: index 同步收缩');

  // CHANGELOG 缺失也不能炸构建
  const out2 = join(dir, 'out2');
  const r4 = generate({ changelogPath: join(dir, '不存在.md'), outDir: out2 });
  eq(JSON.parse(readFileSync(join(out2, 'index.json'), 'utf8')), [], 't3: 源文件缺失 → 空 index,不抛');
  eq(r4.versions, [], 't3: 源文件缺失 → 版本列表为空');
}

// ── t4 shouldShow 真值表(纯函数,import 真实实现) ───────────────────────────
// releaseNotes.js 顶部 import 了 generated JSON,node 直接 import 会因 JSON 断言而失败,
// 所以只把 shouldShow 这一段抽出来求值 —— 求的是【源码里那一份】,改错必红。
const RN_SRC = src('client/src/utils/releaseNotes.js');
const shouldShow = await (async () => {
  const body = RN_SRC.slice(RN_SRC.indexOf('const VERSION_RE'), RN_SRC.indexOf('export function hasReleaseNotes'))
    .replace('export function shouldShow', 'function shouldShow');
  const mod = await import(`data:text/javascript,${encodeURIComponent(`${body}\nexport { shouldShow };`)}`);
  return mod.shouldShow;
})();
{
  eq(shouldShow('0.2.313', null), true, 't4: 首次安装(无 lastSeen)→ 弹');
  eq(shouldShow('0.2.313', undefined), true, 't4: lastSeen 未定义 → 弹');
  eq(shouldShow('0.2.313', '0.2.313'), false, 't4: 同版本 → 不弹(同一版只弹一次)');
  eq(shouldShow('0.2.313', '0.2.312'), true, 't4: 升级 → 弹');
  eq(shouldShow('0.2.310', '0.2.313'), true, 't4: 降级/回滚 → 弹当前实际在跑那一版');
  eq(shouldShow('0.2.313', ''), true, 't4: lastSeen 空串(非法)→ 当没看过');
  eq(shouldShow('0.2.313', 'garbage'), true, 't4: lastSeen 垃圾值 → 当没看过');
  eq(shouldShow('0.2.313', 42), true, 't4: lastSeen 非字符串 → 当没看过');
  eq(shouldShow('unknown', '0.2.313'), false, 't4: 当前版本非法(vite 兜底 unknown)→ 不弹');
  eq(shouldShow('', null), false, 't4: 当前版本空 → 不弹');
  eq(shouldShow(undefined, undefined), false, 't4: 全空 → 不弹');
}

// ── t5 lastSeen 必须落 ~/.claude-gui/prefs.json,禁 localStorage ──────────────
{
  ok(/\/api\/prefs\/release-notes-seen/.test(RN_SRC), 't5: 读写走 /api/prefs/release-notes-seen');
  ok(!/localStorage/.test(code(RN_SRC)), 't5: 更新说明的读写层不许碰 localStorage(绑 WebView 数据目录会丢)');
  const modal = code(src('client/src/components/ReleaseNotesModal.jsx'));
  ok(!/localStorage/.test(modal), 't5: 弹窗组件也不许碰 localStorage');
  const prefs = src('server/routes/prefs.js');
  ok(/router\.get\('\/prefs\/release-notes-seen'/.test(prefs), 't5: 服务端 GET 端点存在');
  ok(/router\.put\('\/prefs\/release-notes-seen'/.test(prefs), 't5: 服务端 PUT 端点存在');
  ok(/prefs\.releaseNotesSeen = version/.test(prefs), 't5: 写进 prefs 对象 → savePrefs 落 prefs.json');
  ok(/withPrefsQueue/.test(prefs.slice(prefs.indexOf("'/prefs/release-notes-seen'"))), 't5: 写走串行队列,不与其他 PUT 互相覆盖');
  ok(/version 必须是版本号字符串/.test(prefs), 't5: PUT 校验版本号格式');
  const app = src('client/src/App.jsx');
  ok(/fetchLastSeen\(\)/.test(app), 't5: App 从服务端读 lastSeen');
  ok(/await markSeen\(ver\)/.test(app), 't5: App 写回服务端');
  // 内容备好就标记已读(不是关窗才标记)——弹窗卡死/强杀进程,下次启动不该重弹
  const eff = app.slice(app.indexOf('let lastSeen = null;'), app.indexOf('setReleaseNotes(data);'));
  // r17-2b(判官必修):原写法 `eff.indexOf(x) < eff.length` 恒真(找不到返回 -1 也成立),
// 于是整个 feature 最关键的那条不变量零守卫 —— 判官把 markSeen 挪到 setReleaseNotes
// 之后(即规格禁止的"先弹后标记")跑,这条照样绿。
ok(eff.includes('await markSeen(ver)'), 't6: markSeen 在 setReleaseNotes 之前(内容备好即标记)');
  ok(!/onClose[^)]*markSeen/.test(app), 't6: 不是关窗才标记');
}

// ── t6 触发时机:不靠固定 setTimeout,等首屏空闲 ──────────────────────────────
{
  const app = src('client/src/App.jsx');
  ok(/requestIdleCallback\(show, \{ timeout: 3000 \}\)/.test(app), 't6: 等浏览器空闲再弹,3s 兜底');
  ok(/typeof requestIdleCallback === 'function'/.test(app), 't6: 不支持 rIC 的内核才回落 setTimeout');
}

// ── t7 层级门控:GUI 弹窗盖住 Claude 更新提示,关闭后恢复 ─────────────────────
{
  const app = src('client/src/App.jsx');
  ok(/\{updateNotice && !updateModalDismissed && !releaseNotesOpen && \(/.test(app),
    't7: 更新说明开着时,Claude/GUI 更新提示不渲染(布尔门,不是堆 z-index)');
  ok(/onClose=\{\(\) => setReleaseNotesOpen\(false\)\}/.test(app), 't7: 叉掉/已知晓 → 门解除 → 下层提示露出');
  // 首启导览同样让路(否则镂空高亮叠在遮罩上是一堆灰框)
  ok(/updateBlocking \|\| releaseNotesOpen\) return;/.test(app), 't7: 使用指引也等更新说明关掉再弹');
}

// ── t8 弹窗布局:flex 列三段,禁 sticky 底栏 ─────────────────────────────────
{
  const modal = code(src('client/src/components/ReleaseNotesModal.jsx')); // 注释里写了"禁 sticky",只看代码
  ok(/rounded-panel[^"]*flex flex-col/.test(modal), 't8: 卡片是 flex 列');
  ok(/flex-1 min-h-0 overflow-y-auto/.test(modal), 't8: 正文是唯一滚动区(flex-1 min-h-0)');
  ok((modal.match(/shrink-0/g) || []).length >= 2, 't8: 头/底 shrink-0');
  ok(!/sticky/.test(modal), 't8: 禁 sticky 底栏(glass 动画的 transform 让 sticky 在 WKWebView 下哑)');
  ok(/已知晓/.test(modal), 't8: 底部有「已知晓」');
  ok(/ChevronLeft|ChevronRight/.test(modal), 't8: 可翻看历史版本');
  ok(/MarkdownRenderer/.test(modal), 't8: 正文复用项目自带的 Markdown 渲染,不引新库');
}

// ── t9 核心决策:整条链路不联网 ────────────────────────────────────────────
{
  const gen = src('scripts/gen-release-notes.mjs');
  for (const [name, s] of [['生成脚本', gen], ['读取层', RN_SRC], ['弹窗', src('client/src/components/ReleaseNotesModal.jsx')]]) {
    ok(!/api\.github\.com|githubusercontent|jsdelivr|https?:\/\/[a-z]/i.test(s), `t9: ${name}不得访问外部网络`);
  }
  ok(/fetch\('\/api\/prefs/.test(RN_SRC) || /fetch\(RELEASE_NOTES_SEEN_URL/.test(RN_SRC), 't9: 唯一的 fetch 是本机 /api 相对路径(已读标记)');
}

// ── t10 进仓产物与 CHANGELOG 同步(防"改了 CHANGELOG 忘了跑生成") ────────────
{
  ok(existsSync(DEFAULT_CHANGELOG), 't10: 仓库有 CHANGELOG.md');
  const r = generate({ changelogPath: DEFAULT_CHANGELOG, outDir: DEFAULT_OUT_DIR });
  eq(r.skipped, true, 't10: 已提交的产物与 CHANGELOG.md 一致(不一致就跑 node scripts/gen-release-notes.mjs)');
  const idx = JSON.parse(readFileSync(join(DEFAULT_OUT_DIR, 'index.json'), 'utf8'));
  ok(idx.length >= 5, 't10: 至少覆盖 0.2.309–0.2.313');
  for (const v of ['0.2.309', '0.2.310', '0.2.311', '0.2.312', '0.2.313']) {
    ok(idx.some((x) => x.version === v), `t10: index 含 ${v}`);
    ok(existsSync(join(DEFAULT_OUT_DIR, `${v}.json`)), `t10: ${v} 的单版正文已生成`);
  }
  eq(idx[0].version, '0.2.313', 't10: index 首项是最新版');
}

// t11 r17-2b(判官流程提醒):发版脚本只 bump package.json/tauri.conf.json,不写 CHANGELOG。
// 忘了加当轮条目时 hasReleaseNotes(当前版) 直接 false → 这个功能【静默不工作】,没有任何
// 报错。把它变成红灯:CHANGELOG 必须含 package.json 里的当前版本号。
{
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  ok(new RegExp(`^##\\s+${pkg.version.replace(/\./g, '\\.')}\\b`, 'm').test(changelog),
    `t11: CHANGELOG.md 必须含当前版本 ${pkg.version} 的条目(否则更新说明弹窗对这一版静默失效)`);
}

console.log(`check-release-notes: all passed (r17-2, ${n} 条断言)`);
