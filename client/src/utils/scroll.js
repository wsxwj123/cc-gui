// 会话滚动容器的位置钳位 / 重排后重定位。纯函数,tests/unit/check-scroll-clamp.mjs 单测。

// 把 scrollTop 钳进合法区间。stickToBottom=true(用户没在看历史)直接吸底。
export function clampScrollTop({ scrollTop, scrollHeight, clientHeight, stickToBottom = false }) {
  const max = Math.max(0, (scrollHeight || 0) - (clientHeight || 0));
  if (stickToBottom) return max;
  return Math.min(Math.max(0, scrollTop || 0), max);
}

// 容器【宽度】变化(开/关右侧面板、拖分屏宽、关窗格)后消息会重排,总高随之变化。
// Blink/Gecko 有 scroll anchoring 会自动补偿 scrollTop,WKWebView(Tauri 的 webview,
// 以及 iOS/macOS Safari)没有 —— scrollTop 原地不动而内容整体位移,视口就可能停在两条
// 消息之间的空白处(用户实报"关监控面板后会话区空白,往上滑能找回")。
// 按"看到的是全文的百分之几"把位置搬过去:重排是全局等比的(每条消息都变窄/变宽),
// 比例还原比原样保留 scrollTop 准得多,且不用遍历消息树、零额外 layout 开销。
export function resizeScrollTop({ prevTop, prevMax, scrollHeight, clientHeight, stickToBottom = false }) {
  if (stickToBottom) return clampScrollTop({ scrollTop: 0, scrollHeight, clientHeight, stickToBottom: true });
  // 变化前不可滚动(内容比视口短)→ 没有比例可言,退回纯钳位。
  // prevTop > prevMax = 上限快照已过期(用户上翻后又流式追加了内容,没有滚动事件来刷新它)。
  // 拿过期基准算比例会算出 100% 直接把人扔到底部,那比不动还糟 —— 宁可不动。
  // ponytail: 只做过期自检不做自动刷新;真要更准就得给内容盒也挂一个 ResizeObserver。
  if (!(prevMax > 0) || !Number.isFinite(prevTop) || prevTop > prevMax) {
    return clampScrollTop({ scrollTop: prevTop, scrollHeight, clientHeight });
  }
  const max = Math.max(0, (scrollHeight || 0) - (clientHeight || 0));
  return clampScrollTop({
    scrollTop: Math.round((Math.max(0, prevTop) / prevMax) * max),
    scrollHeight,
    clientHeight,
  });
}
