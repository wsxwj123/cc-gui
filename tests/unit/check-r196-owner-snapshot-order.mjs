// r196 F1:排队条目的入队快照 owner 必须在「等待」之前取(窗格此刻显示的就是发起的会话)。
//   O1 409 退回排队用的 _queueOwner 在 handleSend 里与 _hist 同一时刻取,先于 POST /api/chat 与读应答这两段等待;
//      两者都按 handleSend 开头(第一个等待之前)取的消息快照 originMessagesAtStart 算(r208:拍文件快照的等待在它们之前,
//      那之后窗格可能已切到别的会话);放回时用这个局部变量,不在等待之后再读窗格。
//   O2 入队门那条路径:stampQueueOwner 在入队门之前定义,入队后同一个同步段里调用;handleSend 开头到入队门之间的等待
//      只在 /remote-control 拦截分支里(那个分支自己返回,不走到入队门)。
//   O3 App.jsx 里 queueOwnerSnapshot( 只有定义 + 上面两处,没有别的调用点。
// node tests/unit/check-r196-owner-snapshot-order.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const hsHead = 'const handleSend = useCallback(async (prompt, opts = {}) => {';
const hs = app.indexOf(hsHead);
ok(hs > 0, '找到 handleSend');
const he = app.indexOf('= useCallback(', hs + hsHead.length);
const body = app.slice(hs, he > 0 ? he : undefined);

// O1
const histAt = body.indexOf('const _hist = resolveHistModel(originMessagesAtStart, _stM.providerEpoch || 0, _officialM);');
const ownerAt = body.indexOf('const _queueOwner = queueOwnerSnapshot(chatCwdFor(selectedSession, selectedProject), selectedSession?.projectHash, originMessagesAtStart);');
const snapAt = body.indexOf('\n    const originMessagesAtStart = getLocalMessages();');
const fetchAt = body.indexOf("const res = await fetch('/api/chat', {");
const jsonAt = body.indexOf('const respJson = await res.json();');
ok(histAt > 0 && ownerAt > histAt, 'O1:_queueOwner 紧跟在 _hist 之后取');
ok(!/\bawait\b/.test(body.slice(histAt, ownerAt)), 'O1:_hist 与 _queueOwner 之间没有等待');
ok(fetchAt > ownerAt && jsonAt > fetchAt, 'O1:_queueOwner 先于 POST /api/chat 与读应答两段等待');
ok(snapAt > 0 && snapAt < body.search(/\bawait\b/) && snapAt < histAt, 'O1:_hist 与 _queueOwner 用的消息快照取在 handleSend 第一个等待之前');
const requeueAt = body.indexOf('useStore.getState().requeueMessageFront(sessionQueueKey, {');
const requeueEnd = body.indexOf('}, { afterBusy: !opts.busyRequeued });', requeueAt);
ok(requeueAt > jsonAt && requeueEnd > requeueAt, 'O1:找到 409 放回那一处(在读应答之后)');
const requeueLit = body.slice(requeueAt, requeueEnd);
ok(/\bowner: _queueOwner,/.test(requeueLit), 'O1:放回用等待之前取好的 _queueOwner');
ok(!/queueOwnerSnapshot\(|getLocalMessages\(\)/.test(requeueLit), 'O1:放回处不再现读窗格');

// O2
const gateAt = body.indexOf('\n    if (!reattachPid && !opts.forceSend && (');
const stampDefAt = body.indexOf('const stampQueueOwner = (q) => useStore.getState().setQueueItemOwner(sessionQueueKey, q.queueId, queueOwnerSnapshot(chatCwdFor(selectedSession, selectedProject), selectedSession?.projectHash, getLocalMessages()));');
const stampCallAt = body.indexOf('stampQueueOwner(queued);', gateAt);
const enqAt = body.indexOf('enqueueMessage(sessionQueueKey, { text: prompt, queuedAt, hidden: !!hiddenUserMessage, opts: queueOpts })', gateAt);
ok(stampDefAt > 0 && stampDefAt < gateAt, 'O2:stampQueueOwner 在入队门之前定义');
ok(enqAt > gateAt && stampCallAt > enqAt, 'O2:入队之后调用');
ok(!/\bawait\b/.test(body.slice(enqAt, stampCallAt)), 'O2:入队与补写快照之间没有等待');
const rcStart = body.indexOf("fetch('/api/remote-control'");
const preGate = body.slice(0, gateAt);
const awaitsBeforeGate = [...preGate.matchAll(/\bawait\b/g)].map((m) => m.index);
ok(awaitsBeforeGate.every((i) => i > rcStart - 200 && i < rcStart + 400), `O2:入队门之前的等待都在 /remote-control 拦截分支里(${awaitsBeforeGate.length} 处)`);

// O3
const calls = app.split('queueOwnerSnapshot(').length - 1;
ok(calls === 3, `O3:queueOwnerSnapshot( 只有定义 + 两处调用(实际 ${calls} 处)`);

console.log(`✓ check-r196-owner-snapshot-order:${checks} 项断言全部通过`);
