// 跨平台审查(0.2.379)建议-1:长会话打开时每条 assistant 记录都整读一遍 usage-issues.json。
// Run: node tests/unit/check-usage-issue-log-cache.mjs
//
// 覆盖:
//  - 文件没动:同进程重复查询只 readFileSync 一次(1500 次查询 = 1 次读);
//  - 外部改动(另一进程写文件):下次查询能发现新内容;
//  - 文件不存在:不炸、行为与改造前一致(缓存里的旧条目一并作废,不拿旧数据充数)。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE = `/tmp/cgui-usage-issues-cache-${process.pid}/usage-issues.json`;
process.env.CGUI_USAGE_ISSUES_PATH = FILE;

const { recordUsageIssue, attachUsageIssues, __resetUsageIssueCache, __readStats, USAGE_ISSUE_FILE } =
  await import('../../server/services/usage-issue-log.js');
assert.equal(USAGE_ISSUE_FILE, FILE, '测试接缝指向临时文件,不碰真实数据目录');
rmSync(dirname(FILE), { recursive: true, force: true });

// ── 1. 写一条 → 反复查询只读一次文件 ─────────────────────────────────────
recordUsageIssue({
  messageId: 'msg_1', model: 'cache-stub', codes: ['USAGE_INVALID'],
  sent: { input_tokens: 0, output_tokens: 4 },
});
assert.ok(existsSync(FILE), '记录落盘(行为不变)');
const afterWrite = readFileSync(FILE, 'utf8');

__resetUsageIssueCache();
assert.deepEqual(__readStats(), { stats: 0, reads: 0 }, '缓存复位后计数归零');

// 2000+ 条记录的长会话:每条 assistant 记录一个各不相同的 message.id
for (let i = 0; i < 1500; i += 1) {
  attachUsageIssues(
    { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { messageId: `msg_long_${i}`, model: 'cache-stub' },
  );
}
assert.equal(__readStats().reads, 1, '1500 次查询只 readFileSync 一次(改造前是 1500 次)');
assert.ok(__readStats().stats >= 1500, '每次查询仍会 stat 一次(判据本身也是 I/O,但只是元数据)');

// 命中仍要正常:同一份缓存里能查到记录过的 id
const hit = attachUsageIssues({ input_tokens: 0, output_tokens: 4 }, { messageId: 'msg_1' });
assert.deepEqual(hit.ccgui_usage?.codes, ['USAGE_INVALID'], '懒加载路径下命中结果不变');
assert.equal(__readStats().reads, 1, '命中查询不额外读文件');

// ── 2. 外部改动(别的进程写文件)必须被发现 ──────────────────────────────
const external = JSON.stringify({
  version: 1,
  entries: [{ messageId: 'msg_external', model: 'cache-stub', codes: ['USAGE_INCONSISTENT'], raw: { prompt_tokens: 1 }, at: Date.now() }],
});
assert.notEqual(external.length, Buffer.byteLength(afterWrite), '夹具:外部内容长度必须变(签名判据含 size)');
writeFileSync(FILE, external);

const found = attachUsageIssues(
  { input_tokens: 0, output_tokens: 4 },
  { messageId: 'msg_external', model: 'cache-stub' },
);
assert.deepEqual(found.ccgui_usage?.codes, ['USAGE_INCONSISTENT'], '另一进程写的内容下次查询就能看到');
assert.equal(__readStats().reads, 2, '发现改动只导致这一次额外读');

const gone = attachUsageIssues({ input_tokens: 0, output_tokens: 4 }, { messageId: 'msg_1' });
assert.equal(gone.ccgui_usage, undefined, '外部改动覆盖后,旧条目不再命中(不拿陈旧缓存充数)');

// ── 3. 文件不存在:不炸,且不继续用旧内容 ────────────────────────────────
__resetUsageIssueCache();
unlinkSync(FILE);
const missing = attachUsageIssues({ input_tokens: 3, output_tokens: 1 }, { messageId: 'msg_external', model: 'cache-stub' });
assert.equal(missing.ccgui_usage, undefined, '文件没了 → 不认旧条目(与改造前一致)');
assert.deepEqual(missing, { input_tokens: 3, output_tokens: 1 }, '原样返回 usage,不改数字');
for (let i = 0; i < 100; i += 1) {
  attachUsageIssues({ input_tokens: 3, output_tokens: 1 }, { messageId: `msg_missing_${i}` });
}
assert.equal(__readStats().reads, 1, '文件缺失期间只在首次尝试读文件,之后吃空缓存(不反复抛异常)');
assert.equal(attachUsageIssues(null, { messageId: 'x' }), null, 'usage 为空时原样返回');

// 记录接口在目录都不存在时自己建目录(行为不变)
recordUsageIssue({ messageId: 'msg_after_delete', codes: ['USAGE_INVALID'] });
assert.ok(existsSync(FILE), '文件被删后仍能重新落盘');
attachUsageIssues({ input_tokens: 0, output_tokens: 0 }, { messageId: 'msg_after_delete' });
assert.ok(existsSync(FILE));

rmSync(dirname(FILE), { recursive: true, force: true });
console.log('check-usage-issue-log-cache: OK');
