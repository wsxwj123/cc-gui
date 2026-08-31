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
const { genuiStateKey, loadBlockState, saveBlockState, clearBlockState, fingerprint, flushMirror } = store;
const { keepValue, keptValue } = await import('../../client/src/genui/upstream/blocks/state.ts');

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

  saveBlockState(k, { answers: { q1: '狗' } }, true);                 // 定稿:排进镜像队列
  assert.equal(localStorage.getItem(STORE_CELL), null, '镜像是防抖的:排进队列这一刻还没落盘');
  flushMirror();                                                     // 防抖到点 / 页面要走了
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
  flushMirror();
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
// 组件只管"同步交给 store",不许自己攒定时器:回合末组件会在 300ms 内被重挂,
// 清理钩子一 clearTimeout 那次编辑就永远没落过盘(B73 的形态)。防抖与
// "页面要走了立刻落盘"都在 store 里(见 §14)。
{
  const iEffect = at(block, 'useEffect(() => {\n    if (stateKey === undefined) return', '持久化 effect');
  // 终点取组件的 JSX 起点(effect 里可能有 `return (` 形态的语句,不能拿它当界)
  const body = block.slice(iEffect, at(block, '<div className={css.block}', '组件 JSX'));
  const iSecret = at(body, 'secretFields.has(id)', '密码过滤');
  const iSave = at(body, 'saveBlockState(stateKey, next, settled, owner)', '交给 store 的那一次写');
  assert.ok(iSecret < iSave, '密码必须在写之前就滤掉:内存层也不许存密码');
  assert.equal((body.match(/secretFields\.has\(id\)/g) || []).length, 1, '密码过滤只该有一处');
  assert.equal((body.match(/saveBlockState\(/g) || []).length, 1,
    '组件里只该有一次 saveBlockState:内存写与镜像排队是同一次调用(mirror 位就是 settled)');
  assert.ok(!/setTimeout/.test(body), '组件里不许再有定时器(重挂即被清,那次编辑就丢了)');
  assert.ok(/\[stateKey, answers, locked, fields, ui, secretFields, settled, owner\]/.test(body),
    'deps 必须含 stateKey(A2-② 靠它迁写)、ui(无 id 那本账)与 settled(定稿后才轮到镜像)');
  // memo 比较器漏了 settled 就永远不落盘(定稿只翻一次,没有第二次机会)
  assert.ok(/prev\.settled === next\.settled/.test(block), 'memo 比较器要比 settled');
}

// ── 8. 去抖定时器在模块级、卸载不清理(§1.2.6)──────────────────────────────────
// 上游 unmount 时 clearTimeout 全部在飞定时器(clear 非 flush),回合末连挂两次正撞
// 300ms 窗口 → 用户在回合结束前 300ms 内点的按钮既没发也没入队,且完全静默。
// r64 M6:定时器表已搬进 `upstream/action-debounce.ts`(纯 .ts,行为级假时钟单测见
// check-genui-action-debounce.mjs)。这里只留 GenuiBlock 侧"没把它挪回组件"的守卫。
{
  assert.ok(!/new Map<string, ReturnType<typeof setTimeout>>/.test(block),
    '定时器表不许再回到 GenuiBlock:重挂就换一份 = 白搭');
  assert.ok(!/useRef\(/.test(block), '定时器不许再挂回组件实例(useRef)');
  assert.ok(!/return \(\) => \{[\s\S]{0,240}(clearTimeout|scheduleAction)/.test(block),
    '不许在卸载钩子里碰在飞定时器:点了就一定要发出去');
  assert.ok(/scheduleAction\(`\$\{debounceScope\}:\$\{action\}`/.test(block),
    '去抖走模块级 scheduleAction,键带作用域前缀(裸 action 会让两个会话互相取消)');
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

// ── 10. 收集面:无天然键的界面态也要进内存层(§3.6「全部保留」)────────────────────
// b06/B71a 红过的那条:无 id 的输入格只活在组件本地 state,重挂即丢。
// keepValue/keptValue 在 .ts 里,裸 node 真跑(不是源码锁)。
{
  const mk = () => {
    const st = { fields: {}, ui: {} };
    return { st, a: { fields: st.fields, ui: st.ui,
      setField: (k, v) => { st.fields[k] = v; }, setUi: (k, v) => { st.ui[k] = v; } } };
  };
  // 带 id → fields(那本要发给模型);无 id → ui(只为活过重挂)
  const withId = mk();
  keepValue(withId.a, 'kept', '0.1', 'WITH-ID');
  assert.deepEqual(withId.st.fields, { kept: 'WITH-ID' }, '带 id 的值必须进 fields');
  assert.deepEqual(withId.st.ui, {}, '带 id 的值不该同时占一条 ui —— 两本账不许重复记');

  const noId = mk();
  keepValue(noId.a, undefined, '0.1', 'NO-ID');
  assert.deepEqual(noId.st.ui, { '0.1': 'NO-ID' }, '无 id 的值必须进 ui(否则重挂即丢 = B71a 那条红)');
  assert.deepEqual(noId.st.fields, {}, '无 id 的值绝不能进 fields —— 那本会被 submit 收集外发给模型');

  // 读回:两本账各读各的,都没有时 undefined(调用方回落 spec 默认值)
  assert.equal(keptValue(withId.a, 'kept', '0.1'), 'WITH-ID');
  assert.equal(keptValue(noId.a, undefined, '0.1'), 'NO-ID');
  assert.equal(keptValue(noId.a, undefined, '9.9'), undefined, '没存过就是 undefined,不许瞎给空串');
  assert.equal(keptValue(undefined, undefined, '0.1'), undefined, '无 answers(独立渲染)不许炸');
  assert.equal(keptValue(noId.a, undefined, undefined), undefined, '无 uiKey 时不读 ui');
  // 无 uiKey 也不写(独立使用 GenuiBlock 时没有路径)
  const bare = mk();
  keepValue(bare.a, undefined, undefined, 'X');
  assert.deepEqual([bare.st.fields, bare.st.ui], [{}, {}], '既无 id 又无 uiKey:两本账都不写');
}

// ── 11. 节点路径键:同 A1 的稳定性思路(不含内容、不含挂载次数)────────────────
{
  const rn = read('client/src/genui/upstream/blocks/render-node.tsx');
  assert.ok(/const uiKey = path === '' \? String\(key\) : `\$\{path\}\.\$\{key\}`/.test(rn),
    'uiKey = 祖先路径 + 兄弟序号');
  assert.ok(!/uiKey[^\n]*JSON\.stringify|uiKey[^\n]*fingerprint/.test(rn),
    '路径键不许掺节点内容:流式期节点还在长,掺了内容就是每 chunk 换一次键(A2-② 那类洞)');
  // 容器必须把自己的路径传给孩子,否则不同容器里的同序号节点撞键
  const adv = read('client/src/genui/upstream/blocks/advanced.tsx');
  assert.equal((rn.match(/renderNode\([^)]*answers, uiKey\)/g) || []).length, 5,
    'render-node 里 5 处递归都要把 uiKey 当孩子的 path 传下去');
  // Tabs / Accordion:孩子的 path 必须**带上页签/分节序号**。直接传自己的 uiKey 的话,
  // 两页(两节)同位的输入格会算出同一个键 —— 在第一页填的字出现在第二页,
  // 正是这批要防的串扰形态。
  assert.ok(/current\.items\.map\(\(c, i\) => renderNode\(c, i, onAction, depth \+ 1, answers, `\$\{uiKey \?\? ''\}\.\$\{active\}`\)\)/.test(adv),
    'TabsNode 的孩子路径要带页签序号 ${active}');
  assert.ok(/item\.items\.map\(\(c, ci\) => renderNode\(c, ci, onAction, depth \+ 1, answers, `\$\{uiKey \?\? ''\}\.\$\{i\}`\)\)/.test(adv),
    'AccordionNode 的孩子路径要带分节序号 ${i}');
  assert.ok(!/renderNode\([^)]*answers, uiKey\)/.test(adv),
    '不许再把容器自己的 uiKey 原样当孩子的 path(那就是撞键)');
  // 存储键分开还不够:两页同位子节点的 React key 同为 i、父面板又是同一个 div ⟹
  // React 复用组件实例、**不重挂**,InputNode 的本地 useState 原样带进下一页
  // (根本不经过存储层 —— 上面那些键断言全绿也测不到,真机是"乙页显示甲页的字")。
  // 面板挂上 key={active} 让切页即换子树。行为级实证见 r64 M5 复核记录:
  // 未修版乙页显示 TAB-A(串),修复版乙页空、两页各自 TAB-A/TAB-B 往返不丢。
  assert.ok(/<div key=\{active\} className=\{css\.col\} role="tabpanel"/.test(adv),
    'TabsNode 的面板必须带 key={active}:否则两页同位的输入框被 React 复用,串值不经存储层');
  // 路径拼出来长什么样:同一 tabs 的两页同位输入格必须不同键
  const childPath = (parent, idx) => (parent === '' ? String(idx) : `${parent}.${idx}`);
  const tabsAt = '0';                                   // tabs 节点自己在根下第 0 位
  const p0 = childPath(`${tabsAt}.0`, 0);               // 第 1 页第 0 个孩子
  const p1 = childPath(`${tabsAt}.1`, 0);               // 第 2 页第 0 个孩子
  assert.notEqual(p0, p1, '两页同位输入格必须落在不同路径上');
  assert.deepEqual([p0, p1], ['0.0.0', '0.1.0'], '路径形态:根序号.页签序号.孩子序号');
}

// ── 12. 两条红线:密码不进任何一层;ui 不外发 ──────────────────────────────────
{
  const forms = read('client/src/genui/upstream/blocks/forms.tsx');
  assert.ok(/\/\/ 密码框一个字节都不留[\s\S]{0,80}if \(!secret\) keepValue\(answers, id, uiKey, v\)/.test(forms),
    '密码框的值连内存层都不许写(§3.6 永不保留)——无 id 的密码框走 ui 就是把密码存起来了');
  assert.ok(/secret \? '' : \(keptValue\(answers, id, uiKey\)/.test(forms),
    '密码框也不许从任何一层读回(恢复出来的密码同样是"存过密码")');
  // `secret` 只在 InputNode 里声明。别处引用它 = 运行时 ReferenceError,而 .tsx 不进
  // eslint 的 no-undef 门(§2.0 的已知代价),只能在这里守
  // (LEARNINGS cross-component-undefined-ref-whitescreen 同一形态)。
  const inputBody = forms.slice(
    at(forms, 'export function InputNode', 'InputNode'),
    at(forms, 'export function TextareaNode', 'TextareaNode'));
  assert.equal((forms.match(/if \(!secret\)/g) || []).length,
    (inputBody.match(/if \(!secret\)/g) || []).length,
    'secret 守卫只许出现在 InputNode 里:别的组件没有这个变量,引用即 ReferenceError');
  assert.ok(!/\bsecret\b/.test(forms.slice(at(forms, 'export function TextareaNode', 'TextareaNode'))),
    'TextareaNode 之后不许再出现 secret(textarea 没有 password 类型)');
  // submit 只收 fields:ui 里的内部路径键不会跟着外发(§1.3.3-L2)
  const submit = forms.slice(at(forms, 'export function SubmitNode', 'SubmitNode'));
  assert.ok(/const fields = answers\?\.fields \?\? \{\}/.test(submit), 'submit 收集的是 fields');
  assert.ok(!/answers\?\.ui|\bui\[/.test(submit.slice(0, 2000)),
    'submit 绝不能收集 ui —— 那是内部路径键,外发即污染 payload');
}

// ── 13. 挂载时的 spec 默认值不许冲掉用户编辑(§3.6)────────────────────────────
// 形态:每次重挂,组件的 mount effect 都把 spec 默认值重新注册一遍 ⟹ 存储里的
// EDIT 被 DEFAULT 压掉。屏幕上当时还对(组件 state 里是 EDIT),下一次重挂就丢。
{
  const mk = () => { const st = { fields: {}, ui: {} };
    return { st, a: { fields: st.fields, ui: st.ui,
      setField: (k, v) => { st.fields[k] = v; }, setUi: (k, v) => { st.ui[k] = v; } } }; };
  // 组件挂载时那两句(带门):没存过才注册默认值
  const mount = (a, id, uiKey, def, guarded) => {
    if (def !== undefined && def.trim() !== '' && (!guarded || keptValue(a, id, uiKey) === undefined)) {
      keepValue(a, id, uiKey, def);
    }
  };
  for (const [id, uiKey] of [['kept', '0'], [undefined, '0']]) {
    const { a } = mk();
    mount(a, id, uiKey, 'DEFAULT', true);
    assert.equal(keptValue(a, id, uiKey), 'DEFAULT', '首次挂载:没存过 → 注册 spec 默认值');
    keepValue(a, id, uiKey, 'EDIT');                       // 用户改了
    mount(a, id, uiKey, 'DEFAULT', true);                  // 回合末重挂一
    mount(a, id, uiKey, 'DEFAULT', true);                  // 重挂二(dockKeyPrefix 换两轮)
    assert.equal(keptValue(a, id, uiKey), 'EDIT',
      `${id === undefined ? '无 id' : '带 id'}:重挂两次后存储里必须还是用户编辑的值,不许被 spec 默认值冲掉`);
  }
  // 反例:去掉门就是被冲掉 —— 这条门存在的理由
  { const { a } = mk();
    keepValue(a, 'kept', '0', 'EDIT');
    mount(a, 'kept', '0', 'DEFAULT', false);
    assert.equal(keptValue(a, 'kept', '0'), 'DEFAULT', '前提:无条件回写确实会冲掉编辑值'); }
  // 源码锁:四个挂载回写点都要带这道门(input / textarea / select / slider)
  const forms = read('client/src/genui/upstream/blocks/forms.tsx');
  assert.equal((forms.match(/keptValue\(answers, id, uiKey\) === undefined/g) || []).length, 4,
    'input/textarea/select/slider 四处挂载回写都要先问"存过没有"');
}

// ── 14. 编辑完立刻刷新/关页,那条编辑也必须落过盘(INTERFACE §3.6「刷新保留」)──
// 锁定验收 B73 的真实形态:填完值紧接着 page.reload()。落盘必须防抖(输入框逐字符
// 触发),而防抖窗口里页面就没了 ⟹ 编辑等于没编辑。真机实测:编辑后 50ms 时
// localStorage 还是 null、550ms 才有。修法=防抖搬进 store + 页面隐藏/卸载时 flush。
{
  cells.clear();
  const k = genuiStateKey(SID, RAW_A);
  saveBlockState(k, { answers: {}, locked: false, fields: { kept: 'WITH-ID-VALUE' } }, true);
  assert.deepEqual(loadBlockState(k).fields, { kept: 'WITH-ID-VALUE' }, '内存层照旧是同步的');
  assert.equal(localStorage.getItem(STORE_CELL), null, '前提:镜像是防抖的,这一刻还没落盘');

  flushMirror();                                   // = pagehide / visibilitychange 那一下
  assert.deepEqual(mirrored()[k].fields, { kept: 'WITH-ID-VALUE' },
    '页面要走了必须把待落盘的编辑写下去 —— 否则刷新后读回一片空白(B73)');

  // 刷新:新模块实例(内存空),值要能从镜像读回来
  const reloaded = await import('../../client/src/genui/upstream/interaction-store.ts?b73=1');
  assert.deepEqual(reloaded.loadBlockState(k).fields, { kept: 'WITH-ID-VALUE' },
    '刷新后按同一个键读得回来(键两端一致:写时与读时都是 g:{queueKey}:{djb2(raw)})');

  // flush 幂等 + 清掉的条目不许被待落盘的旧值写回来
  flushMirror();
  clearBlockState(k);
  flushMirror();
  assert.equal(mirrored()[k], undefined, 'clear 之后再 flush 不许把旧值复活');

  // 流式期编辑 + 立刻刷新:A3 不定时落盘,但页面要走时必须把最新那把键落下去
  // (B73 就是这一路:填完还在流式,紧接着 reload)
  {
    cells.clear();
    let raw = '{"items":[{"type":"input"';
    for (let i = 0; i < 5; i++) {                 // 流式每 chunk 换一次键,同一个组件实例
      raw += `,"x${i}":${i}`;
      saveBlockState(genuiStateKey(SID, raw), { fields: { kept: 'EDIT-WHILE-STREAMING' } }, false, 'blk-1');
    }
    saveBlockState(genuiStateKey(SID, raw + 'other'), { answers: {} }, false, 'blk-2'); // 没碰过的块
    assert.equal(localStorage.getItem(STORE_CELL), null, '流式期不定时落盘(A3 不变)');
    flushMirror();
    const keys = Object.keys(mirrored());
    assert.deepEqual(keys, [genuiStateKey(SID, raw)],
      '页面要走时只落**最新那把键**一条:按组件实例去重,否则流式期 200 把旧键会把 LRU 冲垮');
    assert.deepEqual(mirrored()[keys[0]].fields, { kept: 'EDIT-WHILE-STREAMING' }, '值要对');
  }

  // 兜底监听要真挂上(浏览器里没有这两句,防抖窗口内刷新照样丢)
  const src = read('client/src/genui/upstream/interaction-store.ts');
  assert.ok(/addEventListener\('pagehide', flushMirror\)/.test(src), 'pagehide 兜底');
  assert.ok(/addEventListener\('visibilitychange'/.test(src) && /visibilityState === 'hidden'/.test(src),
    'visibilitychange→hidden 兜底(移动端切走 pagehide 不保证触发)');
  // 定时器不许再挂回组件:回合末 300ms 内重挂会被清理钩子吃掉
  const block = read('client/src/genui/upstream/GenuiBlock.tsx');
  assert.ok(!/setTimeout\(\(\) => saveBlockState/.test(block), '组件里不许再自己防抖落盘');
  assert.ok(/saveBlockState\(stateKey, next, settled, owner\)/.test(block), '组件一次调用:内存同步写 + 排进待落盘槽');
}

console.log('check-genui-state-key: all passed');
