#!/usr/bin/env node
// r17-4:磁盘访问被系统拒绝时,不能显示成「暂无会话」。
//
// 用户实测(另一台 Mac 未授予完全磁盘访问):终端里能读到会话文件、GUI 里却一片
// "暂无会话",第一反应是"数据被 GUI 删了"。静默的空列表与真的没有会话长得一模一样,
// 是最坏的一种失败形态 —— 它让用户去怀疑数据完整性,而真正该做的只是去勾一个权限。
//
// 三层各自钉住:后端把 EPERM/EACCES 单独标成 403 + code;store 区分它与空列表;
// 侧栏空态显示原因而不是"暂无会话"。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── 后端:权限错误必须单独成一类,且明说文件没丢 ──────────────────────
{
  const src = read('../../server/routes/sessions.js');
  assert.match(src, /err\?\.code === 'EPERM' \|\| err\?\.code === 'EACCES'/,
    '后端必须单独识别 EPERM/EACCES,而不是笼统 500');
  assert.match(src, /code: 'no-disk-access'/, '要给前端一个可判定的 code,而不是靠文案匹配');
  assert.match(src, /会话文件本身没有丢失/,
    '提示里必须明说文件没丢 —— 用户的第一反应就是"数据被删了"');
  assert.match(src, /完全磁盘访问/, '提示要给出可执行的处理办法(去哪儿开权限)');
}

// ── store:必须与"真的没有会话"分开,且恢复后要清掉 ────────────────────
{
  const src = read('../../client/src/stores/sessionStore.js');
  assert.match(src, /res\.status === 403 && data\?\.code === 'no-disk-access'/,
    'store 要按 code 判定,不能把 403 的响应体当成会话数组');
  assert.match(src, /sessionsAccessError: null/, '要有独立的错误态字段');
  assert.match(src, /st\.sessionsAccessError \? \{ sessionsAccessError: null \} : st/,
    '权限恢复后必须清掉错误态(否则修好了还一直报错)');
  // 不许把 403 的响应体当数组渲染
  const seg = src.slice(src.indexOf('fetchSessionsForPanel:'), src.indexOf('fetchSessionsForPanel:') + 1400);
  assert.ok(seg.indexOf("code: 'no-disk-access'") === -1 || seg.indexOf('const list') > seg.indexOf('no-disk-access'),
    '403 分支必须在构造 list 之前 return');
}

// ── 侧栏:空态要说原因,不能还显示"暂无会话" ───────────────────────────
{
  const src = read('../../client/src/components/UnifiedSidebar.jsx');
  assert.match(src, /const accessError = useStore\(\(st\) => st\.sessionsAccessError\);/,
    '侧栏要读错误态');
  assert.match(src, /accessError\s*\n?\s*\? <span[^>]*>无法读取会话目录/,
    '有错误时空态显示原因,而不是"暂无会话"');
  assert.match(src, /会话文件没有丢失/, '侧栏也要当场安抚:文件没丢');
}

console.log('check-session-access-error: all passed (r17-4)');
