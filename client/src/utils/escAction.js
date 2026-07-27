// Esc 的会话级语义路由(纯函数,便于单测;副作用全在 App.jsx 的 keydown handler 里)。
//
// 对齐 CLI 2.1.220 的 pty 实测行为:
//   生成中          → 单击即中断(第二击天然落到空闲分支)
//   空闲 + 有文字   → 双击清空输入框
//   空闲 + 输入框空 → 双击打开回退入口(CLI 是 Rewind 选择器,GUI 复用 Checkpoint 时间线)
// 浮层/菜单/权限卡自己在捕获阶段吃掉 Esc,根本走不到这里。

// 双击窗口。CLI 实测在 800–900ms 之间触发,取 800ms(原 GUI 是 600ms,手感偏严)。
export const ESC_DOUBLE_MS = 800;

// 一次 Esc 的落点:'stop'(停当前回合)/ 'arm'(记下这一击,等第二击)/ 'idle-double'。
// lastEscAt=0 表示当前没有待配对的第一击。
export function escRoute({ hasStream, lastEscAt = 0, now = 0 }) {
  if (hasStream) return 'stop'; // 有流永远单击即停,不看双击窗口
  if (!lastEscAt || now - lastEscAt > ESC_DOUBLE_MS) return 'arm';
  return 'idle-double';
}

// 空闲态双击 Esc 干什么:
//   'clear-input'   输入框有字 → 清空(清掉的文本由调用方记住)
//   'restore-input' 输入框已空但刚被 Esc 清过 → 原样填回(壳层没有输入框撤销栈,
//                   ⌘Z 撤不回受控组件的 setText,所以用"再双击一次"当后悔药)
//   'rewind'        真空手 → 打开回退入口
//   'rewind-empty'  会话还没落盘(draft,无 sessionId)→ 没有可回退的点,只提示
export function idleEscAction({ draftText = '', clearedText = '', hasSession = false }) {
  if (String(draftText || '').trim()) return 'clear-input';
  if (String(clearedText || '').trim()) return 'restore-input';
  return hasSession ? 'rewind' : 'rewind-empty';
}

const TYPING_TAGS = new Set(['TEXTAREA', 'INPUT', 'SELECT']);

// 这一击 Esc 要不要让给挂起的权限/计划/越界卡:返回让行的卡片 id(调用方记下来,
// 一张卡只让一击),null = 不让,继续走 escRoute。
// 归属口径:命中本窗格会话的请求 + 无 sessionId 的孤儿(调用方只在活动窗格注册,
// 孤儿只算在活动窗格)。焦点在输入框/下拉里时卡片自己会跳过键盘,那种情况不让行,
// 否则 Esc 两边都没人接 = 哑键。
export function escYieldCardId({ targetTag = null, pendingList = [], psid = null, yieldedForId = null }) {
  if (TYPING_TAGS.has(String(targetTag || '').toUpperCase())) return null;
  const card = (pendingList || []).find((p) => (p.sessionId && p.sessionId === psid) || !p.sessionId);
  if (!card || card.id === yieldedForId) return null;
  return card.id;
}
