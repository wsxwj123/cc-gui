#!/usr/bin/env node
// 单测:r29 Bug2①「/clear 冒出空的『/clear』会话」。
// 根因:findFirstRealUser 的 CI-5 bareToName 分支把【裸无参控制命令】(/clear 等)
// 也当真实首条。CLI 2.1.x 的 /clear 是轮换新会话语义,新 jsonl 头部唯一的 user
// 记录就是 /clear 命令回声 → 列表冒出一个标题「/clear」的空会话。
// 修法:已知无参控制命令(封闭集合 BARE_CONTROL_COMMANDS)返回 null;
// /skillname 裸开场(CI-5 本意)与带 args 的命令(/compact 主题)照旧放行。
// 夹具形态逐字取自真机取证(/tmp/cgui-clear-test,CLI 2.1.237 真跑 /clear 落盘)。
// 变异哨兵(实际验证过红):
//   S1 findFirstRealUser 删掉 BARE_CONTROL_COMMANDS 门控(回到 `if (cmdPrompt) return`)
//      → t1/t3 红(/clear /context 会话重新冒进列表)
//   S2 集合里误加 '/deep-research'(把 skill 名当控制命令)→ t2 红
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME 必须在 import session-reader 之前改 —— 它在模块作用域 join(homedir(), ...)。
const home = mkdtempSync(join(tmpdir(), 'cgui-r29-clear-list-'));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%,不同设沙箱失效
const HASH = 'r29-clear-hash';
mkdirSync(join(home, '.claude', 'projects', HASH), { recursive: true });

const write = (sid, lines) =>
  writeFileSync(join(home, '.claude', 'projects', HASH, `${sid}.jsonl`), lines.join('\n') + '\n');
const rec = (sid, o) => JSON.stringify({ sessionId: sid, cwd: '/tmp/r29-proj', ...o });
const modeLine = (sid) => JSON.stringify({ type: 'mode', mode: 'normal', sessionId: sid });
// 真机形态:CLI 2.1.x 在会话头部写 isMeta 的 local-command-caveat
const caveat = (sid) => rec(sid, {
  type: 'user', isMeta: true, uuid: `${sid}-caveat`, timestamp: '2026-08-21T14:51:11.320Z',
  message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' },
});
const bareCmd = (sid, name) => rec(sid, {
  type: 'user', uuid: `${sid}-cmd`, timestamp: '2026-08-21T14:51:12.000Z',
  message: { role: 'user', content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args></command-args>` },
});
const cmdWithArgs = (sid, name, args) => rec(sid, {
  type: 'user', uuid: `${sid}-cmd`, timestamp: '2026-08-21T14:51:12.000Z',
  message: { role: 'user', content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>` },
});
const sysLine = (sid) => rec(sid, { type: 'system', subtype: 'local_command', uuid: `${sid}-sys`, timestamp: '2026-08-21T14:51:12.500Z' });

const { listSessions } = await import('../../server/services/session-reader.js');

// t1 /clear 轮换出的新会话(真机 7a981af0 形态:mode + caveat + 裸 /clear 回声 + system + last-prompt)
//    → 不进列表
{
  write('clear-rotated', [
    modeLine('clear-rotated'),
    caveat('clear-rotated'),
    bareCmd('clear-rotated', '/clear'),
    sysLine('clear-rotated'),
    rec('clear-rotated', { type: 'last-prompt', uuid: 'clear-rotated-lp', timestamp: '2026-08-21T14:51:13.000Z' }),
  ]);
  const list = await listSessions(HASH);
  assert.equal(list.find((s) => s.sessionId === 'clear-rotated'), undefined,
    't1: 裸 /clear 开场的轮换空会话不得进列表');
}

// t2 CI-5 本意回归:裸 /skillname(无 args)开场仍放行,且标题就是命令名
{
  write('skill-open', [
    modeLine('skill-open'),
    bareCmd('skill-open', '/deep-research'),
    rec('skill-open', { type: 'assistant', uuid: 'skill-open-a1', timestamp: '2026-08-21T14:52:00.000Z',
      message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_1', content: [{ type: 'text', text: '好的,开始调研' }] } }),
  ]);
  const list = await listSessions(HASH);
  const s = list.find((x) => x.sessionId === 'skill-open');
  assert.ok(s, 't2: 裸 /skillname 开场的会话必须进列表(CI-5 不许回归)');
  assert.equal(s.firstPrompt, '/deep-research', 't2: 标题取命令名');
}

// t3 其余常见裸控制命令同样不进列表;/compact 带 args 仍是真实首条
{
  for (const [i, name] of ['/context', '/cost', '/login', '/logout', '/compact'].entries()) {
    const sid = `ctrl-${i}`;
    write(sid, [modeLine(sid), caveat(sid), bareCmd(sid, name), sysLine(sid)]);
  }
  write('compact-args', [
    modeLine('compact-args'),
    cmdWithArgs('compact-args', '/compact', '聚焦重构部分'),
    sysLine('compact-args'),
  ]);
  // 对照组:普通文本开场照常进列表
  write('normal-chat', [
    modeLine('normal-chat'),
    rec('normal-chat', { type: 'user', uuid: 'normal-u1', timestamp: '2026-08-21T14:53:00.000Z', message: { role: 'user', content: '帮我看看这个函数' } }),
    rec('normal-chat', { type: 'assistant', uuid: 'normal-a1', timestamp: '2026-08-21T14:53:05.000Z',
      message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_2', content: [{ type: 'text', text: '好的' }] } }),
  ]);
  const list = await listSessions(HASH);
  for (let i = 0; i < 5; i++) {
    assert.equal(list.find((s) => s.sessionId === `ctrl-${i}`), undefined,
      `t3: 裸控制命令会话 ctrl-${i} 不得进列表`);
  }
  const ca = list.find((s) => s.sessionId === 'compact-args');
  assert.ok(ca, 't3: /compact 带 args 是真实首条,会话进列表');
  assert.equal(ca.firstPrompt, '/compact 聚焦重构部分', 't3: 带 args 标题 = 命令+参数');
  assert.ok(list.find((s) => s.sessionId === 'normal-chat'), 't3: 普通会话不受影响');
}

// t4 接线哨兵:封闭集合存在且含诊断点名命令;findFirstRealUser 真的用它过滤
{
  const src = (await import('node:fs')).readFileSync(
    new URL('../../server/services/session-reader.js', import.meta.url), 'utf8');
  assert.match(src, /const BARE_CONTROL_COMMANDS = new Set\(\[/, 't4: 封闭集合存在');
  for (const c of ['/clear', '/compact', '/context', '/cost', '/login', '/logout']) {
    assert.ok(src.includes(`'${c}'`), `t4: 集合含 ${c}`);
  }
  assert.match(src, /BARE_CONTROL_COMMANDS\.has\(cmdPrompt\.toLowerCase\(\)\)/, 't4: findFirstRealUser 接线过滤');
  assert.ok(!src.includes("'/init'"), 't4: /init 会产生真实模型回合,不得在控制集合里(误收会让 /init 会话消失)');
}

rmSync(home, { recursive: true, force: true });
console.log('✓ check-r29-clear-list: 裸控制命令不进列表 + /skillname 放行 + 带 args 命令保留 + 集合接线');
