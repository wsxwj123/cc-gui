#!/usr/bin/env node
// 批E 守卫:jsonl 读取只碰头尾,别再整文件 JSON.parse。
// 项目列表(listProjects)对每个 jsonl 只要头 10 条判 cwd,老实现却因维护 tail
// 环形缓冲把整个文件解析完 —— 121 项目/2.5GB 环境下单次 GET /api/projects 读盘
// 1GB、耗时 3.9s。本文件锁住三件事:
//   ① parseJsonl(limit) 读满即停:不读完文件、不泄漏 fd(早关必须销毁底层流);
//   ② readJsonlEdges 头尾语义(坏行不占 head 名额、tail 取末条、totalLines 计
//      非空行含坏行)与老实现逐字一致 —— messageCount 和"< 3 行不列出"都靠它;
//   ③ 回调是 onLine(原始字符串) 而非解析后的对象,调用方自己廉价预筛再 parse。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseJsonl, readJsonlEdges } from '../../server/utils/jsonl-parser.js';

const dir = mkdtempSync(join(tmpdir(), 'cgui-edges-'));
const w = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
const line = (o) => JSON.stringify(o);

try {
  // ── 1. 头尾 + 中部回调 ──────────────────────────────────────────────
  // 5000 行,中间夹 compact_boundary 和坏行,尾部无换行。
  {
    const rows = [];
    rows.push(line({ n: 0, tag: 'head0' }));
    rows.push('{ 这行是坏 JSON');                        // 坏行:不占 head 名额
    rows.push(line({ n: 1, tag: 'head1' }));
    rows.push(line({ n: 2, tag: 'head2' }));
    for (let i = 3; i < 2500; i++) rows.push(line({ n: i }));
    rows.push(line({ type: 'system', subtype: 'compact_boundary', uuid: 'B1' }));
    rows.push('');                                       // 空行:不计 totalLines
    for (let i = 2501; i < 4999; i++) rows.push(line({ n: i }));
    rows.push(line({ n: 4999, tag: 'last' }));           // 末行,文件不以换行结尾
    const f = w('mixed.jsonl', rows.join('\n'));

    const seen = [];
    const boundaries = [];
    const { head, tail, totalLines } = await readJsonlEdges(f, 3, (raw) => {
      seen.push(typeof raw);
      if (!raw.includes('"compact_boundary"')) return;
      try { const r = JSON.parse(raw); if (r.uuid) boundaries.push(r.uuid); } catch {}
    });

    assert.deepEqual(head.map((r) => r.tag), ['head0', 'head1', 'head2'],
      'head 按序取前 3 条成功解析的记录;坏行整条丢弃、不占名额');
    assert.equal(tail.at(-1).tag, 'last', 'tail 末条 = 文件最后一行(无尾换行也要拿到)');
    assert.equal(tail.at(-1).n, 4999);
    // 空行不计,坏行计入 → 5000 条 json + 1 条坏行
    assert.equal(totalLines, 5001, 'totalLines = 非空行数(含坏行),空行不计');
    assert.deepEqual([...new Set(seen)], ['string'], 'onLine 收到的必须是原始字符串,不是解析后的对象');
    assert.equal(seen.length, 5001, 'onLine 每个非空行都要回调一次(中部记录靠它收集)');
    assert.deepEqual(boundaries, ['B1'], '调用方能从原始行里筛出中部的 compact_boundary');
  }

  // ── 2. 边界文件:空 / 单行 / 尾部全坏行 ──────────────────────────────
  {
    const empty = w('empty.jsonl', '');
    const r0 = await readJsonlEdges(empty, 3);
    assert.deepEqual(r0, { head: [], tail: [], totalLines: 0 }, '空文件:三项都是空,不抛');
    assert.deepEqual(await parseJsonl(empty, { limit: 10 }), [], '空文件 parseJsonl 返回空数组');

    const one = w('one.jsonl', line({ only: true }));
    const r1 = await readJsonlEdges(one, 3);
    assert.equal(r1.totalLines, 1);
    assert.deepEqual(r1.head, [{ only: true }]);
    assert.deepEqual(r1.tail, [{ only: true }], '单行文件:head 和 tail 是同一条');

    // 尾部全是坏行 → tail 环形缓冲被坏行占满,解析后可能为空。只要不抛、
    // 调用方 tail.at(-1) 拿到 undefined 后有回落即可(listSessions 回落 mtime)。
    const bad = w('badtail.jsonl', [line({ n: 1 }), 'xx', 'yy', 'zz'].join('\n'));
    const r2 = await readJsonlEdges(bad, 3);
    assert.equal(r2.totalLines, 4, '坏行计入 totalLines');
    assert.deepEqual(r2.head, [{ n: 1 }], 'head 只收成功解析的');
    assert.deepEqual(r2.tail, [], '尾部全坏行 → tail 为空,但不抛');

    // 全坏行文件:parseJsonl(limit) 退化成读完整个文件,行为与改动前一致(不抛)。
    const allBad = w('allbad.jsonl', Array.from({ length: 50 }, () => '{{{').join('\n'));
    assert.deepEqual(await parseJsonl(allBad, { limit: 10 }), [], '全坏行文件返回空数组,不抛');
  }

  // ── 3. 超长行(单行远超 64KB 读块)──────────────────────────────────
  {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const f = w('long.jsonl', [line({ tag: 'first' }), line({ blob: huge }), line({ tag: 'last' })].join('\n'));
    const { head, tail, totalLines } = await readJsonlEdges(f, 2);
    assert.equal(totalLines, 3);
    assert.equal(head[0].tag, 'first');
    assert.equal(head[1].blob.length, huge.length, '跨读块的超长行要完整拼回来');
    assert.equal(tail.at(-1).tag, 'last');
  }

  // ── 4. parseJsonl(limit) 真的早停:不读完文件、不泄漏 fd ──────────────
  {
    // ~40MB:老实现(读完整个文件)在这台盘上要秒级,新实现只读前几个块。
    const big = w('big.jsonl', Array.from({ length: 200_000 },
      (_, i) => line({ i, pad: 'p'.repeat(180) })).join('\n'));

    const t0 = Date.now();
    const head = await parseJsonl(big, { limit: 10 });
    const ms = Date.now() - t0;
    assert.equal(head.length, 10, 'limit 命中后立刻停,正好 10 条');
    assert.equal(head[9].i, 9, '取的是最前面 10 条');
    // 阈值给宽(慢盘/CI 抖动):整文件读解析是秒级,早停是毫秒级,300ms 足够分开。
    assert.ok(ms < 300, `parseJsonl(limit:10) 必须早停,实测 ${ms}ms(读完整文件会是秒级)`);

    // fd 不泄漏:rl.close() 不关底层 fd,早关路径必须 destroy 流,否则
    // listProjects 那几百上千次调用会 EMFILE。
    if (process.platform !== 'win32') {
      for (let i = 0; i < 120; i++) await parseJsonl(big, { limit: 5 });
      const open = execSync(`lsof -p ${process.pid} 2>/dev/null | grep -c 'big\\.jsonl' || true`)
        .toString().trim();
      assert.equal(open, '0', `120 次早关后不得有残留 fd,实测 ${open} 个(readline 的 close 不关流)`);
    }

    // 读取错误仍要 reject(空 error handler 不能把真错误吞掉)。
    await assert.rejects(() => parseJsonl(join(dir, 'nope.jsonl')), /ENOENT/,
      '不存在的文件必须 reject,不能静默返回空数组');
    await assert.rejects(() => readJsonlEdges(join(dir, 'nope.jsonl'), 3), /ENOENT/);
  }

  // ── 5. 源码守卫:调用点形态别退回去 ────────────────────────────────
  {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const src = await readFile(join(here, '../../server/services/session-reader.js'), 'utf-8');
    // listProjects 的两处 head-only 读:必须走 parseJsonl(limit),不许回到 readJsonlEdges
    const headOnly = src.match(/parseJsonl\(join\(projectPath, \w+\), \{ limit: 10 \}\)/g) || [];
    assert.equal(headOnly.length, 2,
      'listProjects 的两处 head-only 读必须是 parseJsonl(…,{limit:10});换回 readJsonlEdges 就等于整文件扫');
    // listSessions 的中部收集(boundary + 标题行)必须先做子串预筛再 parse。
    // 批O 在同一个回调里加了 takeTitleLine(custom-title / ai-title),它自己第一句就是
    // includes 预筛;boundary 那半的预筛必须仍在 parse 之前。
    // r13-p2-6:整文件回调挪进 readEdgesCached(mtime 缓存层),形参名 (raw, bUuids, tt);
    // 语义不变 —— 仍是原始行字符串 + includes 预筛在 parse 之前。
    assert.ok(/\(raw, bUuids, tt\) => \{\s*takeTitleLine\(raw, tt\);\s*if \(!raw\.includes\('"compact_boundary"'\)\) return;/.test(src),
      'boundary 回调必须先 raw.includes 预筛再 JSON.parse(收到的是原始行字符串)');
    assert.ok(/const hit = EDGES_CACHE\.get\(key\);[\s\S]{0,200}mtimeMs === st\.mtimeMs && hit\.size === st\.size/.test(src),
      'r13-p2-6:整文件读必须走 mtime+size 缓存(展开项目 1.8s→20ms 的根治点)');
    assert.ok(/function takeTitleLine\(raw, acc\) \{\s*if \(!raw\.includes\('"custom-title"'\) && !raw\.includes\('"ai-title"'\)\) return;/.test(src),
      '标题行收集同样必须先子串预筛(每条会话记录都会过这个回调,无脑 parse = 整文件解析)');
    // totalLines 有真实消费者(messageCount / "<3 行不列出"),不许被当死字段删掉
    assert.ok(src.includes('if (totalLines < 3) continue;'), 'totalLines 仍被空会话过滤消费');
    assert.equal((src.match(/messageCount: (totalLines|agentEdges\.totalLines)/g) || []).length, 3,
      'messageCount 三处都来自 totalLines,readJsonlEdges 不得停止返回它');
    // 这个文件曾经带一个字面 NUL 字节,被 grep/file 当二进制整文件跳过
    // JS \u0000 escape in source = 6 chars, so this file itself never trips it
    assert.ok(!src.includes('\u0000'), 'session-reader.js 不得再出现字面 NUL(会让 grep 静默跳过整个文件)');
  }

  console.log('check-jsonl-edges: PASS');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
