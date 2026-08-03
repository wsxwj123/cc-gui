#!/usr/bin/env node
// 批F F1 护栏:/api/slash-commands 合并 CLI init 事件上报的权威命令表。
// 回归对象(#11):GUI 的斜杠列表只有"硬编码表 + 扫三处磁盘",而 CLI 内置 skill(/loop 等)
// 打包在二进制里、磁盘上没有目录 → 用户敲 "/" 永远看不到 /loop,以为 GUI 不支持。
// 直接 import chat.js 的真函数(非复刻):合并被改回去时下面的断言必须失败。
//
// init 事件真实形态(sdk.d.ts:4060 SDKSystemMessage / CLI 2.1.220):
//   {"type":"system","subtype":"init","session_id":"…","cwd":"…",
//    "slash_commands":["clear","compact","loop",…],"skills":["pdf","docx",…], …}
//   —— 名字【不带前导斜杠】,故合并时必须补 "/"。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mergeInitCommands, getInitCommands } from '../../server/routes/chat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexSrc = readFileSync(join(ROOT, 'server', 'index.js'), 'utf8');
const chatSrc = readFileSync(join(ROOT, 'server', 'routes', 'chat.js'), 'utf8');

// ── ① init 有、磁盘没有 → 追加,且不被订阅门控标记 ─────────────────────────
{
  const commands = [{ name: '/clear', desc: '清除当前会话上下文', type: 'builtin' }];
  const out = mergeInitCommands(commands, { commands: ['clear', 'loop'], skills: ['pdf'], at: 1 });
  assert.equal(out, commands, '就地合并:返回的就是传入的数组');
  const loop = out.find((c) => c.name === '/loop');
  assert.ok(loop, 'init 里有 loop 而磁盘没有 → 必须补进列表');
  assert.equal(loop.requiresAnthropic, false, 'init 来源的条目一律不过订阅门控(init 出现=CLI 真有)');
  assert.ok(out.find((c) => c.name === '/pdf'), 'skills 与 slash_commands 一并合并');
}

// ── ② 同名不重复,保留磁盘/硬编码那份的描述与元数据 ───────────────────────
{
  const commands = [{ name: '/loop', desc: '本地描述', type: 'builtin', note: 'meta' }];
  const out = mergeInitCommands(commands, { commands: ['loop'], skills: ['loop'] });
  assert.equal(out.filter((c) => c.name === '/loop').length, 1, '同名只留一条');
  assert.equal(out[0].desc, '本地描述', '同名时保留原描述(BUILTIN_COMMANDS = 描述元数据来源)');
  assert.equal(out[0].note, 'meta', '原条目的元数据不被覆盖');
}

// ── ③ 名字带不带前导斜杠都归一 ───────────────────────────────────────────
{
  const out = mergeInitCommands([], { commands: ['/already', 'bare'] });
  assert.deepEqual(out.map((c) => c.name).sort(), ['/already', '/bare'], '统一补成 /name,不出现 //name');
}

// ── ④ 缓存为空(server 刚重启)必须容忍 → 回落纯磁盘扫描的现状 ─────────────
{
  const commands = [{ name: '/clear' }];
  assert.equal(mergeInitCommands(commands, null), commands, 'init 为 null 时原样返回,不抛');
  assert.equal(mergeInitCommands(commands, getInitCommands('/nowhere')), commands,
    '空缓存下 getInitCommands 返回 null,合并是 no-op');
  assert.deepEqual(commands.map((c) => c.name), ['/clear'], '空缓存不污染磁盘结果');
  // 脏数据不炸
  const dirty = mergeInitCommands([], { commands: [null, '', '  ', 3], skills: undefined });
  assert.deepEqual(dirty, [], '非字符串/空白项直接跳过');
}

// ── ⑤ 源码守卫:接线与门控 ───────────────────────────────────────────────
{
  const gate = indexSrc.match(/const SUBSCRIPTION_ONLY_NAMES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(gate, 'SUBSCRIPTION_ONLY_NAMES 仍在');
  assert.ok(!/['"]loop['"]/.test(gate[1]),
    "'loop' 不得回到 SUBSCRIPTION_ONLY_NAMES:/loop 靠 CronCreate,纯本地,与订阅无关");
  assert.ok(/'schedule'/.test(gate[1]) && /'remote-trigger'/.test(gate[1]),
    'schedule / remote-trigger 仍受门控(云端 routines,确实要订阅)');

  assert.ok(/mergeInitCommands\(commands, getInitCommands\(/.test(indexSrc),
    '/api/slash-commands 必须调用合并(否则 init 表白缓存)');
  assert.ok(/name: '\/loop'/.test(indexSrc), '/loop 必须在 BUILTIN_COMMANDS 里兜底(server 重启后缓存为空)');
  const loopDesc = indexSrc.match(/name: '\/loop',\s*desc: '([^']*)'/);
  assert.ok(loopDesc && /进程/.test(loopDesc[1]) && /停止/.test(loopDesc[1]),
    '/loop 的描述必须写明存活边界(循环随本地 CLI 进程存活,进程没了就停)');

  assert.ok(/initCommandCache\.set\(slot\.cwd,/.test(chatSrc),
    '消息泵必须把 init 的命令表写进缓存(按 cwd 键)');
  assert.ok(/Array\.isArray\(m\.slash_commands\) \|\| Array\.isArray\(m\.skills\)/.test(chatSrc),
    'init 分支判据必须认 slash_commands / skills 两个字段');
  assert.ok(/INIT_CACHE_MAX/.test(chatSrc) && /initCommandCache\.delete\(/.test(chatSrc),
    '缓存必须有上限与淘汰,否则按 cwd 无界增长');
}

console.log('✓ check-slash-init-merge: init 命令表合并 + /loop 不再被订阅门控拦截');
