#!/usr/bin/env node
// r63:回滚重发丢附件(BUGREPORT-r63-resend)。根因 = handleRollback 里 originalText 一变量两用:
// edit 分支要剥 @path 的 displayText(对的),message/both 自动重发错用同一变量且不传 { meta }
// → CLI 收不到 @path / 气泡无卡片 / sidecar 不写,纯附件消息更是整条消失。
// 修法 = 拆 composerText(edit 用) 与 resendPayloadForMessage(msg) → { prompt: msg.text, meta }。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAttachmentMessage } from '../../client/src/utils/attachments.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');

// ── 1) 源码锚定:handleRollback 自动重发段(message/both 汇流点) ──────────────
{
  const start = app.indexOf("// mode === 'message' | 'both'");
  assert.ok(start > -1, 'r63: 找不到 handleRollback 的自动重发段落注释锚点');
  const resendSection = app.slice(start, start + 3000);

  assert.ok(
    resendSection.includes('resendPayloadForMessage(msg)'),
    'r63: 自动重发必须经 resendPayloadForMessage(msg) 取完整 outbound + meta,不得复用剥掉 @path 的编辑回填文本',
  );
  assert.ok(
    /if \(resendPrompt && handleSendRef\.current\)/.test(resendSection),
    'r63: 重发守卫必须判 resendPrompt(= msg.text,含 @path)。旧守卫判剥附件后的文本,纯附件消息 displayText 为空 → 整条被裁掉后什么都不发',
  );
  assert.ok(
    resendSection.includes('resendReplacing(resendText || resendPrompt, resendMeta ? { meta: resendMeta } : {})'),
    'r63: 自动重发必须补传 { meta: resendMeta },否则新气泡无附件卡片、sidecar 不落盘',
  );
  assert.ok(
    resendSection.includes('resendReplacing(resendText.prompt || resendPrompt, resendText.options || {})'),
    'r63: 带 resendText 对象的分支(编辑重发落地)保持透传 resendText.options,不得被本修复改形',
  );
  // 三个入口(仅回退消息/回退消息和文件/重做整轮)汇流到同一段,不允许在旧变量上重发。
  assert.ok(
    !/resendReplacing\((?:resendText \|\| )?originalText\)/.test(resendSection)
      && !/if \(originalText && handleSendRef\.current\)/.test(resendSection),
    'r63: 自动重发段不得再引用 originalText(一变量两用正是回归 90a93f5 的根因)',
  );
}

// ── 2) 源码锚定:edit 分支行为不变(回填输入框仍用剥 @path 的纯文本 + 附件卡片) ──
{
  const editStart = app.indexOf("if (mode === 'edit' && (");
  assert.ok(editStart > -1, 'r63: 找不到 edit 分支');
  const head = app.slice(Math.max(0, editStart - 800), editStart + 900);
  const ternary = head.match(/const (\w+) = \(hasAttach && msg\.displayText !== undefined\) \? msg\.displayText : \(msg\.text \|\| ''\);/);
  assert.ok(ternary, 'r63: edit 回填文本必须保持 displayText 优先的剥 @path 语义(R5 对照组)');
  assert.ok(
    head.includes(`detail: { text: ${ternary[1]}, targetKey, editMode: true, attachments: hasAttach ? msg.attachments : undefined }`),
    'r63: composer-fill 必须回填剥 @path 文本 + 原附件卡片(edit 分支不许被本修复破坏)',
  );
}

// ── 3) 行为:resendPayloadForMessage 纯函数(修前 export 不存在 = 红) ─────────
const attachmentsMod = await import('../../client/src/utils/attachments.js');
const { resendPayloadForMessage } = attachmentsMod;
assert.equal(typeof resendPayloadForMessage, 'function', 'r63: attachments.js 必须导出 resendPayloadForMessage 纯函数');

{
  // 与 handleSend 落消息对象同形:text=完整 outbound, attachments/displayText 来自 meta。
  const png = { kind: 'image', path: '/tmp/cgui-attachments/a.png', name: 'a.png', bytes: 10, preview: 'data:image/png;base64,xx', status: 'uploaded' };
  const pdf = { kind: 'file', path: '/tmp/cgui-attachments/b.pdf', name: 'b.pdf', bytes: 20, preview: null, status: 'uploaded' };
  const built = buildAttachmentMessage('看这两个附件', [png, pdf]);
  const msg = { uuid: 'u1', type: 'user', text: built.prompt, attachments: built.meta.attachments, displayText: built.meta.displayText };

  const payload = resendPayloadForMessage(msg);
  assert.equal(payload.prompt, built.prompt, 'r63: 重发 prompt 必须是完整 outbound(含 附件:@path 段)');
  assert.ok(/附件:\n@\/tmp\/cgui-attachments\/a\.png\n@\/tmp\/cgui-attachments\/b\.pdf/.test(payload.prompt), 'r63: prompt 内必须保留全部 @path');
  assert.deepEqual(payload.meta.attachments, built.meta.attachments, 'r63: meta.attachments 必须原样保留(气泡卡片/sidecar 依赖)');
  assert.equal(payload.meta.displayText, '看这两个附件', 'r63: meta.displayText 保留纯文本(气泡正文)');
  // sidecar 回归护栏:textHash 以完整 outbound 计,prompt 与原文一字不差 ⇒ 与旧 sidecar 条目
  // 同 hash,即使 meta 在途丢失,刷新也能 rehydrate(修在根上的额外收益)。
  assert.equal(payload.prompt, msg.text, 'r63: prompt === msg.text(sidecar textHash 一致性)');
}

{
  // R3:纯附件消息(displayText='')不得因守卫判剥附件文本而整条消失。
  const built = buildAttachmentMessage('', [{ kind: 'image', path: '/tmp/cgui-attachments/only.png', name: 'only.png', bytes: 1, status: 'uploaded' }]);
  const msg = { text: built.prompt, attachments: built.meta.attachments, displayText: built.meta.displayText };
  assert.equal(msg.displayText, '', '夹具:纯附件消息 displayText 为空串');
  const payload = resendPayloadForMessage(msg);
  assert.ok(payload.prompt, 'r63: 纯附件消息的重发 prompt 必须非空(否则守卫不放行 = 消息凭空消失)');
  assert.equal(payload.prompt, built.prompt);
  assert.equal(payload.meta.attachments.length, 1);
}

{
  // 无附件消息:meta 不造假;异常输入不炸。
  assert.deepEqual(resendPayloadForMessage({ text: 'hello' }), { prompt: 'hello', meta: undefined });
  assert.deepEqual(resendPayloadForMessage({ text: 'x', attachments: [] }), { prompt: 'x', meta: undefined });
  assert.deepEqual(resendPayloadForMessage(null), { prompt: '', meta: undefined });
  // 历史消息 displayText 缺失(极端):meta 仍给出,displayText 回退空串。
  const p = resendPayloadForMessage({ text: 't\n\n附件:\n@/tmp/cgui-attachments/x.png', attachments: [{ path: '/tmp/cgui-attachments/x.png' }] });
  assert.equal(p.meta.displayText, '');
}

// ── 4) 根因C:附件本体已被 7 天 TTL 清理 → 重发时如实提示(不恢复、不阻塞) ─────
{
  const upload = readFileSync(join(root, 'server/routes/upload.js'), 'utf8');
  const idx = upload.indexOf("'/upload/check'");
  assert.ok(idx > -1, 'r63-C: upload.js 必须提供 /upload/check 轻量存在性端点');
  const handler = upload.slice(idx, idx + 900);
  assert.ok(handler.includes('UPLOAD_DIR'), 'r63-C: 存在性检查必须限定在 UPLOAD_DIR(cgui-attachments)内,不当任意路径探针');
  assert.ok(handler.includes('missing'), 'r63-C: 端点须返回 missing 列表');

  const start = app.indexOf("// mode === 'message' | 'both'");
  const resendSection = app.slice(start, start + 3000);
  assert.ok(resendSection.includes('/api/upload/check'), 'r63-C: 自动重发前须 fire-and-forget 检查附件本体是否还在');
  assert.ok(/setProviderSwitchNotice\(\{ text: [^\n]*已被临时目录清理/.test(resendSection), 'r63-C: 文件已清理时须如实提示,不许静默');
  assert.ok(!/await fetch\('\/api\/upload\/check'/.test(resendSection), 'r63-C: 检查必须 fire-and-forget,不得 await 阻塞重发时序');
}

console.log('✓ check-r63-resend-attachments: 重发带完整 @path+meta / 纯附件不消失 / edit 分支不变 / TTL 清理如实提示 全过');
