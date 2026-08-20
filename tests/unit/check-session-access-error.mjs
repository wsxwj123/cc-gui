#!/usr/bin/env node
// r17-4:磁盘访问被系统拒绝时,不能显示成「暂无会话」。
//
// 用户实测(另一台 Mac 未授予完全磁盘访问):终端里能读到会话文件、GUI 里却一片
// "暂无会话",第一反应是"数据被 GUI 删了"。静默的空列表与真的没有会话长得一模一样,
// 是最坏的一种失败形态 —— 它让用户去怀疑数据完整性,而真正该做的只是去勾一个权限。
//
// 三层各自钉住:后端把 EPERM/EACCES 单独标成 403 + code;store 区分它与空列表;
// 侧栏空态显示原因而不是"暂无会话"。
//
// r22:store 那一层改成【真的执行 reducer】。原来只对源码做正则,能证明"代码写了",
// 不能证明"这一支走得通" —— 403 分支只置错误态就 return,列表恒 undefined,侧栏首判
// (undefined → 转圈)把提示那一支永远挡在外面,整轮正则全绿而功能是死的。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// 注释里出现的文案不算实现(r20 把文案搬进 access-hint.js 后,旧断言只靠一句中文注释
// 满足)。与 check-git-init-error.mjs 同一写法,两条测试口径一致。
const stripComments = (t) => t.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── 后端:权限错误必须单独成一类,且明说文件没丢 ──────────────────────
{
  const src = stripComments(read('../../server/routes/sessions.js'));
  assert.match(src, /err\?\.code === 'EPERM' \|\| err\?\.code === 'EACCES'/,
    '后端必须单独识别 EPERM/EACCES,而不是笼统 500');
  assert.match(src, /code: 'no-disk-access'/, '要给前端一个可判定的 code,而不是靠文案匹配');
  assert.match(src, /会话文件本身没有丢失/,
    '提示里必须明说文件没丢 —— 用户的第一反应就是"数据被删了"');
  // r20 平台化后处理办法由 access-hint.js 按平台给,路由不许自带一份 macOS 文案。
  assert.match(src, /hint: accessDeniedHint\(\)/, '处理办法必须来自共用的 accessDeniedHint()');
  assert.ok(!/完全磁盘访问/.test(src),
    'sessions.js 不许硬编 macOS 专属文案(Windows 用户会被指去一个不存在的面板)');
}

// ── store:真跑 reducer —— 注入 403 假 fetch,断言"列表被写成空数组"而非 undefined ──
{
  const { useStore } = await import('../../client/src/stores/sessionStore.js');
  const st = () => useStore.getState();
  const HINT = '去把 cc-gui 加进完全磁盘访问。会话文件本身没有丢失。';
  const DENIED = {
    status: 403, ok: false,
    json: async () => ({ error: '无法读取会话目录（系统拒绝访问）', code: 'no-disk-access', hint: HINT }),
  };
  const okList = (list) => ({ status: 200, ok: true, json: async () => list });

  const realFetch = globalThis.fetch;
  let next = DENIED;
  globalThis.fetch = async () => next;
  try {
    // 1) 面板槽(侧栏折叠树的数据源):403 必须同时落"错误态 + 空列表占位"。
    await st().fetchSessionsForPanel('hash-denied');
    assert.equal(st().sessionsAccessError, HINT, '403 必须置错误态');
    assert.notEqual(st().sessionsByProject['hash-denied'], undefined,
      '403 后该项目的会话列表不能还是 undefined —— 侧栏首判 rawSessions===undefined 直接转圈,'
      + '提示那一支永远不可达(比回 500 兜成 [] 还糟)');
    assert.deepEqual(st().sessionsByProject['hash-denied'], [], '占位必须是空数组(空态 → 显示原因)');

    // 2) 身份稳定:watcher 每 600ms 刷一次,反复 403 不许换数组身份(否则侧栏整树重渲)。
    const first = st().sessionsByProject['hash-denied'];
    await st().fetchSessionsForPanel('hash-denied');
    assert.equal(st().sessionsByProject['hash-denied'], first, '重复 403 复用旧空数组身份,不触发重渲');

    // 3) 权限恢复后错误态必须清掉,列表照常写入。
    next = okList([{ sessionId: 's1', title: 'a' }]);
    await st().fetchSessionsForPanel('hash-denied');
    assert.equal(st().sessionsAccessError, null, '恢复后必须清错误态(否则修好了还一直报错)');
    assert.equal(st().sessionsByProject['hash-denied'].length, 1, '恢复后正常写入会话');

    // 4) 同契约的第二个消费者(旧槽 fetchSessions,权限卡门禁/@面板仍在读)口径必须一致。
    next = DENIED;
    await st().fetchSessions('hash-denied');
    assert.equal(st().sessionsAccessError, HINT, '旧槽同样要置错误态,不许静默吞成空列表');
    assert.deepEqual(st().sessions, [], '旧槽 403 时列表清空');
    assert.equal(st().listLoading, false, '旧槽 403 时不许把 loading 卡住');
    next = okList([{ sessionId: 's1' }]);
    await st().fetchSessions('hash-denied');
    assert.equal(st().sessionsAccessError, null, '旧槽恢复后也要清错误态');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 侧栏:空态要说原因,不能还显示"暂无会话" ───────────────────────────
{
  const src = read('../../client/src/components/UnifiedSidebar.jsx');
  assert.match(src, /const accessError = useStore\(\(st\) => st\.sessionsAccessError\);/,
    '侧栏要读错误态');
  // 上面那条 store 断言("403 也要写空数组")的存在理由就是这一句首判:
  // undefined = 还没拉到 → 转圈,空数组才走得到下面的空态提示。
  assert.match(src, /rawSessions === undefined \?/,
    '加载判据是 rawSessions === undefined(store 的 403 分支必须写占位才走得到空态)');
  // r23-③:文案判定挪进纯函数 sessionEmptyHint(行为断言在 check-project-panel t9),
  // 这里只钉住【两处空态都走它】—— 上一轮只有分组模式那处读 accessError,平铺模式自己
  // 硬编「暂无会话」,403 落成空数组后正好走进去,拒访又被伪装回"没有会话"。
  const { sessionEmptyHint, ACCESS_DENIED_HINT } = await import('../../client/src/utils/projectPanel.js');
  assert.equal(sessionEmptyHint({ accessError: 'EACCES', query: '登录', fallback: '暂无会话' }),
    ACCESS_DENIED_HINT, '有错误时空态显示原因,而不是"暂无会话"/"没有匹配的会话"');
  assert.match(ACCESS_DENIED_HINT, /会话文件没有丢失/, '侧栏也要当场安抚:文件没丢');
  assert.match(src, /accessError\s*\n?\s*\? <span[^>]*title=\{accessError\}>\{text\}<\/span>/,
    '拒访那一支要带 title(hover 看平台化的处理办法)');
  const uses = [...src.matchAll(/\{emptyHint\(/g)].length;
  assert.equal(uses, 2, `空态共用一处判定:平铺与分组两处都要调 emptyHint(现有 ${uses} 处)`);
  assert.ok(!/\{q \? '没有匹配的会话' : '暂无会话'\}/.test(src),
    '平铺空态不许再自己硬编三元(那条路径读不到 accessError)');
}

console.log('check-session-access-error: all passed (r17-4 + r22 真跑 reducer)');
