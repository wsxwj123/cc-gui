#!/usr/bin/env node
// r49b①(B1 前端半)守卫:切档被 CLI 拒绝时【档位回滚 + 原文可见 + 不空转重试】。
//
// 原实现的判据是 `delivered = r.ok || r.status === 400`,服务端又对任何情况恒 200 ok:true
// —— 于是"被 guard 拒"与"切成功"在前端完全无法区分:界面停在新档、用户以为已生效。
// 服务端改回 409 之后,前端必须:
//   ① 409 = 终态(重试自愈不了,别再打了)+ 把档位回滚到切换前的值 + 透出 CLI 原文;
//   ② 该会话此前没有 per-session 档位时,回滚 = 删掉这一条(回到全局默认),不许留新档;
//   ③ 200 且 attempted:0(会话闲置、没有在跑的进程)= 正常收敛,不许当失败无限重试
//      —— 这是"判据补 delivered>0"字面照做会踩的坑:闲置会话切档会空转到 5 分钟上限;
//   ④ 200 部分成功(delivered>0 且 failed 非空)= 不回滚,但把失败原文报出来。
// 真实链路:store.setPermissionMode → postPermissionMode(注入假 fetch)。
import assert from 'node:assert/strict';

// 浏览器全局垫片(store 模块加载所需)
const lsData = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsData.has(k) ? lsData.get(k) : null),
  setItem: (k, v) => lsData.set(k, String(v)),
  removeItem: (k) => lsData.delete(k),
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, removeEventListener() {} };

const { useStore } = await import('../../client/src/stores/sessionStore.js');

const GUARD_ERROR = 'Cannot set permission mode to auto: not supported for model claude-opus-4-5';
const calls = [];
let modeReply = null;
globalThis.fetch = (url, opts) => {
  calls.push({ url: String(url), opts });
  if (String(url).includes('/chat/permission-mode')) return modeReply();
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
};
const modeCalls = (sid) => calls.filter((c) => c.url.includes('/chat/permission-mode')
  && JSON.parse(c.opts.body).sessionId === sid);
const reply = (status, body) => () => Promise.resolve({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ① 有旧档 → 409 回滚到旧档 + 原文 + 只发一次
modeReply = reply(200, { ok: true, attempted: 1, delivered: 1, failed: [] });
useStore.getState().setPermissionMode('acceptEdits', 'sid-m1');
await wait(30);
modeReply = reply(409, { ok: false, attempted: 1, delivered: 0, error: GUARD_ERROR, failed: [{ sessionId: 'sid-m1', error: GUARD_ERROR }] });
useStore.getState().setPermissionMode('auto', 'sid-m1');
assert.equal(useStore.getState().getPermissionModeFor('sid-m1'), 'auto', '①点选当刻先乐观显示新档');
await wait(1300); // 越过第一次重试退避(1s):被拒后不许再打
assert.equal(useStore.getState().getPermissionModeFor('sid-m1'), 'acceptEdits',
  '①被 CLI 拒绝后档位必须回滚到切换前的值(否则界面与 CLI 生效档分叉)');
assert.equal(modeCalls('sid-m1').length, 2, '①409 是终态:除去铺垫那次,被拒后不得重试');
const notice = useStore.getState().permissionModeNotice;
assert.equal(notice?.key, 'sid-m1', '①提示要挂在出问题的那个会话上(分屏下不串窗格)');
assert.ok(notice.text.includes(GUARD_ERROR), '①提示要原样透出 CLI 错误原文,不做语义翻译');

// ② 此前没有 per-session 档位 → 回滚 = 删除该条(回全局默认),不留新档
useStore.getState().setPermissionMode('auto', 'sid-m2');
await wait(1300);
assert.ok(!('sid-m2' in useStore.getState().permissionModeBySession),
  '②原本没有会话级档位时,回滚应删掉这一条而不是写死成某一档');

// ③ 闲置会话(attempted:0)照常收敛,不重试、不回滚、不报警
calls.length = 0;
useStore.getState().clearPermissionModeNotice();
modeReply = reply(200, { ok: true, attempted: 0, delivered: 0, failed: [] });
useStore.getState().setPermissionMode('plan', 'sid-m3');
await wait(1300);
assert.equal(modeCalls('sid-m3').length, 1, '③没有在跑的进程 = 无需送达,不是失败,只许发一次');
assert.equal(useStore.getState().getPermissionModeFor('sid-m3'), 'plan', '③闲置会话切档照常生效');
assert.equal(useStore.getState().permissionModeNotice, null, '③闲置不报警');

// ④ 部分成功:不回滚,但失败原文要报出来
modeReply = reply(200, { ok: true, attempted: 2, delivered: 1, failed: [{ sessionId: 'sid-m4', error: GUARD_ERROR }] });
useStore.getState().setPermissionMode('auto', 'sid-m4');
await wait(1300);
assert.equal(useStore.getState().getPermissionModeFor('sid-m4'), 'auto', '④有 slot 收下了就不回滚');
assert.ok(useStore.getState().permissionModeNotice?.text.includes(GUARD_ERROR), '④部分失败也要把原文报出来');
assert.equal(modeCalls('sid-m4').length, 1, '④200 是终态,不重试');

// ── 提示的落地位置:档位选择器旁的即时反馈(与思考力度回落 toast 同一形态)──────
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const inputSrc = readFileSync(join(ROOT, 'client', 'src', 'components', 'ChatInput.jsx'), 'utf8');
assert.equal((inputSrc.match(/s\.permissionModeNotice/g) || []).length, 1,
  '档位选择器读 store 的提示,恰好一处');
assert.ok(/clearPermissionModeNotice/.test(inputSrc), '提示要能自清,不许永久占屏');
assert.ok(/modeNotice\.key === permKey/.test(inputSrc), '只在出问题的那个窗格显示');

// ⑤ 409 在途竞态(判官r49b重要项):等 409 期间用户又切了新档 → 不许回滚覆盖第二次
// 意图,必须转而补发最新档。原实现 409 直接 return,把在途合并进 latestMode 的 plan
// 一并吞掉且回滚成 prevMode —— 用户第二次选择凭空消失。
calls.length = 0;
useStore.getState().clearPermissionModeNotice();
modeReply = reply(200, { ok: true, attempted: 1, delivered: 1, failed: [] });
useStore.getState().setPermissionMode('acceptEdits', 'sid-m5'); // 铺垫旧档
await wait(30);
let releaseGate;
const gate = new Promise((r) => { releaseGate = r; });
let gated = true;
modeReply = () => {
  if (gated) {
    gated = false; // 只有第一发(auto)被闸住回 409;补发(plan)走 200
    return gate.then(() => ({ ok: false, status: 409, json: async () => ({
      ok: false, attempted: 1, delivered: 0, error: GUARD_ERROR,
      failed: [{ sessionId: 'sid-m5', error: GUARD_ERROR }] }) }));
  }
  return Promise.resolve({ ok: true, status: 200,
    json: async () => ({ ok: true, attempted: 1, delivered: 1, failed: [] }) });
};
useStore.getState().setPermissionMode('auto', 'sid-m5');  // 第一发,在途被闸
await wait(30);
useStore.getState().setPermissionMode('plan', 'sid-m5');  // 在途期间的第二次切档
await wait(30);
releaseGate();                                            // 409 此刻才到达
await wait(120);
assert.equal(useStore.getState().getPermissionModeFor('sid-m5'), 'plan',
  '⑤409 到达时已有更新的目标档,不许回滚覆盖用户第二次选择');
const m5 = modeCalls('sid-m5');
assert.equal(m5.length, 3, '⑤铺垫+auto+补发 plan 恰好三发(409 不回滚也不算终态,要补发)');
assert.equal(JSON.parse(m5[2].opts.body).mode, 'plan', '⑤补发的必须是最新档 plan');

console.log('✓ check-mode-switch-rollback: 409 回滚+原文+不重试 / 无旧档删条 / 闲置不空转 / 部分失败报警 / 在途竞态补发 全部通过');
process.exit(0);
