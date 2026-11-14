// r185:新会话的会话文件出现后,补发一次与文件监听同型的 file-change。
//
// 装机版以 CGUI_DISABLE_FILE_WATCHER=1 起后端,不监听会话目录;命令行新建的会话文件又不经过任何
// 「改写会话文件的接口」,于是没人发 file-change,侧栏要等这一轮结束(turn-complete)才刷出新会话。
// chat.js 在初始化事件里拿到新会话号后,用这里的 watchNewSessionFile 短间隔看一眼会话文件。
// 拿到会话号的那一刻文件往往还没写出(命令行要过零点几秒,装了插件与钩子时要好几秒),太早广播
// 刷不出来(侧栏按目录里的文件列),所以等文件够列会话的门槛了再发,只发一次。
import { open } from 'node:fs/promises';

// 与列会话的门槛同口径:session-reader 的 listSessions 不列 totalLines < 3 的会话文件。
export const LISTABLE_MIN_LINES = 3;

const READ_CHUNK = 64 * 1024;
// trim() 会去掉的 ASCII 空白(换行另算)。只含空白的行不计数,与 session-profile 的 totalLines 一致。
const ASCII_BLANK = new Set([0x20, 0x09, 0x0b, 0x0c, 0x0d]);

/**
 * 数文件里的非空行,数到 cap 即停,不必读完整个文件。口径与 session-profile 的 totalLines 一致:
 * 只含空白的行不算,末尾没换行的半行算。文件不存在或打不开返回 0(调用方当作「还没好」)。
 */
export async function countNonEmptyLinesUpTo(filePath, cap) {
  if (!(cap > 0)) return 0;
  let fh;
  try { fh = await open(filePath, 'r'); } catch { return 0; }
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    let count = 0;
    let lineHasContent = false;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i++) {
        const b = buf[i];
        if (b === 0x0a) {
          if (lineHasContent && ++count >= cap) return count;
          lineHasContent = false;
        } else if (!lineHasContent && !ASCII_BLANK.has(b)) {
          lineHasContent = true;
        }
      }
    }
    return lineHasContent ? count + 1 : count;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * 盯一个新会话的会话文件:立刻看一次,之后每 intervalMs 看一次;文件找到且至少 minLines 个非空行,
 * 就调一次 onReady(文件路径)并停。超过 timeoutMs 仍不够就停,不调用(回合结束的广播照旧兜底)。
 * locate(sessionId) 返回文件路径或 null(生产用 session-reader 的 findSessionFile),找到后不再重找。
 * 返回 { stop }:回合结束、进程收尾时调用;停掉之后不留定时器,正在进行的那次检查结果也作废。
 */
export function watchNewSessionFile({
  sessionId, locate, onReady,
  minLines = LISTABLE_MIN_LINES, intervalMs = 300, timeoutMs = 30000,
}) {
  const deadline = Date.now() + timeoutMs;
  let stopped = false;
  let timer = null;
  let filePath = null;
  const stop = () => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  };
  const check = async () => {
    timer = null;
    let ready = false;
    try {
      if (!filePath) filePath = (await locate(sessionId)) || null;
      if (filePath) ready = (await countNonEmptyLinesUpTo(filePath, minLines)) >= minLines;
    } catch {
      // 这一次找不到 / 读不了就当还没好,下一次再看;到上限仍不行就放弃,不影响回合本身。
    }
    if (stopped) return;
    if (ready) {
      stop();
      // 检查是丢出去不等的异步任务,回调抛错不能变成未处理的拒绝(会掀翻后端进程),记日志即可。
      try { onReady(filePath); } catch (e) { console.error('[chat] new-session file notice failed:', e?.message || e); }
      return;
    }
    const left = deadline - Date.now();
    if (left <= 0) { stop(); return; }
    timer = setTimeout(check, Math.min(intervalMs, left));
  };
  void check();
  return { stop };
}
