// r207:历史读取的超时,按进展算。
//   普通会话文件:连续 stallMs(15 秒)没有进展才算超时,总时长 totalMs(120 秒)兜底;
//   非普通文件(命名管道等),以及还没确认是普通文件之前:不认进展 = stallMs 硬超时(r171 不变)。
//   进展 = 累计读到的字节比上次算进展时多 ≥ minProgressBytes(64KB),或进入了新的一步。
//   为什么不按「读到字节就算」:每秒只进 1 字节的读法会一直续命到兜底,按 64KB 才算一次。
export const HISTORY_STALL_MS = 15_000;
export const HISTORY_TOTAL_MS = 120_000;
export const HISTORY_PROGRESS_MIN_BYTES = 64 * 1024;

/**
 * 开始计时。onTimeout 至多调用一次(之后 progress / clear 都不再有任何效果)。
 * progress(event):getSessionMessages 的 paging.onProgress 事件 —— { step:'open', regularFile } 先到,
 * 之后 { step, bytes }。clear():读完 / 出错 / 断开时收尾,停掉两个计时器。
 */
export function startHistoryReadDeadline(onTimeout, {
  stallMs = HISTORY_STALL_MS, totalMs = HISTORY_TOTAL_MS, minProgressBytes = HISTORY_PROGRESS_MIN_BYTES,
} = {}) {
  let done = false;
  let regularFile = false;
  let lastStep = null;
  let lastBytes = 0;
  let stallTimer = null;
  let totalTimer = null;
  const stop = () => {
    done = true;
    clearTimeout(stallTimer);
    clearTimeout(totalTimer);
  };
  const fire = () => {
    if (done) return;
    stop();
    onTimeout();
  };
  stallTimer = setTimeout(fire, stallMs);
  totalTimer = setTimeout(fire, totalMs);
  return {
    progress(event) {
      if (done || !event || typeof event !== 'object') return;
      if (event.step === 'open') regularFile = event.regularFile === true;
      if (!regularFile) return;
      let advanced = false;
      if (typeof event.step === 'string' && event.step !== lastStep) {
        lastStep = event.step;
        advanced = true;
      }
      if (Number.isFinite(event.bytes) && event.bytes - lastBytes >= minProgressBytes) {
        lastBytes = event.bytes;
        advanced = true;
      }
      if (!advanced) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(fire, stallMs);
    },
    clear: stop,
  };
}
