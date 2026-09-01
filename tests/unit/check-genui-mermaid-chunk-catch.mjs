#!/usr/bin/env node
// MermaidNode:懒加载胶水 chunk **自身**拉取失败时必须落到降级态。
//
// 缺陷形态:effect 里 `import('../mermaid-lazy.ts').then(...)` 只在 then 内部包了
// try/catch —— 那层只护得住 renderMermaid(图语法错,以及它内部 import('mermaid') 拉
// 引擎大 chunk 失败)。胶水 import() 自己 reject(离线、旧部署的 chunk hash 404)时整条
// 链没人接:failed 永远停在 false、html 永远停在 null,界面永卡 <pre>源码</pre> + "渲染中…",
// 外加一条 unhandled rejection。mermaid-lazy.ts 第 5-6 行的文档承诺("When the chunk
// fails to load the MermaidNode shows its plain-source fallback")靠这条兑现。
//
// chunk 失败复用"图语法有误"这句文案的归因不精确是**已定的取舍**:该文案被只读的
// tests/acceptance/r64-genui/browser/harness.js(COPY.mermaidFallback)逐字锁定,不新增
// 文案、不新增状态。所以这条锁只管"有没有落到 failed",不管措辞怎么归因。
//
// .tsx 裸 node 加载不了(ERR_UNKNOWN_FILE_EXTENSION),按仓内惯例(check-genui-security-patches
// 等)走源码锁:readFileSync + 切片定位 + 断言**结构与顺序**,不锁具体格式化。
// 负例(catch 存在且置降级态)与正例(内层 try/catch、成功路径、两个提示还在)成对写 ——
// 只写负例的话,把 catch 焊成"永远 failed"、把渲染成功那条删掉也照样全绿,而那等于把
// mermaid 渲染关掉,只剩源码。
//
// 变异自证(在 scratchpad 的副本上用同一套切片脚本实跑过,真源码树未动):
//   A:catch 体改成 setHtml(code)(接住了但不置降级态)             → 红
//   B:整条 .catch(...) 删掉(回到修复前形态)                       → 红
//   C:.catch 挪到 .then 之前(先 catch 后 then,接不到 then 里抛的)  → 红
//   D:删掉内层 `const svg = await m.renderMermaid` / setHtml(焊死降级态) → 红
//   M10:删掉 <div className={css.mermaidHint}>渲染中…</div>       → 红
//   M16:给 <pre> 加 className(纯格式化演进)                       → 绿(不许误红)
//   Z1:两条早退分支调换顺序(loading 排到 failed 前)              → 红
//   Y3/Y4:块注释 /* */ 、JSX 注释 {/* */} 里写"渲染中…"+删真 UI   → 红
//   Y6:留一句 /* TODO ... .catch(...) ... */ + 删掉真 .catch      → 红
//   X1:只删降级分支里的 <pre>{code}</pre>(留 loading 分支那份)    → 红
//   S1/S2/S4:Scene3DNode 删掉 / 补 .catch / 内部砸烂              → 绿(切片隔离)
//
// ── 这份锁**管不到**什么(别误以为它管得更宽)────────────────────────────────────
//   · 行尾 // 注释没剥(见下面 strip 处):`code` 后跟一句 // 渲染中… 仍能救绿,已知残留通道。
//   · 只保**结构与顺序**,不保语义:守卫取反(if (!alive))、短路(alive && false)这类
//     语义变异,任何源码锁都抓不到 —— 那是全仓源码锁的共同天花板,语义靠 r64 验收 harness。
//
// M10 / M16 是盲审揪出的两个不达标点,首版分别是**假锁**和**过死锁**:
//   假锁:断言在含注释的切片上 includes('渲染中…'),而本文件自己的 CGUI-PATCH 注释里就有
//        这四个字 —— 真 UI 删光也照绿。修法见下面切片处的剥注释(治的是一整类,不止这条)。
//   过死:`<pre>\{code\}</pre>` 连属性都不许有,给 <pre> 加个 className 就误红,而且红出来的
//        文案会让人以为"源码展示被删了"。同批放宽的还有 try/catch(允许 catch (e))、
//        deps(只认 themeEpoch 在不在,不锁顺序与个数)、if (failed) 的空白。
//        放宽只针对纯格式化/无害演进,语义断言(置不置 failed、成功路径在不在)一条没松。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'client/src/genui/upstream/blocks/advanced.tsx'), 'utf8');

// ── 切片:只看 MermaidNode 自己 ────────────────────────────────────────────────
// 切到**下一个** export 为止:切到文件尾会把 Scene3DNode / TimelineNode 等一起圈进来;
// 同文件的 Scene3DNode 是同款懒加载写法(不在本锁范围内,另案处理),不隔开就会互相假绿/假红。
const iMermaid = src.indexOf('export const MermaidNode');
assert.notEqual(iMermaid, -1, '找不到 MermaidNode(组件被改名/挪走了?这条锁需要跟着改)');
const iNext = src.indexOf('\nexport ', iMermaid + 1);
// 匹配前先把注释剥掉。这不是洁癖:本组件的 CGUI-PATCH 注释里就写着 "渲染中…"、
// <pre>源码</pre>、import('mermaid') 这类和被锁对象一模一样的字样 —— 首版就栽在这:
// 把 <div className={css.mermaidHint}>渲染中…</div> 整条删掉,断言却被注释里的"渲染中…"
// 救绿(假锁)。剥一次,下面所有切片(chain/catchBody/thenBody/failedBranch)与锚点
// (import()/return () =>/.then/.catch)全部继承。
// 块注释 /* */ 与 JSX 注释 {/* */} 必须一起剥,不是理论风险:{/* CGUI-PATCH ... */} 就是
// 本文件既有写法(advanced.tsx:178/232/293),而且切片尾巴天然含着下一个组件的 doc 块注释。
// 最狠的一例:删掉真 .catch、留一句 /* TODO 以后补 .catch(() => { if (alive) setFailed(true) }) */,
// 只剥整行 // 的话整份锁全绿 —— 这条锁存在的全部理由被一句 TODO 顶掉。
// ⚠️ 已知残留通道:**行尾** // 注释没剥(通用剥法会误伤 URL 与字符串字面量),
//    `code` 后面跟一句 // 渲染中… 仍能救绿。要堵得换真解析器,当前按性价比不做。
const mermaid = src.slice(iMermaid, iNext === -1 ? src.length : iNext)
  .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// effect 里那条 promise 链:从 import() 起,到清理函数 `return () =>` 止。
const iImport = mermaid.indexOf("import('../mermaid-lazy.ts')");
assert.notEqual(iImport, -1, 'MermaidNode 必须仍走 mermaid-lazy 动态 import(mermaid 引擎不许进主 chunk)');
const iCleanup = mermaid.indexOf('return () =>', iImport);
assert.notEqual(iCleanup, -1, 'effect 必须仍返回清理函数(alive 标记要能翻掉)');
const chain = mermaid.slice(iImport, iCleanup);

// ── 1. 负例锁:chunk 加载失败这层有人接,且接住后置降级态 ────────────────────────
const iThen = chain.indexOf('.then(');
const iCatch = chain.indexOf('.catch(');
assert.notEqual(iThen, -1, 'import() 后仍应有 .then(渲染逻辑在里面)');
assert.notEqual(iCatch, -1,
  'import() 自身 reject 没人接 ⟹ failed 永 false、界面永卡"渲染中…" + unhandled rejection:链尾必须有 .catch');
assert.ok(iThen < iCatch,
  '.catch 必须挂在 .then **之后**:挂在前面接不到 then 回调里抛出的东西,等于没接');

const catchBody = chain.slice(iCatch);
assert.ok(/setFailed\(\s*true\s*\)/.test(catchBody),
  'catch 体必须置 setFailed(true) —— 接住了却不改状态,界面照样永卡"渲染中…"(与不接等价)');
assert.ok(/\balive\b/.test(catchBody),
  'catch 体要有 alive 守卫:组件已卸载还 setState 是同目录周边一致的写法');
assert.ok(catchBody.indexOf('alive') < catchBody.search(/setFailed\(\s*true\s*\)/),
  '守卫在 setFailed 之前(放后面等于没放)');

// ── 2. 正例锁:别把闸门焊死 —— 成功路径与内层 try/catch 都还在 ──────────────────
const thenBody = chain.slice(0, iCatch);
assert.ok(/await m\.renderMermaid\(/.test(chain),
  '成功路径必须还在:renderMermaid 仍要被调用');
assert.ok(/setHtml\(/.test(chain),
  '渲染成功仍要把 svg 交给 setHtml(只留降级分支 = 永远只显示源码,照样全绿)');
assert.ok(/\btry\s*\{[\s\S]*?\}\s*catch\b/.test(thenBody),
  '内层 try/catch 仍在:那层护的是图语法错与引擎 chunk 失败,与胶水 chunk 加载是两回事');
assert.ok(/setFailed\(\s*true\s*\)/.test(thenBody),
  '内层 catch 仍要置 setFailed(true):语法错这条路径不许被拆掉');
assert.ok(chain.indexOf('setHtml(') < iCatch,
  '成功路径仍属于 then 内,不该被挪进 catch');

// 主题跟随不许被这次改动碰掉(CGUI-PATCH:epoch 进 deps 才会跟着换主题重画)。
// 只锁"deps 里点了 themeEpoch",不锁顺序、不锁有没有别的 dep、不锁 `}, [` 中间的空格。
assert.ok(/\}\s*,\s*\[[^\]]*\bthemeEpoch\b[^\]]*\]\)/.test(mermaid),
  'effect deps 里必须仍有 themeEpoch:掉了 = 切深色后旧图停在旧主题直到刷新');

// ── 3. 分支顺序锁:两条早退分支的**先后**是本次修复能生效的前提 ────────────────────
// chunk 失败时 html 恒为 null,failed 才是 true。把这两条 return 调换(一次"读起来更顺"的
// 整理就会这么干),loading 分支先命中 ⟹ 界面照样永卡"渲染中…",.catch 白设 —— 而
// 上面所有断言(catch 在、置 failed、两条文案都在)统统还是绿的。所以顺序必须单独锁。
const iFailedBranch = mermaid.search(/if\s*\(\s*failed\s*\)/);
const iLoadingBranch = mermaid.search(/html\s*===\s*null/);
assert.notEqual(iFailedBranch, -1, '降级 UI 要由 failed 驱动(找不到 if (failed) 早退分支)');
assert.notEqual(iLoadingBranch, -1, '找不到 html === null 的 loading 早退分支');
assert.ok(iFailedBranch < iLoadingBranch,
  'failed 分支必须排在 loading 分支之前:反过来的话 chunk 失败(html 恒 null)会被 loading'
  + ' 分支先命中,降级态永远显示不出来,这条 .catch 等于白设');

// 两个提示都得在:降级态没有对应的 UI,置了也白置。
// (现在锁的是真 UI —— 上面已把整行 // 、块注释、JSX 注释都剥掉,同名字样救不了它们。)
assert.ok(mermaid.includes('渲染中…'), 'loading 提示必须还在');
assert.ok(mermaid.includes('图语法有误，已降级显示源码'),
  '降级提示必须还在(catch 置的 failed 靠它显示;文案被 r64 验收 harness 逐字锁定,不许改)');

// 源码降级只认**降级分支自己**那份 <pre>{code}</pre>:整段切片上匹配的话,loading 分支
// 里的同款 <pre> 会把它救绿(删光降级分支的源码展示仍全绿,而断言文案说的正是它)。
// 取"failed 分支起 → loading 分支止"这段区间,而不是那一行 —— 对 JSX 换行重排也稳。
// <pre> 允许带属性:加个 className / data-* 是无害演进,不该误红成"源码展示被删了"。
const failedBranch = mermaid.slice(iFailedBranch, iLoadingBranch);
assert.ok(/<pre[^>]*>\{code\}<\/pre>/.test(failedBranch),
  '降级分支里必须仍把原始源码显出来(plain-source fallback 的"source")');

console.log('✅ check-genui-mermaid-chunk-catch:懒加载 chunk 拉取失败落降级态(.catch 在 .then 之后 + alive 守卫 + 置 failed),'
  + ' 且成功路径 / 内层 try-catch / themeEpoch deps / 渲染中-降级两个提示均未被焊掉');
