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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, linkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseJsonl, readJsonlEdges } from '../../server/utils/jsonl-parser.js';
// 只调 listProjects(显式传临时目录)—— 不碰真实 ~/.claude/projects。
import { listProjects } from '../../server/services/session-reader.js';

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

  // ── 5. 行为:listProjects 冷读只读头部,不整文件扫 ──────────────────────
  // B1 之前这里数的是「源码里 parseJsonl(…,{limit:10}) 出现 2 次」—— 数的是拼写,
  // 实现换写法就误报,而且"数够 2 处"并不等于"真的没整文件扫"。改成量行为:
  // 10 个项目各挂一份 38MB jsonl(hardlink 同一 inode,不额外占盘),只读头是毫秒级,
  // 整文件扫是几百毫秒级(本机实测:头读 ~1ms / 10×38MB 全读 ~360ms)。
  {
    const cwdDir = join(dir, 'cwd-probe'); // cwd 必须真实存在(isNonProjectPath 会丢掉不存在的路径)
    mkdirSync(cwdDir, { recursive: true });
    const parts = [line({ type: 'user', cwd: cwdDir })];
    for (let i = 0; i < 200_000; i++) parts.push(line({ i, pad: 'p'.repeat(180) }));
    const bigSource = join(dir, 'big-proj.jsonl');
    writeFileSync(bigSource, parts.join('\n'));

    const projRoot = join(dir, 'projects');
    const hashes = Array.from({ length: 10 }, (_, n) => `-tmp-cgui-edges-probe-${n}`);
    for (const h of hashes) {
      mkdirSync(join(projRoot, h), { recursive: true });
      linkSync(bigSource, join(projRoot, h, 'sess.jsonl'));
    }

    const t0 = Date.now();
    const projects = await listProjects(projRoot);
    const ms = Date.now() - t0;
    assert.equal(projects.length, hashes.length, '10 个项目文件夹都要列出来');
    for (const p of projects) {
      assert.equal(p.path, cwdDir, 'listProjects 判 cwd 只用 jsonl 头部(头 10 条可解析记录)');
    }
    assert.ok(ms < 150, `listProjects 冷读 10 个 38MB 文件必须只读头部,实测 ${ms}ms(整文件扫是几百毫秒级)`);
  }

  // ── 6. 源码守卫:调用点形态别退回去 ────────────────────────────────
  {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const src = await readFile(join(here, '../../server/services/session-reader.js'), 'utf-8');
    // listProjects 的两处 head 读(解析 cwd / sidecar 计数)都必须走 head10 级画像 ——
    // 该等级 = 读满 10 条可解析记录即收工(scanProfile 的 need:'head10')。改成 full 级,
    // 或出现任何整文件读(readJsonlEdges / 无 limit 的 parseJsonl / streamJsonl)= 整文件扫。
    const lpStart = src.indexOf('export async function listProjects(');
    // 先剥注释再查:正文注释里会出现 parseJsonl / head10 这些词(讲"与旧实现等价"),
    // 拿注释当代码判会误报。
    const lpBody = src.slice(lpStart, src.indexOf('\nexport ', lpStart))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.equal((lpBody.match(/'head10'/g) || []).length, 2,
      'listProjects 的两处 head-only 读都必须走 head10 画像(cwd 解析 + sidecar 计数各一处)');
    assert.ok(!/readJsonlEdges\(|streamJsonl\(|parseJsonl\(/.test(lpBody),
      'listProjects 里不许出现整文件读(readJsonlEdges / 无 limit 的 parseJsonl / streamJsonl)');
    // listSessions 的中部收集(boundary + 标题行)必须先做子串预筛再 parse。
    // 批O 在同一个回调里加了 takeTitleLine(custom-title / ai-title),它自己第一句就是
    // includes 预筛;boundary 那半的预筛必须仍在 parse 之前。
    // B1:整文件回调挪进画像扫描层(scanProfile 逐行喂给 onRawLine),形参名 (raw, bUuids, tt);
    // 语义不变 —— 仍是原始行字符串 + includes 预筛在 parse 之前。
    assert.ok(/\(raw, bUuids, tt\) => \{\s*takeTitleLine\(raw, tt\);\s*if \(!raw\.includes\('"compact_boundary"'\)\) return;/.test(src),
      'boundary 回调必须先 raw.includes 预筛再 JSON.parse(收到的是原始行字符串)');
    // 整文件读必须走失效判据缓存(展开项目 1.8s→20ms 的根治点)。判据 = (v, ino, mtimeMs,
    // size) 四元组,唯一实现处 session-profile.js 的 isProfileValid。旧版钉的是 EDGES_CACHE
    // 那两行源码文本;这里直接喂四元组看结果 —— 任一分量变了都必须判 miss(= 全量重扫),
    // 比"文本存在"严:源码里留着判据但用错(或删掉某个分量)照样红。
    const { isProfileValid, PROFILE_VERSION } = await import('../../server/services/session-profile.js');
    const st = { ino: 42, size: 1000, mtimeMs: 1_700_000_000_000 };
    const prof = { v: PROFILE_VERSION, level: 'full', ino: 42, size: 1000, mtimeMs: 1_700_000_000_000 };
    assert.equal(isProfileValid(prof, st), true, '四元组一致 → 命中缓存(命中 = 不重扫)');
    assert.equal(isProfileValid({ ...prof, mtimeMs: st.mtimeMs + 1 }, st), false, 'mtimeMs 变 → miss');
    assert.equal(isProfileValid({ ...prof, size: st.size + 1 }, st), false, 'size 变 → miss');
    assert.equal(isProfileValid({ ...prof, ino: st.ino + 1 }, st), false, 'ino 变(同名换文件)→ miss,不许吃旧画像');
    assert.equal(isProfileValid({ ...prof, v: PROFILE_VERSION + 1 }, st), false, '画像版本变 → miss');
    assert.equal(isProfileValid(null, st), false, '没有画像 = miss');
    const stNoIno = { ...st, ino: 0 }; // Windows 形态:st.ino 取不到
    assert.equal(isProfileValid({ ...prof, size: st.size + 1 }, stNoIno), false,
      'ino 不可用时退回 (mtimeMs,size),判据不更松');
    assert.equal(isProfileValid({ ...prof, ino: undefined }, stNoIno), true, 'ino 不可用时只看 (mtimeMs,size)');
    // 判据要真被查:loadProfile 必须"先查缓存命中、后扫描",顺序反了 = 每次请求都白扫。
    const loadStart = src.indexOf('async function loadProfile(');
    const loadBody = src.slice(loadStart, src.indexOf('\nexport ', loadStart));
    assert.ok(loadBody.indexOf('getEntry(') >= 0 && loadBody.indexOf('getEntry(') < loadBody.indexOf('scanProfile('),
      'loadProfile 必须先 getEntry 判命中再 scanProfile 扫描');
    assert.ok(/function takeTitleLine\(raw, acc\) \{\s*if \(!raw\.includes\('"custom-title"'\) && !raw\.includes\('"ai-title"'\)\) return;/.test(src),
      '标题行收集同样必须先子串预筛(每条会话记录都会过这个回调,无脑 parse = 整文件解析)');
    // totalLines 有真实消费者(messageCount / "<3 行不列出"),不许被当死字段删掉
    assert.ok(src.includes('if (totalLines < 3) continue;'), 'totalLines 仍被空会话过滤消费');
    // messageCount 的口径 = totalLines(非空行数,含坏行)。旧版钉"恰好 3 处 + 变量名
    // agentEdges"(都是当时源码的拼写:重构把 agentEdges 换成画像后计数就误报,而"3"本身
    // 不承载语义 —— 三个消费点各自的字段存在与否由 check-session-profile 行为级兜着)。
    // 这里钉口径本身:每一处 messageCount 都必须直接取自 *totalLines 计数器,换成别的
    // 度量(head.length / 解析成功条数 / 独立再数一遍)就红。
    const mcSources = [...src.matchAll(/messageCount:\s*([^,\n]+),/g)].map((m) => m[1].trim());
    assert.ok(mcSources.length > 0, '源码里找不到 messageCount 赋值 —— 断言前提被破坏(正则空转会静默放过)');
    for (const expr of mcSources) {
      assert.ok(/(^|\.)totalLines$/.test(expr), `messageCount 必须取自 totalLines 口径,实测: ${expr}`);
    }
    // 这个文件曾经带一个字面 NUL 字节,被 grep/file 当二进制整文件跳过
    // JS \u0000 escape in source = 6 chars, so this file itself never trips it
    assert.ok(!src.includes('\u0000'), 'session-reader.js 不得再出现字面 NUL(会让 grep 静默跳过整个文件)');
  }

  console.log('check-jsonl-edges: PASS');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
