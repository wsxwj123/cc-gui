#!/usr/bin/env node
// r192:①待发消息取出到输入框时带回附件卡片(追加,不替换已挂的附件);
// ②输入框附件卡片没有预览时按路径读原图(经共用的 useAttachmentImageSrc,不把读图地址直接写进 img)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageAttachmentSrc } from '../../client/src/utils/attachments.js';
import { homeDraftFromOrphan } from '../../client/src/utils/home.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// ── A. 待发条目还原:纯文字 + 附件卡片(会话待发条目与首页孤儿条目同结构)──────────
{
  const bigImage = { kind: 'image', name: 'big.png', path: '/tmp/up/big.png', bytes: 320 * 1024, preview: null };
  const item = {
    queueId: 'q-r192-a',
    text: 'hello r192\n\n附件:\n@/tmp/up/big.png',
    opts: { meta: { displayText: 'hello r192', attachments: [bigImage] } },
  };
  const restored = homeDraftFromOrphan(item);
  assert.equal(restored.text, 'hello r192', '取出后文字不含「@路径」');
  assert.equal(restored.attachments.length, 1, '附件恢复成卡片');
  assert.equal(restored.attachments[0].path, bigImage.path);
  assert.equal(restored.attachments[0].status, 'uploaded', '恢复的卡片是已上传状态');
  assert.ok(restored.attachments[0].id, '恢复的卡片有 id(列表 key / 删除用)');

  const imageOnly = homeDraftFromOrphan({ queueId: 'q2', text: '附件:\n@/tmp/up/a.png', opts: { meta: { displayText: '', attachments: [{ kind: 'image', name: 'a.png', path: '/tmp/up/a.png' }] } } });
  assert.equal(imageOnly.text, '', '只有图片时文字为空串');
  assert.equal(imageOnly.attachments.length, 1);

  const textOnly = homeDraftFromOrphan({ queueId: 'q3', text: 'plain', opts: {} });
  assert.deepEqual(textOnly, { text: 'plain', attachments: [] }, '纯文字条目不带附件');
}

// ── B. editFromQueueAt 接线:用 homeDraftFromOrphan,有附件时带上并追加 ─────────────
{
  const app = read('client/src/App.jsx');
  const start = app.indexOf('const editFromQueueAt = useCallback(');
  assert.ok(start > 0, '找到 editFromQueueAt');
  const seg = app.slice(start, app.indexOf('}, [messageQueue, sessionQueueKey]);', start));
  assert.match(seg, /homeDraftFromOrphan\(item\)/, '取出时经 homeDraftFromOrphan 还原文字与附件');
  assert.match(seg, /detail\.attachments = restored\.attachments/, '回填事件带上附件');
  assert.match(seg, /detail\.appendAttachments = true/, '附件追加在已挂附件之后,不替换');
  assert.doesNotMatch(seg, /text: item\.text/, '不再把带「@路径」的完整提示词塞回输入框');
  assert.match(seg, /'cgui:composer-fill'/);

  // 接收方的追加语义(按路径去重)仍在
  const ci = read('client/src/components/ChatInput.jsx');
  assert.match(ci, /if \(e\?\.detail\?\.appendAttachments\) \{\s*setAttachments\(\(prev\) => \{\s*const seen = new Set\(prev\.map\(\(a\) => a\.path\)\);\s*return \[\.\.\.prev, \.\.\.fillAttach\.filter\(\(a\) => !seen\.has\(a\.path\)\)\];/,
    '输入框按路径去重追加附件');
  // 放大层复用卡片已加载的显示地址
  assert.match(ci, /onPreview=\{\(attachment, displaySrc\) => setZoomImage\(\{ src: displaySrc \|\| attachment\.preview/,
    '点开放大用卡片已加载好的地址');
}

// ── C. 输入框卡片:没有预览时取按路径读图的来源,经共用 hook 加载 ───────────────
{
  assert.equal(imageAttachmentSrc({ kind: 'image', path: '/tmp/up/big.png', preview: null }),
    `/api/files/read?path=${encodeURIComponent('/tmp/up/big.png')}&raw=1`, '没有预览 → 按路径读原图');
  assert.equal(imageAttachmentSrc({ kind: 'image', path: '/tmp/up/s.png', preview: 'data:image/png;base64,AA' }),
    'data:image/png;base64,AA', '有预览 → 用预览');

  const list = read('client/src/components/PendingAttachmentList.jsx');
  assert.match(list, /import \{ imageAttachmentSrc \} from '\.\.\/utils\/attachments\.js'/);
  assert.match(list, /import \{ useAttachmentImageSrc \} from '\.\.\/hooks\/useAttachmentImageSrc\.js'/);
  assert.match(list, /useAttachmentImageSrc\(imageSrc\)/, '图源经 useAttachmentImageSrc 加载');
  assert.match(list, /: imageAttachmentSrc\(attachment\)/, '已上传的图用 imageAttachmentSrc(预览优先,没有就按路径)');
  assert.match(list, /src=\{displaySrc\}/, 'img 用 hook 给出的显示地址');
  assert.doesNotMatch(list, /\/api\/files\/read/, '不把读图地址直接写进 img(绕过并发闸门、看不到 429)');
  assert.match(list, /const uploadedImage = isImage && !!displaySrc;/, '加载中 / 失败画文件名卡片');

  const hook = read('client/src/hooks/useAttachmentImageSrc.js');
  assert.match(hook, /export function useAttachmentImageSrc\(src\)/);
  assert.match(hook, /loadAttachmentImageBytes\(src\)/, 'hook 经 loadAttachmentImageBytes 取字节');

  const bubble = read('client/src/components/MessageBubble.jsx');
  assert.match(bubble, /import \{ useAttachmentImageSrc \} from '\.\.\/hooks\/useAttachmentImageSrc\.js'/, '气泡引用共用 hook');
  assert.doesNotMatch(bubble, /function useAttachmentImageSrc\(/, '气泡里不再留一份副本');
}

console.log('✓ check-r192-queue-edit-attachments: 待发消息取出带回附件(追加)+ 输入框卡片无预览时按路径读图全过');
