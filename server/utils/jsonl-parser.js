import { createReadStream } from 'fs';
import { open } from 'fs/promises';
import { createInterface } from 'readline';

/**
 * Parse a JSONL file into an array of parsed JSON objects.
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.limit] - Max lines to read
 * @param {number} [options.skip] - Skip first N lines
 * @returns {Promise<object[]>}
 */
export async function parseJsonl(filePath, { limit, skip } = {}) {
  return new Promise((resolve, reject) => {
    const results = [];
    let lineNum = 0;
    const input = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });
    // rl.close() 只停 readline,不关底层 fd:limit 早关路径每调一次泄漏一个 fd
    // (实测 300 次早关 = 300 个常开 fd)。listProjects 每次请求要跑几百到几千次
    // (每个 jsonl 一次),不销毁必然 EMFILE。销毁若失败会在 rl 关闭后往 input 补发
    // 'error',那时 readline 已摘掉监听 → 无人处理的 'error' 会直接掀翻进程,
    // 因此挂一个空 handler 吞掉;真正的读取错误仍由 rl 的 'error' 转成 reject。
    input.on('error', () => {});

    rl.on('line', (line) => {
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
      try { input.destroy(); } catch {}
      resolve(results);
    });
    rl.on('error', reject);
  });
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
