// r208 第 1 项:handleSend 里描述「发起这条消息的会话」的三个值,都从发送开头那份消息快照取。
//   S1 快照 const originMessagesAtStart = getLocalMessages(); 在 handleSend 函数体顶层(不在任何分支里)、
//      第一个 await 之前、第一个 return 之前,只声明一次。
//   S2 turnsBefore(这一轮开始前已有几轮回复)、_hist(历史模型)、_queueOwner(入队快照)三处都用这份快照;
//      这三个名字的赋值处都不再现读窗格此刻的消息(getLocalMessages())。
//   S3 三处各在一段等待之后(turnsBefore 在剥思考块的等待之后,_hist / _queueOwner 在拍文件快照的等待之后)——
//      这正是不能现读窗格的原因(等待期间窗格可能已切到别的会话);409 退回排队时放回的仍是 _queueOwner。
// node tests/unit/check-r208-send-origin-snapshot.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const hsHead = 'const handleSend = useCallback(async (prompt, opts = {}) => {';
const hs = app.indexOf(hsHead);
ok(hs > 0, '找到 handleSend');
const he = app.indexOf('= useCallback(', hs + hsHead.length);
ok(he > hs, '找到 handleSend 的结尾(下一个 useCallback)');
// 整行注释换成空行(行数与位置关系不变),注释里的「await」「return」字样不算
const code = app.slice(hs, he).split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');

// S1
const snapLine = '\n    const originMessagesAtStart = getLocalMessages();\n';
const snapAt = code.indexOf(snapLine);
ok(snapAt > 0, 'S1:handleSend 函数体顶层(缩进 4 格)有发送开头的消息快照');
ok(code.split(/\boriginMessagesAtStart\s*=[^=>]/).length - 1 === 1, 'S1:快照只赋值一次(声明处)');
const firstAwait = code.search(/\bawait\b/);
ok(firstAwait > 0 && snapAt < firstAwait, 'S1:快照取在 handleSend 第一个 await 之前');
const firstReturn = code.search(/\breturn\b/);
ok(firstReturn > 0 && snapAt < firstReturn, 'S1:快照取在 handleSend 第一个 return 之前(任何提前返回的分支都已取好)');

// S2
const turnsLine = "try { turnsBefore = (originMessagesAtStart || []).filter((m) => m.type === 'turn').length; } catch {}";
const histLine = 'const _hist = resolveHistModel(originMessagesAtStart, _stM.providerEpoch || 0, _officialM);';
const ownerLine = 'const _queueOwner = queueOwnerSnapshot(chatCwdFor(selectedSession, selectedProject), selectedSession?.projectHash, originMessagesAtStart);';
const turnsAt = code.indexOf(turnsLine);
const histAt = code.indexOf(histLine);
const ownerAt = code.indexOf(ownerLine);
ok(turnsAt > snapAt, 'S2:turnsBefore 按快照数');
ok(histAt > snapAt, 'S2:_hist 按快照算');
ok(ownerAt > histAt, 'S2:_queueOwner 按快照取(紧跟 _hist)');
const assignLines = code.split('\n').filter((l) => /\b(turnsBefore|_hist|_queueOwner)\s*=[^=>]/.test(l));
ok(assignLines.length === 4, `S2:三个名字的赋值处共 4 行(let turnsBefore = 0 + 三处取值;实际 ${assignLines.length} 行)`);
ok(assignLines.every((l) => !l.includes('getLocalMessages(')), 'S2:三个名字的赋值处都不现读窗格此刻的消息');

// S3
const stripAwaitAt = code.indexOf("await runHistoryOp(sid0, 'strip-thinking'");
const checkpointAwaitAt = code.indexOf('try { await checkpointPromise; } catch {}');
ok(stripAwaitAt > snapAt && stripAwaitAt < turnsAt, 'S3:turnsBefore 在剥思考块的等待之后(所以要用开头的快照)');
ok(checkpointAwaitAt > snapAt && checkpointAwaitAt < histAt, 'S3:_hist / _queueOwner 在拍文件快照的等待之后(所以要用开头的快照)');
const requeueAt = code.indexOf('useStore.getState().requeueMessageFront(sessionQueueKey, {');
const requeueEnd = code.indexOf('}, { afterBusy: !opts.busyRequeued });', requeueAt);
ok(requeueAt > ownerAt && requeueEnd > requeueAt && /\bowner: _queueOwner,/.test(code.slice(requeueAt, requeueEnd)), 'S3:409 退回排队放回的是 _queueOwner');

console.log(`✓ check-r208-send-origin-snapshot:${checks} 项断言全部通过`);
