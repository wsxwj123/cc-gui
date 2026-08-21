#!/usr/bin/env node
// r31 钉子:draft 窗格「添加到上下文」targetKey 必须与 ChatInput 的 permKey 同构。
// 根因:FileExplorerPanel addPathToContext 手写 `draft-${projectHash}`(旧 B5 之前形态,
// 无 draftId 段),而 ChatInput 的 permKey = queueKeyFor(selectedSession) =
// `draft-<projectHash>-<draftId>`(r26-B5 起)。两键不等 → ChatInput onFill 的
// `targetKey !== permKey` 守门把字段挡掉,draft 窗格「添加到上下文」点了没反应。
// 修:改调 queueKeyFor(activeSession)。真会话返回 sessionId,行为不变。
// 钉:①FileExplorerPanel 不再手写裸 `draft-${projectHash}` 模板;②改调 queueKeyFor;
//      ③queueKeyFor 对 draft 产出 `draft-<hash>-<draftId>`,与真正会话/草稿同构;
//      ④真会话返回 sessionId。
// Run: node tests/unit/check-r31-composer-fill-draft.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { queueKeyFor } from '../../client/src/utils/steerQueue.js';

const src = readFileSync(new URL('../../client/src/components/FileExplorerPanel.jsx', import.meta.url), 'utf8');
const addPath = src.slice(src.indexOf('const addPathToContext'), src.indexOf('const deletePath'));

// ① 手写裸模板(旧形态)不得回归
assert.doesNotMatch(addPath, /`draft-\$\{activeSession\?\.projectHash/,
  'FileExplorerPanel 不得手写旧形态 draft-<hash> 模板');
assert.doesNotMatch(addPath, /\|\| `draft-\$\{/,
  '不得再用 `|| `draft-...` 兜底裸模板');
// ② 改调 queueKeyFor(activeSession)
assert.match(addPath, /const targetKey = queueKeyFor\(activeSession\);?/,
  'targetKey 必须走 queueKeyFor(activeSession) 统一构造点');
// deps 覆盖 draftId
assert.match(addPath, /activeSession\?\.draftId/, 'useCallback deps 须包含 draftId(targetKey 依赖它)');
// import 到位
assert.match(src, /import \{ queueKeyFor \} from '\.\.\/utils\/steerQueue\.js';?/, '导入 queueKeyFor');

// ③ 键同构:draft 产出 draft-<hash>-<draftId>,与 ChatInput permKey 同构(单一构造点保证)
assert.equal(queueKeyFor({ projectHash: 'abc', draftId: 'd1' }), 'draft-abc-d1', 'draft 键带 draftId 段');
assert.equal(queueKeyFor({ projectHash: 'abc', draftId: 'd1', sessionId: null }), 'draft-abc-d1', 'draft(sessionId null) 同为 draft-...');
// ④ 真会话返回 sessionId(行为不变,不误伤分屏真会话)
assert.equal(queueKeyFor({ sessionId: 'sid-1', projectHash: 'abc' }), 'sid-1', '真会话返回 sessionId');
assert.equal(queueKeyFor({ projectHash: 'none' }), 'draft-none-none', '无 draftId 兜底 -none(安全失败)');

console.log('PASS check-r31-composer-fill-draft');
