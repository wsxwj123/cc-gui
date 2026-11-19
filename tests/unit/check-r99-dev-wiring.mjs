// r99 开发自测(App.jsx 接线):源码锁 + 计数锁 + 既有行为回归锁。
// 契约见 .devflow/INTERFACE-r99.md §4。零网络、零文件写入。
// 跑法:node tests/unit/check-r99-dev-wiring.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const A = readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
const count = (s, re) => (s.match(re) || []).length;
// r176:代码搬家,页面行为不变 —— 报错分支的三条判据(及优先级)搬进 utils/apiErrorActions.js,
// 渲染段的三块动作界面搬进 components/ApiErrorActions.jsx;原来对 App.jsx 报错分支 / 渲染段的源码文字断言改指到这两个文件,
// App.jsx 只剩接线,另行钉住。
const AE = readFileSync(path.join(ROOT, 'client/src/utils/apiErrorActions.js'), 'utf8');
const AC = readFileSync(path.join(ROOT, 'client/src/components/ApiErrorActions.jsx'), 'utf8');

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); }
};

// ---- §4.2 必须出现 ----
t('4.2 import 纯函数模块', () => {
  // classifyUpstreamRefusal 随判据搬进 apiErrorActions.js(同目录,写 './contentRisk.js');App.jsx 仍 import 另两个。
  assert.match(A, /from '\.\/utils\/contentRisk\.js'/);
  const line = A.split('\n').find((l) => l.includes("./utils/contentRisk.js"));
  for (const n of ['lastUserIndex', 'locateRiskAnchor']) {
    assert.ok(line.includes(n), `import 缺 ${n}`);
  }
  const lineE = AE.split('\n').find((l) => l.includes("from './contentRisk.js'"));
  assert.ok(lineE, "apiErrorActions.js 缺 from './contentRisk.js' 的 import");
  assert.ok(lineE.includes('classifyUpstreamRefusal'), 'apiErrorActions.js import 缺 classifyUpstreamRefusal');
  const lineD = A.split('\n').find((l) => l.includes("./utils/apiErrorActions.js"));
  assert.ok(lineD && lineD.includes('deriveApiErrorUi'), 'App.jsx 必须从 apiErrorActions.js import deriveApiErrorUi');
});
t('4.2 错误分支打标', () => {
  // 判据与动作取值在 apiErrorActions.js;App.jsx 报错分支把 msg 交给它、把结果写进消息的 errorAction;
  // 渲染在 ApiErrorActions.jsx,App.jsx 把消息的 errorAction 当 action 传入。
  assert.match(AE, /const risk = classifyUpstreamRefusal\(msg\)/);
  assert.match(AE, /const action = risk \? 'content-risk'/);
  assert.match(AC, /action === 'content-risk'/);
  assert.match(A, /const errUi = deriveApiErrorUi\(msg\)/);
  assert.match(A, /errorAction: errUi\.action/);
  assert.match(A, /<ApiErrorActions action=\{msg\.errorAction \|\| null\}/);
});
t('4.2 三元链里 content-risk 排在 isAuthError 之前(M15)', () => {
  // 原来比的是两个子串的先后;现在三支在 apiErrorActions.js 的同一行里,先逐字钉整条三元表达式,
  // 再比 content-risk 与 provider 两支的位置(沿用原来「内容审核排在鉴权之前」的判法)。
  assert.match(AE, /const action = risk \? 'content-risk' : isAuth \? 'provider' : isEmptyBlock \? 'repair-official' : null;/);
  const i = AE.indexOf("risk ? 'content-risk'");
  const j = AE.indexOf("isAuth ? 'provider'");
  assert.ok(i > 0 && j > 0 && i < j, `content-risk@${i} 必须排在 isAuth ? 'provider'@${j} 之前`);
});
t('4.2 两个新回调存在', () => {
  assert.match(A, /const runContentRiskRewind = useCallback/);
  assert.match(A, /const newSessionWithLastUser = useCallback/);
});
t('4.2 按钮文案逐字 + 提示文案关键词', () => {
  // 三块动作界面搬进 ApiErrorActions.jsx,文案逐字照旧,改在该文件里找。
  assert.match(AC, /回退到上一条工具输出之前并重发/);
  assert.match(AC, /回退到上一条消息之前并重新编辑/);
  assert.match(AC, /新开会话/);
  assert.match(AC, /内容审核/);
  assert.match(AC, /每一轮/);
});
t('4.2 主动作走应用内确认框(danger)', () => {
  const blk = A.slice(A.indexOf('const runContentRiskRewind = useCallback'), A.indexOf('const newSessionWithLastUser = useCallback'));
  assert.match(blk, /await confirmDialog\(/);
  assert.match(blk, /\{ danger: true \}/);
});
t('4.2 主动作复用既有链路,不自写 fetch', () => {
  const blk = A.slice(A.indexOf('const runContentRiskRewind = useCallback'), A.indexOf('const newSessionWithLastUser = useCallback'));
  assert.match(blk, /handleRetryToolRef\.current\?\.\(/);
  assert.match(blk, /contentRisk: true/);
  assert.equal(count(blk, /fetch\(/g), 0, '新回调里不许自写 fetch');
});

// ---- 判官 ①:不收敛 + .bak 覆盖 ----
const REWIND = A.slice(A.indexOf('const runContentRiskRewind = useCallback'), A.indexOf('const newSessionWithLastUser = useCallback'));
t('①a 锚点之后还有用户消息时不自动重发,改走退化路径', () => {
  assert.match(REWIND, /if \(!anchor \|\| anchor\.carryText \|\| rewoundOnce\)/);
  // carryText 绝不再作为自动重发的载荷送进 handleRetryTool
  assert.equal(count(A, /carryText: anchor\.carryText/g), 0);
  assert.equal(count(A, /resendReplacing\(opts\.carryText/g), 0);
});
t('①b 同会话只自动回退一次,标记 keyed by sessionId(分屏不串)', () => {
  assert.match(A, /const \[riskRewoundSids, setRiskRewoundSids\] = useState\(\{\}\)/);
  // 表示法不许用 `useState(() => new Set())`:check-r26 的 HomeState 哨兵按整段源码扫这个字面量
  assert.equal((A.match(/useState\(\(\) => new Set\(\)\)/g) || []).length, 0);
  assert.match(REWIND, /const rewoundOnce = !!sid && !!riskRewoundSids\[sid\]/);
  // 标记必须在确认之后、真正执行回退时写入(取消不该消耗额度)
  const okIdx = REWIND.indexOf('if (!ok) return;');
  const markIdx = REWIND.indexOf('setRiskRewoundSids(');
  assert.ok(okIdx > 0 && markIdx > okIdx, '标记必须写在确认框通过之后');
  // r99b(Windows 审查中-1):标记改为在截断【成功】后经 onTrimmed 回调写入 —— 写在
  // handleRetryToolRef.current?.( 的 opts 里,而不是调用之前(截断 EPERM 失败时不烧掉唯一一次机会)。
  assert.ok(markIdx > REWIND.indexOf('handleRetryToolRef.current?.('), '标记必须在回退调用的 opts 里(截断成功后回调)');
  assert.match(REWIND, /onTrimmed: \(\) => \{ if \(sid\) setRiskRewoundSids\(/, 'onTrimmed 回调里置位');
  // R25 重构后收尾判据从"裸 fetch 的 trData.status"换成统一入口的信封 {ok,error,status}:
  // 断言语义不变 —— onTrimmed 必须在【截断成功判定之后】调用,且全文件只有这一处调用点。
  const body = A.slice(A.indexOf('const handleRetryTool = useCallback'), A.indexOf('const handleRetryToolRef = useRef'));
  const failIdx = body.indexOf('if (!tr.ok) throw new Error(');
  const callIdx = body.indexOf('opts.onTrimmed?.();');
  assert.ok(failIdx > 0, '裁剪失败判定必须还在(失败即抛,继续走到提示)');
  assert.ok(callIdx > failIdx, `onTrimmed 必须在裁剪成功判定之后调用(失败判定@${failIdx},通知@${callIdx})`);
  assert.equal((body.match(/opts\.onTrimmed\?\.\(\)/g) || []).length, 1,
    'onTrimmed 只许一处调用点(多一处就可能绕开成功判定)');
});
t('①b 裁剪走统一入口(R25 接线契约:客户端只走"预览→提交"两步,不自拼端点)', () => {
  const body = A.slice(A.indexOf('const handleRetryTool = useCallback'), A.indexOf('const handleRetryToolRef = useRef'));
  assert.match(body, /const tr = await runHistoryOpSettled\(sel\.sessionId, 'trim-before-tool', \{[^\n]*\{ runOp: runHistoryOp \}\);/,
    '裁剪必须经 utils/historyOps.js 的统一入口');
  assert.equal(count(body, /fetch\(`\/api\/sessions\//g), 0, '不许自拼历史端点(会跳过预览令牌/备份)');
  assert.match(A, /import \{ runHistoryOp(?:, [A-Za-z_]+)* \} from '\.\/utils\/historyOps\.js'/);
});
t('①b 按钮判据与退化条件对齐:有后续用户消息 / 已回退过 → 不给自动回退', () => {
  const memo = A.slice(A.indexOf('const contentRiskAnchor = useMemo'), A.indexOf('// /branch 分叉'));
  assert.match(memo, /riskRewoundSids\[sid\]\) return null/);
  assert.match(memo, /return a && !a\.carryText \? a : null/);
});
t('①b 提示里说明"已回退过一次"', () => {
  assert.match(A, /本会话已自动回退过一次/);
});

// ---- 判官 ②:不注入重试哨兵 ----
t('② continuePrompt 顶掉续跑指令且不注入 tool= 哨兵', () => {
  assert.match(A, /const appendSystemPrompt = opts\.continuePrompt \|\| \[/);
  assert.match(A, /opts\.continuePrompt\s*\n\s*\? `<cgui-tool-retry>\$\{opts\.continuePrompt\}<\/cgui-tool-retry>`/);
  assert.match(A, /continuePrompt: RISK_CONTINUE_PROMPT/);
  // 带 tool= 属性的哨兵只剩既有「工具重做」那一处
  assert.equal(count(A, /<cgui-tool-retry tool="/g), 1);
});

// ---- 判官 ③:先停后 trim ----
t('③ 停止在飞回合早于截断会话文件,且停止有超时兜底', () => {
  const body = A.slice(A.indexOf('const handleRetryTool = useCallback'), A.indexOf('const handleRetryTurnRef = useRef'));
  // r188:停止请求与等待挪进 utils/historyOps.js 的 stopTurnAndWait(带身份、等回话、Promise.race 超时兜底);
  // 这里钉 App 里 await 它早于裁剪,超时兜底钉在 historyOps 里。
  const stopIdx = body.indexOf('await stopTurnAndWait(');
  const trimIdx = body.indexOf("'trim-before-tool'");
  assert.ok(stopIdx > 0 && trimIdx > 0, '两处调用都要在');
  assert.ok(stopIdx < trimIdx, `stop@${stopIdx} 必须早于 trim@${trimIdx}`);
  const HO2 = readFileSync(new URL('../../client/src/utils/historyOps.js', import.meta.url), 'utf8');
  assert.match(HO2, /await Promise\.race\(\[req, new Promise\(\(r\) => \{ timer = setTimeout\(r, maxWaitMs\); \}\)\]\);/);
  assert.match(HO2, /export const STOP_WAIT_MAX_MS = \d{4};/, '等停止上限是秒级常量');
});
t('4.2 退化路径复用既有「重新编辑」', () => {
  assert.match(A, /handleRollbackRef\.current\?\.\([^)]*\{ mode: 'edit' \}/);
});
t('4.2 新开会话三件套带 targetKey(M17)', () => {
  const blk = A.slice(A.indexOf('const newSessionWithLastUser = useCallback'), A.indexOf('const contentRiskAnchor = useMemo'));
  assert.match(blk, /newDraftId\(\)/);
  assert.match(blk, /queueKeyFor\(\{ projectHash/);
  assert.match(blk, /cgui:composer-fill/);
  assert.match(blk, /detail: \{ text: carry, targetKey \}/);
});
t('4.2 两个新回调不装 window 监听、不写全局单值(每窗格隔离)', () => {
  const blk = A.slice(A.indexOf('const runContentRiskRewind = useCallback'), A.indexOf('const contentRiskAnchor = useMemo'));
  assert.equal(count(blk, /window\.addEventListener/g), 0);
});
t('4.2 主动作块内不出现压缩(M11)', () => {
  const blk = A.slice(A.indexOf('const runContentRiskRewind = useCallback'), A.indexOf('const newSessionWithLastUser = useCallback'));
  assert.equal(count(blk, /summarize-after|summarize-before|compact-segment/g), 0);
});
t('4.2 全文件无原生弹窗调用(M14;Tauri 禁用 window.confirm/alert)', () => {
  assert.equal(count(A, /window\.confirm\(/g), 0);
  assert.equal(count(A, /window\.alert\(/g), 0);
  assert.equal(count(A, /(?<![.\w])alert\(/g), 0);
});

// ---- §4.3 计数锁 ----
// r176:errorAction 原为 App.jsx 里恰 6 次(打标 3 + 渲染 3),搬家后拆成三份各自钉死(见下面单独的一条),
// 不再放进这张「App.jsx 内出现次数」表。
t('4.3 计数锁 errorAction:打标 3 + 渲染 3 恰 6 处,App.jsx 接线恰 4 处', () => {
  for (const v of ['content-risk', 'provider', 'repair-official']) {
    assert.equal(AE.split(`? '${v}'`).length - 1, 1, `apiErrorActions.js 里打标「${v}」应恰 1 处`);
    assert.equal(AC.split(`action === '${v}'`).length - 1, 1, `ApiErrorActions.jsx 里渲染「${v}」应恰 1 处`);
  }
  assert.equal(count(AE, /\? '(?:content-risk|provider|repair-official)'/g), 3, '打标总数应恰 3');
  assert.equal(count(AC, /action === '(?:content-risk|provider|repair-official)'/g), 3, '渲染总数应恰 3');
  assert.equal(A.split('errorAction').length - 1, 4, 'App.jsx 的 errorAction 应只剩 4 处接线');
});
const COUNTS = [
  ['trim-before-tool', 1], ['compact-segment', 2],
  // r146b:composer-fill 5→6、newDraftId() 9→10(回退中途切走:留回原会话输入框 / 裁空会话记孤儿),其余不变。
  // r203:+2 首页接收 composer-fill(注册 + 注销)
  ['cgui:composer-fill', 8], ['newDraftId()', 10], ['handleRetryTool', 8],
];
for (const [tok, want] of COUNTS) {
  t(`4.3 计数锁 ${tok} === ${want}`, () => {
    const n = A.split(tok).length - 1;
    assert.equal(n, want);
  });
}
// r120(2026-09-16)对齐真实值:此前的 60~62 是更早轮次人为调高的,与代码实际数量脱节,
// 长期停在红的基线里(0.2.393 上就是红的),等于这条守卫失效。改为按实测锁定:
// 0.2.393 = 63;r120 新增 2 处(大目录拍快照询问、清理回滚点的确认) = 65。
// 2026-09-21 r126 新增 1 处(ProviderManager.removeCustom:删除自定义 provider 被服务端拒绝——如配置文件损坏
// 409 CONFIG_CORRUPT——时显示原因,此前静默吞掉)= 66。
// 2026-11-13 r179 新增 1 处(CustomProviderForm.fetchModels:获取模型被拒时原样显示后端说明——借已保存 Key 而
// 地址改了,400 STORED_KEY_URL_MISMATCH;只带「确定」的说明提示,不是破坏性确认)= 67。
// 以后再加弹窗会红,是设计意图——请复核该弹窗确有必要后同步本数字。
t('4.3 confirmDialog 67(新增弹窗须复核并同步此数)', () => {
  const n = A.split('confirmDialog').length - 1;
  assert.equal(n, 67, `实际 ${n}`);
});
// 注:INTERFACE §4.2 写「window.confirm 0 次」,但改前基线就有 1 次(2973 行的注释
// "不用 window.confirm")。这里锁「调用点 0 次 + 注释仍在」,口径比字面锁更准。
t('4.3 window.confirm 仅存注释一处(基线既有,非本轮引入)', () => {
  assert.equal(count(A, /window\.confirm/g), 1);
  assert.equal(count(A, /window\.confirm\(/g), 0);
});

// ---- §4.4 既有行为回归锁 ----
t('4.4 「工具重做」原文案与隐藏重发逐字仍在(M18)', () => {
  assert.match(A, /请重新执行 \$\{toolCall\.name\} 工具调用/);
  assert.match(A, /<cgui-tool-retry tool=/);
  assert.match(A, /hiddenUserMessage: true/);
});
t('4.4 handleRetryTool 第三参有默认值(既有两个调用点零改动)', () => {
  assert.match(A, /const handleRetryTool = useCallback\(\(turn, toolCall, opts = \{\}\) =>/);
  assert.match(A, /const stableRetryTool = useCallback\(\(turn, toolCall\) => handleRetryToolRef\.current\?\.\(turn, toolCall\), \[\]\)/);
});
t('4.4 乐观截断仍在', () => {
  assert.ok(count(A, /_retryTrimToolId/g) >= 2);
  assert.match(A, /setRetryActiveUuid\(turn\.uuid\)/);
});
t('4.4 停流三件套逐字仍在', () => {
  assert.match(A, /stoppedPidsRef\.current\.add\(String\(_rtPid\)\)/);
  // r188:hard 停止的请求体挪进 utils/historyOps.js 的 stopTurnAndWait;App 里钉按 _rtPid 调它。
  assert.match(A, /await stopTurnAndWait\(\{ pid: _rtPid, owner: _rtOwner, fetchImpl: fetch \}\)/);
  assert.match(readFileSync(new URL('../../client/src/utils/historyOps.js', import.meta.url), 'utf8'), /owner \? \{ hard: true, owner \} : \{ hard: true \}/);
  assert.match(A, /backgroundPidRef\.current = null/);
});
t('4.4 既有两个 errorAction 块逐字仍在', () => {
  // 两块搬进 ApiErrorActions.jsx:msg.errorAction → action,selectedSession?.sessionId → sessionId 属性;
  // 守卫的值由 App.jsx 的 apiErrorActionProps 传入,同处钉住。
  const iP = A.indexOf('const apiErrorActionProps = {');
  assert.ok(iP > 0, '找不到 App.jsx 的 apiErrorActionProps');
  const propsBlk = A.slice(iP, A.indexOf('\n  };', iP) + 5);
  assert.match(AC, /action === 'provider' && !mobileChrome/);
  assert.match(propsBlk, /\n\s+mobileChrome,\n/);
  assert.match(AC, /action === 'repair-official' && sessionId/);
  assert.match(propsBlk, /sessionId: selectedSession\?\.sessionId \|\| null/);
});
t('4.4 错误分支其它自愈判据逐字不变', () => {
  assert.match(A, /usage credits required for 1m context/);
  assert.match(A, /invalid signature in thinking/);
  assert.match(A, /No conversation found/);
  assert.match(A, /payload too large/);
});
t('4.4 handleRollback 签名逐字不变', () => {
  assert.match(A, /const handleRollback = useCallback\(async \(msg, \{ mode, resendText = null, softFiles = false \} = \{\}\) =>/);
});

// ---- TDZ 守卫(memory: cross-component-undefined-ref-whitescreen) ----
t('新回调声明在其引用的 ref 声明之后(防 TDZ 白屏)', () => {
  assert.ok(A.indexOf('const handleRetryToolRef = useRef') < A.indexOf('const runContentRiskRewind = useCallback'));
  assert.ok(A.indexOf('const handleRollbackRef = useRef') < A.indexOf('const runContentRiskRewind = useCallback'));
});
t('渲染块引用的三个标识符都在同一组件内先声明', () => {
  // r176:渲染块搬进 ApiErrorActions.jsx(这三个标识符变成它的 props,组件里不存在先后问题);
  // App.jsx 里引用它们的地方换成 apiErrorActionProps 对象字面量 —— 对象在渲染期求值,等同原来的渲染块。
  // 所以原判据(三个标识符先于渲染块声明)改成:三个标识符先于 apiErrorActionProps 声明、
  // apiErrorActionProps 先于它的第一处 {...apiErrorActionProps} 使用、声明与使用之间没有跨出同一个组件函数。
  const iProps = A.indexOf('const apiErrorActionProps = {');
  const iUse = A.indexOf('{...apiErrorActionProps}');
  assert.ok(iProps > 0, 'apiErrorActionProps 未声明');
  assert.ok(iUse > iProps, 'apiErrorActionProps 必须先声明、后在渲染里使用');
  const propsBlk = A.slice(iProps, A.indexOf('\n  };', iProps) + 5);
  const wiring = {
    runContentRiskRewind: /onContentRiskRewind: runContentRiskRewind,/,
    newSessionWithLastUser: /onNewSessionWithLastUser: newSessionWithLastUser,/,
    contentRiskAnchor: /\n\s+contentRiskAnchor,\n/,
  };
  for (const id of ['runContentRiskRewind', 'newSessionWithLastUser', 'contentRiskAnchor']) {
    const iDecl = A.indexOf(`const ${id} = `);
    assert.ok(iDecl > 0, `${id} 未声明`);
    assert.ok(iDecl < iProps, `${id} 必须先于 apiErrorActionProps 声明(否则渲染期 TDZ 白屏)`);
    assert.match(propsBlk, wiring[id], `apiErrorActionProps 必须引用 ${id}`);
    assert.ok(!/^(?:export default )?function [A-Z]\w*\s*\(/m.test(A.slice(iDecl, iUse)), `${id} 的声明与渲染使用之间跨出了组件`);
  }
});

console.log(`\n[check-r99-dev-wiring] ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
