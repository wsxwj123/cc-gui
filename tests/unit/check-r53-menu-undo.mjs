#!/usr/bin/env node
// 单测:r53 ⌘Z 输入撤销 —— macOS 自建菜单必须放走 undo/redo 加速键。
// 根因:Tauri 2 未设菜单时自动挂 Menu::default(),其 Edit 带 Undo(⌘Z)/Redo(⇧⌘Z),
// macOS 菜单 keyEquivalent 分发优先于 webview → DOM keydown 不触发 → 前端
// client/src/utils/inputUndo.js 全哑。修复=自建菜单,Edit 不含 undo/redo。
// 行为级(真按 ⌘Z)无法自动化,只能源码级钉死结构;人工验证见规格。
// 变异哨兵(实际验证过红):往 Edit 段加回 .undo() → t2/t3 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 注释行剔掉再扫:代码里留了"不要加回 .undo()"的警示注释,锚只认真代码
const rs = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n');

// t1 菜单构建函数存在,且整段在 macos cfg 门内(非 macOS 不设菜单,免多出菜单栏)
{
  const decl = rs.indexOf('fn build_app_menu');
  assert.ok(decl > 0, 't1: build_app_menu 存在');
  const before = rs.slice(0, decl);
  assert.match(
    before.slice(-120),
    /#\[cfg\(target_os = "macos"\)\]\s*$/,
    't1: 构建函数紧挨 macos cfg 门'
  );
  // 挂接同样只在 macos 门内
  const hook = rs.indexOf('.menu(build_app_menu)');
  assert.ok(hook > 0, 't1: builder 已挂 build_app_menu');
  assert.match(
    rs.slice(hook - 200, hook),
    /#\[cfg\(target_os = "macos"\)\]\s*\n\s*let builder = builder\s*$/,
    't1: 挂接在 macos cfg 门内'
  );
}

// t2 Edit 子菜单:cut/copy/paste/select_all 四锚在位(剪贴板加速键不能丢),无 undo/redo
{
  const start = rs.indexOf('SubmenuBuilder::new(app, "Edit")');
  assert.ok(start > 0, 't2: Edit 子菜单可定位');
  const edit = rs.slice(start, rs.indexOf('.build()?;', start));
  for (const item of ['.cut()', '.copy()', '.paste()', '.select_all()']) {
    assert.ok(edit.includes(item), `t2: Edit 保留 ${item}`);
  }
  assert.equal(edit.includes('.undo()'), false, 't2: Edit 不含 undo(⌘Z 留给网页层)');
  assert.equal(edit.includes('.redo()'), false, 't2: Edit 不含 redo(⇧⌘Z 留给网页层)');
}

// t3 全文零 undo/redo 菜单项锚(任何写法:builder 方法或 PredefinedMenuItem)
{
  for (const anchor of [
    '.undo()',
    '.redo()',
    'undo_with_text',
    'redo_with_text',
    'PredefinedMenuItem::undo',
    'PredefinedMenuItem::redo',
  ]) {
    assert.equal(rs.includes(anchor), false, `t3: 全文不得出现 ${anchor}`);
  }
}

// t4(判官r53建议1):View→fullscreen 在位(ctrl+⌘F 键盘全屏),且挂进 items。
{
  assert.ok(/\.fullscreen\(\)/.test(rs), 't4: View 段含 fullscreen');
  assert.ok(/&view_menu/.test(rs), 't4: view_menu 已挂进菜单 items');
}

console.log('check-r53-menu-undo: all passed');
