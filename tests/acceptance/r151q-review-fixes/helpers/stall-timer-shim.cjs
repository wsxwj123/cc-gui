// r151q 夹具:只把 300000ms 的那一个定时器改成 R151Q_STALL_TIMER_MS,让"默认阈值(5 分钟)"的看门狗在测试里几秒内触发。
// 不设 CGUI_STALL_MS(服务端因此仍按默认 300000 认为阈值是 5 分钟,提示文案由服务端自己算)。
const ms = Number(process.env.R151Q_STALL_TIMER_MS);
if (Number.isFinite(ms) && ms > 0) {
  const real = global.setTimeout;
  global.setTimeout = function r151qSetTimeout(fn, delay, ...args) {
    return real(fn, Number(delay) === 300_000 ? ms : delay, ...args);
  };
}
