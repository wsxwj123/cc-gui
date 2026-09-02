#!/usr/bin/env node
// 批O-1 守卫:会话改名落进 jsonl + 标题读侧的优先级链。
//
// 背景:改名此前只写 GUI 自己的 prefs.customTitles,CLI 与其它客户端看不到;而 CLI
// 首轮后会自己往会话 jsonl 写一行 ai-title,GUI 又不读。两边各写各的。现在:
//   写:PUT /api/prefs/custom-titles 顺带调 SDK renameSession 追加一行 custom-title;
//   读:session-reader 扫出 custom-title / ai-title 两个【独立】字段。
// 本文件锁住四件事:
//   ① 标题行是追加语义,同一文件多行取最后一行(改名多次);
//   ② custom-title 与 ai-title 绝不合并(合并 = AI 自动标题盖掉用户手改);
//   ③ 空 customTitle = 用户清空,读侧当"无"(否则清空后旧标题被 jsonl 顶回来);
//   ④ 会话没落盘(draft)时写 jsonl 失败只降级记日志,改名请求本身不失败。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessionTitles, findSessionFile } from '../../server/services/session-reader.js';
import { writeJsonlTitle } from '../../server/routes/prefs.js';
import { resolveSessionTitle } from '../../client/src/utils/sessionTitle.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'cgui-title-'));
const line = (o) => JSON.stringify(o);
const SID = '11111111-2222-4333-8444-555555555555';

try {
  // ── ① 追加语义:多行 last-wins;② 两字段独立 ────────────────────────────
  {
    const f = join(dir, `${SID}.jsonl`);
    writeFileSync(f, [
      line({ type: 'user', message: { role: 'user', content: 'hi' } }),
      line({ type: 'ai-title', aiTitle: 'CLI 自动标题', sessionId: SID }),
      line({ type: 'assistant', message: { role: 'assistant', content: [] } }),
      line({ type: 'custom-title', customTitle: '第一次改名', sessionId: SID }),
      line({ type: 'custom-title', customTitle: '  第二次改名  ', sessionId: SID }),
    ].join('\n') + '\n');

    const t = await readSessionTitles(f);
    assert.equal(t.customTitle, '第二次改名', '同一文件多行 custom-title 必须取最后一行(改名是追加,不是覆盖),并 trim');
    assert.equal(t.aiTitle, 'CLI 自动标题', 'ai-title 必须独立暴露,不能被 custom-title 吞并');
  }

  // ③ 空 customTitle(用户清空标题)= 没有自定义标题
  {
    const f = join(dir, 'cleared.jsonl');
    writeFileSync(f, [
      line({ type: 'custom-title', customTitle: '旧标题', sessionId: SID }),
      line({ type: 'ai-title', aiTitle: '自动标题', sessionId: SID }),
      line({ type: 'custom-title', customTitle: '', sessionId: SID }),
    ].join('\n') + '\n');
    const t = await readSessionTitles(f);
    assert.equal(t.customTitle, '', '追加空 customTitle = 清空,读侧不得把旧标题顶回来');
    assert.equal(t.aiTitle, '自动标题', '清空自定义标题不影响 ai-title');
  }

  // 吞并防线:清空标题之后又聊了两句,CLI 会追加新的 ai-title —— 行序是 custom('') 在前、
  // ai 在后。读侧若把 ai-title 并进 customTitle(SDKSessionInfo.customTitle 就是这么干的),
  // 新自动标题会顶掉刚清空的自定义标题 = 清空当场失效。前面两个用例的行序恰好掩护得住
  // 这种吞并(ai 行在前被后来的 custom 覆盖),必须单独按这个行序验。
  {
    const f = join(dir, 'cleared-then-ai.jsonl');
    writeFileSync(f, [
      line({ type: 'custom-title', customTitle: '旧标题', sessionId: SID }),
      line({ type: 'custom-title', customTitle: '', sessionId: SID }),
      line({ type: 'ai-title', aiTitle: '新自动标题', sessionId: SID }),
    ].join('\n') + '\n');
    const t = await readSessionTitles(f);
    assert.equal(t.customTitle, '', '清空后新来的 ai-title 不得回填 customTitle(两个字段严禁合并)');
    assert.equal(t.aiTitle, '新自动标题', 'ai-title 自己照常更新');
  }

  // 坏行/无标题行/文件不存在都不能抛
  {
    const f = join(dir, 'junk.jsonl');
    writeFileSync(f, '{ 坏 JSON "custom-title"\n' + line({ type: 'user' }) + '\n');
    assert.deepEqual(await readSessionTitles(f), { customTitle: '', aiTitle: '' }, '坏行不得抛,按无标题处理');
    assert.deepEqual(await readSessionTitles(join(dir, 'nope.jsonl')), { customTitle: '', aiTitle: '' }, '文件不存在按无标题处理');
  }

  // ── 优先级链 ────────────────────────────────────────────────────────────
  // jsonl custom > prefs custom > jsonl ai > prefs auto > firstPrompt
  {
    const s = (extra) => ({ sessionId: SID, firstPrompt: '首条消息', ...extra });
    assert.equal(resolveSessionTitle(s({ customTitle: 'J自定义', aiTitle: 'J自动' }), 'P自定义', 'P自动'), 'J自定义');
    assert.equal(resolveSessionTitle(s({ aiTitle: 'J自动' }), 'P自定义', 'P自动'), 'P自定义',
      '手改(prefs)必须压过自动(jsonl ai-title):否则 AI 一刷新就把用户改的名字盖掉');
    assert.equal(resolveSessionTitle(s({ aiTitle: 'J自动' }), '', 'P自动'), 'J自动');
    assert.equal(resolveSessionTitle(s({}), '', 'P自动'), 'P自动');
    assert.equal(resolveSessionTitle(s({}), '', ''), '首条消息');
    assert.equal(resolveSessionTitle(null, '', ''), '', '无 session 返回空串,不得抛');
    assert.equal(resolveSessionTitle(s({ customTitle: '' }), '', ''), '首条消息', '空 customTitle 不参与竞争');
  }

  // ── ④ draft(未落盘)降级:写 jsonl 失败不抛 ─────────────────────────────
  {
    const missing = '99999999-9999-4999-8999-999999999999';
    assert.equal(await findSessionFile(missing), null, '不存在的会话必须返回 null,不得抛');
    assert.equal(await findSessionFile('not-a-uuid'), null, '非 uuid 直接拒绝(不去拼路径)');
    const warned = [];
    const orig = console.warn;
    console.warn = (m) => warned.push(String(m));
    try {
      await writeJsonlTitle(missing, '随便什么标题'); // 会话不存在 → SDK 抛 → 必须被吞
      await writeJsonlTitle(missing, '');            // 清空路径同样降级
    } finally { console.warn = orig; }
    assert.equal(warned.length, 2, '两条降级路径都要留日志(静默失败=以后没人知道 jsonl 没写上)');
    assert.ok(warned.every((w) => w.includes(missing)), '日志要带 sessionId');
  }

  // ── 源码锁 ──────────────────────────────────────────────────────────────
  {
    const prefs = readFileSync(join(root, 'server/routes/prefs.js'), 'utf8');
    assert.ok(/import \{ renameSession \} from '@anthropic-ai\/claude-agent-sdk'/.test(prefs),
      '改名必须走 SDK renameSession(纯本地追加,零网络零子进程),不要自己拼协议');
    const put = prefs.slice(prefs.indexOf("router.put('/prefs/custom-titles'"), prefs.indexOf("router.get('/prefs/auto-titles'"));
    assert.ok(/await writeJsonlTitle\(sessionId, \(title \|\| ''\)\.trim\(\)\)/.test(put),
      'custom-titles PUT 必须同时把标题写进会话 jsonl');
    assert.ok(put.indexOf('await writeJsonlTitle') < put.indexOf('broadcast('),
      '先写 jsonl 再广播:广播出去的标题必须已经落盘');
    assert.ok(/prefs\.customTitles = m/.test(put), 'prefs 仍要写(跨端广播/搜索/draft 会话都靠它当缓存)');

    const reader = readFileSync(join(root, 'server/services/session-reader.js'), 'utf8');
    assert.ok(/customTitle: titles\.customTitle,\s*\n\s*aiTitle: titles\.aiTitle,/.test(reader),
      'listSessions 必须把两个标题分开暴露给前端');
    assert.ok(/takeTitleLine\(raw, tt\);/.test(reader),
      '标题行走 readJsonlEdges 已有的整文件回调收集(零额外 I/O),不要另开一遍读盘');

    const chat = readFileSync(join(root, 'server/routes/chat.js'), 'utf8');
    const title = chat.slice(chat.indexOf("router.post('/chat/title'"), chat.indexOf('const childEnv = { ...process.env };'));
    // r90:短路搬进 waitForAiTitle(先等原生几秒再决定要不要自己起进程),判据不变 ——
    // 端点必须走它、它必须读 jsonl 的 ai-title,拿到就直接返回、不起 -p 子进程。
    assert.ok(/const aiTitle = await waitForAiTitle\(jsonlSid\)/.test(title) && /if \(aiTitle\) return res\.json/.test(title),
      '标题端点必须先看 jsonl 里 CLI 写好的 ai-title,有就直接返回,不起 -p 子进程');
    assert.ok(/async function waitForAiTitle\([\s\S]*?readSessionTitles\(f\)[\s\S]*?t\?\.aiTitle/.test(chat),
      'waitForAiTitle 必须读 jsonl 的 ai-title 行');
    assert.ok(/claudeSpawn\(titleArgs/.test(chat), '自建标题链路必须保留当回退(第三方 provider 未必写 ai-title)');
  }

  console.log('✓ check-rename-session: 标题追加语义 / 两字段独立 / 优先级链 / draft 降级 全部通过');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
