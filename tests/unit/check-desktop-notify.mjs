#!/usr/bin/env node
// 批L L2:OS 系统通知。
// 回归对象:人不在 GUI 前面时,后台代理卡在授权/表单请求没人知道 —— 角标只在你看着
// 界面时有用。加了通知就必须同时防轰炸,否则一个刷屏的会话能把通知中心塞满,用户会
// 直接在系统设置里把本应用的通知关掉(那比不发还糟)。
//
// 防轰炸与门控是纯逻辑,这里真 import 跑;时钟由 now 注入(不 sleep)。平台侧
// (capability / 插件注册 / 依赖)与接线点靠源码守卫钉住。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  planNotification, resetNotifyState, maybeNotify, newWaitingKeys,
  permissionNotice, desktopNotifyEnabled, NOTIFY_PREF_KEY,
} from '../../client/src/utils/desktopNotify.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIN = 60_000;
// 基线时间刻意不取 0:合并条的"一分钟一条"节流若用 0 当初值,任何真实时钟下第一条
// 合并通知都发不出来(now - 0 < 60000 恒不成立才对)。
const T0 = 1_700_000_000_000;
const plan = (o) => planNotification({ enabled: true, focused: false, ...o });

// ── 1. 门控:开关关 / 窗口在前台 / 没有 key ────────────────────────────────
{
  resetNotifyState();
  assert.equal(plan({ key: 'a:permission', title: 't', body: 'b', now: T0, enabled: false }), null,
    '开关关了一条都不发');
  assert.equal(plan({ key: 'a:permission', title: 't', body: 'b', now: T0, focused: true }), null,
    '窗口在前台不发 —— 你正看着 GUI,系统通知只会碍事');
  assert.equal(plan({ key: '', title: 't', body: 'b', now: T0 }), null, '没有 key 就没法去重,不发');
  // 被门控挡掉的尝试不能占用限流额度,否则关着开关跑一会儿,一开开关就"已超额"
  assert.deepEqual(plan({ key: 'a:permission', title: 't', body: 'b', now: T0 }), { title: 't', body: 'b' },
    '门控挡掉的不计入限流');
}

// ── 2. 去重:同一件事 60s 内只发一次 ──────────────────────────────────────
{
  resetNotifyState();
  assert.deepEqual(plan({ key: 'sid1:permission', title: '等待授权', body: 'Bash', now: T0 }),
    { title: '等待授权', body: 'Bash' }, '第一条照发');
  assert.equal(plan({ key: 'sid1:permission', title: '等待授权', body: 'Bash', now: T0 + 59_999 }), null,
    '同一 key 差一毫秒不到 60s,仍算同一件事');
  assert.deepEqual(plan({ key: 'sid1:permission', title: '等待授权', body: 'Bash', now: T0 + MIN }),
    { title: '等待授权', body: 'Bash' }, '满 60s 可以再发');
  // 不同 key(同会话不同类型 / 不同会话)互不影响
  resetNotifyState();
  plan({ key: 'sid1:permission', title: 't', body: 'b', now: T0 });
  assert.ok(plan({ key: 'sid1:elicitation', title: 't', body: 'b', now: T0 }), '同会话不同类型是两件事');
  assert.ok(plan({ key: 'sid2:permission', title: 't', body: 'b', now: T0 }), '不同会话是两件事');
}

// ── 2b. 去重基准必须是"上次真发出去的时间",不是"上次尝试的时间" ──────────
// 用尝试当基准的话,每 30s 来一次的同一件事永远落在上一次尝试的 60s 阴影里,一辈子
// 发不出第二条(静默失效,最难发现的那种)。
{
  resetNotifyState();
  assert.ok(plan({ key: 'k:permission', title: 't', body: 'b', now: T0 }), '第 0 秒发出');
  assert.equal(plan({ key: 'k:permission', title: 't', body: 'b', now: T0 + 30_000 }), null, '第 30 秒被去重');
  assert.ok(plan({ key: 'k:permission', title: 't', body: 'b', now: T0 + 61_000 }),
    '第 61 秒必须能发 —— 距上次【发出】已超 60s,中间那次被丢弃的尝试不能续期');
}

// ── 3. 限流:60s 内最多 3 条,超出合并成一条 ───────────────────────────────
{
  resetNotifyState();
  for (let i = 1; i <= 3; i++) {
    assert.ok(plan({ key: `s${i}:permission`, title: 't', body: `b${i}`, now: T0 + i }), `第 ${i} 条在额度内`);
  }
  const merged = plan({ key: 's4:permission', title: 't', body: 'b4', now: T0 + 4 });
  assert.ok(merged, '第 4 条要有东西发,不能整条吞掉(用户会以为没事)');
  assert.ok(/^\d+ 个会话在等待处理/.test(merged.body), `合并条正文要报数,实际:${merged.body}`);
  assert.equal(merged.body.split(' ')[0], '4', '数的是本窗口内出现过的不同 key 数');
  assert.notEqual(merged.body, 'b4', '合并条不是第 4 条的原文');

  const later = plan({ key: 's5:permission', title: 't', body: 'b5', now: T0 + 5 });
  assert.equal(later, null, '合并条一分钟只发一条,同窗口内更晚到的不再触发新通知');
  // 一分钟内的上限:3 条个别 + 1 条合并
  assert.equal(plan({ key: 's6:permission', title: 't', body: 'b6', now: T0 + 59_000 }), null);

  // 窗口滚过去后额度回来
  const after = plan({ key: 's7:permission', title: 't', body: 'b7', now: T0 + MIN + 10 });
  assert.deepEqual(after, { title: 't', body: 'b7' }, '滚出 60s 窗口后恢复个别通知');
}

// ── 3b. 持续刷屏:每分钟稳定 3 条个别 + 1 条合并,不会一路吞光 ─────────────
{
  resetNotifyState();
  let individual = 0; let mergedCount = 0;
  for (let i = 0; i < 60; i++) {           // 3 分钟,每 3 秒一件新事
    const r = plan({ key: `x${i}:permission`, title: 't', body: `b${i}`, now: T0 + i * 3_000 });
    if (!r) continue;
    if (/个会话在等待处理/.test(r.body)) mergedCount++; else individual++;
  }
  assert.ok(individual >= 6 && individual <= 12, `个别通知应随窗口滚动恢复,实际 ${individual}`);
  assert.ok(mergedCount >= 2 && mergedCount <= 4, `合并条约每分钟一条,实际 ${mergedCount}`);
  assert.ok(individual + mergedCount <= 16, `3 分钟总量必须被压住,实际 ${individual + mergedCount}`);
}

// ── 3c. 为什么"重放已知卡不发通知"必须在入口挡,不能指望 60s 去重 ──────────
// 心跳每 25s 无条件对账(refetchPendingPermissions),会把服务端所有 pending 项重放进
// handlePermissionRequest。一张没人处理的卡每轮都在、每轮都重放,而 60s 去重只压得住
// 两轮 —— 第 75 秒那轮就过期了。下面用真实时钟节拍证明:防轰炸【兜不住】这个节奏,
// 所以 addCard 必须按"store 里已有同 id"直接不发(见第 8 组守卫)。
{
  resetNotifyState();
  const key = 'sid:permission';
  const fired = [];
  for (let t = 0; t <= 200_000; t += 25_000) {         // 25s 心跳,同一张卡一直没被处理
    if (plan({ key, title: '等待授权', body: 'Bash', now: T0 + t })) fired.push(t / 1000);
  }
  assert.deepEqual(fired, [0, 75, 150], '去重只挡到 50s,第 75/150 秒各会重发一条 —— 这正是要在入口挡掉的原因');
}

// ── 4. maybeNotify 的真实门控(hasFocus + 开关)────────────────────────────
// 真调 maybeNotify,靠注入 globalThis 的 document / localStorage 打桩。返回值就是它
// 决定要发的内容,不发返回 null。
{
  const notice = { key: 'sid:permission', title: '等待授权', body: 'Bash' };
  let focused = true;
  let pref = null;
  globalThis.document = { hasFocus: () => focused };
  globalThis.localStorage = { getItem: (k) => (k === NOTIFY_PREF_KEY ? pref : null) };

  resetNotifyState();
  assert.equal(maybeNotify(notice), null, '窗口在前台:不发');
  focused = false;
  assert.deepEqual(maybeNotify(notice), { title: '等待授权', body: 'Bash' }, '窗口不在前台:发');

  resetNotifyState();
  pref = '0';
  assert.equal(desktopNotifyEnabled(), false, '开关存 "0" = 关');
  assert.equal(maybeNotify(notice), null, '开关关掉:不发');
  pref = null;
  assert.equal(desktopNotifyEnabled(), true, '没存过 = 默认开(新装用户就该收到)');
  assert.ok(maybeNotify(notice), '默认开:发');
  assert.equal(maybeNotify(null), null, '空输入不炸');

  delete globalThis.document;
  delete globalThis.localStorage;
  resetNotifyState();
  // 没有 document(非浏览器环境)时按"在前台"处理:宁可少发,不可乱发
  assert.equal(maybeNotify(notice), null, '拿不到焦点状态时不发');
}

// ── 5. 上升沿:1.5s 轮询下不能按水平值重发 ────────────────────────────────
{
  resetNotifyState();
  assert.deepEqual(newWaitingKeys('a,b'), ['a', 'b'], '首轮出现的都是新的');
  assert.deepEqual(newWaitingKeys('a,b'), [], '同一批持续等待,不重发(否则每 1.5s 一条)');
  assert.deepEqual(newWaitingKeys('a,b,c'), ['c'], '只报新出现的那个');
  assert.deepEqual(newWaitingKeys('c'), [], '有条目消失不算新事件');
  assert.deepEqual(newWaitingKeys('a'), ['a'], '消失后再出现 = 一次新的等待事件');
  assert.deepEqual(newWaitingKeys(''), [], '清空不报');
  assert.deepEqual(newWaitingKeys(null), [], '拿不到数据不炸');
  assert.deepEqual(newWaitingKeys('?,?'), ['?'], '无 sessionId 的占位不重复');
}

// ── 6. 卡片类型 → 通知文案 ────────────────────────────────────────────────
{
  const perm = permissionNotice({ toolName: 'Bash', sessionId: 'sid1', cwd: '/Users/x/proj' });
  assert.equal(perm.key, 'sid1:permission');
  assert.equal(perm.title, '等待授权');
  assert.ok(perm.body.includes('Bash') && perm.body.includes('proj'), '正文要带工具名与会话线索');

  const eli = permissionNotice({ kind: 'elicitation', serverName: 'paper-search', sessionId: 'sid1', cwd: '/a/b' });
  assert.equal(eli.key, 'sid1:elicitation');
  assert.equal(eli.title, 'MCP 请求输入');
  assert.ok(eli.body.includes('paper-search'), '正文要带 MCP 服务器名');

  assert.equal(permissionNotice({ kind: 'dialog', sessionId: 'sid1' }).title, 'Claude 需要你的选择');
  assert.equal(permissionNotice({ toolName: 'AskUserQuestion', sessionId: 'sid1' }).key, 'sid1:ask');
  assert.equal(permissionNotice({ toolName: 'ExitPlanMode', sessionId: 'sid1' }).key, 'sid1:plan');
  // draft(还没落盘的新会话)没有 sessionId,不能让 key 变成 'undefined:permission' 之外的东西:
  // 只要稳定即可,重点是不同类型仍分得开
  assert.equal(permissionNotice({ toolName: 'Bash' }).key, 'draft:permission');
  assert.equal(permissionNotice(null), null, '空输入不炸');
  // Windows 的 cwd 是反斜杠路径:只按 / 切会把整条路径当成最后一段
  assert.ok(permissionNotice({ toolName: 'Bash', cwd: 'C:\\Users\\x\\proj' }).body.includes('(proj)'),
    '反斜杠路径也要取到项目名');
  assert.ok(!permissionNotice({ toolName: 'Bash' }).body.includes('('), '没有 cwd 就不带空括号');
}

// ── 7. 平台事实守卫(照调研实锤,别按直觉改回去)──────────────────────────
{
  const util = readFileSync(join(root, 'client/src/utils/desktopNotify.js'), 'utf8');
  const code = util.replace(/^\s*\/\/.*$/gm, ''); // 注释里会提到这些名字,只查真代码
  assert.ok(!/isPermissionGranted\s*\(/.test(code),
    '不许调 isPermissionGranted():桌面端硬编码恒返回 granted,用户在系统设置关了也返回 true');
  assert.ok(!/Notification\.permission/.test(code),
    '不许读 window.Notification.permission:Windows 上插件无条件把它设成 denied(上游 bug)');
  assert.ok(!/onAction\s*\(/.test(code),
    '不许接通知点击回调:桌面端没注册该命令,会报 Command not found');
  assert.ok(/import\('@tauri-apps\/plugin-notification'\)/.test(code), '插件走动态 import(浏览器/手机端没有它)');
  assert.ok(/\.catch\(\(\) => \{\}\)/.test(code), '发不出去必须静默降级 —— 通知失败不能影响主流程');
}

// ── 8. 接线守卫 ──────────────────────────────────────────────────────────
{
  const ws = readFileSync(join(root, 'client/src/hooks/useWebSocket.js'), 'utf8');
  assert.ok(/import \{ maybeNotify, permissionNotice \} from '\.\.\/utils\/desktopNotify\.js'/.test(ws));
  assert.ok(/function addCard\(req\) \{\s*const known = useStore\.getState\(\)\.pendingPermissions\.some\(\(p\) => p\.id === req\.id\);\s*if \(!known\) maybeNotify\(permissionNotice\(req\)\);\s*useStore\.getState\(\)\.addPendingPermission\(req\);/.test(ws),
    '弹卡与发通知必须在同一个入口(否则新增分支漏通知),且【只对表里还没有的卡】发 —— '
    + '25s 心跳对账会把未处理的卡一轮轮重放进来,不挡住就每 75s 重发一条(见第 3c 组)');
  // 判据必须是 store 里有没有这张卡,不能拿 inFlightResponds 顶替:那个守卫只挡"提交中"
  // 的卡,挡不住"已入表、用户还没点"的卡 —— 后者恰恰是会被重放的那批。
  assert.ok(/const known = useStore\.getState\(\)\.pendingPermissions\.some/.test(ws),
    '重放判据取 store 里是否已有同 id');
  const handler = ws.slice(ws.indexOf('function handlePermissionRequest'), ws.indexOf('function addCard'));
  assert.equal((handler.match(/addPendingPermission\(/g) || []).length, 0,
    'handlePermissionRequest 里不许再直接入表 —— 绕过 addCard 就没有通知');
  assert.equal((handler.match(/addCard\(req\)/g) || []).length, 2, '危险命令卡与普通卡两条入表分支都要走 addCard');
  assert.ok(/respondPermission\(req\.id, \{ decision: 'allow' \}\);\s*\n\s*return;/.test(handler),
    '白名单自动放行分支不入表也不发通知(用户不需要知道 = 纯噪音)');

  const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  assert.ok(/import \{ notifyWaiting \} from '\.\/utils\/desktopNotify\.js'/.test(app));
  assert.ok(/useEffect\(\(\) => \{ notifyWaiting\(waitingKeys\); \}, \[waitingKeys\]\)/.test(app),
    '依赖必须是等待集合本身(上升沿在 notifyWaiting 内部判);挂到计数上会漏掉"一个走一个来"');
  // 批L1 的角标链路不许被这批改动(同一段代码)
  assert.ok(/useEffect\(\(\) => \{ applyAttentionBadge\(attentionCount\); \}, \[attentionCount\]\)/.test(app),
    '角标下发保持原样');
  assert.ok(/setWaitingKeys\(waitingSessionKeys\(d\.agents\)\)/.test(app), '复用同一条 /agents/active 轮询,不另起');

  const sp = readFileSync(join(root, 'client/src/components/SettingsPanel.jsx'), 'utf8');
  assert.ok(/id: 'set-desktop-notify', tab: 'general'/.test(sp), '开关要能被设置搜索找到');
  assert.ok(/<div id="set-desktop-notify"><DesktopNotifyToggle \/><\/div>/.test(sp), '开关挂在通用 tab');
  assert.ok(/localStorage\.setItem\(NOTIFY_PREF_KEY, v \? '1' : '0'\)/.test(sp), '开关与 desktopNotify 读的是同一个键');
}

// ── 9. Tauri 侧:插件 + capability + 依赖 ─────────────────────────────────
{
  const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
  assert.ok(/^tauri-plugin-notification = "2"$/m.test(cargo), 'Rust 侧插件依赖');
  const lib = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8');
  assert.ok(/\.plugin\(tauri_plugin_notification::init\(\)\)/.test(lib), '插件必须挂进 builder,否则命令不存在');

  const cap = JSON.parse(readFileSync(join(root, 'src-tauri/capabilities/notification.json'), 'utf8'));
  assert.ok(cap.permissions.includes('notification:default'), '缺权限 = 运行时被 ACL 拒');
  assert.deepEqual(cap.windows, ['main']);
  // 生产 webview 加载 http://127.0.0.1:<port>,属 remote 上下文:不列 remote.urls 权限不生效
  const dialog = JSON.parse(readFileSync(join(root, 'src-tauri/capabilities/dialog.json'), 'utf8'));
  assert.deepEqual(cap.remote?.urls, dialog.remote.urls, 'remote.urls 必须与 dialog.json 的端口列表一致(6677..6687)');

  const pkg = JSON.parse(readFileSync(join(root, 'client/package.json'), 'utf8'));
  assert.ok(pkg.dependencies['@tauri-apps/plugin-notification'], 'JS 侧插件包要进 dependencies(不是 devDependencies)');
}

console.log('✓ check-desktop-notify: 门控 + 去重 + 限流合并 + 上升沿 + 文案 + 接线 + capability 全过');
