#!/usr/bin/env node
// r209 夹具。用法:node fixtures.mjs main | sweep。全部落在 .artifacts/runtime-data 下(假家目录),不读用户 profile。
// main:后端 A 的家目录:几条「静态」会话(页面要能在侧栏里看到,必须在后端起来前写好;后端关了目录监听)。备份文件由各用例自己在用例开始时写。
// sweep:后端 B 的家目录:自动清理时间线用的全部文件,以「此刻」为基准一次写好,清单写进 manifest(a-sweep 据此核对)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  art, dataRoot, mainHome, mainR, sweepHome, sweepR, manifestPath, DAY, putFile, putSession, sidOf, tok, hb, hbOld, bakTs, bakPlain, guard,
} from './common.mjs';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = 'claude-opus-4-6';
const encodeProjectDir = (cwd) => cwd.replace(/[/\\]/g, '-');
const wsDir = (tag) => path.join(fs.realpathSync(os.tmpdir()), `r209-ws-${tag}`);

export const STATIC = {
  u1: { sid: '5a090001-0000-4000-8000-000000000001', marker: 'R209U1' },
  h1: { sid: '5a090002-0000-4000-8000-000000000002', marker: 'R209H1' },
  h2: { sid: '5a090003-0000-4000-8000-000000000003', marker: 'R209H2' },
  d1: { sid: '5a090004-0000-4000-8000-000000000004', marker: 'R209D1' },
};
for (const [tag, c] of Object.entries(STATIC)) {
  c.tag = tag;
  c.workspace = wsDir(tag);
  c.workspaceName = `r209-ws-${tag}`;
  c.projectHash = encodeProjectDir(c.workspace);
  c.dir = path.join(mainR(), c.projectHash);
  c.file = path.join(c.dir, `${c.sid}.jsonl`);
  c.targetText = `${c.marker} 第二条用户消息`;
}

function sessionLines(c) {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: c.workspace, sessionId: c.sid, version: '2.1.322', gitBranch: '' };
  let n = 0; let prev = null; let sec = 0;
  const ts = () => new Date(Date.UTC(2026, 10, 19, 9, 1, (sec += 1))).toISOString();
  const user = (text) => { const uuid = `u-${c.tag}-${(n += 1)}`; const r = { ...base, parentUuid: prev, type: 'user', isMeta: false, message: { role: 'user', content: text }, uuid, timestamp: ts(), permissionMode: 'default', promptSource: 'sdk' }; prev = uuid; return r; };
  const asst = (text) => {
    const uuid = `a-${c.tag}-${(n += 1)}`;
    const r = { ...base, parentUuid: prev, type: 'assistant', uuid, timestamp: ts(), requestId: `req_${uuid}`, message: { model: D, id: `msg_${uuid}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } };
    prev = uuid; return r;
  };
  const lines = [{ type: 'summary', summary: `${c.marker} 会话`, leafUuid: 'x' }];
  lines.push(user(`${c.marker} 第一条用户消息`), asst('R209 回复一。'), user(c.targetText), asst('R209 回复二。'));
  lines[0].leafUuid = prev;
  return lines;
}

function writeMain() {
  fs.mkdirSync(mainR(), { recursive: true });
  fs.mkdirSync(path.join(mainHome(), '.claude-gui'), { recursive: true });
  fs.mkdirSync(path.join(mainHome(), 'fake-claude'), { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(suiteDir, '..', '..', '..', 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(mainHome(), '.claude-gui', 'prefs.json'), `${JSON.stringify({ releaseNotesSeen: version })}\n`);
  fs.writeFileSync(path.join(mainHome(), '.claude-gui', 'permission-guide-shown.flag'), `${new Date().toISOString()}\n`);
  fs.writeFileSync(path.join(mainHome(), '.claude', 'settings.json'), `${JSON.stringify({ model: D, env: { ANTHROPIC_MODEL: D } }, null, 2)}\n`);
  fs.mkdirSync(art('fakebin'), { recursive: true });
  const shim = art('fakebin', 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  for (const c of Object.values(STATIC)) {
    fs.mkdirSync(c.workspace, { recursive: true });
    fs.mkdirSync(c.dir, { recursive: true });
    fs.writeFileSync(c.file, `${sessionLines(c).map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
  fs.writeFileSync(manifestPath(), `${JSON.stringify({ sessions: STATIC }, null, 2)}\n`);
}

// ───────────────────────── sweep(后端 B 的时间线夹具) ─────────────────────────
// 期望分类 expect:r1=首轮(启动)删;r2=第二轮才删(gone 组「连续两轮」);cross=首轮与第二轮都还在、跨过 14 天边界后被定时轮删;keep=全程不动。
function writeSweep() {
  const G = Date.now();
  const R = sweepR();
  const H = sweepHome();
  fs.mkdirSync(R, { recursive: true });
  const T = (off) => String(G + off);
  const H1 = 3_600_000;
  const files = [];
  const add = (key, dir, name, expect, opt = {}) => { putFile(dir, name, { size: 100, mtimeMs: opt.mtimeMs ?? G, ...opt }); files.push({ key, dir, name, expect }); };
  const main = path.join(R, 'sw-main'); const gone = path.join(R, 'sw-gone'); const elA = path.join(R, 'sw-else-a'); const elB = path.join(R, 'sw-else-b');
  const [s1, s2, s3, s4, s5, s6, s7, s8, s9, s11, s12, s13, s14] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14].map(sidOf);
  for (const s of [s1, s2, s3, s4, s5, s6, s7, s14]) putSession(main, s);
  // s1 天数规则
  add('age_expired', main, hb(s1, T(-14 * DAY - 2000), tok('a')), 'r1');
  add('age_near', main, hb(s1, T(-14 * DAY + 150_000), tok('b')), 'keep');
  add('age_nameOld_mtimeNew', main, hb(s1, T(-20 * DAY), tok('c')), 'r1', { mtimeMs: G });
  add('age_nameNew_mtimeOld', main, hb(s1, T(-H1), tok('d')), 'keep', { mtimeMs: G - 20 * DAY });
  add('age_bakTs', main, bakTs(s1, T(-15 * DAY)), 'r1');
  add('age_oldForm', main, hbOld(s1, T(-30 * DAY)), 'r1');
  add('age_plainBak', main, bakPlain(s1), 'keep', { mtimeMs: G - 30 * DAY });
  // s2 每会话 3 份(三种形态合计,古早 .bak 不占名额)
  add('cnt_1', main, hb(s2, T(-H1), tok('1')), 'keep');
  add('cnt_2', main, hbOld(s2, T(-2 * H1)), 'keep');
  add('cnt_3', main, bakTs(s2, T(-3 * H1)), 'keep');
  add('cnt_4', main, hb(s2, T(-4 * H1), tok('2')), 'r1');
  add('cnt_5', main, hb(s2, T(-5 * H1), tok('3')), 'r1');
  add('cnt_plainBak', main, bakPlain(s2), 'keep', { mtimeMs: G - 30 * DAY });
  // s3 同一时刻:按文件名字典序从大到小留 3 份
  for (const c of ['a', 'b', 'c', 'd']) add(`tie_${c}`, main, hb(s3, T(-H1), tok(c)), c === 'a' ? 'r1' : 'keep');
  // s4 正好 3 份全留
  for (const [i, c] of ['a', 'b', 'c'].entries()) add(`exact3_${i + 1}`, main, hb(s4, T(-(i + 1) * H1), tok(c)), 'keep');
  // s5 先按天数再按份数
  add('mix_exp1', main, hb(s5, T(-15 * DAY), tok('a')), 'r1');
  add('mix_exp2', main, hb(s5, T(-16 * DAY), tok('b')), 'r1');
  for (let d = 1; d <= 4; d += 1) add(`mix_f${d}`, main, hb(s5, T(-d * DAY), tok('c')), d === 4 ? 'r1' : 'keep');
  // s6 创建时刻在未来的文件不算备份(不占名额):3 份新的 + 1 份未来的,全留
  for (let i = 1; i <= 3; i += 1) add(`fut_${i}`, main, hb(s6, T(-i * H1), tok('a')), 'keep');
  add('fut_future', main, hb(s6, T(10 * DAY), tok('b')), 'keep');
  // s14 跨 14 天边界(不重启):创建时刻 = 夹具写入时刻 − 14 天 + 35 秒
  add('cross_14d', main, hb(s14, T(-14 * DAY + 35_000), tok('a')), 'cross');
  // s7 名字差一点 / 不是备份的东西:全部很旧(匹配的话一定会被删),全留
  const old = T(-20 * DAY); const u = '123e4567-e89b-12d3-a456-426614174000';
  const decoys = {
    jsonl_self: null,
    archived: `${s7}.jsonl.archived`, tmpTrim: `${s7}.jsonl.tmp-trim-${u}`, tok23: hb(s7, old, 'a'.repeat(23)), tok25: hb(s7, old, 'a'.repeat(25)), tokUpper: hb(s7, old, 'A'.repeat(24)),
    ts12: hb(s7, '176000000000', tok('a')), ts14: hb(s7, '17600000000000', tok('a')), tsLetter: hb(s7, '176000000000a', tok('a')), tsLeadingZero: hb(s7, '0176000000000', tok('a')),
    tmpSuffix: `${hb(s7, old, tok('a'))}.tmp`, bakTsX: `${bakTs(s7, old)}-x`, upperBAK: `${s7}.jsonl.BAK`, bakOld: `${s7}.jsonl.bak.old`,
    notesPrefix: `notes.jsonl.histbak-${old}-${tok('a')}`, xPrefix: `x${hb(s7, old, tok('a'))}`, jsonNotJsonl: `${s7}.json.histbak-${old}-${tok('a')}`,
  };
  for (const [k, name] of Object.entries(decoys)) if (name) add(`decoy_${k}`, main, name, 'keep', { mtimeMs: G - 20 * DAY });
  files.push({ key: 'decoy_jsonl_self', dir: main, name: `${s7}.jsonl`, expect: 'keep' });
  const subdirName = hb(s7, T(-21 * DAY), tok('e'));
  fs.mkdirSync(path.join(main, subdirName), { recursive: true }); fs.writeFileSync(path.join(main, subdirName, 'inner.txt'), 'inner\n');
  files.push({ key: 'decoy_subdir', dir: main, name: subdirName, expect: 'keep' }, { key: 'decoy_subdir_inner', dir: path.join(main, subdirName), name: 'inner.txt', expect: 'keep' });
  const linkName = hb(s7, T(-22 * DAY), tok('f'));
  fs.writeFileSync(path.join(H, 'outside-target.txt'), 'target\n');
  fs.symlinkSync(path.join(H, 'outside-target.txt'), path.join(main, linkName));
  files.push({ key: 'decoy_symlink', dir: main, name: linkName, expect: 'keep' }, { key: 'decoy_symlink_target', dir: H, name: 'outside-target.txt', expect: 'keep' });
  // s8 归属不明:同目录的 .jsonl 是软链接 → 备份一份不动(5 份新的,超过 3 份也不删)
  fs.writeFileSync(path.join(H, 'outside-real.jsonl'), `${userLine0()}\n`);
  fs.symlinkSync(path.join(H, 'outside-real.jsonl'), path.join(main, `${s8}.jsonl`));
  files.push({ key: 'unknown_jsonl_link', dir: main, name: `${s8}.jsonl`, expect: 'keep' });
  for (let i = 1; i <= 5; i += 1) add(`unknown_${i}`, main, hb(s8, T(-i * H1), tok('a')), 'keep');
  add('unknown_old', main, hb(s8, T(-20 * DAY), tok('b')), 'keep');
  // s9 会话记录不在了(gone):第一轮全留(含已过期的),第二轮删三种;古早 .bak 永远留
  add('gone_1', gone, hb(s9, T(-H1), tok('a')), 'r2');
  add('gone_2', gone, hbOld(s9, T(-2 * H1)), 'r2');
  add('gone_expired', gone, hb(s9, T(-15 * DAY), tok('b')), 'r2');
  add('gone_plainBak', gone, bakPlain(s9), 'keep', { mtimeMs: G - 30 * DAY });
  // s11 会话记录在别的工作区目录(elsewhere):一律不动
  putSession(elB, s11);
  for (let i = 1; i <= 5; i += 1) add(`else_${i}`, elA, hb(s11, T(-i * H1), tok('a')), 'keep');
  add('else_old', elA, hb(s11, T(-20 * DAY), tok('b')), 'keep');
  files.push({ key: 'else_jsonl', dir: elB, name: `${s11}.jsonl`, expect: 'keep' });
  // 不是工作区目录的条目:点开头的目录、软链接目录、普通文件 —— 里面的东西一律不动
  const hid = path.join(R, '.hidden-dir'); putSession(hid, s12); add('hidden_old', hid, hb(s12, T(-20 * DAY), tok('a')), 'keep');
  const out = path.join(H, 'outside-dir'); putSession(out, s13); add('linkdir_old', out, hb(s13, T(-20 * DAY), tok('a')), 'keep');
  fs.symlinkSync(out, path.join(R, 'sw-link'));
  fs.writeFileSync(path.join(R, 'not-a-dir.txt'), 'x\n');
  files.push({ key: 'plain_file_in_R', dir: R, name: 'not-a-dir.txt', expect: 'keep' });
  const man = { G, workspaceDirs: 4, expectRound1Deleted: files.filter((f) => f.expect === 'r1').length, expectRound2Deleted: files.filter((f) => f.expect === 'r2').length, files: files.map((f) => ({ ...f, dir: f.dir, path: path.join(f.dir, f.name) })) };
  fs.writeFileSync(art('sweep-manifest.json'), `${JSON.stringify(man, null, 2)}\n`);
}
const userLine0 = () => JSON.stringify({ type: 'user', message: { role: 'user', content: 'outside' } });

const mode = process.argv[2];
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (mode === 'main') writeMain();
  else if (mode === 'sweep') { fs.rmSync(guard(sweepHome()), { recursive: true, force: true }); fs.mkdirSync(path.join(sweepHome(), '.claude-gui'), { recursive: true }); fs.mkdirSync(path.join(sweepHome(), 'fake-claude'), { recursive: true }); writeSweep(); } else { process.stderr.write('用法:fixtures.mjs main|sweep\n'); process.exit(2); }
  process.stdout.write(`${mode} ok\n`);
}
