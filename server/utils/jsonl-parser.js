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
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
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

    rl.on('close', () => resolve(results));
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
 * 本函数为拿 tail/totalLines 本就逐行解析整个文件;onRecord 让调用方顺路收集
 * 中部记录(如 compact_boundary),不必再读一遍文件。
 */
export async function readJsonlEdges(filePath, edgeSize = 3, onRecord) {
  const head = [];
  let totalLines = 0;
  const tail = [];

  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      totalLines++;
      try {
        const parsed = JSON.parse(line);
        if (head.length < edgeSize) {
          head.push(parsed);
        }
        // Keep a rotating buffer for tail
        tail.push(parsed);
        if (tail.length > edgeSize) tail.shift();
        if (onRecord) onRecord(parsed);
      } catch {}
    });

    rl.on('close', () => resolve({ head, tail, totalLines }));
    rl.on('error', reject);
  });
}
