#!/usr/bin/env node
// 单测:r147 K2 + K5 —— 输入法上屏 / 取消候选那一下按键,不得被当成"提交"或"关浮层"。
//
// 现象:macOS 应用跑在 WebKit 内核,输入法按 Enter 上屏时 keydown 是 key='Enter'、isComposing=false、
// keyCode=229(Chromium / WebView2 此时 key='Process')。只判 isComposing 或什么都不判的 Enter 处理器会把
// "确认候选词 / 上屏原文"当成提交:旁问半句话被发出、提问卡半截回答交给模型、半截权限规则落盘……(K2)。
// 三处带输入框的浮层,Esc 捕获监听不判输入法:组字时按 Esc 取消候选,浮层直接关闭(K5)。
// 项目标准判定:client/src/components/ChatInput.jsx 的 `e.nativeEvent?.isComposing || e.key === 'Process' || e.keyCode === 229`。
//
// 双层:
//   ① 逻辑层:共用判定 client/src/utils/imeGuard.js 真跑(React 合成事件 / 原生事件各一种写法);
//   ② 源码锚:K2 清单里每个 Enter 提交分支、K5 三处 Esc 捕获监听,都在动作之前先过共用判定。
//      清单 = 下面的 K2_CALL_SITES(审计 A2 报告 ② 表"无 / 只判 isComposing"的全部行;
//      password / number 输入框输入法不介入,按任务书不改,不在清单里)。
// Run: node tests/unit/check-r147-ime-guard.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};

console.log('r147 K2 / K5 输入法守卫');

// ── ① 逻辑层 ──────────────────────────────────────────────
let mod = null;
await check('共用判定模块存在(client/src/utils/imeGuard.js 导出 isImeKeydown / isImeReactKeydown)', async () => {
  mod = await import(root + 'client/src/utils/imeGuard.js');
  assert.equal(typeof mod.isImeKeydown, 'function', '缺原生事件写法 isImeKeydown');
  assert.equal(typeof mod.isImeReactKeydown, 'function', '缺 React 合成事件写法 isImeReactKeydown');
});

// 原生 KeyboardEvent(addEventListener 拿到的)
const native = (o) => ({ key: 'Enter', isComposing: false, keyCode: 13, ...o });
// React 合成事件(onKeyDown 拿到的):isComposing 只在 nativeEvent 上;key / keyCode 两边都有
const react = (o, n) => ({ key: 'Enter', keyCode: 13, ...o, nativeEvent: native({ key: o.key || 'Enter', keyCode: o.keyCode ?? 13, ...n }) });

await check('原生事件:组字中 / WebKit 上屏(keyCode 229)/ Chromium 的 Process 都算输入法按键', async () => {
  assert.ok(mod, '模块不存在');
  assert.equal(mod.isImeKeydown(native({ isComposing: true })), true, '组字中的 Enter');
  assert.equal(mod.isImeKeydown(native({ isComposing: false, keyCode: 229 })), true, 'WebKit 上屏那一下:isComposing=false、keyCode=229');
  assert.equal(mod.isImeKeydown(native({ key: 'Process', keyCode: 229 })), true, 'Chromium / WebView2:key=Process');
  assert.equal(mod.isImeKeydown(native({ key: 'Escape', isComposing: false, keyCode: 229 })), true, '取消候选的 Esc(K5)');
});

await check('原生事件:普通 Enter / Esc 不算;空事件不抛错', async () => {
  assert.ok(mod, '模块不存在');
  assert.equal(mod.isImeKeydown(native({})), false, '普通 Enter');
  assert.equal(mod.isImeKeydown(native({ key: 'Escape', keyCode: 27 })), false, '普通 Esc');
  assert.equal(mod.isImeKeydown(null), false);
  assert.equal(mod.isImeKeydown(undefined), false);
});

await check('React 合成事件:isComposing 从 nativeEvent 读;keyCode 229 / Process 也认', async () => {
  assert.ok(mod, '模块不存在');
  assert.equal(mod.isImeReactKeydown(react({}, { isComposing: true })), true, 'nativeEvent.isComposing');
  assert.equal(mod.isImeReactKeydown(react({ keyCode: 229 }, { isComposing: false })), true, 'WebKit 上屏:keyCode 229');
  assert.equal(mod.isImeReactKeydown(react({ key: 'Process', keyCode: 229 }, {})), true, 'Process');
  assert.equal(mod.isImeReactKeydown(react({}, {})), false, '普通 Enter');
  assert.equal(mod.isImeReactKeydown(null), false);
  // 合成事件上没挂 nativeEvent(防御:被手搓的事件对象)时,只看自身字段,不抛错
  assert.equal(mod.isImeReactKeydown({ key: 'Enter', keyCode: 229 }), true);
  assert.equal(mod.isImeReactKeydown({ key: 'Enter', keyCode: 13 }), false);
});

// ── ② 源码锚 ──────────────────────────────────────────────
// 从 src[openIdx] === '{' 起取到配对的 '}'(跳过字符串 / 注释里的括号)
function balancedFrom(src, openIdx) {
  assert.equal(src[openIdx], '{', 'balancedFrom 起点必须是 {');
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i += 1;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  throw new Error('括号不配对');
}
const uniqueIndex = (src, anchor, from = 0) => {
  const i = src.indexOf(anchor, from);
  assert.ok(i >= 0, `锚点不在源码里(源码改了位置/文案?):${anchor}`);
  assert.equal(src.indexOf(anchor, i + 1) < 0 || from > 0, true, `锚点不唯一:${anchor}`);
  return i;
};
/**
 * 取某个输入框的 onKeyDown 处理器源码。
 *   mode 'element':锚点落在 <input / <textarea 的属性里,取包住它的那个元素;
 *   mode 'fn':锚点就是处理器函数的声明(如 `const onKeyDown = (e) =>`),取它的函数体。
 * within:锚点在文件里不唯一时,先定位到这段之后再找第一个。
 */
function keyHandler(src, { anchor, mode = 'element', within = null }) {
  const from = within ? uniqueIndex(src, within) : 0;
  const i = uniqueIndex(src, anchor, from);
  if (mode === 'fn') return balancedFrom(src, src.indexOf('{', src.indexOf('=>', i)));
  const start = Math.max(src.lastIndexOf('<input', i), src.lastIndexOf('<textarea', i));
  assert.ok(start >= 0, `锚点附近找不到输入框元素:${anchor}`);
  const k = src.indexOf('onKeyDown={', start);
  assert.ok(k >= 0 && !src.slice(start, k).includes('/>'), `这个输入框上没有 onKeyDown(锚点:${anchor})`);
  return balancedFrom(src, k + 'onKeyDown='.length);
}

// K2 清单:文件 / 用途 / 定位锚 / Enter 分支里的提交动作(守卫必须出现在动作之前)。
// 行号是 2026-10-08 fix/r146-crosstalk 上的位置,只作阅读提示;判定靠锚点。
export const K2_CALL_SITES = [
  { file: 'client/src/components/BtwWindow.jsx', what: '旁问输入框(~:251)', anchor: 'placeholder="继续旁问…（Enter 发送）"', action: 'submit()' },
  { file: 'client/src/components/PermissionPrompt.jsx', what: '提问卡「自定义回答」(~:414)', anchor: "'或自定义回答,回车提交…'", action: 'submit()' },
  { file: 'client/src/components/GoalBar.jsx', what: '目标条件编辑(~:99,原先只判 isComposing)', anchor: 'placeholder="输入新的目标条件"', action: 'saveEdit()' },
  { file: 'client/src/App.jsx', what: '顶栏会话重命名(~:207)', anchor: 'placeholder="自定义标题（留空恢复默认）"', action: 'save()' },
  { file: 'client/src/App.jsx', what: '侧栏会话重命名(~:1807)', anchor: 'placeholder="自定义标题（清空恢复默认）"', action: 'saveRename()' },
  { file: 'client/src/components/PermissionPrompt.jsx', what: 'MCP 表单卡文本框(~:641)', anchor: "type={f.type === 'number' ? 'number' : 'text'}", action: 'submit()' },
  { file: 'client/src/components/UnifiedSidebar.jsx', what: 'worktree 分支名(~:1730)', anchor: 'placeholder="分支名 (如 feature-X)"', action: 'createWorktree()' },
  { file: 'client/src/components/SettingsPanel.jsx', what: '权限规则(~:2900)', anchor: 'placeholder="如 Bash(git *) / Read(//path/**) / WebFetch(domain:example.com)"', action: 'addRule(key)' },
  { file: 'client/src/components/ChatSearch.jsx', what: '窗内检索(~:161)', anchor: 'const onKeyDown = (e) =>', mode: 'fn', action: 'go(' },
  { file: 'client/src/components/SettingsPanel.jsx', what: '称呼(~:2220)', anchor: 'type="text" maxLength={20} placeholder="未设置"', action: 'blur()' },
  { file: 'client/src/App.jsx', what: '自定义模型 ID(手机页,~:10325)', anchor: 'placeholder="自定义模型 ID…"', action: 'addCustom(v)' },
  { file: 'client/src/components/SessionSelectors.jsx', what: '自定义模型 ID(桌面弹层,~:758)', anchor: 'placeholder="自定义模型 ID..."', action: 'handleCustomSubmit()' },
  { file: 'client/src/components/ProviderPriceEditor.jsx', what: '价格行手输 model id(~:110)', anchor: 'placeholder="或手输 model id"', action: 'addRow(manual)' },
  { file: 'client/src/components/SettingsPanel.jsx', what: '环境变量值(~:2132;明文显示时输入法介入)', anchor: 'onBlur={() => saveValue(k)}', action: 'blur()' },
  { file: 'client/src/components/SettingsPanel.jsx', what: '新环境变量的值(~:2154)', anchor: 'placeholder="值" disabled={saving}', action: 'addKey()' },
  { file: 'client/src/components/SettingsPanel.jsx', what: '轻量快速模型 id(~:2576)', within: 'function SmallFastModelInput(', anchor: 'onBlur={commit}', action: 'blur()' },
  { file: 'client/src/App.jsx', what: '头像 URL / emoji(~:11120)', anchor: 'placeholder="图片 URL(https)或 emoji"', action: 'applyAvatarInput()' },
  { file: 'client/src/components/PermissionPrompt.jsx', what: '计划修改意见(⌘/Ctrl+Enter,~:217)', anchor: 'placeholder="告诉 Claude 该如何修改这份计划...（⌘/Ctrl+Enter 提交）"', action: 'submitRefine()' },
];

const GUARD_REACT = 'isImeReactKeydown(e)';
for (const site of K2_CALL_SITES) {
  await check(`K2 ${site.file.replace('client/src/', '')} · ${site.what}:Enter 提交前先过输入法判定`, async () => {
    const body = keyHandler(read(site.file), site);
    assert.ok(body.includes('Enter'), `取到的处理器里没有 Enter 分支(锚点取错了?):\n${body.slice(0, 300)}`);
    const a = body.indexOf(site.action);
    assert.ok(a >= 0, `处理器里找不到提交动作 ${site.action}:\n${body.slice(0, 300)}`);
    const g = body.indexOf(GUARD_REACT);
    assert.ok(g >= 0, `缺输入法守卫:Enter 分支没有调用共用判定 ${GUARD_REACT}\n      处理器:${body.replace(/\s+/g, ' ').slice(0, 260)}`);
    assert.ok(g < a, `守卫在提交动作之后才判(${GUARD_REACT} 应先于 ${site.action})`);
  });
}

// K5:三处带输入框的浮层,Esc 捕获监听在关闭前先过输入法判定(原生事件写法)
const K5_LISTENERS = [
  { file: 'client/src/components/SessionSelectors.jsx', what: '锚定弹层 AnchoredPopover(模型 / Provider 选择,~:159)', within: 'export function AnchoredPopover(', anchor: 'const onEsc = (e) =>', action: "onRequestClose?.('escape')" },
  { file: 'client/src/App.jsx', what: 'Provider 管理弹窗(~:9754)', within: 'function ProviderManagerModal(', anchor: 'const onEsc = (e) =>', action: 'tryClose()' },
  { file: 'client/src/components/ModelPickModal.jsx', what: '模型勾选弹窗(~:44)', anchor: 'const onKey = (e) =>', action: "setQuery('')" },
];
const GUARD_NATIVE = 'isImeKeydown(e)';
for (const site of K5_LISTENERS) {
  await check(`K5 ${site.file.replace('client/src/', '')} · ${site.what}:组字中的 Esc 不关浮层`, async () => {
    const body = keyHandler(read(site.file), { ...site, mode: 'fn' });
    assert.ok(body.includes('Escape'), `取到的监听里没有 Escape(锚点取错了?):\n${body.slice(0, 300)}`);
    const a = body.indexOf(site.action);
    assert.ok(a >= 0, `监听里找不到关闭动作 ${site.action}`);
    const g = body.indexOf(GUARD_NATIVE);
    assert.ok(g >= 0, `缺输入法守卫:Esc 监听没有调用共用判定 ${GUARD_NATIVE}\n      监听:${body.replace(/\s+/g, ' ').slice(0, 260)}`);
    assert.ok(g < a, `守卫在关闭动作之后才判(${GUARD_NATIVE} 应先于 ${site.action})`);
  });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
