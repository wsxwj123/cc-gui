// r193:发送 / 并入应答里的 imageAttach → 页面提示句(client/src/utils/imageAttachNotice.js)。
// 纯函数真 import 跑;另查 App.jsx 两处接入(发送应答、并入应答)与提示所用的机制。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { imageAttachNoticeText, IMAGE_ATTACH_REASON_TEXT } from '../../client/src/utils/imageAttachNotice.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const tpl = (n, reasons) => `有 ${n} 张图没能带上:${reasons.join('、')}。消息已照常发出。`;
const one = (reason, name = 'a.png') => ({ inlined: 0, skipped: [{ name, reason }] });

const WORDS = {
  missing: '文件已不在(上传的图 7 天后会被清理),请重新添加',
  unreadable: '文件无法读取',
  'too-large': '太大(单张或一条消息合计超过 20MB)',
  'too-many': '一条消息最多带 20 张',
  unsupported: '格式不支持(可用 png、jpg、gif、webp)',
  damaged: '文件已损坏',
};

check('每种原因的用词与接口文件错误契约表逐字相同', () => {
  assert.deepEqual(IMAGE_ATTACH_REASON_TEXT, WORDS);
  for (const [reason, word] of Object.entries(WORDS)) {
    assert.equal(imageAttachNoticeText(one(reason)), tpl(1, [word]), reason);
  }
});

check('outside 不提示、不计入 N', () => {
  assert.equal(imageAttachNoticeText(one('outside')), null);
  assert.equal(imageAttachNoticeText({ inlined: 1, skipped: [{ name: 'x.png', reason: 'outside' }, { name: 'y.png', reason: 'outside' }] }), null);
  assert.equal(
    imageAttachNoticeText({ inlined: 0, skipped: [{ name: 'x.png', reason: 'outside' }, { name: 'y.png', reason: 'damaged' }] }),
    tpl(1, [WORDS.damaged]),
  );
});

check('多种原因按首次出现的顺序用顿号连接,同一种只写一次;N 按项数计', () => {
  const ia = {
    inlined: 2,
    skipped: [
      { name: 'a.heic', reason: 'unsupported' },
      { name: 'b.png', reason: 'missing' },
      { name: 'c.heic', reason: 'unsupported' },
      { name: 'd.png', reason: 'outside' },
      { name: 'e.png', reason: 'too-large' },
    ],
  };
  assert.equal(imageAttachNoticeText(ia), tpl(4, [WORDS.unsupported, WORDS.missing, WORDS['too-large']]));
});

check('同一种原因多张:N 计张数,原因只写一次', () => {
  const skipped = Array.from({ length: 3 }, (_, i) => ({ name: `p${i}.png`, reason: 'too-many' }));
  assert.equal(imageAttachNoticeText({ inlined: 20, skipped }), tpl(3, [WORDS['too-many']]));
});

check('没有 imageAttach、skipped 为空或不是数组、认不出的原因:不提示', () => {
  for (const v of [undefined, null, {}, { inlined: 1 }, { inlined: 1, skipped: [] }, { skipped: 'missing' }, { skipped: [null, {}, { reason: 'weird' }] }, 'x', 3]) {
    assert.equal(imageAttachNoticeText(v), null, JSON.stringify(v));
  }
});

check('App.jsx:发送应答与并入应答两处都接入,用带会话键的提示,不弹系统窗', () => {
  const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  assert.ok(app.includes("import { imageAttachNoticeText } from './utils/imageAttachNotice.js';"));
  assert.ok(app.includes('showImageAttachNotice(sessionQueueKey, respJson.imageAttach);'), '发送应答处');
  assert.ok(app.includes('showImageAttachNotice(sessionId, response.imageAttach);'), '并入应答处');
  const start = app.indexOf('const showImageAttachNotice = useCallback(');
  assert.ok(start > 0);
  const body = app.slice(start, app.indexOf('}, [paneStillOn]);', start));
  assert.ok(body.includes('imageAttachNoticeText(imageAttach)'));
  assert.ok(body.includes('ownerKey'), '提示带所属会话键');
  assert.ok(body.includes('leaveSessionNotice(ownerKey'), '已切走时给那个会话留言');
  assert.ok(!/alert\(|confirmDialog|toast/i.test(body), '不用系统弹窗');
});

// ── F1:新会话拿到正式编号时,提示与留言按所属会话改挂 ──
const { migrateNoticeOwner, migrateSessionNotice, leaveSessionNotice, takeSessionNotice } = await import('../../client/src/utils/sessionNotice.js');

check('F1 migrateNoticeOwner:只按 ownerKey 改挂,其余字段原样;无所属 / 属于别的会话原样返回同一引用', () => {
  const n = { text: 'x', ownerKey: 'draft-h-1', ttlMs: 15000 };
  assert.deepEqual(migrateNoticeOwner(n, 'draft-h-1', 'sid-1'), { text: 'x', ownerKey: 'sid-1', ttlMs: 15000 });
  assert.equal(n.ownerKey, 'draft-h-1', '不改原对象');
  const other = { text: 'y', ownerKey: 'sid-9' };
  assert.equal(migrateNoticeOwner(other, 'draft-h-1', 'sid-1'), other);
  const none = { text: 'z' };
  assert.equal(migrateNoticeOwner(none, 'draft-h-1', 'sid-1'), none);
  assert.equal(migrateNoticeOwner(null, 'draft-h-1', 'sid-1'), null);
  const sticky = { text: 'w', ownerKey: 'draft-h-1', sticky: true };
  assert.deepEqual(migrateNoticeOwner(sticky, 'draft-h-1', 'sid-1'), { text: 'w', ownerKey: 'sid-1', sticky: true });
});

check('F1 migrateSessionNotice:留言从草稿键搬到正式键,旧键清空;正式键已有留言时接在后面、同句不重复', () => {
  leaveSessionNotice('draft-f1-a', '甲');
  migrateSessionNotice('draft-f1-a', 'sid-f1-a');
  assert.equal(takeSessionNotice('draft-f1-a'), null);
  assert.equal(takeSessionNotice('sid-f1-a'), '甲');
  leaveSessionNotice('sid-f1-b', '旧');
  leaveSessionNotice('draft-f1-b', '新');
  migrateSessionNotice('draft-f1-b', 'sid-f1-b');
  assert.equal(takeSessionNotice('sid-f1-b'), '旧 新');
  leaveSessionNotice('sid-f1-c', '同');
  leaveSessionNotice('draft-f1-c', '同');
  migrateSessionNotice('draft-f1-c', 'sid-f1-c');
  assert.equal(takeSessionNotice('sid-f1-c'), '同');
  migrateSessionNotice('draft-f1-none', 'sid-f1-d'); // 没有留言:不做事
  assert.equal(takeSessionNotice('sid-f1-d'), null);
  leaveSessionNotice('k-same', '自');
  migrateSessionNotice('k-same', 'k-same');
  assert.equal(takeSessionNotice('k-same'), '自');
});

check('F1 App.jsx:流开头草稿键改挂本地条目处同批改挂提示条;startedAsDraft 兜底处改挂留言', () => {
  const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  assert.ok(app.includes("import { leaveSessionNotice, mergeDraftText, takeSessionNotice, migrateSessionNotice, migrateNoticeOwner } from './utils/sessionNotice.js';"));
  const relabel = app.indexOf('prev.map((m) => (m.ownerKey === _dk0 ? { ...m, ownerKey: event.session_id } : m))');
  assert.ok(relabel > 0, '找不到本地条目改挂那一段');
  const near = app.slice(relabel, relabel + 600);
  assert.ok(near.includes('setProviderSwitchNotice((prev) => migrateNoticeOwner(prev, _dk0, event.session_id));'), '提示条与本地条目同批改挂');
  const q = app.indexOf('migrateDraftQueue(useStore.getState().messageQueue, _dk, event.session_id);');
  assert.ok(q > relabel, '找不到 startedAsDraft 里的队列迁移');
  const after = app.slice(q, q + 900);
  assert.ok(after.includes('const _nk = queueKeyFor(selectedSession);'), '用发起时闭包里的草稿键');
  assert.ok(after.includes('migrateSessionNotice(_nk, event.session_id);'), '留言改挂');
  assert.ok(after.includes('if (!selIsOrigin) setProviderSwitchNotice((prev) => migrateNoticeOwner(prev, _nk, event.session_id));'), '已切走时提示条也改挂');
  assert.equal(app.split('migrateSessionNotice(').length - 1, 1, 'App.jsx 只有一处调用 migrateSessionNotice');
  assert.equal(app.split('migrateNoticeOwner(prev').length - 1, 2, 'App.jsx 只有两处改挂提示条');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
