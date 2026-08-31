#!/usr/bin/env node
// r64 M5:稳定身份(难题 A)。锁四件事:
//   ① 键算法(PLAN §1.2.2 A1) —— 含 §1.2.5 留给测试裁决的那两条争议用例;
//   ② 写透方向(A2/A3) —— 内存层实时写、持久层只在非流式镜像,**方向不能反**;
//   ③ A2-② —— 流式期键每 chunk 变一次,按最终键仍读得到点击时那份状态;
//   ④ 去抖定时器在模块级、卸载不清理(§1.2.6)。
// interaction-store.ts 是 .ts,裸 node 真跑(不写死键的字面形态,只断言性质);
// GenuiBlock.tsx / GenuiFence.jsx 是 JSX 裸 node 加载不了(ERR_UNKNOWN_FILE_EXTENSION),
// 按仓内惯例(check-genui-fence-render / check-codeblock-extract)走源码锁。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// localStorage 存根必须在 import 之前:模块加载期不碰它,但函数调用期会。
const cells = new Map();
globalThis.localStorage = {
  getItem: (k) => (cells.has(k) ? cells.get(k) : null),
  setItem: (k, v) => { cells.set(k, String(v)); },
  removeItem: (k) => { cells.delete(k); },
};
const STORE_CELL = 'cgui.genui.interaction';
const mirrored = () => JSON.parse(localStorage.getItem(STORE_CELL) ?? '{"order":[],"blocks":{}}').blocks;

const store = await import('../../client/src/genui/upstream/interaction-store.ts');
const { genuiStateKey, loadBlockState, saveBlockState, clearBlockState, fingerprint } = store;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const block = read('client/src/genui/upstream/GenuiBlock.tsx');
const fence = read('client/src/components/GenuiFence.jsx');
const at = (hay, needle, what) => {
  const i = hay.indexOf(needle);
  assert.notEqual(i, -1, `找不到:${what}(${needle})`);
  return i;
};

// 两条消息各自的围栏体。逐字节不同(换了题),但在各自文本块里的 offset 相同。
const RAW_A = '{"items":[{"type":"radio","group":"q1","options":["猫","狗"]}]}';
const RAW_B = '{"items":[{"type":"radio","group":"q1","options":["红","蓝"]}]}';
const SID = 'sess-aaa';

// ── 1. §1.2.5 裁决用例①:两条不同消息的围栏落在各自文本块**同一 offset** 上,不得碰撞 ──
// 这条是 A-M2 争议的落点。offset 单独当身份(丢掉 prefix 的 dockKeyFor)在这里必撞;
// 内容指纹不撞。红绿即裁决 —— 把 genuiStateKey 换成按 offset 算,这一节当场红。
{
  const offsetIdentity = (offset) => `dock:${offset}`; // 反方案:只剩 offset 的身份
  assert.equal(offsetIdentity(12), offsetIdentity(12),
    '前提:两条消息的围栏 offset 相同 —— 只按 offset 算身份的方案在这里就撞了');

  const kA = genuiStateKey(SID, RAW_A);
  const kB = genuiStateKey(SID, RAW_B);
  assert.notEqual(kA, kB, '§1.2.5-①:不同内容的围栏必须拿到不同的键(跨消息碰撞比指纹碰撞严重得多)');

  // 碰撞的后果要一起锁:A 里选的答案不许在 B 里冒出来。
  saveBlockState(kA, { answers: { q1: '猫' } });
  assert.equal(loadBlockState(kB), null, '§1.2.5-①:B 那条围栏必须是干净的,读不到 A 的答案');
}

// ── 2. §1.2.5 裁决用例②:同一位置模型换了题,旧答案不得恢复到新题上 ────────────────
// INTERFACE §3.6「模型输出内容不同的围栏 → 不保留,干净重来」,只有内容指纹能兑现。
{
  const kOld = genuiStateKey(SID, RAW_A);
  saveBlockState(kOld, { answers: { q1: '猫' }, locked: true });
  const kNew = genuiStateKey(SID, RAW_B); // 同一条消息的同一个位置,模型改了 spec
  assert.equal(loadBlockState(kNew), null, '§1.2.5-②:换题必须干净重来,不许把旧答案套到新题上');
  assert.deepEqual(loadBlockState(kOld), { answers: { q1: '猫' }, locked: true },
    '旧键自己的状态不受影响(用户翻回历史那条消息,答案还在)');
}

// ── 3. 键的正例:同原文同键、会话分量隔离 ────────────────────────────────────────
{
  assert.equal(genuiStateKey(SID, RAW_A), genuiStateKey(SID, RAW_A), '同 queueKey + 同原文 = 同键');
  // 定稿文本与流式末尾文本逐字节相同(V1 实测),所以"定稿的键"就是"最后一个 chunk 的键"。
  assert.equal(genuiStateKey(SID, RAW_A), genuiStateKey(SID, `${RAW_A}`), '定稿帧与流式末帧同键');
  // 草稿窗格:queueKeyFor 给的是 draft-<hash>-<draftId>,两个草稿窗格必须不共用状态(arch-M3)。
  assert.notEqual(genuiStateKey('draft-h1-d1-1', RAW_A), genuiStateKey('draft-h1-d2-1', RAW_A),
    '两个草稿窗格里的同一份界面,状态不许串(裸 sessionId 时双双为空才会串)');
  assert.notEqual(genuiStateKey('sess-aaa', RAW_A), genuiStateKey('sess-bbb', RAW_A), '不同会话不共用');
  assert.equal(fingerprint(RAW_A), fingerprint(RAW_A), 'djb2 是确定性的');
  assert.notEqual(fingerprint(RAW_A), fingerprint(RAW_B), '内容不同则指纹不同');
}

// ── 4. 写透方向(A2/A3):内存实时写,localStorage 只在**非流式**时镜像 ─────────────
// 方向做反(流式期就镜像)正是上游[§4.3 落差一]的成因:流式每 chunk 一个新指纹,
// 一停顿就往 200 条 LRU 里塞一条空状态,长围栏会把真状态整个挤出去。
{
  cells.clear();
  const k = genuiStateKey(SID, RAW_A);
  saveBlockState(k, { answers: { q1: '猫' } });                       // 流式期:mirror 缺省 false
  assert.deepEqual(loadBlockState(k), { answers: { q1: '猫' } }, '内存层必须立刻可读(不等防抖)');
  assert.equal(localStorage.getItem(STORE_CELL), null, 'A3:流式期一个字节都不许落 localStorage');

  saveBlockState(k, { answers: { q1: '狗' } }, true);                 // 定稿:镜像
  assert.deepEqual(mirrored()[k], { answers: { q1: '狗' } }, '定稿后必须镜像到 localStorage');
  assert.deepEqual(loadBlockState(k), { answers: { q1: '狗' } }, '内存层同时也是最新的');

  clearBlockState(k);
  assert.equal(loadBlockState(k), null, 'clear 要两层一起清');
  assert.equal(mirrored()[k], undefined, 'clear 后镜像里也不许残留');
}

// ── 5. 刷新恢复:内存空了,镜像还在,读得回来(INTERFACE §3.6「刷新应用 → 保留」)──
{
  cells.clear();
  const k = genuiStateKey(SID, RAW_A);
  saveBlockState(k, { answers: { q1: '猫' }, fields: { name: '张三' } }, true);
  // 换一份模块实例 = 新页面(内存 Map 空),localStorage 存根不变。
  const reloaded = await import('../../client/src/genui/upstream/interaction-store.ts?refresh=1');
  assert.equal(reloaded.loadBlockState('nope'), null, '前提:新实例的内存层是空的');
  assert.deepEqual(reloaded.loadBlockState(k), { answers: { q1: '猫' }, fields: { name: '张三' } },
    '刷新后必须从镜像读回(内存层不是唯一真相,只是快的那一层)');
}

// ── 6. A2-②:点击后键连续变化 N 次(流式每 chunk 一次),按最终键仍读得到 ───────────
// plan-I3 指出的洞:用户在第 50 个 chunk 点选、第 100 个 chunk 才定稿,中间再无状态变更。
// 只在"状态变更时写"就再没写过 ⟹ 定稿按最后那个键去读 = 空 = 静默清零。
{
  cells.clear();
  const picked = { answers: { q1: '猫' } };
  let raw = '{"items":[{"type":"radio","group":"q1"';
  saveBlockState(genuiStateKey(SID, raw), picked);        // 用户在这一帧点了单选
  for (let i = 0; i < 50; i++) {                          // 模型继续写,键每 chunk 一变
    raw += `,"x${i}":${i}`;
    saveBlockState(genuiStateKey(SID, raw), picked);      // effect 的 [stateKey] deps:键一变就迁写
  }
  assert.deepEqual(loadBlockState(genuiStateKey(SID, raw)), picked,
    'A2-②:定稿键(= 最后一个 chunk 的键)必须读得到点击时那份状态');

  // 反例:只写点击那一帧(上游行为)—— 定稿键读到的是空。
  cells.clear();
  let raw2 = '{"items":[{"type":"radio","group":"q2"';
  saveBlockState(genuiStateKey(SID, raw2), { answers: { q2: '狗' } });
  const settledKey = genuiStateKey(SID, `${raw2},"tail":1}]}`);
  assert.equal(loadBlockState(settledKey), null,
    '前提:不迁写就读不到 —— 这正是 A2-② 存在的理由,别把它当多余');
}

// ── 7. 写透的**时机**锁(A2/A3 在组件侧的落法)────────────────────────────────────
// 纯函数测不到时机:内存写必须在 effect 体里同步跑,不能被防抖裹住(裹住 = 键每 chunk
// 一变、定时器每次被清理钩子清掉,永远轮不到落 = A2-② 直接失效)。
{
  const iEffect = at(block, 'useEffect(() => {\n    if (stateKey === undefined) return', '持久化 effect');
  // 终点取组件的 JSX 起点(effect 里自己也有 `return (` 形态的清理钩子,不能拿它当界)
  const body = block.slice(iEffect, at(block, '<div className={css.block}', '组件 JSX'));
  const iSync = at(body, 'saveBlockState(stateKey, next)', '内存层同步写');
  const iGate = at(body, 'if (!settled) return', '非流式不镜像的门');
  const iTimer = at(body, 'setTimeout(', '镜像防抖');
  assert.ok(iSync < iGate && iGate < iTimer,
    '顺序必须是 同步写内存 → settled 门 → 防抖镜像:内存写进了定时器就等于没写透');
  assert.ok(/setTimeout\(\(\) => saveBlockState\(stateKey, next, true\)/.test(body),
    '只有防抖里那次带 mirror=true —— 镜像方向做反(流式期也镜像)就回到上游的落差一');
  assert.ok(/\[stateKey, answers, locked, fields, secretFields, settled\]/.test(body),
    'deps 必须含 stateKey(A2-② 靠它迁写)与 settled(定稿后才轮到镜像)');
  // 密码:两条写路共用同一个 safeFields,不许只在镜像那一路过滤(INTERFACE §3.6 永不保留)
  assert.equal((body.match(/secretFields\.has\(id\)/g) || []).length, 1, '密码过滤只该有一处');
  assert.ok(at(body, 'secretFields.has(id)', '密码过滤') < iSync,
    '密码必须在**两条写路之前**就滤掉:内存层也不许存密码');
  // memo 比较器漏了 settled 就永远不落盘(定稿只翻一次,没有第二次机会)
  assert.ok(/prev\.settled === next\.settled/.test(block), 'memo 比较器要比 settled');
}

// ── 8. 去抖定时器在模块级、卸载不清理(§1.2.6)──────────────────────────────────
// 上游 unmount 时 clearTimeout 全部在飞定时器(clear 非 flush),回合末连挂两次正撞
// 300ms 窗口 → 用户在回合结束前 300ms 内点的按钮既没发也没入队,且完全静默。
{
  const iMap = at(block, 'const pendingActions = new Map', '模块级定时器表');
  const iComponent = at(block, 'export const GenuiBlock = memo', 'GenuiBlock 组件');
  const iHook = at(block, 'function useDebouncedAction', 'useDebouncedAction');
  assert.ok(iMap < iHook && iMap < iComponent, '定时器表必须在模块级,不在组件里(重挂就换一份 = 白搭)');
  assert.ok(!/pendingActions\.clear\(\)/.test(block), '不许清空在飞定时器表');
  assert.ok(!/return \(\) => \{[\s\S]{0,240}pendingActions/.test(block),
    '不许在卸载钩子里碰在飞定时器:点了就一定要发出去');
  assert.ok(!/useRef\(/.test(block), '定时器不许再挂回组件实例(useRef)');
  assert.ok(/const key = `\$\{stateKey \?\? ''\}:\$\{action\}`/.test(block),
    '键必须是 `${stateKey}:${action}`:表已是全局的,裸 action 会让两个块互相取消(§1.2.6)');
  assert.ok(/useDebouncedAction\(useGenuiAction\(\), stateKey\)/.test(block), 'stateKey 要传进去');
  assert.ok(/pendingActions\.delete\(key\)/.test(block), '触发后自删,否则表只增不减');
}

// ── 9. 键只在 spec 分支算(空体/超大/解析失败不产生状态条目)────────────────────────
{
  const iKey = at(fence, 'genuiStateKey(queueKey, raw)', 'stateKey 接线');
  assert.ok(at(fence, "fence.kind === 'spec'", 'spec 分支') < iKey
    && iKey < at(fence, "fence.kind === 'oversize'", '超大分支'),
    '键只在渲染成功那一支上算:空体/超大/解析失败三条降级路一个状态条目都不该产生');
  assert.ok(/<GenuiBlock spec=\{fence\.spec\} stateKey=\{genuiStateKey\(queueKey, raw\)\} settled=\{settled\}/.test(fence),
    'GenuiBlock 要同时收 stateKey 与 settled;指纹取围栏原文 raw,不取解析后的 spec');
  assert.equal((fence.match(/genuiStateKey\(/g) || []).length, 1, '接线点只有一处');
}

console.log('check-genui-state-key: all passed');
