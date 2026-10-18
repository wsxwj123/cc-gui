// r151h 夹具:让**当前(未修复)代码**也能按接口的 CGUI_STALL_MS 调小静默看门狗阈值,以便同一套用例
// 在修复前 / 修复后都能跑。接口要求"服务端启动时读 CGUI_STALL_MS(合法正整数且 ≥1000 时作为静默阈值)",
// 但修复前代码把静默阈值写死成 300_000ms(仓库里只有这一处 300_000 的定时器);这个 --require 垫片只把
// 这一个 300000ms 的 setTimeout 换成环境变量给的值,不碰任何其它定时器、不识别代码是否修复:
//   - 修复后代码自己读 CGUI_STALL_MS(1500ms),垫片看到的延时不是 300000,什么都不做;
//   - 没设 / 非法 CGUI_STALL_MS 时垫片也不做事(默认 300000 原样保留)。
// 这是夹具层的适配,不是断言;断言仍写死修复后应有的行为。
const raw = Number(process.env.CGUI_STALL_MS);
const ms = Number.isFinite(raw) && raw >= 1000 ? raw : null;
if (ms) {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = function r151hSetTimeout(fn, delay, ...args) {
    if (Number(delay) === 300_000) return realSetTimeout(fn, ms, ...args);
    return realSetTimeout(fn, delay, ...args);
  };
}
