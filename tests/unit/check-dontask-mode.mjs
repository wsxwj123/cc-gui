#!/usr/bin/env node
// 批O-2 守卫:「不打扰」档(dontAsk)。
//
// 这一档【必须由 GUI 自己模拟,绝不能透传给 SDK】:透传原生 dontAsk 后 CLI 直接按
// settings.json 的 permissions.allow 预授权判定,canUseTool 一次都不调 —— 危险 Bash
// 强拦、MCP 自动执行名单、越界卡、AskUserQuestion 特判全部失效,而用户的 allow 名单
// 通常是空的,结果是"全拒且没有任何防线"。所以本文件锁两头:
//   ① autoDecide 的 dontAsk 分支四路裁决(提问放行给用户 / 只读放行 / 勾了自动执行的
//      MCP 放行 / 其余带理由拒绝),越界与危险命令都不得被放宽;
//   ② sdkMode 映射仍落 'default'(即 canUseTool 照常被调),前后端档位清单都认这一档。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// mcpAutoApproved 读 ~/.claude/gui/mcp-autoapprove.json。把 HOME 指到临时目录,
// 用例才不依赖本机真实勾选状态(必须在 import chat.js 之前设好)。
const fakeHome = mkdtempSync(join(tmpdir(), 'cgui-dontask-home-'));
const realHome = process.env.HOME;
mkdirSync(join(fakeHome, '.claude', 'gui'), { recursive: true });
writeFileSync(join(fakeHome, '.claude', 'gui', 'mcp-autoapprove.json'), JSON.stringify(['paper-search']));
process.env.HOME = fakeHome;

try {
  const { autoDecide } = await import('../../server/routes/chat.js');
  const d = (tool, input = {}, boundary = null) => autoDecide('dontAsk', tool, input, boundary);

  // ① 提问卡永远等人 —— 它问的就是用户本人,自动裁决它等于替用户答题。
  assert.equal(d('AskUserQuestion', { questions: [] }), null,
    'AskUserQuestion 必须落到用户(返回 null),不打扰档也不例外');

  // ② 只读工具直接执行
  for (const t of ['Read', 'Glob', 'Grep', 'WebFetch', 'TaskCreate']) {
    assert.deepEqual(d(t, { file_path: '/tmp/a.txt' }), { decision: 'allow' }, `${t} 属只读类,应直接放行`);
  }

  // ③ 已勾选"自动执行"的 MCP 直接执行;没勾的照样拒
  assert.deepEqual(d('mcp__paper-search__search_pubmed', {}), { decision: 'allow' },
    '勾了自动执行的 MCP server 其工具应放行');
  assert.equal(d('mcp__someother__do_thing', {}).decision, 'deny', '没勾自动执行的 MCP 不得放行');

  // ④ 其余一律拒绝,且理由要告诉用户"怎么办"
  for (const [tool, input] of [['Write', { file_path: '/tmp/a.txt' }], ['Edit', {}], ['Bash', { command: 'ls' }]]) {
    const v = d(tool, input);
    assert.equal(v.decision, 'deny', `${tool} 在不打扰档必须拒绝`);
    assert.ok(/不打扰/.test(v.reason) && /切换权限档位/.test(v.reason),
      '拒绝理由要说清是哪一档拒的、以及怎么恢复(模型会把它读给用户听)');
  }

  // ⑤ 危险命令:拒绝而不是弹卡。分支必须排在危险 Bash 强拦(返回 null=弹卡)之前,
  // 否则"永不弹窗"的承诺破功;deny 比弹卡更严,不构成放宽。
  assert.equal(d('Bash', { command: 'rm -rf /tmp/x' }).decision, 'deny',
    '危险命令在不打扰档应直接拒绝,不得弹卡(该档承诺不弹窗)');

  // ⑥ 越界(沙箱外)不放行:不打扰 ≠ 自动扩权
  assert.equal(d('Read', { file_path: '/etc/passwd' }, '/etc/passwd').decision, 'deny',
    '越界路径即便是只读也不得自动放行');
  assert.equal(d('mcp__paper-search__search_pubmed', {}, '/etc/x').decision, 'deny',
    '越界时 MCP 自动执行名单同样不生效');

  // ⑦ 其它档位不受影响(回归)
  assert.equal(autoDecide('default', 'Write', { file_path: '/tmp/a.txt' }, null), null, 'default 档仍弹卡');
  assert.deepEqual(autoDecide('bypassPermissions', 'Write', {}, null), { decision: 'allow' }, '放任档仍全放行');
  assert.deepEqual(autoDecide('acceptEdits', 'Write', {}, null), { decision: 'allow' }, '接受编辑档仍放行写类');

  // ── 源码锁 ────────────────────────────────────────────────────────────
  const chat = readFileSync(join(root, 'server/routes/chat.js'), 'utf8');
  assert.ok(/VALID_PERMISSION_MODES = new Set\(\[[^\]]*'dontAsk'/.test(chat), '服务端档位白名单必须收 dontAsk');
  // 透传红线:两处 sdkMode 映射都只认 plan/auto,dontAsk 必须落 'default'(canUseTool 照常被调)。
  const maps = chat.match(/=== 'plan' \? 'plan' : \w+ === 'auto' \? 'auto' : 'default'/g) || [];
  assert.equal(maps.length, 2, 'sdkMode 映射(spawn + 热切)必须仍是两处、且只特判 plan/auto');
  // 代码里出现 'dontAsk' 的地方只许是:档位白名单、autoDecide 的分支判断、注释。
  // 任何"把它塞进 SDK 选项"的写法(permissionMode: … dontAsk / sdkPermMode = 'dontAsk')都不行。
  assert.ok(!/permissionMode:[^\n]*dontAsk|sdk\w*Mode\s*=\s*[^\n]*'dontAsk'/.test(chat),
    'dontAsk 绝不能作为 SDK permissionMode 透传(会让 canUseTool 完全不被调用)');
  const auto = chat.slice(chat.indexOf('export function autoDecide'), chat.indexOf('function makeCanUseTool'));
  assert.ok(auto.indexOf("mode === 'dontAsk'") > auto.indexOf("mode === 'bypassPermissions'"),
    'dontAsk 分支排在 bypassPermissions 之后');
  assert.ok(auto.indexOf("mode === 'dontAsk'") < auto.indexOf('isDangerousBash(toolName, input)'),
    'dontAsk 分支必须排在危险 Bash 弹卡之前,否则该档会弹窗');
  assert.ok(/resolvePendingForSession\(sessionId, \(r\) => autoDecide\(mode,/.test(chat),
    '切档重裁必须继续共用 autoDecide:切到不打扰档时在飞卡片才会被自动判掉');

  const store = readFileSync(join(root, 'client/src/stores/sessionStore.js'), 'utf8');
  assert.ok(/PERMISSION_MODES = \[[^\]]*'dontAsk'/.test(store), '前端档位清单必须收 dontAsk');
  const input = readFileSync(join(root, 'client/src/components/ChatInput.jsx'), 'utf8');
  assert.ok(/dontAsk:\s*\{ label: '不打扰'/.test(input), 'MODE_META 必须有 dontAsk 档(否则选择器渲染不出它)');

  console.log('✓ check-dontask-mode: 四路裁决 / 越界与危险命令不放宽 / 不透传 SDK / 前后端档位清单 全部通过');
} finally {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
}
