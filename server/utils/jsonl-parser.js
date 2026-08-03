import { createReadStream } from 'fs';
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
