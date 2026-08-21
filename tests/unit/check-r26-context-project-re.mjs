#!/usr/bin/env node
// 单测:r26-G9 CONTEXT_PROJECT_RE 排纯点段。
// 根因:原正则 /^[A-Za-z0-9._-]{1,4096}$/ 字符集含 '.',把 '.'/'..'/'...' 放行进
// readHistoricalContextMeta 的目录扫描与 validateContextRequest 的 projectHash 校验,
// 防线只剩隐式约定。修法:^ 后加前置否定 (?!\.+$)。
// 变异哨兵(实际验证过红):S1 删掉 (?!\.+$) → t1 三条全红。
import assert from 'node:assert/strict';
import { validateContextRequest } from '../../server/routes/chat.js';

const req = (projectHash) => ({
  params: { sessionId: 'session-fixture' },
  query: { projectHash, cwd: '/tmp/context-fixture', model: 'synthetic-model' },
});

// t1 纯点段必须拒(遍历注入面:'.'/'..' 是路径穿越的基础段)
for (const bad of ['.', '..', '...', '....']) {
  assert.equal(validateContextRequest(req(bad)), null, `t1: '${bad}' 必须被拒`);
}

// t2 误伤哨兵:含点但非纯点段的合法目录名放行
for (const good of ['.foo', 'foo.bar', '-Users-alice-Desktop-proj', '.claude', 'a..b']) {
  const out = validateContextRequest(req(good));
  assert.ok(out, `t2: '${good}' 不应被误伤`);
  assert.equal(out.projectHash, good, `t2: '${good}' 原样透传`);
}

// t3 空串照旧放行(可选参数缺省语义不变)
{
  const out = validateContextRequest(req(''));
  assert.ok(out && out.projectHash === '', 't3: 空 projectHash 缺省放行');
}

console.log('PASS r26-g9-context-project-re');
