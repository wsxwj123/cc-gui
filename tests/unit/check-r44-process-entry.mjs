#!/usr/bin/env node
// R44:「进程」从坞 rail 收进设置(能力保留,只挪入口)。纯源码哨兵,四条不变量:
//   ① rail 渲染过滤掉 processes —— 但 ② PANEL_MAP 条目必须还在(→ Cmd/Ctrl+7 直达、
//      手机菜单、面板身份全不变;这两条必须成对成立,单独一条都是"砍能力")。
//   ③ 设置页内嵌的是同一个 ProcessPanel 组件(复制一份 = 分叉,两边各自演化)。
//   ④ 设置搜索索引里有 set-processes(否则用户只能靠翻到「高级」才找得到)。
// 变异哨兵(逐条实跑验证过红):
//   S1 rail 的 filter 去掉 `&& id !== 'processes'` → ①红
//   S2 顺手把 PANEL_MAP 的 processes 条目删掉(砍能力) → ②红
//   S3 设置里改成复制一份进程列表(不再复用组件) → ③红
//   S4 摘掉 SETTINGS_INDEX 的 set-processes → ④红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');
const app = read('client/src/App.jsx');
const settings = read('client/src/components/SettingsPanel.jsx');
const procPanel = read('client/src/components/ProcessPanel.jsx');

// ① rail 不再渲染进程按钮(与终端同一处过滤;rail 只此一处遍历 PANEL_MAP 建按钮)
assert.ok(/Object\.entries\(PANEL_MAP\)\.filter\(\(\[id\]\) => id !== 'term' && id !== 'processes'\)/.test(app),
  'rail 渲染必须过滤掉 processes(入口已收到设置页,坞里不该再有这枚按钮)');
// ② PANEL_MAP / 短名条目保留 —— 快捷键按 PANEL_MAP 顺序取,删条目 = Cmd/Ctrl+7 错位
assert.ok(/processes: \{ label: '进程管理 \/ 停止', icon: \w+, component: ProcessPanel \}/.test(app),
  'PANEL_MAP 的 processes 条目必须保留(Cmd/Ctrl+7 与手机菜单都按它取)');
assert.ok(/processes: '进程'/.test(app), 'PANEL_SHORT 的 processes 短名必须保留(面板身上仍要显示)');
// ③ 设置页内嵌同一组件(带 embedded 走宿主布局),不是复制一份列表
assert.ok(/import \{ ProcessPanel \} from '\.\/ProcessPanel\.jsx'/.test(settings), '设置页必须复用 ProcessPanel 组件');
assert.ok(/<ProcessPanel embedded \/>/.test(settings), '设置页内嵌 ProcessPanel 必须走 embedded(否则双写 padding/滚动容器)');
assert.ok(/export function ProcessPanel\(\{ embedded = false \}\)/.test(procPanel),
  'ProcessPanel 要留 embedded 开关,且默认 false(面板坞里行为一字不变)');
// ④ 设置搜索索引
assert.ok(/\{ id: 'set-processes', tab: 'advanced', title: '进程管理 \/ 停止'/.test(settings),
  '进程管理必须登记进 SETTINGS_INDEX(否则设置搜索框搜不到)');

console.log('R44 进程入口搬家审计通过(rail 无此按钮 + PANEL_MAP/快捷键/手机菜单保留 + 设置页复用组件)');
