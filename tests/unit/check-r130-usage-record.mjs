#!/usr/bin/env node
// r130 · user 记录分类(server/utils/usage-record.js):合成回显表、子代理两重排除、tool_result 判定、
// 与 session-reader.js 的 isLocalCommandEcho 正则**跨文件逐字相等**(两处漂移 = 消息数悄悄变)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SYNTHETIC_USER_ECHO_RE, isUserMessage } from '../../server/utils/usage-record.js';

// ── 跨文件钉相等:从 session-reader.js 源码里抠出正则字面量,与本模块导出的逐字比 ──
{
  const src = readFileSync(new URL('../../server/services/session-reader.js', import.meta.url), 'utf8');
  const m = /function isLocalCommandEcho\(text\) \{\s*return (\/.+?\/[a-z]*)\.test\(text\);/.exec(src);
  assert.ok(m, 'session-reader.js 里应能定位 isLocalCommandEcho 的正则字面量(重构后同步本锚)');
  assert.equal(m[1], SYNTHETIC_USER_ECHO_RE.toString(), '两处正则必须逐字相同(CLI 新增合成标签时一起改)');
}

const user = (content, extra = {}) => ({ type: 'user', uuid: 'u', timestamp: '2026-09-27T01:00:00Z', message: { role: 'user', content }, ...extra });
const toolResult = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'out' };
const text = (t) => ({ type: 'text', text: t });

// ── 回显表:八种标签(含前导空白)不算;bash-input / pasted_content / 普通文本算 ──
const echoes = ['<local-command-caveat>x</local-command-caveat>', '<local-command-stdout>ok</local-command-stdout>',
  '<local-command-stderr>err</local-command-stderr>', '<command-name>/clear</command-name>', '<command-message>clear</command-message>',
  '<command-args>-a</command-args>', '<task-notification>done</task-notification>', '<cgui-tool-retry>1</cgui-tool-retry>',
  '  \n<command-name>/help</command-name>'];
for (const t of echoes) assert.equal(isUserMessage(user(t)), false, `合成回显不算:${JSON.stringify(t)}`);
for (const t of ['<bash-input>ls -la</bash-input>', '<pasted_content>粘贴的内容</pasted_content>', '普通提问', '<system-reminder>x', 'x <command-name>']) {
  assert.equal(isUserMessage(user(t)), true, `用户内容算:${JSON.stringify(t)}`);
}
assert.equal(isUserMessage(user('')), true, '空字符串按契约字面:typeof string → 算');

// ── 数组内容:首个 text 块决定回显;至少一个非 tool_result 块才算 ──
assert.equal(isUserMessage(user([toolResult])), false, '只有 tool_result 块不算');
assert.equal(isUserMessage(user([toolResult, text('继续')])), true, 'tool_result 之外有 text 块 → 算');
assert.equal(isUserMessage(user([text('<command-name>/x</command-name>')])), false, '数组首个 text 块是回显 → 不算');
assert.equal(isUserMessage(user([toolResult, text('<task-notification>d</task-notification>')])), false, '首个 text 块(不是首个块)是回显 → 不算');
assert.equal(isUserMessage(user([text('你好'), text('<command-name>/x</command-name>')])), true, '只看第一个 text 块');
assert.equal(isUserMessage(user([{ type: 'image', source: {} }])), true, '非 tool_result 的其它块算');
assert.equal(isUserMessage(user([null, toolResult])), false, '空块不算作"非 tool_result"');
assert.equal(isUserMessage(user([])), false, '空数组不算');

// ── 记录级排除:type / isMeta / isSidechain / 子代理路径 / 缺 content ──
assert.equal(isUserMessage({ ...user('hi'), type: 'assistant' }), false, '非 user 不算');
assert.equal(isUserMessage(user('hi', { isMeta: true })), false, 'isMeta 不算');
assert.equal(isUserMessage(user('hi', { isMeta: false })), true);
assert.equal(isUserMessage(user('hi', { isSidechain: true })), false, 'isSidechain 不算');
assert.equal(isUserMessage(user('hi', { isSidechain: false }), { inSubagentPath: true }), false, '子代理文件里 isSidechain=false 也不算(路径双保险)');
assert.equal(isUserMessage(user('hi'), { inSubagentPath: false }), true);
assert.equal(isUserMessage(user('hi')), true, '不传选项 = 顶层文件');
assert.equal(isUserMessage({ type: 'user', uuid: 'u' }), false, '缺 message 不算');
assert.equal(isUserMessage(user({ text: 'obj' })), false, 'content 为对象不算');
assert.equal(isUserMessage(user(undefined)), false, 'content 缺失不算');
assert.equal(isUserMessage(null), false);
assert.equal(isUserMessage(undefined), false);

console.log('check-r130-usage-record: PASS');
