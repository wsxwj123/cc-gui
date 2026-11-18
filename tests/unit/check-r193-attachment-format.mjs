// r193 第 1 步:附件段格式的共用定义 —— 页面拼接产物与后端解析逐个对上。
// 运行:node tests/unit/check-r193-attachment-format.mjs
import assert from 'node:assert/strict';
import { buildAttachmentMessage } from '../../client/src/utils/attachments.js';
import {
  ATTACHMENT_LABEL,
  ATTACHMENT_DEFAULT_TEXT,
  formatAttachmentPrompt,
  parseAttachmentPrompt,
} from '../../server/utils/attachment-prompt-format.js';

let count = 0;
const check = (name, fn) => { fn(); count += 1; console.log(`ok ${count} ${name}`); };
const att = (path, kind = 'image') => ({ kind, path, name: path.split(/[/\\]/).pop(), bytes: 1, status: 'uploaded' });

check('标签与默认句', () => {
  assert.equal(ATTACHMENT_LABEL, '附件:');
  assert.equal(ATTACHMENT_DEFAULT_TEXT, '请查看这些附件');
});

check('产物逐字与改动前相同(有文字 / 无文字 / 无附件)', () => {
  assert.equal(buildAttachmentMessage('  说明 ', [att('/tmp/a.png')]).prompt, '说明\n\n附件:\n@/tmp/a.png');
  assert.equal(buildAttachmentMessage('', [att('/tmp/a.png'), att('/tmp/b.txt', 'text')]).prompt,
    '请查看这些附件\n\n附件:\n@/tmp/a.png\n@/tmp/b.txt');
  assert.equal(buildAttachmentMessage('纯文字', []).prompt, '纯文字');
  assert.equal(formatAttachmentPrompt('x', []), 'x');
});

check('有文字 + 1 张:解析出路径与文字', () => {
  const built = buildAttachmentMessage('看这张图', [att('/var/folders/x/T/cgui-attachments/abc.png')]);
  assert.deepEqual(parseAttachmentPrompt(built.prompt), {
    text: '看这张图', paths: ['/var/folders/x/T/cgui-attachments/abc.png'],
  });
});

check('没有文字:文字部分是默认句', () => {
  const built = buildAttachmentMessage('', [att('/tmp/cgui-attachments/only.png')]);
  assert.deepEqual(parseAttachmentPrompt(built.prompt), { text: '请查看这些附件', paths: ['/tmp/cgui-attachments/only.png'] });
});

check('带空格的 Windows 式路径 + 多个附件,顺序逐个对上', () => {
  const paths = [
    'C:\\Users\\Ann Lee\\AppData\\Local\\Temp\\cgui-attachments\\a b.png',
    'C:\\Users\\Ann Lee\\AppData\\Local\\Temp\\cgui-attachments\\notes v2.txt',
    '/tmp/cgui-attachments/c.webp',
  ];
  const built = buildAttachmentMessage('第一行\n\n第二段', paths.map((p) => att(p)));
  const parsed = parseAttachmentPrompt(built.prompt);
  assert.deepEqual(parsed.paths, paths);
  assert.equal(parsed.text, '第一行\n\n第二段');
});

check('文字里本身带一段「附件:」样式时取末尾那段', () => {
  const built = buildAttachmentMessage('前文\n\n附件:\n@/fake/x.png\n后文', [att('/real/y.png')]);
  assert.deepEqual(parseAttachmentPrompt(built.prompt).paths, ['/real/y.png']);
});

check('不是附件段 → null', () => {
  const cases = [
    '没有附件',
    '',
    '附件:\n@/tmp/a.png', // 前面没有空行
    '说明\n附件:\n@/tmp/a.png', // 只有换行没有空行
    '说明\n\n附件:\n@/tmp/a.png\n后面还有字', // 标签在中间
    '说明\n\n附件:\n@/tmp/a.png\n普通一行\n@/tmp/b.png', // 段内夹了不以 @ 开头的行
    '说明\n\n附件:\n@/tmp/a.png\n', // 末尾多一个换行
    '说明\n\n附件:\n', // 段内没有行
    '说明\n\n附件:\n@', // 只有 @
    '说明\n\n附件：\n@/tmp/a.png', // 全角冒号不是这个标签
  ];
  for (const text of cases) assert.equal(parseAttachmentPrompt(text), null, JSON.stringify(text));
  assert.equal(parseAttachmentPrompt(null), null);
  assert.equal(parseAttachmentPrompt(['x']), null);
});

console.log(`check-r193-attachment-format: ${count} passed`);
