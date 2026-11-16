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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
