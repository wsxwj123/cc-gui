#!/usr/bin/env node
// 批A A4/A5 护栏:客户端按服务端广播的存活集剪僵尸卡 + 双键收终态 + task_started 补 sessionId。
// 回归对象:子代理跑完了卡片还在转圈(#3)、「停止后台 N」计数与服务端脱钩(#10)。
// 剪枝体是纯函数,这里真 import;接线点用源码守卫。
import assert from 'node:assert/strict';
import { pruneByLiveSet, LEVEL_PRUNE_MIN_AGE_MS } from '../../client/src/utils/levelPrune.js';

// ── 源码守卫用的小工具(不是被测逻辑)────────────────────────────────────
// 去注释:等长替换(换行保留)→ 报错行号与原文件一致。注释里写的 `// f(...)` 既不能
// 充数骗绿,也不能冤枉变红。字符串/模板串里的 `//` 不算注释。
// ponytail: 轻量状态机,不解析正则/JSX 文本 —— 极少数段落会被它误判成"串里",漏剥几行注释。
// 若将来冒出指不到真实代码的建卡点,先查这里(当前 6 个建卡点都在剥干净的区域,已逐个核对)。
function stripComments(src) {
  let out = '', i = 0, quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; } continue; }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  '; i += 2; continue;
    }
    out += c; i += 1;
  }
  return out;
}

// 抠出所有 `name(...)` 调用的实参文本(括号配平,串/模板里的括号不计)。
// 跳过 `function name(` 声明 —— 那是定义不是调用点。
function callArgsOf(src, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  for (let m; (m = re.exec(src));) {
    if (/function\s*$/.test(src.slice(Math.max(0, m.index - 16), m.index))) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0, j = open, quote = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) { if (c === '\\') j++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, args: src.slice(open + 1, j) });
    re.lastIndex = j + 1;
  }
  return out;
}

const SID = 'sess-A';
const ts = 1_000_000_000;
const started = ts - LEVEL_PRUNE_MIN_AGE_MS - 1; // 够老
const A = (patch) => ({ sessionId: SID, taskManaged: true, status: 'working', startedAt: started, ...patch });
const payload = (patch) => ({ sessionId: SID, taskIds: [], toolUseIds: [], settled: [], ts, ...patch });

// ① 不在活集且够老 → 收
{
  const ids = pruneByLiveSet({ toolu_1: A({}) }, payload());
  assert.deepEqual(ids, ['toolu_1'], '本会话 taskManaged 条目不在活集 → 剪');
}
// ② 在活集 → 不收(两把钥匙各测一次)
{
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({}) }, payload({ toolUseIds: ['toolu_1'] })), [],
    'toolUseIds 命中 → 不剪');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ taskId: 'tk1' }) }, payload({ taskIds: ['tk1'] })), [],
    'taskIds 命中(条目上钉的 taskId)→ 不剪');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ taskId: 'tk9' }) }, payload({ taskIds: ['tk1'] })), ['toolu_1'],
    'taskId 不在集里照剪');
}
// ③ 刚起的不剪(与服务端 grace 对称,防乱序误收)
{
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ startedAt: ts - LEVEL_PRUNE_MIN_AGE_MS }) }, payload()), [],
    '年龄 = 门槛 → 不剪(判据是严格小于)');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ startedAt: ts }) }, payload()), [], '刚起 → 不剪');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ startedAt: null }) }, payload()), [],
    'startedAt 缺失 → 判不出年龄,不剪');
}
// ④ 不受 level 管辖的条目一律不剪
{
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ taskManaged: false }) }, payload()), [],
    '非 taskManaged(没发过 task_started)不在 CLI 的 tasks 表里,剪它必然误收');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ hydrated: true }) }, payload()), [],
    'hydrated(翻历史现补的条目)不剪');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ workflow: true }) }, payload()), [],
    'workflow 内层不进 CLI 的 tasks 集,不剪');
}
// ⑤ 已终态 → 不收(幂等,不刷新 finishedAt)
{
  for (const status of ['done', 'error', 'stopped']) {
    assert.deepEqual(pruneByLiveSet({ toolu_1: A({ status }) }, payload()), [], `已是 ${status} 不重复收`);
  }
}
// ⑥ 别的会话 / 无归属 → 不收(分屏隔离)
{
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ sessionId: 'sess-B' }) }, payload()), [],
    '别的会话的条目绝不碰');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ sessionId: null }) }, payload()), [],
    'sessionId 为空的条目保守不动');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({}) }, payload({ sessionId: null })), [],
    '广播没带 sessionId → 一条都不剪(宁可漏收不可误收)');
}
// 健壮性
{
  assert.deepEqual(pruneByLiveSet(null, payload()), [], '无 agents 不炸');
  assert.deepEqual(pruneByLiveSet({ x: null }, payload()), [], 'null 条目不炸');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({}) }, null), [], '无载荷不剪');
  // 多条混合:只挑该剪的
  const agents = {
    a: A({}), b: A({ taskId: 'tk-b' }), c: A({ status: 'done' }), d: A({ sessionId: 'other' }),
    e: A({ workflow: true }), f: A({}),
  };
  assert.deepEqual(pruneByLiveSet(agents, payload({ toolUseIds: ['f'] })), ['a', 'b'], '混合场景只剪该剪的');
}

// ── 行为侧:建出来的条目必须能被 task_id 反查命中 ─────────────────────────
// 下面那条源码锁守的是"每个建卡点都把 task_id 传下去了";这里守"传下去之后它真的能当钥匙用"。
// 反查体是 App.jsx 的 findAgentIdByTaskId(线性扫 activeAgents 找 a.taskId === task_id —— 见
// 其源码守卫)。task_updated 事件只带 task_id、不带 tool_use_id,反查落空 = 那张卡片跨回合 /
// 重连后永远收不了尾。所以"建卡点漏传 task_id"不是少个字段,是功能坏掉。
{
  const { rebuildWorkflowEntry } = await import('../../client/src/utils/workflowEntry.js');
  const byTaskId = (agents, taskId) => Object.entries(agents).find(([, a]) => a?.taskId === taskId)?.[0] ?? null;
  const ev = { tool_use_id: 'toolu_wf', task_id: 'T1' };

  const fresh = rebuildWorkflowEntry({ toolUseId: ev.tool_use_id, taskId: ev.task_id, sessionId: SID });
  assert.equal(byTaskId({ [ev.tool_use_id]: fresh }, ev.task_id), ev.tool_use_id,
    '带 task_id 补出来的条目:task_id 反查必须命中(否则只有 tool_use_id 的更新能碰到它)');
  const lost = rebuildWorkflowEntry({ toolUseId: ev.tool_use_id, taskId: null, sessionId: SID });
  assert.equal(byTaskId({ [ev.tool_use_id]: lost }, ev.task_id), null,
    '反面:建卡点没把 task_id 递进去 → 反查落空 —— 这正是下面源码锁要挡的那种回归');
}

// ── 源码守卫:接线点 ────────────────────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const app = readFileSync(join(root, 'client', 'src', 'App.jsx'), 'utf8');
  const ws = readFileSync(join(root, 'client', 'src', 'hooks', 'useWebSocket.js'), 'utf8');

  // A5:task_started 存在性分支必须同时补 taskManaged / taskId / sessionId,且 sessionId 保留既有值
  assert.ok(/_s0\.upsertAgent\(event\.tool_use_id, \{\s*taskManaged: true,\s*taskId: event\.task_id,\s*sessionId: _s0\.activeAgents\[event\.tool_use_id\]\.sessionId \|\| streamOwnerSid\(\),/.test(app),
    'task_started 存在性分支必须补 taskManaged + taskId + sessionId(已有 sessionId 不覆盖)');
  // ── 建卡点必须【逐个】钉 taskId ──────────────────────────────────────
  // 旧写法数的是 `taskId: event.task_id,` 的字面量出现次数(==3)。上一轮新增"刷新后缺条目
  // 补建"那条建卡路(rebuildWorkflowEntry)时,新点写成 `taskId: event.task_id || null` ——
  // 语义等价,计数照旧是 3、这条锁照旧绿,但那个点根本没被罩住:改成 event.id、把整行删掉,
  // 同样测不出来。字面量计数锁的是"某段拼写出现过几次",不是"每个建卡点都钉了 taskId"。
  // 现在改成:先枚举 App.jsx 里的建卡点,再逐点断言(不数次数)。
  //   A. task_started 处理区块里,凡写 taskManaged / status:'working' 的 upsertAgent 调用
  //      —— 三处:存在性补钉、local_agent 建条目、local_workflow 建条目;
  //   B. 全文件所有 rebuildWorkflowEntry(...) 调用 —— 刷新后缺条目按最小形态补一条
  //      (SSE 直连与 WS 兜底两条路共用这个判据);
  //   C. 全文件所有 applyWorkflowProgress(...) 调用 —— WS 那条路把广播里的 task_id 递进
  //      补建点的唯一通道(形参带 `= null` 默认值,漏传是静默的,更要钉)。
  // 逐点断言两件事:① 键在(丢了 → 红);② 值取自 task_id(改成别的字段 / 写死 → 红)。
  // 值为什么也要钉:task_updated 只带 task_id、不带 tool_use_id,findAgentIdByTaskId 只能靠
  // 条目上的 taskId 反查;哪个建卡点少钉一个,它建出来的卡片跨回合 / 重连后就永远收不了尾。
  {
    const code = stripComments(app);
    assert.equal(code.split('\n').length, app.split('\n').length,
      '去注释自检:行数必须不变(否则下面报的行号会指错地方)');

    const zoneStart = code.indexOf("subtype === 'task_started'");
    const zoneEnd = code.indexOf("subtype === 'task_notification'", zoneStart);
    assert.ok(zoneStart > 0 && zoneEnd > zoneStart, 'task_started 事件区块必须还在(枚举建卡点的前提)');
    const zone = code.slice(zoneStart, zoneEnd);
    const zoneStartLine = code.slice(0, zoneStart).split('\n').length;

    const sites = [];
    for (const c of callArgsOf(zone, 'upsertAgent')) {
      if (/taskManaged|status:\s*['"]working['"]/.test(c.args)) {
        sites.push({ kind: 'task_started 建条目', line: zoneStartLine + c.line - 1, args: c.args });
      }
    }
    for (const c of callArgsOf(code, 'rebuildWorkflowEntry')) sites.push({ ...c, kind: '缺条目补建' });
    for (const c of callArgsOf(code, 'applyWorkflowProgress')) sites.push({ ...c, kind: 'WS 兜底递 task_id' });

    for (const kind of ['task_started 建条目', '缺条目补建', 'WS 兜底递 task_id']) {
      assert.ok(sites.some((s) => s.kind === kind),
        `检测器一个「${kind}」建卡点都没识别到 —— 建卡形态变了,这条锁必须跟着改(不许让它空转成假绿)`);
    }

    for (const s of sites) {
      const at = `App.jsx:${s.line} 的「${s.kind}」建卡点`;
      const key = /(?:^|[{,]\s*)taskId\s*([:,}])/.exec(s.args);
      assert.ok(key, `${at} 没有钉 taskId —— 丢了它,task_updated(只带 task_id)跨回合反查不到这条,卡片永远不收尾`);
      if (key[1] !== ':') continue;   // 简写 `taskId,`:值来自上一层形参(现只有 WS 补建那一处),由上面 C 类那条锁管
      const val = s.args.slice(key.index + key[0].length).split(/[,}\n]/)[0];
      assert.ok(/\.task_id\b/.test(val), `${at} 的 taskId 不取自 task_id(值 = ${val.trim()})—— 钉别的字段 / 写死等于没钉`);
    }
  }

  // A4:双键反查
  assert.ok(/function findAgentIdByTaskId\(st, taskId\)/.test(app), 'findAgentIdByTaskId 必须存在');
  assert.ok(/\|\| findAgentIdByTaskId\(_st, event\.task_id\)/.test(app),
    'task_updated 解析必须有第三条路(本流 map 跨回合即失效)');
  assert.ok(/const id = \(tool_use_id && st\.activeAgents\[tool_use_id\]\) \? tool_use_id : findAgentIdByTaskId\(st, task_id\);/.test(app),
    'WS 兜底必须放宽成 tool_use_id || task_id 双键');

  // A4:level 消费链路 WS → window 事件 → 剪枝
  assert.ok(/case 'background-tasks':/.test(ws), 'useWebSocket 必须转发 background-tasks');
  assert.ok(/new CustomEvent\('cgui:background-tasks', \{ detail: data \}\)/.test(ws), 'WS 必须派发 cgui:background-tasks');
  assert.ok(/window\.addEventListener\('cgui:background-tasks', onBackgroundTasks\)/.test(app), 'App 必须监听 cgui:background-tasks');
  assert.ok(/window\.removeEventListener\('cgui:background-tasks', onBackgroundTasks\)/.test(app), '监听必须配对移除');
  assert.ok(/pruneByLiveSet\(useStore\.getState\(\)\.activeAgents, d\)/.test(app), '剪枝必须走纯函数 pruneByLiveSet');
  // 剪枝出来的终态必须带 settledBy(成败未知),且【绝不】驱动流/进程动作
  const h = app.slice(app.indexOf('const settleByLevel ='));
  const body = h.slice(0, h.indexOf('const onSessionProcsKilled'));
  assert.ok(/if \(!a \|\| \['done', 'error', 'stopped'\]\.includes\(a\.status\)\) return;/.test(body),
    '已终态条目不得被 level 覆盖(可能是刚到的权威终态,盖上 settledBy 会把绿勾降级)');
  assert.ok(/st\.upsertAgent\(id, \{ settledBy: 'level' \}\);\s*\n\s*finalizeAgent\(st, id, 'completed'\);/.test(body),
    '先标 settledBy 再走 finalizeAgent(拿到级联收尾 + 悬空 toolCall 合成结果)');
  assert.ok(!/finalizeAgent\(st, id, 'completed', undefined, true\)/.test(body),
    'level 收尾不得声明 authoritative —— 它是推断不是权威');
  assert.equal((body.match(/settledBy: 'level'/g) || []).length, 1, 'settled 与剪枝两条路共用同一个收尾函数');
  for (const forbidden of ['abort(', 'fetch(', '/stop', 'finalizeSessionAgents', 'updateStreaming']) {
    assert.ok(!body.includes(forbidden), `level 消费不得触碰 ${forbidden} —— 它只做 UI 收敛`);
  }

  // settledBy 的终态必须可被权威事件覆盖:A0 实测 level 信号恒【早于】权威终态 <1ms 到达,
  // 不可覆盖就等于每个任务的真实状态都被"猜的 done"吞掉。
  assert.ok(/const canOverride = !!authoritative\s*&& \(!!ag\.settledBy \|\| \(ag\.status === 'stopped' && \(!!ag\.taskManaged \|\| !!ag\.optimisticStop\)\)\);/.test(app),
    'canOverride 必须放行 settledBy 条目');
  assert.ok(/const patch = ag\.settledBy \? \{ settledBy: null \} : \{\};/.test(app),
    '权威覆盖时必须清 settledBy(哪怕 status 同值,否则卡片一直显示中性"已结束")');

  // local_bash 不建 agent 条目 → level 剪枝天然碰不到后台 shell 卡
  assert.ok(/else if \(event\.task_type === 'local_agent'\)/.test(app),
    'task_started 建条目仍只对 local_agent(local_bash 建条目会在监控里冒出假子代理卡)');

  // TaskCard:settledBy 不给绿勾
  const card = readFileSync(join(root, 'client', 'src', 'components', 'tools', 'TaskCard.jsx'), 'utf8');
  assert.ok(/const isSettledUnknown = isDone && !isError && !isStopped && !!agent\?\.settledBy;/.test(card),
    'TaskCard 必须区分"对账猜出来的结束"');
  assert.ok(/isSettledUnknown \? \([\s\S]{0,200}aria-label="子代理已结束"/.test(card),
    'settledBy 条目显示中性"已结束",不冒充绿勾"完成"');

  // r114(§F):工作流内层助手的水合条目(wfInner)必须同时带 hydrated:true —— 否则它会
  // 落进 level 剪枝的射程(内层助手根本不在 CLI 的 tasks 表里,必被误收成"已结束")。
  {
    const files = ['client/src/components/tools/WorkflowCard.jsx', 'client/src/App.jsx'];
    let found = 0;
    for (const rel of files) {
      let src = '';
      try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
      let p = src.indexOf('wfInner: true');
      while (p >= 0) {
        found += 1;
        const seg = src.slice(Math.max(0, p - 200), p + 200);
        assert.ok(/hydrated:\s*true/.test(seg),
          `${rel} 里的 wfInner 水合写入必须同时带 hydrated:true(否则内层助手卡会被 level 误收)`);
        p = src.indexOf('wfInner: true', p + 1);
      }
    }
    assert.ok(found > 0, '前端必须有 wfInner:true 的水合写入点(内层助手点开对话的唯一入口)');
  }
}

console.log('✓ check-level-prune: 剪枝 6 组 + 混合场景 + task_id 反查行为 + 接线源码守卫(建卡点逐个钉 taskId)全过');
