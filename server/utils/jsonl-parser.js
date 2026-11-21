import { createReadStream, constants } from 'fs';
import { open } from 'fs/promises';
import { createInterface } from 'readline';

/**
 * Parse a JSONL file into an array of parsed JSON objects.
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.limit] - Max lines to read
 * @param {number} [options.skip] - Skip first N lines
 * @param {AbortSignal} [options.signal] - r168:中止即停读、关文件,以 AbortError 拒绝(不给半截
 *   结果,免得调用方当成完整文件);不传 = 旧行为逐字不变
 * @returns {Promise<object[]>}
 */
export async function parseJsonl(filePath, { limit, skip, signal } = {}) {
  return new Promise((resolve, reject) => {
    // r168:请求方在开读前就已断开 → 不开文件。
    if (signal?.aborted) {
      reject(readAbortedError());
      return;
    }
    const results = [];
    let lineNum = 0;
    const input = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });
    // r168:中止 = 关 readline(→ 下面 'close' 里销毁底层流);当前块里已缓冲的剩余行由
    // aborted 挡掉(与 limit 早关同理,rl.close() 不打断正在派发的这一块)。
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      rl.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // rl.close() 只停 readline,不关底层 fd:limit 早关路径每调一次泄漏一个 fd
    // (实测 300 次早关 = 300 个常开 fd)。listProjects 每次请求要跑几百到几千次
    // (每个 jsonl 一次),不销毁必然 EMFILE。销毁若失败会在 rl 关闭后往 input 补发
    // 'error',那时 readline 已摘掉监听 → 无人处理的 'error' 会直接掀翻进程,
    // 因此挂一个空 handler 吞掉;真正的读取错误仍由 rl 的 'error' 转成 reject。
    input.on('error', () => {});

    rl.on('line', (line) => {
      if (aborted) return;
      // rl.close() 不打断当前 chunk:readline 会把这一块里已缓冲的行继续同步派发,
      // 所以只靠 close() 的话 limit:10 实测会返回 329 条(一个 64KB 块的量)。
      // 必须显式挡住,否则 limit 只是"至少 n 条",调用方拿到的头部长度不可控。
      if (limit && results.length >= limit) return;
      if (!line.trim()) return;
      lineNum++;
      if (skip && lineNum <= skip) return;
      try {
        results.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
      if (limit && results.length >= limit) {
        rl.close();
      }
    });

    rl.on('close', () => {
      signal?.removeEventListener('abort', onAbort);
      try { input.destroy(); } catch {}
      if (aborted) reject(readAbortedError());
      else resolve(results);
    });
    rl.on('error', reject);
  });
}

function readAbortedError() {
  return Object.assign(new Error('jsonl read aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

/**
 * Stream-parse a JSONL file, calling callback for each record.
 * Useful for large files where you don't want to hold everything in memory.
 */
export async function streamJsonl(filePath, callback) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        callback(JSON.parse(line), count);
        count++;
      } catch {
        // skip malformed lines
      }
    });

    rl.on('close', () => resolve(count));
    rl.on('error', reject);
  });
}

/**
 * Read just the first and last N lines of a JSONL file for preview.
 *
 * 仍需逐行读完整个文件(totalLines 被会话列表当 messageCount 用,且调用方要顺路
 * 收集中部记录如 compact_boundary),但**只对头尾各 edgeSize 行做 JSON.parse**:
 * tail 存原始字符串环形缓冲,关闭时才解析。回调是 onLine(raw string) 而非解析后
 * 的对象,调用方先做廉价子串过滤再自己 parse —— 大会话里这一步把 parse 次数从
 * 数万降到几十。
 *
 * 语义细节(与旧实现的差异,调用方已核对):
 * - head 只收成功解析的记录,坏行不占名额(同旧实现)。
 * - tail 环形缓冲按"非空行"计,坏行会占名额 → 尾部若全是坏行,tail 可能少于
 *   edgeSize 条解析结果。调用方只取 tail 末条/逆序找首个 assistant,可接受。
 * - totalLines 仍是"非空行数"(含坏行),与旧实现一致。
 */
export async function readJsonlEdges(filePath, edgeSize = 3, onLine) {
  const head = [];
  let totalLines = 0;
  const tailRaw = [];

  return new Promise((resolve, reject) => {
    const input = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });
    input.on('error', () => {}); // 见 parseJsonl:销毁后的补发 error 不能掀翻进程

    rl.on('line', (line) => {
      if (!line.trim()) return;
      totalLines++;
      if (head.length < edgeSize) {
        try { head.push(JSON.parse(line)); } catch {}
      }
      tailRaw.push(line);
      if (tailRaw.length > edgeSize) tailRaw.shift();
      if (onLine) onLine(line);
    });

    rl.on('close', () => {
      const tail = [];
      for (const raw of tailRaw) {
        try { tail.push(JSON.parse(raw)); } catch {}
      }
      try { input.destroy(); } catch {}
      resolve({ head, tail, totalLines });
    });
    rl.on('error', reject);
  });
}

/**
 * 字节级断行扫描器 —— **与 readline(crlfDelay: Infinity) 逐字同语义**:`\n`、`\r`(\r\n 算一次)、
 * `U+2028`、`U+2029` 都是行终止符。为什么必须对齐:readJsonlEdges / parseJsonl 走 readline,
 * 而 JSON.stringify 不转义 U+2028/U+2029 —— 真实数据里一条 tool_result 带 U+2028 就会被
 * readline 切成两条"行"(两半都 JSON.parse 失败,但都计入非空行数)。只按 \n 切会让画像的
 * messageCount 与消息视图(同一个 readline)对不上(实测:某 agent 转写 218 行 vs 215 行)。
 *
 * `next(from)` 返回 { at, next }(断行符在 at,下一行从 next 起)| { maybeAt }(尾部字节不足以
 * 判定:可能是被截断的 U+2028/U+2029 序列,调用方应把 maybeAt 之后留给下一块)| null。
 * **三段候选位置各只向前推进(单调)**:每行都对整个缓冲重新 indexOf 是 O(n²)
 * (实测 254 MB 的项目从 1.7 s 变成 6.6 s),所以候选指针只在落后于 from 时才重算。
 * 约定:同一 buffer 上的 from 必须单调不减。
 */
export function newLineBreaker(buf) {
  const BYTE = [0x0A, 0x0D, 0xE2];
  const pos = BYTE.map((b) => buf.indexOf(b));
  return {
    next(from) {
      let p = from;
      for (;;) {
        for (let i = 0; i < 3; i++) if (pos[i] !== -1 && pos[i] < p) pos[i] = buf.indexOf(BYTE[i], p);
        let at = -1;
        for (let i = 0; i < 3; i++) if (pos[i] !== -1 && (at === -1 || pos[i] < at)) at = pos[i];
        if (at === -1) return null;
        const b = buf[at];
        if (b === 0x0A) return { at, next: at + 1 };
        if (b === 0x0D) return { at, next: buf[at + 1] === 0x0A ? at + 2 : at + 1 };
        if (at + 2 >= buf.length) return { maybeAt: at };
        if (buf[at + 1] === 0x80 && (buf[at + 2] === 0xA8 || buf[at + 2] === 0xA9)) return { at, next: at + 3 };
        pos[2] = buf.indexOf(0xE2, at + 1); // 这个 E2 不是 U+2028/U+2029:推进该候选
        p = at + 1;
      }
    },
  };
}

/**
 * 读 [offset, offset+len) 的原始字节(越界自动夹取:offset<0 从 0 起,越过 EOF 的部分
 * 直接短读)。给锚点校验(/增量读的前缀哈希)用。**调用方负责文件存在**,不存在会抛出
 * fs 的 ENOENT —— 与 readJsonlEdges 同语义(错误不外吞)。
 */
export async function readBytesAt(filePath, offset, len) {
  const n = Math.floor(Number(len) || 0);
  if (n <= 0) return Buffer.alloc(0);
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(n);
    const { bytesRead } = await fh.read(buf, 0, n, start);
    return bytesRead === n ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * 从 EOF 向前按块回读,直到凑够 minLines 条**非空**行(或到文件头)。
 *
 * 语义与 readJsonlEdges 的 tailRaw 逐字对齐:非空行(**坏行也占名额**、空白行不占)、
 * 按 \n 切、行尾 \r 去掉(同 readline 的 crlfDelay:Infinity)、文件末没有 \n 的尾段
 * 也算一行(取到即非空)。返回 { lines, startOffset },lines 为**文件顺序**的最后
 * minLines 条非空行,startOffset = lines[0] 的字节偏移(一条都没取到时 = size)。
 *
 * 注意:这里读的是**原始行字符串**,不 JSON.parse(与 readJsonlEdges 一样,尾部坏行
 * 解析后会被丢弃 —— 由调用方各自 parse 决定)。
 */
export async function readTailWindow(filePath, size, { minLines = 40, blockBytes = 256 * 1024 } = {}) {
  const total = Math.max(0, Math.floor(Number(size) || 0));
  if (!total) return { lines: [], startOffset: 0 };
  const block = Math.max(1024, Math.floor(blockBytes) || 256 * 1024);
  let lines = [];                 // { off, text },文件顺序
  let pending = Buffer.alloc(0);  // 左端未定界的片段(其起点还在更前面)
  let pos = total;
  while (true) {
    const from = Math.max(0, pos - block);
    const chunk = await readBytesAt(filePath, from, pos - from);
    pos = from;
    const region = pending.length ? Buffer.concat([chunk, pending]) : chunk;
    const breaker = newLineBreaker(region);
    const base = from;
    let p = 0;
    let cut = 0; // >0:本区域左端那段残片的终点(不含),它整段留作下一轮的 pending
    const found = [];
    for (;;) {
      const br = breaker.next(p);
      if (!br || br.maybeAt !== undefined) break; // 尾部字节不足以判定断行 → 留给下一块
      if (p === 0 && base > 0) {
        // 块边界落在行中间(256KB 不可能是行长整数倍,这是常态):region[0..br.at] 的左半
        // 还在更靠前的一块里,收下它就会把一行拆成两条"半行"(两条都 JSON.parse 失败)。
        // 整段(含其断行符)留给下一轮 —— 下一轮 region = [chunk][pending] 正好把它接在
        // 新块右侧拼回整行(与 session-profile.js 的 eachLine 同口径,只是方向相反)。
        // base===0 时这段是文件首行,照常收(见下面的 else)。
        cut = br.next;
      } else {
        const text = region.subarray(p, br.at).toString('utf-8');
        if (text.trim()) found.push({ off: base + p, text });
      }
      p = br.next;
    }
    // p>0:本区域右端是行边界,剩下的尾段是一条完整行(右端要么是文件尾,要么是
    // 已收集行的起点,而后者前面紧挨着一个 \n)。p===0:整块都落在某一行内部。
    if (p > 0 && p < region.length) {
      const text = region.subarray(p).toString('utf-8').replace(/\r$/, '');
      if (text.trim()) found.push({ off: base + p, text });
      p = region.length;
    } else if (p === 0 && pos === 0) {
      // 到文件头了:pending 就是文件的首行,右端同样在行边界上。
      const text = region.toString('utf-8').replace(/\r$/, '');
      if (text.trim()) found.push({ off: 0, text });
      p = region.length;
    }
    if (found.length) lines = found.concat(lines);
    // cut>0:残片(含断行符)就是新的 pending;否则按老口径取本次未定界的尾段 ——
    // 「整块落在行内」(p===0 且找不到断行符)时 pending = 整块,不能改坏。
    pending = cut
      ? Buffer.from(region.subarray(0, cut))
      : (p >= region.length ? Buffer.alloc(0) : Buffer.from(region.subarray(p)));
    if (lines.length >= minLines || pos === 0) break;
  }
  const tail = lines.slice(-minLines);
  return { lines: tail.map((l) => l.text), startOffset: tail.length ? tail[0].off : total };
}

// ── r207:快速扫描(按字节范围逐行读,行首就看得出类型的元数据行不解析)────────────────
export const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;   // 每读一块(≤4MB)回报一次进展;块与块之间的 await 即让出
const SCAN_HEAD_LIMIT = 8192;                       // 行首找顶层 type 最多看这么多字节,超了按「看不出」照常解析

function scanRangeError(message) {
  return new RangeError(`scanJsonlRange: ${message}`);
}
function isOffset(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

/**
 * 只按 JSON.stringify 的写法(无空白)读行首的顶层 `type`:`{"k":标量,…,"type":"X"`。
 * 键带转义、type 之前有对象 / 数组值、有空白、type 不是不带转义的字符串、看到头还没碰到 type → null
 * (调用方照常解析)。重复键(JSON.parse 取最后一个)这里认第一个 —— JSON.stringify 写不出重复键。
 */
export function leadingRecordType(buf, limit = SCAN_HEAD_LIMIT) {
  const n = Math.min(buf.length, limit);
  if (n < 2 || buf[0] !== 0x7B) return null;                   // {
  let i = 1;
  for (;;) {
    if (buf[i] !== 0x22) return null;                         // 键以 " 开头
    const keyStart = i + 1;
    let j = keyStart;
    while (j < n && buf[j] !== 0x22 && buf[j] !== 0x5C) j++;
    if (j >= n || buf[j] !== 0x22) return null;               // 键里有转义 / 看到头
    const isType = j - keyStart === 4 && buf[keyStart] === 0x74 && buf[keyStart + 1] === 0x79
      && buf[keyStart + 2] === 0x70 && buf[keyStart + 3] === 0x65;
    i = j + 1;
    if (buf[i] !== 0x3A) return null;                         // :
    i += 1;
    if (isType) {
      if (buf[i] !== 0x22) return null;
      const vs = i + 1;
      let k = vs;
      while (k < n && buf[k] !== 0x22 && buf[k] !== 0x5C) k++;
      if (k >= n || buf[k] !== 0x22) return null;
      return buf.toString('utf-8', vs, k);
    }
    const c = buf[i];
    if (c === 0x22) {                                         // 字符串值:跳过转义
      i += 1;
      while (i < n && buf[i] !== 0x22) i += buf[i] === 0x5C ? 2 : 1;
      if (i >= n) return null;
      i += 1;
    } else if (c === 0x7B || c === 0x5B || c === undefined) {
      return null;                                            // 对象 / 数组值:不往里看
    } else {
      while (i < n && buf[i] !== 0x2C && buf[i] !== 0x7D) i++; // true / false / null / 数字
      if (i >= n) return null;
    }
    if (buf[i] !== 0x2C) return null;                         // 遇到 } = 没有顶层 type
    i += 1;
  }
}

/**
 * r207:按字节范围逐行扫描 JSONL,解析出的每条记录交给 onRecord(record, 行首偏移)。
 * 断行与 readline(crlfDelay: Infinity)逐字同口径(\n、\r\n、单独的 \r、U+2028、U+2029,见 newLineBreaker,
 * 跨块的 \r\n 与被块边界切开的 U+2028/U+2029 也一样);只有空白的行跳过;坏行丢弃。
 * 长行跨块时只把各块里属于它的那段记下来,换行到了才拼一次,不重扫、不每块整段拷贝。
 *
 * - start / end:非负安全整数且 start ≤ end,否则 RangeError。end 缺省或超过打开时的大小 = 打开时大小
 *   (之后追加的不读)。start 不在行首 → 从下一个行首开始(第一行残片丢掉);end 应落在行首。
 * - requireNewline:true(缺省)= 没写完换行的末段不算;false = 同 readline,末段非空也算一行。
 * - skipTypes(type, rawLine):行首能确定顶层 type(leadingRecordType)且它返回 true → 不解析直接跳过;
 *   看不出就照常解析。
 * - 打开时文件不存在 / 不是普通文件 → 抛错(ENOENT / EISDIR / EINVAL);不对命名管道等阻塞。
 * - 读的时候文件变短 → 停在实际文件尾,返回 shortRead:true(调用方按「文件变了」处理)。
 * - 每读一块(≤4MB)回调 onProgress(累计读到的字节数);signal 中止 → 关文件,以 AbortError 拒绝。
 * @returns {Promise<{ endOffset: number, shortRead: boolean }>} endOffset = 已按行处理到哪(最后一个断行之后;
 *   requireNewline:false 且末段已算一行时为读到的末尾)
 */
export async function scanJsonlRange(filePath, {
  start = 0, end, skipTypes, requireNewline = true, signal, onRecord, onProgress,
} = {}) {
  if (!isOffset(start)) throw scanRangeError('start must be a non-negative safe integer');
  if (end !== undefined && (!isOffset(end) || end < start)) throw scanRangeError('end must be a safe integer ≥ start');
  if (signal?.aborted) throw readAbortedError();
  const fh = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw Object.assign(new Error('scanJsonlRange: not a regular file'), { code: st.isDirectory() ? 'EISDIR' : 'EINVAL' });
    }
    const stop = end === undefined ? st.size : Math.min(end, st.size);
    let pos = start;          // 下一次从文件哪里读
    let bytesRead = 0;
    let shortRead = false;
    let endOffset = Math.min(start, stop);
    let pieces = [];          // 当前这一行在之前各块里的部分(视图,按序)
    let lineAt = start;       // 当前这一行的行首偏移
    let discardFirst = false; // start 落在行中间:第一行是残片,不算
    let carry = null;         // 上一块末尾判不了的 ≤2 字节(可能是 \r\n 的 \r、U+2028 的前半),接到下一块开头

    if (start > 0 && start < stop) {
      // 看 start 前面是不是断行:\n / U+2028 / U+2029 → 行首;\r → 行首(若 start 处是 \n,它属于同一个 \r\n,跳过)。
      const back = Math.min(3, start);
      const head = Buffer.alloc(back + 1);
      const { bytesRead: got } = await fh.read(head, 0, back + 1, start - back);
      const prev = head[back - 1];
      const isSep = got >= back && (prev === 0x0A || prev === 0x0D || (back === 3 && head[0] === 0xE2 && head[1] === 0x80
        && (head[2] === 0xA8 || head[2] === 0xA9)));
      if (!isSep) discardFirst = true;
      else if (prev === 0x0D && got > back && head[back] === 0x0A) { pos = start + 1; lineAt = pos; }
    }

    const emit = (lineBuf, offset) => {
      if (discardFirst) { discardFirst = false; return; }
      if (!lineBuf.length) return;
      if (skipTypes) {
        const type = leadingRecordType(lineBuf);
        if (type !== null && skipTypes(type, lineBuf)) return;
      }
      const text = lineBuf.toString('utf-8');
      if (!text.trim()) return;
      let record;
      try { record = JSON.parse(text); } catch { return; }
      onRecord?.(record, offset);
    };
    const takeLine = (buf, from, to) => {
      if (!pieces.length) return buf.subarray(from, to);
      pieces.push(buf.subarray(from, to));
      const whole = Buffer.concat(pieces);
      pieces = [];
      return whole;
    };

    for (;;) {
      const want = Math.min(SCAN_CHUNK_BYTES, stop - pos);
      const lead = carry ? carry.length : 0;
      let n = lead;
      let buf = carry || Buffer.alloc(0);
      if (want > 0) {
        buf = Buffer.allocUnsafe(lead + want);
        if (carry) carry.copy(buf, 0);
        const r = await fh.read(buf, lead, want, pos);
        n = lead + r.bytesRead;
        pos += r.bytesRead;
        bytesRead += r.bytesRead;
        if (r.bytesRead < want) shortRead = true;
        if (signal?.aborted) throw readAbortedError();
      }
      carry = null;
      const final = shortRead || pos >= stop;
      const region = n === buf.length ? buf : buf.subarray(0, n);
      const base = pos - n;   // region[0] 的文件偏移
      const breaker = newLineBreaker(region);
      let p = 0;
      let search = 0;
      let hold = n;           // region[hold, n) 留给下一块
      for (;;) {
        const br = breaker.next(search);
        if (!br) break;
        if (br.maybeAt !== undefined) {
          if (!final) { hold = br.maybeAt; break; }
          search = br.maybeAt + 1;   // 到头了:不完整的 E2 序列只是正文
          continue;
        }
        if (!final && br.next === n && region[br.at] === 0x0D) { hold = br.at; break; }  // 块尾的 \r:可能连着下一块的 \n
        emit(takeLine(region, p, br.at), lineAt);
        if (signal?.aborted) throw readAbortedError();
        p = br.next;
        search = p;
        lineAt = base + p;
        endOffset = lineAt;
      }
      if (!final) {
        if (hold > p) pieces.push(region.subarray(p, hold));
        if (hold < n) carry = Buffer.from(region.subarray(hold, n));
        onProgress?.(bytesRead);
        continue;
      }
      // 末段(没有断行结尾):requireNewline:false 时同 readline 算一行
      if (!requireNewline && (p < n || pieces.length)) {
        emit(takeLine(region, p, n), lineAt);
        endOffset = base + n;
      }
      pieces = [];
      onProgress?.(bytesRead);
      if (signal?.aborted) throw readAbortedError();
      return { endOffset, shortRead };
    }
  } finally {
    await fh.close().catch(() => {});
  }
}
