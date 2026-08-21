// r26-E6:「系统拒绝访问」判定抽取 —— 错误码为主、本地化文本为辅。
//
// 修前:ACCESS_DENIED_RE 只有英/简中词表,日文 Windows「アクセスが拒否されました」、
// 繁中「存取被拒」匹配不上 → 落「未知错误」兜底,用户拿不到可照着做的指引。
// 文本词表是开放集合永远列不全,所以主判据改为 fs 错误的结构化 code(与语言无关),
// 文本匹配降为没有 code 可给的场景(git stderr)的辅判据。
import assert from 'node:assert/strict';
import { ACCESS_DENIED_RE, isAccessDenied } from '../../server/utils/access-hint.js';

let n = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); n += 1; };
const ok = (v, m) => { assert.ok(v, m); n += 1; };

// ── 主判据:结构化错误码,与文本/语言无关 ─────────────────────────────
eq(isAccessDenied({ code: 'EPERM' }), true, 'EPERM 无文本也命中(主判据哨兵)');
eq(isAccessDenied({ code: 'EACCES' }), true, 'EACCES 命中');
eq(isAccessDenied({ code: 'EROFS' }), true, 'EROFS 计入(只读挂载 = 同类可行动错误)');
eq(isAccessDenied({ code: 'EPERM', message: '磁盘已满' }), true, 'code 优先,不看文本说什么');

// ── 主判据不误纳:别的错误码不该被当成「系统拒绝」 ─────────────────────
eq(isAccessDenied({ code: 'ENOSPC', message: 'No space left on device' }), false, 'ENOSPC 不算拒访(磁盘满方向不同)');
eq(isAccessDenied({ code: 'ENOENT', message: 'no such file or directory' }), false, 'ENOENT 不算拒访');
eq(isAccessDenied({ code: 128, stderr: 'fatal: not a git repository' }), false, 'git 退出码(数字)不被误判为 fs code');

// ── 辅判据:本地化文本(开放集合),补日/繁形态 ──────────────────────────
eq(isAccessDenied({ stderr: 'fatal: アクセスが拒否されました' }), true, '日文 Windows 拒访文本命中(修前漏判)');
eq(isAccessDenied({ message: 'アクセス許可がありません' }), true, '日文「没有访问权限」形态命中');
eq(isAccessDenied({ stderr: 'fatal: 存取被拒。' }), true, '繁中「存取被拒」命中(修前漏判)');
eq(isAccessDenied({ stderr: '存取權限不足' }), true, '繁中「存取權限不足」命中');
eq(isAccessDenied({ stderr: '權限不足' }), true, '繁中「權限不足」命中');
// 既有词表回归
for (const m of ['Operation not permitted', 'Permission denied', 'Access is denied', '拒绝访问。', '不允许的操作', '权限不够']) {
  eq(isAccessDenied({ stderr: m }), true, `既有词表不回退: ${m}`);
}

// ── 误命中闸:与拒访无关的错误一律 false ─────────────────────────────
eq(isAccessDenied({ stderr: 'fatal: detected dubious ownership in repository' }), false,
  'dubious ownership 不是拒访(E1 的误诊源,辅判据不许把它捞回来)');
eq(isAccessDenied({ message: 'No space left on device' }), false, '磁盘满 → false');
eq(isAccessDenied({ message: 'disk full' }), false, 'disk full → false');
eq(isAccessDenied(null), false, 'null 输入不抛且 false');
eq(isAccessDenied({}), false, '空对象 false');
eq(isAccessDenied(new Error('boom')), false, '普通 Error false');

// ── stderr 优先于 message(execFile 错误的真正原因在 stderr 里) ────────
eq(isAccessDenied({ message: 'Command failed: git ...', stderr: 'Permission denied' }), true,
  'message 无意义、stderr 有原因时命中');

// ACCESS_DENIED_RE 导出保留(既有测试锚 check-git-init-error 在用)
ok(ACCESS_DENIED_RE instanceof RegExp, 'ACCESS_DENIED_RE 导出不撤');

console.log(`✓ check-r26-access-denied(E6):${n} 条断言全过`);
