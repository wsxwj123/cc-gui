#!/usr/bin/env node
// Scene3DNode:懒加载 chunk **自身**拉取失败时必须落到错误态。
//
// 缺陷形态:effect 里 `import('../scene3d-lazy.ts').then(...)` 只在 then 内部包了
// try/catch —— 那层只护得住 mountScene(无 GPU / three 初始化炸)。import() 自己 reject
// (离线、旧部署的 chunk hash 404、CDN 断)时整条链没人接:status 永远停在 'loading',
// 界面一直转"加载 3D 场景…",外加一条 unhandled rejection。scene3d-lazy.ts 第 6 行的
// 文档承诺("When the chunk fails to load the Scene3DNode shows its error hint")靠这条兑现。
//
// .tsx 裸 node 加载不了(ERR_UNKNOWN_FILE_EXTENSION),按仓内惯例(check-genui-security-patches
// 等)走源码锁:readFileSync + 切片定位 + 断言**结构与顺序**,不锁具体格式化。
// 负例(catch 存在且置错误态)与正例(内层 try/catch 与两个提示还在)成对写 —— 只写负例的话,
// 把 catch 焊成"永远 error"、把 ready 分支删掉也照样全绿,而那等于把 3D 关掉。
//
// 变异自证(在 scratchpad 的副本上用同一套切片脚本实跑过,真源码树未动):
//   A:catch 体改成 setStatus('loading')(接住了但不置错误态)   → 红
//   B:整条 .catch(...) 删掉(回到修复前形态)                    → 红
//   C:.catch 挪到 .then 之前(先 catch 后 then,接不到 then 里抛的)→ 红
//   D:删掉内层 `dispose = await m.mountScene` 那条(焊死错误态)  → 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'client/src/genui/upstream/blocks/advanced.tsx'), 'utf8');

// ── 切片:只看 Scene3DNode 自己 ─────────────────────────────────────────────────
// 切到**下一个** export 为止:切到文件尾会把 TimelineNode 等一起圈进来;而同文件的
// MermaidNode 是同款写法(本次不在范围内),不隔开就会互相假绿/假红。
const iScene = src.indexOf('export const Scene3DNode');
assert.notEqual(iScene, -1, '找不到 Scene3DNode(组件被改名/挪走了?这条锁需要跟着改)');
const iNext = src.indexOf('\nexport ', iScene + 1);
const scene = src.slice(iScene, iNext === -1 ? src.length : iNext);

// effect 里那条 promise 链:从 import() 起,到清理函数 `return () =>` 止。
const iImport = scene.indexOf("import('../scene3d-lazy.ts')");
assert.notEqual(iImport, -1, 'Scene3DNode 必须仍走 scene3d-lazy 动态 import(three 不许进主 chunk)');
const iCleanup = scene.indexOf('return () =>', iImport);
assert.notEqual(iCleanup, -1, 'effect 必须仍返回清理函数(dispose 要能跑)');
const chain = scene.slice(iImport, iCleanup);

// ── 1. 负例锁:chunk 加载失败这层有人接,且接住后置错误态 ────────────────────────
const iThen = chain.indexOf('.then(');
const iCatch = chain.indexOf('.catch(');
assert.notEqual(iThen, -1, 'import() 后仍应有 .then(挂载逻辑在里面)');
assert.notEqual(iCatch, -1,
  'import() 自身 reject 没人接 ⟹ status 卡死 loading + unhandled rejection:链尾必须有 .catch');
assert.ok(iThen < iCatch,
  '.catch 必须挂在 .then **之后**:挂在前面接不到 then 回调里抛出的东西,等于没接');

const catchBody = chain.slice(iCatch);
assert.ok(/setStatus\(\s*'error'\s*\)/.test(catchBody),
  "catch 体必须置 setStatus('error') —— 接住了却不改状态,界面照样一直转圈(与不接等价)");
assert.ok(/\balive\b/.test(catchBody),
  'catch 体要有 alive 守卫:组件已卸载还 setState 是同目录周边一致的写法');
assert.ok(catchBody.indexOf('alive') < catchBody.indexOf("setStatus('error')"),
  '守卫在 setStatus 之前(放后面等于没放)');

// ── 2. 正例锁:别把闸门焊死 —— 成功路径与内层 try/catch 都还在 ──────────────────
assert.ok(/dispose = await m\.mountScene\(/.test(chain),
  '成功路径必须还在:mountScene 仍要被调用并把 disposer 交出去');
assert.ok(/setStatus\(\s*'ready'\s*\)/.test(chain),
  "挂载成功仍要置 ready(只留错误分支 = 3D 永远不显示,照样全绿)");
assert.ok(/try \{[\s\S]*?\} catch \{/.test(chain),
  'mountScene 的内层 try/catch 仍在:那层护的是运行时失败(无 GPU 等),与 chunk 加载是两回事');
assert.ok(chain.indexOf("setStatus('ready')") < iCatch,
  'ready 仍属于 then 内的成功路径,不该被挪进 catch');

// 两个提示都得在:错误态没有对应的 UI,置了也白置。
assert.ok(scene.includes('加载 3D 场景…'), 'loading 提示必须还在');
assert.ok(scene.includes('3D 渲染失败'), 'error 提示必须还在(catch 置的 error 靠它显示)');
assert.ok(/status === 'error'/.test(scene), '错误提示要由 status === \'error\' 驱动');

console.log('✅ check-genui-scene3d-chunk-catch:懒加载 chunk 拉取失败落错误态(.catch 在 .then 之后 + alive 守卫 + 置 error),'
  + ' 且成功路径 / 内层 try-catch / loading-error 两个提示均未被焊掉');
