// r17-8:git init 失败必须给出能照着做的下一步,而不是同一句 "Command failed: git -C … init"。
// 用【真实的 execFile 错误对象】驱动,不手捏 —— 手捏的 err 挡不住"实际形态和我以为的不一样"。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { classifyGitInitError } from '../../server/routes/git.js';

const p = promisify(execFile);
let n = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); n += 1; };
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const grab = async (fn) => { try { await fn(); assert.fail('这一步本应失败'); } catch (e) { return e; } };

// —— 三种真实失败形态 ——
const timeoutErr = await grab(() => p('sleep', ['5'], { timeout: 300 }));
ok(timeoutErr.killed === true, '前提:超时错误的 killed 为 true');
eq(classifyGitInitError(timeoutErr).code, 'git-init-timeout', '超时 → git-init-timeout');

const missingErr = await grab(() => p('git-does-not-exist-r17-8', ['x'], { timeout: 2000 }));
eq(missingErr.code, 'ENOENT', '前提:命令不存在是 ENOENT');
eq(classifyGitInitError(missingErr).code, 'git-missing', 'git 没装 → git-missing');

// /System 在 SIP 保护下不可写,git 报 "Operation not permitted" —— 与 TCC 拒读同形态
const deniedErr = await grab(() => p('git', ['-C', '/System', 'init'], { timeout: 4000 }));
ok(/operation not permitted|permission denied/i.test(String(deniedErr.stderr)), '前提:拒绝访问的原因只在 stderr 里');
eq(classifyGitInitError(deniedErr).code, 'no-disk-access', '系统拒绝 → no-disk-access');

// —— 这就是本次修复要挡住的回归:三种失败的 message 本身完全无法区分 ——
const msgs = [timeoutErr, deniedErr].map((e) => String(e.message).split('\n')[0]);
ok(msgs.every((m) => /^Command failed: /.test(m)), '前提:超时与拒绝访问的 message 都是 "Command failed: …"');
const codes = new Set([timeoutErr, missingErr, deniedErr].map((e) => classifyGitInitError(e).code));
eq(codes.size, 3, '三种形态必须分出三种 code(仅凭 message 做不到)');

// —— 每一支都要给出能照着做的下一步,兜底支不许编 hint ——
for (const e of [timeoutErr, missingErr, deniedErr]) ok(classifyGitInitError(e).hint, '可诊断的失败必须带 hint');
eq(classifyGitInitError(new Error('boom')).code, 'git-init-failed', '未知错误 → 兜底');
eq(classifyGitInitError(new Error('boom')).hint, undefined, '兜底支不编造 hint');
ok(/boom/.test(classifyGitInitError(new Error('boom')).error), '兜底支保留原始信息');

// —— 路由确实用上了它(防止分类器写了却没接进去) ——
const src = readFileSync(new URL('../../server/routes/git.js', import.meta.url), 'utf-8');
ok(/catch \(err\) \{\s*\n\s*return res\.status\(400\)\.json\(classifyGitInitError\(err\)\);/.test(src), 'git init 的 catch 走分类器');
ok(/if \(!already\) \{\s*\n\s*try \{\s*\n\s*await execFileP\('git', \['-C', cwd, 'init'\]/.test(src), 'init 调用被 try 包住(此前失败会直接落到外层 catch,只回一句 err.message)');

console.log(`✓ check-git-init-error:${n} 条断言全过`);
