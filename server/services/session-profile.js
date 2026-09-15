// 会话/子代理 jsonl 的**扫描器**:只做 I/O + 行数计数 + 增量闸门。
//
// 分工红线(INTERFACE §B.1):**画像字段的派生不在这里** —— 那是 session-reader.js 的
// deriveProfile(全量) / applyIncremental(增量) 两个导出。本模块对「画像里有什么字段」
// 零知识:它只回答「这个文件有多少非空行、完整行到哪个字节、头尾窗口是哪些原始行、
// 头窗口是否已满、以及本次能不能只扫新增区段」。这样派生实现只有一份,不存在慢慢跑偏
// 的第二份副本。
//
// 语义基准 = 今天 server/utils/jsonl-parser.js 的 readJsonlEdges(本批不改它):
//   · 非空行(!line.trim())才计数;坏行计(JSON.parse 失败只在 head 收集时丢)
//   · head = 前 N 条**可解析**记录(坏行不占名额)
//   · tailRaw = 最后 N 条**非空原始行**(坏行占名额)——与 readTailWindow 逐字同口径
//   · 行尾 \r 去掉(同 readline 的 crlfDelay:Infinity)
import { createHash } from 'crypto';
import { open } from 'fs/promises';
import { readBytesAt, readTailWindow, newLineBreaker } from '../utils/jsonl-parser.js';

export const PROFILE_VERSION = 1;

const HEAD_SIZE = 40;      // 会话边窗口(head/tailRaw 各 40 条),= 今天的 edgeSize 40
const HEAD10 = 10;         // listProjects 的 cwd10 只需要前 10 条可解析记录
const CHUNK = 1 << 20;     // 顺序读块
const HEAD_CHUNK = 64 << 10; // head10 的块:读满即收工,别为一个 cwd 拉 1MB
const ANCHOR_BYTES = 4096; // 前缀锚点窗口

/**
 * 逐块读 [start, end) 的字节,按 0x0A 切行,按文件顺序回调 onLine(text, startOff, nlOff)。
 *   · text    行内容(不含 \n,行尾 \r 已去掉)
 *   · startOff 该行首字节的绝对偏移
 *   · nlOff   终止该行的 0x0A 绝对偏移;文件末尾没有 \n 的尾段 → -1
 * 按 0x0A 切是 UTF-8 安全的:0x0A 不可能出现在多字节序列内部,故行首必是字符边界;
 * 解码只对**完整行**做,跨块的半个字符永远不会被解码。
 * onLine 返回 false → 提前收工(调用方只读头时用)。
 * 读失败原样抛出(调用方按 §B.1 的错误语义处理)。
 */
async function eachLine(filePath, start, end, chunkBytes, onLine) {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    let pending = Buffer.alloc(0); // 左端未定界的片段(其起点在更前面)
    let pendingOff = start;        // pending 的绝对起点 = 本块拼成的 region 的起点
    let pos = start;
    while (pos < end) {
      const want = Math.min(chunkBytes, end - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (!bytesRead) break;
      // region = 上一块遗留的未定界片段 + 本块,所以 region[0] 的绝对偏移是 pendingOff
      // (不是本块的 pos —— 早先写成 base=pos 时,只要有一行跨块,后面所有行的偏移就整体偏了)
      const regionBase = pendingOff;
      pos += bytesRead;
      const region = pending.length ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const breaker = newLineBreaker(region);
      let p = 0;
      let stopped = false;
      for (;;) {
        const br = breaker.next(p);
        if (!br) break;
        // maybeAt:尾部字节不足以判定是不是被截断的 U+2028/U+2029 → [p, end) 整段留给下一块
        if (br.maybeAt !== undefined) break;
        if (onLine(region.subarray(p, br.at).toString('utf-8'), regionBase + p, regionBase + br.at) === false) { stopped = true; break; }
        p = br.next;
      }
      if (stopped) return;
      pendingOff = regionBase + p;
      pending = p >= region.length ? Buffer.alloc(0) : Buffer.from(region.subarray(p));
    }
    // 文件末没有断行符的尾段也算一行(与 readline 一样)
    if (pending.length) onLine(pending.toString('utf-8'), pendingOff, -1);
  } finally {
    await fh.close();
  }
}

/** [completeOffset-4KB, completeOffset) 的 sha1 hex;completeOffset=0 → 空串(§A.1)。 */
async function anchorOf(filePath, completeOffset) {
  if (!completeOffset) return '';
  const len = Math.min(ANCHOR_BYTES, completeOffset);
  const buf = await readBytesAt(filePath, completeOffset - len, len);
  return createHash('sha1').update(buf).digest('hex');
}

/**
 * 增量闸门(§B.2,全真才走增量;任何一条不满足 = 全量重扫 —— I3 只许慢,不许错)。
 * 任一条「取不到判据」(ino 非正数、锚点读失败)一律 fail-closed 返回 false。
 */
async function canIncremental(filePath, st, prev) {
  if (!prev) return false;                                        // G-a
  if (prev.v !== PROFILE_VERSION || prev.level !== 'full') return false; // G-a
  if (typeof st.ino !== 'number' || !(st.ino > 0) || prev.ino !== st.ino) return false; // G-b
  if (!(st.size > prev.size)) return false;                        // G-c:size 回退/不变 → 全量
  if (prev.headFull !== true) return false;                        // G-e
  if (typeof prev.completeOffset !== 'number' || !(prev.completeOffset >= 0) || prev.completeOffset > st.size) return false; // G-f 前半
  if (typeof prev.anchorHash !== 'string') return false;
  let anchor;
  try { anchor = await anchorOf(filePath, prev.completeOffset); } catch { return false; } // G-f 后半:读不到 = 不敢增量
  return anchor === prev.anchorHash;
}

function newAcc() {
  return { boundaryUuids: [], titles: { customTitle: '', aiTitle: '' } };
}

/**
 * 扫描一个 jsonl,返回 Artifacts(§B.1)。**不认识画像字段**:它只交出「原始行窗口 + 计数」,
 * 由 session-reader.js 的派生函数决定这些行意味着什么。
 *
 * @param {string} filePath
 * @param {fs.Stats} st       调用方在读之前取的 stat(基准快照)
 * @param {object|null} prev  上一次该文件的画像(可能已过期;本函数按 §B.2 自行判定)
 * @param {{ need?: 'head10'|'full', onRawLine?: Function, seed?: object }} [opts]
 *        onRawLine 由 session-reader.js 注入(与今天 listSessions 里那个闭包同签名:
 *        onRawLine(raw, boundaryUuids, titles));扫描器只负责「原样喂给它」,边界/标题
 *        的判定逻辑不在本模块里实现。
 *        seed 只有**增量路径**会用到:边界/标题的累加器从 prev 的已有值起算(前缀 + 新区段)。
 */
export async function scanProfile(filePath, st, prev, opts = {}) {
  const need = opts.need === 'head10' ? 'head10' : 'full';
  const onRawLine = typeof opts.onRawLine === 'function' ? opts.onRawLine : null;
  const feedFor = (acc) => (onRawLine ? (line) => onRawLine(line, acc.boundaryUuids, acc.titles) : null);
  const size = st.size;

  if (need === 'full' && await canIncremental(filePath, st, prev)) {
    // ── 增量:只扫 [prev.completeOffset, size) 的新增区段 + 从 EOF 回读尾部窗口 ──
    // 区间必从行首开始(0x0A 的下一字节必是 UTF-8 边界),旧尾行落在区间内被重数一次
    // 且仅一次;head 派生字段一律由调用方从 prev 继承(闸门 G-e 保证头窗口已满)。
    // 累加器**只有这一条路径**才从 prev 播种(前缀结果 + 新区段的顺序扫描 = 全文件结果)。
    // 全量路径必须用空累加器:文件可能已被 trim/重写,prev 的标题/边界未必还在文件里,
    // 继承过来会让「删掉的标题仍然显示」「已消失的 boundary 仍然参与链折叠」。
    const acc = opts.seed
      ? {
        boundaryUuids: [...(opts.seed.boundaryUuids || [])],
        titles: { customTitle: opts.seed.customTitle || '', aiTitle: opts.seed.aiTitle || '' },
      }
      : newAcc();
    const feed = feedFor(acc);
    let addedComplete = 0;
    let partial = 0;
    let completeOffset = prev.completeOffset;
    await eachLine(filePath, prev.completeOffset, size, CHUNK, (line, off, nlOff) => {
      if (nlOff >= 0) {
        completeOffset = nlOff + 1;
        if (line.trim()) addedComplete++;
      } else {
        partial = line.trim() ? 1 : 0;
      }
      if (!line.trim()) return;
      if (feed) feed(line);
    });
    const { lines: tailRaw40 } = await readTailWindow(filePath, size, { minLines: HEAD_SIZE });
    return {
      depth: 'full',
      mode: 'incremental',
      head40: null,
      tailRaw40,
      totalLines: prev.complete + addedComplete + partial,
      complete: prev.complete + addedComplete,
      partial,
      completeOffset,
      anchorHash: await anchorOf(filePath, completeOffset),
      headFull: true,
      boundaryUuids: acc.boundaryUuids,
      titles: acc.titles,
    };
  }

  const acc = newAcc(); // 全量路径:从零重算,不继承任何东西
  const feed = feedFor(acc);
  const head = [];
  const tailRaw = [];
  let totalLines = 0;
  let partial = 0;
  let completeOffset = 0;
  const limit = need === 'head10' ? HEAD10 : HEAD_SIZE;
  await eachLine(filePath, 0, size, need === 'head10' ? HEAD_CHUNK : CHUNK, (line, off, nlOff) => {
    if (nlOff >= 0) completeOffset = nlOff + 1;
    else partial = line.trim() ? 1 : 0;
    if (!line.trim()) return;
    totalLines++;
    if (head.length < limit) {
      try { head.push(JSON.parse(line)); } catch {}
    }
    if (need === 'full') {
      if (tailRaw.length >= HEAD_SIZE) tailRaw.shift();
      tailRaw.push(line);
      if (feed) feed(line);
    }
    // head10 只判 cwd:读满 10 条可解析记录即收工(与今天 parseJsonl({limit:10}) 同义)
    if (need === 'head10' && head.length >= HEAD10) return false;
    return undefined;
  });

  if (need === 'head10') {
    return {
      depth: 'head10',
      mode: 'full',
      head40: head,
      tailRaw40: [],
      totalLines: 0,
      complete: 0,
      partial: 0,
      completeOffset: 0,
      anchorHash: '',
      headFull: false,
      boundaryUuids: acc.boundaryUuids,
      titles: acc.titles,
    };
  }

  return {
    depth: 'full',
    mode: 'full',
    head40: head,
    tailRaw40: tailRaw,
    totalLines,
    complete: totalLines - partial,
    partial,
    completeOffset,
    anchorHash: await anchorOf(filePath, completeOffset),
    headFull: head.length >= HEAD_SIZE,
    boundaryUuids: acc.boundaryUuids,
    titles: acc.titles,
  };
}

/**
 * 失效契约的唯一实现处(§C.1):`(v, ino, mtimeMs, size)` 四元组。
 * `st.ino` 取不到(非正数)时退化为今天的 `(mtimeMs, size)` —— **不更松**。
 *
 * 与上面 canIncremental 的增量闸门(:89)分工不同,别把两者说成同一回事:
 *   · 增量闸门:ino 取不到 → fail-closed,本次全量重扫(只慢不错);
 *   · 缓存命中闸门(本函数):ino 取不到 → **不是** fail-closed,而是退化成 `(size, mtimeMs)`
 *     照常判命中。即"**增量**关掉、**缓存命中**照常"。
 * 所以 ino 取不到 ≠ 索引全废(那是把两条闸门混为一谈)。另外 libuv 在 Windows 上会用文件
 * 句柄信息填 st_ino,NTFS 上通常为正,取不到的只是不支持文件 ID 的卷/网络重定向 ——
 * **Windows 的 st.ino 真实取值未真机确证**,以上按"可能为 0"写。
 * 命中判据要改口径,只许改这里。
 */
export function isProfileValid(p, st) {
  if (!p || !st) return false;
  if (p.v !== PROFILE_VERSION) return false;
  if (p.size !== st.size || p.mtimeMs !== st.mtimeMs) return false;
  if (typeof st.ino === 'number' && st.ino > 0) return p.ino === st.ino;
  return true;
}

/** 'head10'(只有 cwd10 可用)| 'full'(全字段)。见 §C.2 的 level 定义。 */
export function profileLevel(p) {
  return p?.level === 'head10' ? 'head10' : 'full';
}
