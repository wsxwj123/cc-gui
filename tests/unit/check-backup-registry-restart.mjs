#!/usr/bin/env node
// 单测:历史操作备份的**登记**(R25 那套的存储面)。
//
// 被锁的行为:服务端重启后登记表是空的,而备份文件仍在磁盘上 —— 此时用户点「在访达中显示」
// 必须还能用(凭 ref 把登记找回来),找不回来时给的话也不能让人以为文件被删了。
// 修前:纯内存 Map 一清,接口回 404「备份不存在或已被清理」,把"重启"说成了"清理"。
//
// 隔离:HOME 指到临时目录(绝不碰真实 ~/.claude),必须在 import 之前设好 ——
// session-reader 在模块加载时就解析 homedir()。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'cgui-histbak-'));
const HOME = join(ROOT, 'home');
const HASH = '-tmp-cgui-histbak';
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DIR = join(HOME, '.claude', 'projects', HASH);
mkdirSync(DIR, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME; // Windows 的 os.homedir() 读 USERPROFILE
const sessionFile = join(DIR, `${SID}.jsonl`);
writeFileSync(sessionFile, '{"type":"user","uuid":"x"}\n');

const { __writeHistoryBackup, __recoverBackup, __backupMissingText, __resetHistoryStores } =
  await import('../../server/routes/session-history.js');

// ── t1 写一份备份:ref 与文件名同源(时刻 + 令牌都编进两边)──
const RAW = '{"type":"user","uuid":"x","content":"备份的原文"}\n';
const ref = await __writeHistoryBackup(sessionFile, RAW, { sid: SID, projectHash: HASH, principal: 'local' });
assert.match(ref, /^bk-[0-9a-z]+-[0-9a-f]{24}$/, 't1: ref 形态 = bk-<创建时刻 base36>-<随机令牌 24 hex>');
const [, tsPart, token] = ref.split('-');
const backupPath = `${sessionFile}.histbak-${parseInt(tsPart, 36)}-${token}`;
assert.ok(existsSync(backupPath), `t1: 备份文件名必须与 ref 同源（期望 ${backupPath}）`);
assert.equal(readFileSync(backupPath, 'utf8'), RAW, 't1: 备份内容 = 写入的原文');

// ── t2 「重启」= 登记表清空；文件还在 → 凭 ref 必须把登记找回来 ──
__resetHistoryStores();
const back = await __recoverBackup(ref, SID, 'local');
assert.ok(back.entry, 't2: 重启后凭 ref 恢复登记（不许当成"不存在"）');
assert.equal(back.entry.path, backupPath, 't2: 恢复出的路径 = 当初写的那份');
assert.equal(back.entry.sid, SID, 't2: 会话绑定不变');
assert.equal(back.entry.projectHash, HASH, 't2: 项目 hash 从会话文件所在目录推出');
assert.equal(back.entry.principal, 'local', 't2: 主体按出示 ref 者记账');

// ── t3 令牌是保密的那一半：知道时刻也推不出文件（否则 ref 退化成可枚举）──
const wrongToken = await __recoverBackup(`bk-${tsPart}-${'0'.repeat(24)}`, SID, 'local');
assert.equal(wrongToken.entry, null, 't3: 令牌不对 → 定位不到');
assert.equal(wrongToken.reason, 'file-missing', 't3: 归到"磁盘上没有"，不是"认不出 ref"');

// ── t4 旧形态 ref（bk-<24 hex>，本版之前建的）：无从定位 → 另立一种说法 ──
const legacy = await __recoverBackup(`bk-${'a'.repeat(24)}`, SID, 'local');
assert.equal(legacy.entry, null, 't4: 旧形态 ref 不恢复');
assert.equal(legacy.reason, 'unresolvable', 't4: 与"文件不在"分开（文案不同）');

// ── t5 会话文件没有 → 不抛，同样按找不到处理 ──
const noSession = await __recoverBackup(ref, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'local');
assert.equal(noSession.entry, null, 't5: 会话文件不在 → 不恢复（也不抛）');

// ── t6 文件真被删了 → file-missing ──
__resetHistoryStores();
unlinkSync(backupPath);
const gone = await __recoverBackup(ref, SID, 'local');
assert.equal(gone.reason, 'file-missing', 't6: 文件真的没了才算"不在磁盘上"');

// ── t7 文案：不许把"服务端重启过"说成"备份已被清理" ──
const textUnresolvable = __backupMissingText('unresolvable');
assert.doesNotMatch(textUnresolvable, /已被清理|不存在/, 't7: 认不出 ref 时不得说文件被清理/不存在');
assert.match(textUnresolvable, /重启/, 't7: 如实说明常见原因是服务端重启过');
assert.match(textUnresolvable, /没有被动过/, 't7: 明确"备份文件本身没被动过"');
assert.match(textUnresolvable, /histbak/, 't7: 给出可自己去找的线索（文件名的后缀）');
assert.match(__backupMissingText('file-missing'), /不在磁盘上/, 't7: 文件确实不在时如实说不在磁盘上');

// ── t8 恢复过的 ref 进登记表（同进程后续请求直接命中，不再重复推路径）──
const again = await __recoverBackup(ref, SID, 'local');
assert.equal(again.entry, null, 't8: 文件已删，恢复不出来');

console.log('✓ check-backup-registry-restart: ref 与文件名同源、重启后凭 ref 找回登记、令牌仍是保密那一半、404 文案不谎称"已被清理"');
