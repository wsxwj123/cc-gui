// r195-trim-keep-titles · 接口用例(行为清单 1–13 + E1;另加 11b 补「回退并压缩时排在摘要之后」)。
// 只依据 .devflow/r195-trim-keep-titles-接口.md:只通过 HTTP 接口 + 会话记录文件观察,没看实现代码。
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import {
  call, uuid, newSession, rename, listItem, prefTitles, rollback, records, rawLines, appendLines, lastOfType,
  userRec, asstRec, customTitle, aiTitle, tagRec,
} from './helpers/env.mjs';

const U2_PARAMS = (c) => ({ uuid: c.u2 });

// ============================ 复现:截断点之后的标题被一并删掉 ============================

test('1 【复现】回退(trim,按 uuid 锚到第 2 条用户消息)后,列表 customTitle、会话记录最后一条改名、偏好都是「新名」', async ({ request }) => {
  const c = newSession();
  await rename(request, c.sid, '新名');
  await rollback(request, c, 'trim', U2_PARAMS(c));
  expect((await listItem(request, c.hash, c.sid))?.customTitle, '列表 customTitle').toBe('新名');
  expect(lastOfType(records(c.file), 'custom-title')?.customTitle, '会话记录最后一条 custom-title').toBe('新名');
  expect((await prefTitles(request))[c.sid], '偏好里的名字').toBe('新名');
});

test('2 【复现】回退(trim,按 fromTimestamp 锚到第 2 条用户消息的时刻)后,名字仍是「新名」', async ({ request }) => {
  const c = newSession();
  await rename(request, c.sid, '新名');
  await rollback(request, c, 'trim', { fromTimestamp: c.recU2.timestamp });
  expect((await listItem(request, c.hash, c.sid))?.customTitle, '列表 customTitle').toBe('新名');
  expect(lastOfType(records(c.file), 'custom-title')?.customTitle, '会话记录最后一条 custom-title').toBe('新名');
  expect((await prefTitles(request))[c.sid], '偏好里的名字').toBe('新名');
});

test('3 【复现】改名夹在工具调用与工具结果之间,回退到工具调用前(trim-before-tool)后,名字仍是「新名」', async ({ request }) => {
  const toolId = `toolu_${uuid().replace(/-/g, '').slice(0, 20)}`;
  const c = newSession({
    a2: (cc) => asstRec(cc, cc.a2, cc.u2, 4, [{ type: 'text', text: '我先跑个命令' }, { type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'ls' } }]),
  });
  await rename(request, c.sid, '新名'); // 工具还在跑时改的名:夹在工具调用行与工具结果行之间
  const resultId = uuid();
  appendLines(c.file, [
    userRec(c, resultId, c.a2, 5, [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }]),
    asstRec(c, uuid(), resultId, 6, [{ type: 'text', text: '命令跑完了' }]),
  ]);
  await rollback(request, c, 'trim-before-tool', { toolUseId: toolId });
  expect((await listItem(request, c.hash, c.sid))?.customTitle, '列表 customTitle').toBe('新名');
  expect(lastOfType(records(c.file), 'custom-title')?.customTitle, '会话记录最后一条 custom-title').toBe('新名');
});

test('4 【复现】回退并压缩(compact-segment,after,锚到第 2 条用户消息)后,名字仍是「新名」', async ({ request }) => {
  const c = newSession();
  await rename(request, c.sid, '新名');
  await rollback(request, c, 'compact-segment', { uuid: c.u2, direction: 'after' });
  expect((await listItem(request, c.hash, c.sid))?.customTitle, '列表 customTitle').toBe('新名');
});

test('5 【复现】分叉出的会话 F 改名「旧名分支1」后回退到复制来的第 2 条用户消息,F 的名字仍是「旧名分支1」,源会话 S 不受影响', async ({ request }) => {
  const c = newSession();
  await rename(request, c.sid, '新名');
  const sBefore = fs.readFileSync(c.file, 'utf8');
  const fk = await call(request, 'POST', '/api/fork', { sessionId: c.sid, projectHash: c.hash });
  expect(fk.status, `分叉:${fk.text}`).toBe(200);
  const fid = fk.json?.newSessionId;
  expect(typeof fid, '分叉应返回 newSessionId').toBe('string');
  await rename(request, fid, '旧名分支1');
  await rollback(request, c, 'trim', U2_PARAMS(c), fid);
  expect((await listItem(request, c.hash, fid))?.customTitle, 'F 的 customTitle').toBe('旧名分支1');
  expect(fs.readFileSync(c.file, 'utf8'), 'S 的会话记录应一字不变').toBe(sBefore);
  expect((await listItem(request, c.hash, c.sid))?.customTitle, 'S 的 customTitle').toBe('新名');
});

test('6 【复现】截断点之后把名字清空,回退后列表里没有自定义名(不是「旧名」)', async ({ request }) => {
  const c = newSession();
  await rename(request, c.sid, '新名');
  await rename(request, c.sid, '');
  await rollback(request, c, 'trim', U2_PARAMS(c));
  const item = await listItem(request, c.hash, c.sid);
  expect(item, '会话 S 应仍在列表里(还剩第 1 轮对话)').not.toBeNull();
  expect(item.customTitle || '', '列表 customTitle 应为空').toBe('');
});

test('7 【复现】没有改名记录,截断点之前有 ai-title「旧AI名」、之后有「新AI名」,回退后列表 aiTitle 是「新AI名」', async ({ request }) => {
  const c = newSession({ leading: (cc) => [aiTitle(cc.sid, '旧AI名')], tail: (cc) => [aiTitle(cc.sid, '新AI名')] });
  await rollback(request, c, 'trim', U2_PARAMS(c));
  expect((await listItem(request, c.hash, c.sid))?.aiTitle, '列表 aiTitle').toBe('新AI名');
});

test('8 【复现】截断点之前有 tag「旧标签」、之后有「新标签」,回退后会话记录最后一条 tag 是「新标签」', async ({ request }) => {
  const c = newSession({ leading: (cc) => [customTitle(cc.sid, '旧名'), tagRec(cc.sid, '旧标签')], tail: (cc) => [tagRec(cc.sid, '新标签')] });
  await rename(request, c.sid, '新名');
  await rollback(request, c, 'trim', U2_PARAMS(c));
  expect(lastOfType(records(c.file), 'tag')?.tag, '会话记录最后一条 tag').toBe('新标签');
});

// ============================ 回归 / 守卫 ============================

test('9 【回归】截断点之后没有任何标题类记录:回退后的会话记录与原文里截断点之前的部分逐字节相同', async ({ request }) => {
  const c = newSession();
  await rollback(request, c, 'trim', U2_PARAMS(c));
  expect(fs.readFileSync(c.file, 'utf8')).toBe(`${c.beforeRaw.join('\n')}\n`);
});

test('10 【守卫】被删的内容不混进回退结果:含 "custom-title" 字样的用户消息、last-prompt 记录都不出现', async ({ request }) => {
  const u3 = uuid();
  const c = newSession({
    tail: (cc) => [
      userRec(cc, u3, cc.a2, 5, '第三个问题:MARK-U3 请解释一下 custom-title 是什么'),
      asstRec(cc, uuid(), u3, 6, [{ type: 'text', text: '第三个回答' }]),
      { type: 'last-prompt', lastPrompt: '第三个问题', leafUuid: u3, sessionId: cc.sid },
    ],
  });
  await rename(request, c.sid, '新名');
  await rollback(request, c, 'trim', U2_PARAMS(c));
  const text = fs.readFileSync(c.file, 'utf8');
  const recs = records(c.file);
  expect(text.includes('MARK-U3'), '含 custom-title 字样的用户消息不应留下').toBe(false);
  expect(recs.filter((r) => r.type === 'last-prompt').length, 'last-prompt 记录不应留下').toBe(0);
  expect(recs.some((r) => r.uuid === u3 || r.uuid === c.u2 || r.uuid === c.a2), '被删消息的 uuid 不应留下').toBe(false);
  expect(recs.some((r) => r.uuid === c.u1) && recs.some((r) => r.uuid === c.a1), '截断点之前的对话应保留').toBe(true);
});

const TAG_RAW = (sid) => `{"type": "tag", "tag":"\\u65b0\\u6807\\u7b7e", "sessionId":"${sid}", "x":1}`;
const AI_RAW = (sid) => `{"sessionId":"${sid}","aiTitle":"\\u65b0AI\\u540d","type":"ai-title"}`;

/** 准备 11 / 11b 共用的会话:截断点之后依次是 tag、ai-title(手写的非常规格式,方便发现被重新序列化)、改名接口写的「新名」。 */
async function prepareTitledTail(request) {
  const c = newSession({ tail: (cc) => [TAG_RAW(cc.sid), AI_RAW(cc.sid)] });
  await rename(request, c.sid, '新名');
  const all = rawLines(c.file);
  const titlesRaw = all.slice(c.before.length + 2); // 跳过 U2、A2
  expect(titlesRaw.length, '截断点之后应有 3 条标题类行').toBe(3);
  expect(titlesRaw[0]).toBe(TAG_RAW(c.sid));
  expect(titlesRaw[2]).toContain('新名');
  return { c, titlesRaw };
}

test('11 【守卫】回退(trim)后留下的标题类记录与原行逐字节相同,排在保留的原有行之后,先后顺序不变', async ({ request }) => {
  const { c, titlesRaw } = await prepareTitledTail(request);
  await rollback(request, c, 'trim', U2_PARAMS(c));
  expect(rawLines(c.file)).toEqual([...c.beforeRaw, ...titlesRaw]);
});

test('11b 【守卫】回退并压缩(compact-segment)后,留下的标题类记录逐字节相同、顺序不变,排在摘要记录之后', async ({ request }) => {
  const { c, titlesRaw } = await prepareTitledTail(request);
  await rollback(request, c, 'compact-segment', { uuid: c.u2, direction: 'after' });
  const lines = rawLines(c.file);
  expect(lines.slice(-3), '最后三行应是原样的三条标题类记录').toEqual(titlesRaw);
  const summary = JSON.parse(lines[lines.length - 4]);
  expect(summary.isCompactSummary, '标题类记录之前一行应是摘要记录').toBe(true);
});

test('12 【回归】回退到第一条用户消息(对话全删):resultSessionId 为 null,且列表不列这份只剩元数据的会话记录', async ({ request }) => {
  const c = newSession({ tail: (cc) => [aiTitle(cc.sid, '新AI名'), tagRec(cc.sid, '新标签')] });
  await rename(request, c.sid, '新名');
  const out = await rollback(request, c, 'trim', { uuid: c.u1 });
  expect(out.resultSessionId).toBeNull();
  expect(await listItem(request, c.hash, c.sid), '只剩元数据的会话不应出现在列表里').toBeNull();
});

test('13 【守卫】记录里有两个会话编号:回退后末尾依次是「源名2」(G)、「源名分支1」(本会话),与原行逐字节相同,列表 customTitle 是「源名分支1」', async ({ request }) => {
  const g = uuid();
  const rawG2 = `{"type":"custom-title","customTitle":"源名2","sessionId":"${g}"}`;
  let rawS1 = '';
  const c = newSession({
    leading: () => [customTitle(g, '源名')],
    tail: (cc) => { rawS1 = `{"type":"custom-title","customTitle":"源名分支1","sessionId":"${cc.sid}"}`; return [rawG2, rawS1]; },
  });
  await rollback(request, c, 'trim', U2_PARAMS(c));
  expect(rawLines(c.file)).toEqual([...c.beforeRaw, rawG2, rawS1]);
  expect((await listItem(request, c.hash, c.sid))?.customTitle, '列表 customTitle').toBe('源名分支1');
});

// ============================ 错误契约 ============================

test('E1 回退(trim)的 uuid 在会话记录里不存在:预览 404、code 为 SESSION_NOT_FOUND,会话记录一字不变', async ({ request }) => {
  const c = newSession();
  const before = fs.readFileSync(c.file);
  const r = await call(request, 'POST', `/api/sessions/${c.sid}/trim`, { projectHash: c.hash, dryRun: true, uuid: uuid() });
  expect(r.status, r.text).toBe(404);
  expect(r.json?.code).toBe('SESSION_NOT_FOUND');
  expect(fs.readFileSync(c.file).equals(before), '会话记录应一字不变').toBe(true);
});
