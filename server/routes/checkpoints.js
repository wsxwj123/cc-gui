import { Router } from 'express';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { join, resolve as resolvePath, sep, basename, dirname } from 'path';
import { stat, mkdir, readFile, writeFile, rm, access, readdir } from 'fs/promises';
import { resolveWorkspacePath } from '../utils/safe-path.js';
import { CHECKPOINTS_ROOT } from '../utils/checkpoint-paths.js';
import { findSessionFile, readSessionTitles } from '../services/session-reader.js';
import { isLocalReq } from '../services/auth.js';
import { readJsonlEdges } from '../utils/jsonl-parser.js';
import { broadcastSessionFileChange } from './sessions.js';

const execFileP = promisify(execFile);
const router = Router();

// Checkpoints are stored as a shadow git index under ~/.claude/gui/checkpoints/<sessionId>/
// (a separate worktree-like directory keyed off GIT_DIR). We don't touch the
// user's real repo history; restores happen via `git --work-tree=<cwd> --git-dir=<shadow>
// checkout <sha> -- .` so the user's index/branch/staging is untouched.
// CHECKPOINTS_ROOT 来自 server/utils/checkpoint-paths.js(删会话连带清理要共用同一个根)。

function safe(p) {
  // Canonicalize `//+` and trailing `/` rather than reject — legacy project
  // dirs decode to non-canonical paths but are still valid.
  // resolveWorkspacePath = $HOME 门禁 + 已知 claude 工作区例外(Windows 项目在
  // D:\ 等其他盘、mac /tmp 下的会话文件,纯 $HOME 门禁让回滚报 outside $HOME)。
  return resolveWorkspacePath(p);
}

const SESSION_RE = /^[A-Za-z0-9_-]{1,80}$/;
function assertSession(id) {
  if (!SESSION_RE.test(String(id || ''))) throw new Error('invalid sessionId');
}

// ── 上限与安全阀(全部可配置;测试注入极小值触发)─────────────────────────
// 默认给宽:正常项目(源码)体积远在 1 GB 之下,不会误伤;真正会吃盘的只有
// "工作目录是几十 G 数据目录且没有 .gitignore"这种,那时按设计就该跳过。
function envNum(keys, dflt) {
  for (const k of keys) {
    const raw = process.env[k];
    if (raw == null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return dflt;
}
const MAX_SNAPSHOT_BYTES = () => envNum(['CGUI_CHECKPOINT_MAX_BYTES', 'CGUI_CHECKPOINTS_MAX_BYTES'], 2 * 1024 ** 3);
const MAX_SNAPSHOT_COUNT = () => envNum(['CGUI_CHECKPOINT_MAX_COUNT', 'CGUI_CHECKPOINTS_MAX_COUNT'], 20);
const RETENTION_DAYS = () => envNum(['CGUI_CHECKPOINT_RETENTION_DAYS', 'CGUI_CHECKPOINTS_RETENTION_DAYS'], 30);
// 每会话快照**总占用**上限(第三回收维,默认 10 GiB)。
// 为什么需要:条数(20)与天数(30)两维管不住"目录本身就很大"的场景 —— 大目录被用户点过
// 一次"保存"后,后续快照一路放行(每会话只问一次的设计),峰值 = 20 × 目录体积(45 GB 的
// 目录 ≈ 900 GB),等于把"磁盘被悄悄吃掉"换个形态还回来。
// 取值理由:单次快照上限(2 GB)的 5 倍、20 条理论峰值(40 GB)的 1/4 —— 几个大目录快照兜得住,
// 又远在普通源码项目(几十~几百 MB × 20 条)之上,不会把正常项目的 20 条砍掉。目录到 1 GB
// 量级才开始收紧(保留条数随目录变大递减),这正是要治的那类会话。
const MAX_SESSION_TOTAL_BYTES = () => envNum(
  ['CGUI_CHECKPOINT_MAX_TOTAL_BYTES', 'CGUI_CHECKPOINTS_MAX_TOTAL_BYTES'], 10 * 1024 ** 3);
// 保留时长是"天"级产品语义,测试要注入 1ms 得显式声明——避免有人把 30 误写成毫秒。
function retentionMs() {
  const days = RETENTION_DAYS();
  if (days > 0 && days < 1 && process.env.CGUI_ALLOW_TINY_CHECKPOINT_RETENTION !== '1') return 30 * 86400_000;
  return days * 86400_000;
}
// 估算上限:估算是"防呆"不是计量,遍历太大就早退(拿已知部分当答案)。
// 默认值给宽:普通源码项目远到不了,不会误伤 "正常项目也被跳过" 这一失败模式。
const ESTIMATE_MAX_FILES = () => envNum(['CGUI_CHECKPOINT_ESTIMATE_MAX_FILES'], 200_000);
const ESTIMATE_MAX_MS = () => envNum(['CGUI_CHECKPOINT_ESTIMATE_MAX_MS'], 4000);

/** 路径拼接后必须校验落在 roots 之下——rm -rf 不许越界。 */
function underRoot(dir, roots) {
  const abs = resolvePath(dir);
  return roots.some((r) => abs === r || abs.startsWith(r + sep));
}
/** 会话快照目录;sessionId 走白名单正则 + 前缀校验,双重保险。 */
function sessionDir(sessionId) {
  assertSession(sessionId);
  const d = join(CHECKPOINTS_ROOT, String(sessionId));
  if (!underRoot(d, [CHECKPOINTS_ROOT])) throw new Error('checkpoint path escapes root');
  return d;
}
async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function shadowDir(sessionId) {
  const d = join(CHECKPOINTS_ROOT, sessionId);
  await mkdir(d, { recursive: true });
  try { await stat(join(d, 'HEAD')); }
  catch {
    await execFileP('git', ['--git-dir', d, 'init', '--bare'], { timeout: 10000 });
  }
  return d;
}

async function gitShadow(args, sessionId, workTree, opts = {}) {
  const gitDir = await shadowDir(sessionId);
  // cwd 必须是 workTree:`checkout <sha> -- .` 的 `.` pathspec 相对 git 进程 cwd 解析,
  // 不设就落在 server 自己的目录(work-tree 之外)→ "pathspec '.' did not match"
  // (用户在无文件改动的消息上回滚时的还原失败根因)。
  // maxBuffer 32MB:默认 1MB 会让大仓库(2 万+ 文件)的 ls-tree/首次 commit 输出超限
  // 抛错 —— commit 实际已完成但请求报 500,meta 与 git log 漂移。timeout 60s 同理。
  // LC_ALL=C 固定英文错误输出:错误分类靠 regex 匹配英文串(pathspec did not match
  // 等),中文/其它 locale 下 git 输出本地化会让匹配全失效 → 空快照误判 restore_failed。
  // core.quotepath=off:否则 ls-tree --name-only 把中文/非 ASCII 名输出成 "\346\226..."
  // 转义带引号形态 → restore-file 的 targetFiles.includes(rel)(rel 是真 UTF-8)恒 false
  // → 中文名文件一律"不在快照中"404;差集删除也因 garbled 路径不存在而静默 no-op(残留)。
  return execFileP('git', ['--git-dir', gitDir, '--work-tree', workTree, '-c', 'core.quotepath=off',
    '-c', 'advice.graftFileDeprecated=false', ...args],
    { timeout: 60000, cwd: workTree, maxBuffer: 32 * 1024 * 1024, ...opts,
      env: { ...process.env, LC_ALL: 'C', ...(opts.env || {}) } });
}

async function loadMeta(sessionId) {
  // 只读,不许建目录 —— 否则删完再查列表又凭空把空目录造回来(验收 R3-1)。
  const d = await sessionDir_(sessionId);
  if (!d) return [];
  try {
    const raw = await readFile(join(d, 'meta.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function saveMeta(sessionId, entries) {
  const d = await shadowDir(sessionId);
  await writeFile(join(d, 'meta.json'), JSON.stringify({ entries: entries.slice(-500) }, null, 2));
}

function parseMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

function textPrefix(value) {
  return String(value || '').slice(0, 60);
}

// commit message 用的 label:换行塌成空格 —— git log %s 只取首行,多行 label 会让
// resolve 的 git-log 回落路径文本匹配失效(退化成纯时间窗)。
function oneLineLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function listTreeFiles(sessionId, workTree, sha) {
  const out = await gitShadow(['ls-tree', '-r', '--name-only', sha], sessionId, workTree);
  return out.stdout.trim().split('\n').filter(Boolean);
}

// ── 影子库直呼(不带 work-tree;清理/删除只跟仓打交道)────────────────────
async function gitIn(gitDir, args, opts = {}) {
  return execFileP('git', ['--git-dir', gitDir, '-c', 'advice.graftFileDeprecated=false', ...args],
    { timeout: 20000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }, ...opts });
}

/** 该会话全部快照 sha(新→旧)。认 replace,与界面看到的顺序一致。 */
async function listShas(sessionId) {
  const gitDir = await sessionDir_(sessionId);
  if (!(await pathExists(join(gitDir, 'HEAD')))) return [];
  try {
    const out = await gitIn(gitDir, ['log', '--format=%H']);
    return out.stdout.trim().split('\n').filter(Boolean);
  } catch { return []; }
}
/** 有则返回目录,不存在返回 null(不建仓——清理路径不该凭空造目录)。 */
async function sessionDir_(sessionId) {
  const d = sessionDir(sessionId);
  return (await pathExists(d)) ? d : null;
}

// ── R2 清理 + 真实回收 ────────────────────────────────────────────────────
// 坑:影子库里删提交后,`git gc --prune=now` / `git repack -a -d` 都不会真的回收
// 被删提交(实测:中间那条删完对象仍在)。原因是仓里还有挂着 HEAD 的 reflog 与
// 自动生成的 replace 引用,它们让对象"看起来仍可达";而且 git 自带命令在删提交
// 这件事上没有"只保留这 N 条"的入口(一条一条 revert 才是官方姿势,慢且会留垃圾)。
// 所以这里自己做诚实的可达集重打包:rev-list --objects --all(认 replace、认 graft)
// → pack-objects → 丢掉旧 pack → 扫掉不在可达集里的松散对象。改完 git log 与磁盘
// 严格一致,列出来的 sha 一定打得开。
async function repackHonest(gitDir) {
  let revs;
  try {
    revs = (await gitIn(gitDir, ['rev-list', '--objects', '--all'])).stdout;
  } catch { return; }
  if (!revs.trim()) return;
  const keep = new Set(revs.split('\n').map((l) => l.slice(0, 40).trim()).filter(Boolean));
  const packDir = join(gitDir, 'objects', 'pack');
  let packs = [];
  try { packs = (await readdir(packDir)).filter((f) => f.endsWith('.pack')); } catch { /* 无 */ }
  // 还没打过包的仓(新会话):直接扫掉不可达的松散对象即可。**故意不打包** ——
  // 三两条小快照的仓库,新 pack+.idx 的固定开销比删掉的对象还大,"清理完反而更大"。
  if (packs.length) {
    let newPack = '';
    try {
      const out = await new Promise((resolve, reject) => {
        const p = spawn('git', ['--git-dir', gitDir, 'pack-objects', '--non-empty',
          join(packDir, 'pack')], { stdio: ['pipe', 'pipe', 'pipe'] });
        let so = ''; let se = '';
        p.stdout.on('data', (b) => { so += b; });
        p.stderr.on('data', (b) => { se += b; });
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve(so) : reject(new Error(se || `pack-objects ${code}`))));
        p.stdin.on('error', () => {});   // git 早退时 stdin 写入 EPIPE:结果以 close 为准,别走 uncaughtException
        p.stdin.end(revs);
      });
      newPack = String(out).trim().split('\n').pop().trim();
    } catch { return; }                                   // 打包失败:保留原样,不清(宁可不省,不许删坏)
    try {
      for (const f of await readdir(packDir)) {
        if (newPack && f.includes(newPack)) continue;
        if (!/\.(pack|idx|rev|keep|bitmap)$/.test(f)) continue;
        try { await rm(join(packDir, f), { force: true }); } catch { /* 只读/被占,忽略 */ }
      }
    } catch { /* 目录不存在 */ }
  }
  // 松散对象:不在诚实可达集里的一律删(prune 在这套引用布局下不管用)。
  try {
    for (const d2 of await readdir(join(gitDir, 'objects'))) {
      if (!/^[0-9a-f]{2}$/.test(d2)) continue;
      const sub = join(gitDir, 'objects', d2);
      for (const f of await readdir(sub)) {
        if (!/^[0-9a-f]{38}$/.test(f)) continue;
        if (keep.has(d2 + f)) continue;
        try { await rm(join(sub, f), { force: true }); } catch { /* 忽略 */ }
      }
    }
  } catch { /* 忽略 */ }
}

/** 单条提交**新增**的对象占用(字节)。这是"这条快照进了多少新数据"的度量,
 *  逐条加起来 ≈ 整个会话的影子仓占用(增量口径,不是"最新那条的历史总账")。
 *
 *  口径:`git rev-list --objects <sha> --not <它的父们>` = 这条提交相对父提交新引入的
 *  对象集合(沿用影子仓既有的 reachable-set 口径,不新造算法、不 stat 用户目录)。
 *  父提交怎么算:直接用 `rev-list --parents` 读出来的真实父 —— detachShas 会写 info/grafts
 *  把残留提交的父改写成时间线上紧邻的下一个 keep,所以这里读到的就是**逻辑时间线**上的
 *  前一条,而不是磁盘上早已不存在的那些。读的是 git 自己的东西,不碰工作区。
 *
 *  代价与误差方向(决定这维偏松还是偏紧):
 *   * 每条快照 2 个进程(rev-list --parents + 断言对象的 cat-file),默认 20 条 ≈ 40 次 fork;
 *     只在本会话确实有东西可丢时才跑。大仓一次可达数秒 —— 正是它要护的那种场景。
 *   * `--batch-check` 给的是**压缩前**大小。git 对大文本/重复内容能压掉一大半 → 高估磁盘
 *     占用,这维**偏紧**(会多丢几条)。方向是有意选的:偏紧只损失"还能回滚到的更早版本",
 *     偏松就回到"删不掉、盘被吃"的老毛病(判官点出的那个遗留风险)。
 *   * 拿不到(git 失败/超时/父解析不出)返回 0 = "这条不占",绝不把清理搞挂。 */
async function shaBytes(gitDir, sha) {
  try {
    const head = (await gitIn(gitDir, ['rev-list', '--parents', '-n', '1', sha])).stdout.trim();
    if (!head) return 0;
    const parents = head.split(/\s+/).slice(1);                  // 第一个字段是自己
    // 父们也要列:不用 --not 的话会顺着父一路走上去,算出"历史累计"而不是"这条新增",
    // 20 条一累就是二次方(实测 20 × 64 KiB 会算成 ~13 MB)。
    const list = (await gitIn(gitDir, ['rev-list', '--objects', sha, ...(parents.length ? ['--not', ...parents] : [])])).stdout;
    // 每行是 "<sha>[ <path>]"(路径可含空格)→ 只取第一个字段,path 喂给 cat-file 会报 not a valid object
    const names = list.split('\n').map((l) => l.split(' ')[0].trim()).filter(Boolean);
    if (!names.length) return 0;
    let total = 0;
    await new Promise((resolve, reject) => {
      const c = spawn('git', ['--git-dir', gitDir, 'cat-file', '--batch-check'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      c.stdout.on('data', (b) => {
        for (const line of String(b).split('\n')) {
          const m = /^\S+ \S+ (\d+)$/.exec(line.trim());
          if (m) total += Number(m[1]);
        }
      });
      c.on('error', reject);
      c.on('close', () => resolve());
      c.stdin.on('error', () => {});   // 同 pack-objects:EPIPE 不外泄
      c.stdin.end(names.join('\n') + '\n');
    });
    return total;
  } catch (e) {
    // 计量失败 = 这条按 0 计(这维对它失效)。留一行日志:否则"上限静默失效"无法察觉。
    console.warn('[checkpoints] 总占用计量失败,该条按 0 计:', sha.slice(0, 8), e.message);
    return 0;
  }
}

/**
 * 每会话保留最近 N 条(默认 20)、最长 M 天(默认 30)、总占用不超过 B 字节(默认 10 GiB)。
 * 三维**取最严**:任一条命中就丢;丢的顺序恒为从最旧开始。只在快照创建成功后调用。
 * 删不掉也绝不把 snapshot 搞挂——这里抛的错由调用方吞。
 * opts.maxCount / opts.maxAgeMs / opts.maxTotalBytes / opts.bytesOf 让 R3 单条删除与测试
 * 复用同一套"删提交 + 对账 meta"逻辑。
 */
async function gcSession(sessionId, opts = {}) {
  const gitDir = await sessionDir_(sessionId);
  if (!gitDir) return { removed: 0 };
  const log = await listShas(sessionId);                            // 新→旧
  if (log.length === 0) return { removed: 0 };
  const maxCount = opts.maxCount != null ? opts.maxCount : MAX_SNAPSHOT_COUNT();
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : retentionMs();
  const maxTotalBytes = opts.maxTotalBytes != null ? opts.maxTotalBytes : MAX_SESSION_TOTAL_BYTES();
  // 时间维:meta 的 ts 是用户消息口径(与会话裁剪同源),比 commit ct 准。
  const meta = await loadMeta(sessionId);
  const tsOf = new Map(meta.filter((e) => e.sha).map((e) => [e.sha, e.messageTimestamp || e.ts || 0]));
  const now = Date.now();
  const dropped = [];
  const keep = [];
  log.forEach((sha, i) => {
    const ts = tsOf.get(sha) || 0;
    const tooOld = maxAgeMs > 0 && ts > 0 && now - ts > maxAgeMs;
    if (i >= maxCount || tooOld) dropped.push(sha); else keep.push(sha);
  });
  // 总占用维:先占住最新那条(保底),再从次新往旧累加,装不下就丢 —— 丢的顺序仍是
  // "从最旧开始"。先判断有没有可丢的(log 只有一条 = 前两维没动、也没料可丢),
  // 免得每次拍快照都白起一堆 git 进程去量。
  if (maxTotalBytes > 0 && (keep.length > 1 || dropped.length > 0)) {
    const bytesOf = typeof opts.bytesOf === 'function'
      ? opts.bytesOf
      : (sha) => shaBytes(gitDir, sha);
    const b = new Map(await Promise.all(log.map(async (sha) => [sha, await bytesOf(sha)])));
    const sizeOf = (sha) => b.get(sha) || 0;
    // 保底那条(最新的一条)先占住,再从次新往旧累加、装不下就丢 —— 这样丢的顺序恒为
    // "从最旧开始",且总占用维永远不会把会话清空(新版必须始终可回滚)。
    const floor = keep.length ? keep[0] : log[0];
    const kept = [floor];
    let total = sizeOf(floor);
    for (const sha of keep.slice(1)) {                        // 次新 → 旧(keep 本就是新→旧)
      if (total + sizeOf(sha) > maxTotalBytes) { dropped.push(sha); continue; }
      total += sizeOf(sha);
      kept.push(sha);
    }
    keep.length = 0;
    keep.push(...kept);                                       // kept 已是新→旧
  }
  if (!dropped.length) return { removed: 0 };
  // 保底:至少留最新一条,否则条数/时间维(测试注入极小值)会把会话清空。
  if (!keep.length) {
    keep.push(dropped.shift());
  }
  await detachShas(gitDir, dropped, keep);
  const removed = new Set(dropped);
  await saveMeta(sessionId, meta.filter((e) => !removed.has(e.sha)));
  return { removed: dropped.length };
}

// ── r122 R5:会话级互斥 ────────────────────────────────────────────────────
// 同一会话的影子仓同一时刻只许一路在改(POST 后的 gcCheckpoints / DELETE / 启动清扫):
// 两路 detachShas + repackHonest 撞在一起会互删对方刚打好的 pack。"先占再放":清理类
// 路径占不到就跳过本次(下次拍快照再收);删除类路径等一小会儿(用户的删除不该因为
// 后台清扫正好扫到它而失败)。
// 取舍(2026-09-21 裁定):两个 DELETE 路由**等锁至多 15 秒**而不是跳过 —— 跳过等于让用户的
// 删除无故失败;POST 后的回收与启动清扫本身占不到锁就跳过本次,它们下次还有机会。
const gcInFlight = new Set();
function tryAcquireGc(sessionId) {
  if (gcInFlight.has(sessionId)) return false;
  gcInFlight.add(sessionId);
  return true;
}
function releaseGc(sessionId) { gcInFlight.delete(sessionId); }
/** 等锁(上限 waitMs);等不到也放行 —— 删除路径的 rm 是 force 的,真撞上也只是多一次 no-op。 */
async function waitGc(sessionId, waitMs = 15_000) {
  const deadline = Date.now() + waitMs;
  while (!tryAcquireGc(sessionId)) {
    if (Date.now() > deadline) { gcInFlight.add(sessionId); return; }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 会话目录内的清理入口(POST 拍快照成功后)。占不到锁 = 启动清扫正在收这个会话,本次跳过。 */
async function gcCheckpoints(sessionId) {
  if (!tryAcquireGc(sessionId)) return { removed: 0, skipped: 'busy' };
  try { return await gcSession(sessionId); } finally { releaseGc(sessionId); }
}

// ── r122 R5:启动后后台清扫一遍 ──────────────────────────────────────────
// 背景:r120 的自动回收只在"该会话下次拍快照"时触发,升级前就已超限、之后不再使用的旧会话
// 永远收不掉(实测一个会话留了 286 条 / 815 MB)。服务起来后延迟一段时间,逐个会话按既有规则
// (条数 / 天数 / 总占用,从最旧开始、保底最新一条)回收一遍,不需要该会话再拍快照。
//   CGUI_CHECKPOINT_SWEEP=0            关闭(默认开)
//   CGUI_CHECKPOINT_SWEEP_DELAY_MS     启动后多久开始(默认 60000)
//   CGUI_CHECKPOINT_SWEEP_IDLE_MS      "最近有活动"的窗口(默认 600000),活动 = meta.json 的修改时间
const SWEEP_IDLE_MS = () => envNum(['CGUI_CHECKPOINT_SWEEP_IDLE_MS'], 600_000);

/** 排程判定(纯函数,给 index.js 与单测):enabled=false 就不排 setTimeout;delayMs 非法/缺省 = 60 秒。 */
export function checkpointSweepPlan(env = process.env) {
  const enabled = String(env.CGUI_CHECKPOINT_SWEEP ?? '') !== '0';
  const raw = env.CGUI_CHECKPOINT_SWEEP_DELAY_MS;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return { enabled, delayMs: Number.isFinite(n) && n >= 0 ? n : 60_000 };
}

/**
 * 便宜粗筛(R5-7):没超限的会话只做 stat / 读 meta 级别的检查,不为它们起一堆 git 进程。
 *   ① 条数:meta 条数已超 → 直接判超(零 git);否则至多一次 `rev-list --count HEAD`
 *      (影子仓里还有 restore 前自动拍的 pre-restore 提交,它们没有 meta 条目,gcSession 按
 *      git log 数,这里也得按 git 数才不会漏掉);
 *   ② 时间:meta 最旧的 messageTimestamp||ts 早于保留期(与 gcSession 同口径,没有 ts 的不算旧);
 *   ③ 总占用:dirBytes(纯 stat,checkpoints-stats 就是它)对比上限。dirBytes 是磁盘上压缩后的
 *      数字,比 gcSession 精确计量用的"压缩前对象大小之和"偏小 → 这维偏松:只有磁盘上确实
 *      超了才去精确算;用户在意的正是磁盘。
 * 任一超 → 交给 gcSession(它内部精确计量并回收);三维都没超 → 不碰。
 */
async function coarseOverLimit(dir, { now, maxCount, maxAgeMs, maxTotalBytes }, io = {}) {
  let entries = [];
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    entries = Array.isArray(parsed.entries) ? parsed.entries.filter((e) => e && e.sha) : [];
  } catch { /* 没有 meta:靠 git 数 */ }
  let count = entries.length;
  if (maxCount > 0 && count > maxCount) return { over: true, reason: 'count', count };
  const countOf = io.gitCount || (async (d) => {
    if (!(await pathExists(join(d, 'HEAD')))) return 0;
    try { return Number((await gitIn(d, ['rev-list', '--count', 'HEAD'])).stdout.trim()) || 0; } catch { return 0; }
  });
  count = Math.max(count, await countOf(dir));
  if (!count) return { over: false, reason: 'empty', count };
  if (maxCount > 0 && count > maxCount) return { over: true, reason: 'count', count };
  if (maxAgeMs > 0) {
    let oldest = 0;
    for (const e of entries) {
      const ts = Number(e.messageTimestamp || e.ts || 0);
      if (ts > 0 && (oldest === 0 || ts < oldest)) oldest = ts;
    }
    if (oldest > 0 && now - oldest > maxAgeMs) return { over: true, reason: 'age', count };
  }
  if (maxTotalBytes > 0 && count > 1) {
    const bytes = await (io.dirBytes || dirBytes)(dir);
    if (bytes > maxTotalBytes) return { over: true, reason: 'bytes', count, bytes };
  }
  return { over: false, count };
}

/**
 * 扫一遍所有会话的回滚点(可注入,便于单测;生产由 runStartupSweep 调)。串行、每个会话之间
 * 歇 pauseMs,任何单会话失败只计数不抛。返回汇总 { scanned, reclaimed, gcCalls, skippedActive,
 * skippedInvalid, skippedBusy, failed, ms }。
 *   opts.root / now / idleMs / maxCount / maxAgeMs / maxTotalBytes / gc(sessionId) / pauseMs / log / io
 */
export async function sweepAllSessions(opts = {}) {
  const root = opts.root || CHECKPOINTS_ROOT;
  const now = opts.now ?? Date.now();
  const idleMs = opts.idleMs ?? SWEEP_IDLE_MS();
  const limits = {
    now,
    maxCount: opts.maxCount ?? MAX_SNAPSHOT_COUNT(),
    maxAgeMs: opts.maxAgeMs ?? retentionMs(),
    maxTotalBytes: opts.maxTotalBytes ?? MAX_SESSION_TOTAL_BYTES(),
  };
  const gc = opts.gc || ((sid) => gcSession(sid, {
    maxCount: limits.maxCount, maxAgeMs: limits.maxAgeMs, maxTotalBytes: limits.maxTotalBytes,
  }));
  const pauseMs = opts.pauseMs ?? 150;
  const log = opts.log || ((line) => console.log(line));
  const startedAt = Date.now();
  const sum = { scanned: 0, reclaimed: 0, gcCalls: 0, skippedActive: 0, skippedInvalid: 0, skippedBusy: 0, failed: 0, ms: 0 };
  let dirs = [];
  try { dirs = await readdir(root, { withFileTypes: true }); } catch { dirs = []; }   // 根目录还不存在 = 没什么可扫
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    if (!SESSION_RE.test(id)) { sum.skippedInvalid += 1; continue; }     // 白名单外的目录名一律不碰
    sum.scanned += 1;
    try {
      const dir = join(root, id);
      // ② 最近有活动(meta.json 刚被写过)→ 留给它自己的拍快照路径处理,别和正在进行的快照打架。
      let metaMtime = 0;
      try { metaMtime = (await stat(join(dir, 'meta.json'))).mtimeMs; } catch { /* 没有 meta = 不算活跃 */ }
      if (idleMs > 0 && metaMtime > 0 && now - metaMtime < idleMs) { sum.skippedActive += 1; continue; }
      const verdict = await coarseOverLimit(dir, limits, opts.io || {});
      if (!verdict.over) continue;
      if (!tryAcquireGc(id)) { sum.skippedBusy += 1; continue; }        // 正被 POST/DELETE 占着:下次
      let r;
      try { r = await gc(id); } finally { releaseGc(id); }
      sum.gcCalls += 1;
      sum.reclaimed += Number(r?.removed) || 0;
    } catch (e) {
      sum.failed += 1;
      console.warn('[checkpoints] sweep 单个会话失败(继续下一个):', id, e?.message || e);
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  sum.ms = Date.now() - startedAt;
  log(`[checkpoints] sweep 完成: 扫描 ${sum.scanned} 个会话, 回收 ${sum.reclaimed} 条, 活跃跳过 ${sum.skippedActive}, 耗时 ${sum.ms} ms`
    + (sum.failed || sum.skippedBusy || sum.skippedInvalid ? `（失败 ${sum.failed}, 占用跳过 ${sum.skippedBusy}, 非法目录名 ${sum.skippedInvalid}）` : ''));
  return sum;
}

/** 一次进程只跑一遍;整个 run 包 try/catch,任何异常只打日志、不影响服务。 */
let sweepStarted = false;
export async function runStartupSweep(opts = {}) {
  if (sweepStarted) return null;
  sweepStarted = true;
  try { return await sweepAllSessions(opts); }
  catch (e) { console.warn('[checkpoints] sweep 失败(已忽略,不影响服务):', e?.message || e); return null; }
}

/**
 * 从影子库里摘掉若干提交,让 keep 这些提交照常可 checkout/可 resolve。
 * 做法:先把 HEAD 指到 keep 里最新的一条(它就是"当前状态"),再用 graft 把每个
 * keep 提交的父改成时间线上紧邻的另一个 keep 提交(最后一条 graft 成 root)。
 * 删掉的提交随之变成不可达,由 repackHonest 真正回收。
 *
 * graft 写 info/grafts 文件,不写 `git replace --graft` —— 后者会为每个被 graft 的
 * 提交额外造一个"改过父"的提交对象,并挂在 refs/replace/<原 sha> 下。那个对象
 * **本身是个提交**,于是 `rev-list --all` 把它也数进去:"磁盘上真实存在的提交条数"
 * 比列表多一条(每条被 graft 的 keep 各多一条),看着就是空间没回收干净。改用文件
 * graft 后:git log 照常按 keep 链显示、checkout 照常可用,但可达集里不再多出
 * 幽灵提交,rev-list 与列表严格对齐。
 * (info/grafts 已被 git 标记"过时"但仍完全支持,rev-list/repack 也认它,见
 *  repackHonest 注释;写各处的 -c advice.graftFileDeprecated=false 与它配套,别删。)
 */
async function detachShas(gitDir, dropped, keep) {
  if (!keep.length) return;
  try { await gitIn(gitDir, ['update-ref', 'HEAD', keep[0]]); } catch { /* 忽略 */ }
  // 每个 keep 提交父 → 时间线上紧邻的下一个 keep(最后一条无父 = root)。不建 graft 的话
  // 每个 keep 的真实父正被删掉,`git log` 会立刻 "Failed to traverse parents" 报错。
  try {
    await mkdir(join(gitDir, 'info'), { recursive: true });
    await writeFile(join(gitDir, 'info', 'grafts'),
      keep.map((sha, i) => `${sha}${keep[i + 1] ? ` ${keep[i + 1]}` : ''}`).join('\n') + '\n');
  } catch { /* 写不了 = 保持原样,log 仍按真实历史走,不炸 */ }
  // replace 引用一律清掉:本函数已不再新建,但旧版本对 keep 提交建的 refs/replace/*
  // 会一直在——每个都挂着一个幽灵提交,不清就永远 rev-list 数多一条。
  for (const sha of [...keep, ...dropped]) {
    try { await gitIn(gitDir, ['replace', '-d', sha]); } catch { /* 没有就算了 */ }
  }
  try { await gitIn(gitDir, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']); } catch {}
  try { await rm(join(gitDir, 'logs'), { recursive: true, force: true }); } catch {}
  await repackHonest(gitDir);
}

// ── 体积估算(安全阀用)───────────────────────────────────────────────────
// 只 stat 不读内容:用户目录可能有几十 G,读一遍等于把盘再写一遍。
// 用 `git ls-files -co --exclude-standard` 让 git 自己套 .gitignore(不重新实现忽略
// 规则),顺带拿到"会被 add -A 收进去"的那份文件清单——口径与快照一致。
// 上限(文件数 / 时长)命中就带着已统计的部分早退:估算是防呆,精确值无意义。
// 返回 { bytes, files, truncated }。
async function estimateWorkTreeBytes(sessionId, workTree) {
  const maxFiles = ESTIMATE_MAX_FILES();
  const budget = ESTIMATE_MAX_MS();
  const deadline = Date.now() + budget;
  let bytes = 0;
  let files = 0;
  let truncated = false;

  let listing = '';
  try {
    const out = await gitShadow(['ls-files', '-co', '--exclude-standard', '-z'], sessionId, workTree,
      { timeout: Math.max(1000, budget) });
    listing = out.stdout;
  } catch {
    return { bytes: 0, files: 0, truncated: true };   // 列不出来 = 不敢拍,按超限处理
  }

  for (const rel of listing.split('\0')) {
    if (!rel) continue;
    if (files >= maxFiles) { truncated = true; break; }
    files += 1;
    if ((files & 0xff) === 0 && Date.now() > deadline) { truncated = true; break; }
    try { bytes += (await stat(join(workTree, rel))).size; } catch { /* 竞态删除,忽略 */ }
  }
  return { bytes, files, truncated };
}

async function removeWorktreePath(workTree, rel) {
  if (!rel || rel.includes('\0') || rel.startsWith('../') || rel === '..') return;
  const root = resolvePath(workTree);
  const abs = resolvePath(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return;
  // 嵌套 git 仓库保护:shadow 快照里 gitlink 无内容,rm 掉整个子仓库(含未推送
  // 提交)后无法从快照重建 —— 原生 git checkout 会拒删嵌套 .git,这里对齐。
  try {
    await stat(join(abs, '.git'));
    console.warn('[checkpoints] skip removing embedded git repo:', abs);
    return;
  } catch { /* 无 .git → 正常删除 */ }
  await rm(abs, { force: true, recursive: true });
}

function relativeToWorkTree(workTree, file) {
  const root = resolvePath(workTree);
  const abs = resolvePath(file);
  if (abs === root || !abs.startsWith(root + sep)) throw new Error('file outside cwd');
  // 统一正斜杠:git ls-tree 输出恒为 `/` 分隔,Windows 上 resolve 产出 `\` —— 直接
  // 比较 targetFiles.includes(rel) 必 false,会把要还原的文件误判为"快照中没有"。
  return abs.slice(root.length + 1).split(sep).join('/');
}

async function fileExists(file) {
  try { await access(file); return true; }
  catch { return false; }
}

/** POST /api/checkpoints  { sessionId, cwd, label } */
router.post('/checkpoints', async (req, res) => {
  try {
    const { sessionId, cwd, label, clientMessageId, messageTimestamp, promptPreview, allowOversize } = req.body || {};
    assertSession(sessionId);
    const workTree = safe(cwd);
    // R1 体积安全阀:`add -A` 是无条件全量收进影子库,大目录(几十 G 数据目录、无
    // .gitignore)每拍一次就是一份全量副本(git 对大二进制不做增量)。先估算,超阈值
    // 就不拍——但**照常回 200 + skipped**,让调用方(界面)能如实告诉用户。
    // R7/D7 例外:调用方带上 allowOversize:true = 用户已在弹窗里选过"保存"这个大目录,
    // 照常拍。不带标记时的语义与 R1 一字不变(既有验收/既有调用方零影响)。
    //
    // 安全:这个上限护的是【主机磁盘】,标记本身是调用方自报,不能谁带谁过关 ——
    // 公开版默认开局域网 + 随机密码,已授权但不可信的远端(手机/别的机器)甚至被注入的
    // 页面都能一个请求让服务端把几十 G 目录整份复制进 ~/.claude/gui/ 打满盘。所以只认
    // 【本机(回环)请求】的标记;远端即使带了也照旧"跳过 + 原因"。判据复用服务端既有的
    // isLocalReq(回环 socket ∧ 无 CF 隧道标记 ∧ Host 是本机集,拿不准一律判外部),
    // "用户确实点了保存"这件事只有本机界面证明得了。
    const allowOversizeTrusted = allowOversize === true && isLocalReq(req);
    const maxBytes = MAX_SNAPSHOT_BYTES();
    const hadRepo = await pathExists(join(CHECKPOINTS_ROOT, String(sessionId)));
    const est = await estimateWorkTreeBytes(sessionId, workTree);
    if (!allowOversizeTrusted && (est.truncated || est.bytes > maxBytes)) {
      // 估算本身会建影子仓(git ls-files 要一个 git-dir)。这次什么都没拍,把刚建的
      // 空仓收掉——否则每被跳过一次就白留一份 ~25 KB 的裸仓(174 个会话就是这么堆起来的)。
      if (!hadRepo) {
        try { await rm(join(CHECKPOINTS_ROOT, String(sessionId)), { recursive: true, force: true }); } catch {}
      }
      return res.json({
        ok: true,
        skipped: true,
        reason: est.truncated
          ? '工作目录过大或无忽略规则,未创建回滚点(估算超时/超量,避免整目录复制)'
          : `工作目录约 ${Math.round(est.bytes / 1024 / 1024)} MB,超过回滚点体积上限 ${Math.round(maxBytes / 1024 / 1024)} MB,未创建回滚点`,
        estimatedBytes: est.bytes,
        limitBytes: maxBytes,
        truncated: est.truncated,      // 界面据此把"约 X"改成"至少 X"(估算被截断时只是下界)
      });
    }
    await gitShadow(['add', '-A'], sessionId, workTree);
    try {
      await gitShadow(
        ['commit', '--allow-empty', '-q', '-m', oneLineLabel(label) || `checkpoint ${new Date().toISOString()}`],
        sessionId, workTree,
        { env: { GIT_AUTHOR_NAME: 'claude-gui', GIT_AUTHOR_EMAIL: 'gui@claude', GIT_COMMITTER_NAME: 'claude-gui', GIT_COMMITTER_EMAIL: 'gui@claude' } },
      );
      const rev = await gitShadow(['rev-parse', 'HEAD'], sessionId, workTree);
      const sha = rev.stdout.trim();
      const entries = await loadMeta(sessionId);
      entries.push({
        sha,
        ts: Date.now(),
        label: label || '',
        cwd: workTree,
        clientMessageId: String(clientMessageId || ''),
        messageTimestamp: parseMs(messageTimestamp),
        promptPreview: textPrefix(promptPreview || label || ''),
      });
      await saveMeta(sessionId, entries);
      // R2 自动清理:只在拍成功后跑一次(不在每个请求上跑全量扫描)。
      try { await gcCheckpoints(sessionId); } catch { /* 清理失败不影响本次快照 */ }
      res.json({ ok: true, sha });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/checkpoints/:sessionId */
router.get('/checkpoints/:sessionId', async (req, res) => {
  try {
    assertSession(req.params.sessionId);
    // meta.json 优先:messageTimestamp 是消息落盘口径,与会话裁剪(trim fromTimestamp)
    // 同源;git commit ct 是"add -A 完成后"的秒级时间,大仓下晚数秒 → 面板 restore 按
    // ct 裁剪会少裁一段(或竞态反向把触发消息裁掉)。meta 为空才回落 git log。
    const meta = await loadMeta(req.params.sessionId);
    if (meta.length) {
      const entries = meta
        .filter((e) => e.sha)
        .map((e) => ({ sha: e.sha, ts: e.messageTimestamp || e.ts, label: e.label || e.promptPreview || '' }))
        .reverse();
      return res.json({ entries });
    }
    const gitDir = await sessionDir_(req.params.sessionId);
    if (!gitDir) return res.json({ entries: [] });
    try {
      const out = await gitIn(gitDir, ['log', '--format=%H%x09%ct%x09%s'], { timeout: 10000 });
      const entries = out.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [sha, ts, ...rest] = line.split('\t');
        return { sha, ts: Number(ts) * 1000, label: rest.join('\t') };
      });
      res.json({ entries });
    } catch {
      res.json({ entries: [] });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/checkpoints/:sessionId/resolve?timestamp=&text= */
router.get('/checkpoints/:sessionId/resolve', async (req, res) => {
  try {
    assertSession(req.params.sessionId);
    const targetTs = parseMs(req.query.timestamp);
    const prefix = textPrefix(req.query.text);
    const before = req.query.before === 'true';
    const meta = await loadMeta(req.params.sessionId);
    const scored = meta
      .filter((e) => e.sha && /^[a-f0-9]{7,40}$/.test(e.sha))
      .map((e) => {
        const sameText = !prefix || !e.promptPreview || prefix.startsWith(e.promptPreview) || e.promptPreview.startsWith(prefix);
        const baseTs = e.messageTimestamp || e.ts || 0;
        if (before && targetTs && baseTs > targetTs) return null;
        const delta = targetTs ? (before ? targetTs - baseTs : Math.abs(baseTs - targetTs)) : 0;
        return { entry: e, score: (sameText ? 0 : 1000000000) + delta };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);
    const best = scored[0];
    if (best && best.score < 1000000000 + (before ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000)) {
      return res.json({ sha: best.entry.sha, source: 'meta' });
    }

    const gitDir = await shadowDir(req.params.sessionId);
    const out = await gitIn(gitDir, ['log', '--format=%H%x09%ct%x09%s'], { timeout: 10000 });
    const fallback = out.stdout.trim().split('\n').filter(Boolean)
      .map((line) => {
        const [sha, ts, ...rest] = line.split('\t');
        const label = rest.join('\t');
        // pre-restore commit 不是用户消息锚点(restore 前自动拍的现状快照)——选中它
        // 会把文件恢复成"上次回滚前"的状态。git-log 回落路径排除。
        if (/^pre-restore /.test(label)) return null;
        const sameText = !prefix || label.includes(prefix);
        const baseTs = Number(ts) * 1000;
        if (before && targetTs && baseTs > targetTs) return null;
        const delta = targetTs ? (before ? targetTs - baseTs : Math.abs(baseTs - targetTs)) : 0;
        return { sha, score: (sameText ? 0 : 1000000000) + delta };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)[0];
    if (fallback && fallback.score < 1000000000 + (before ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000)) {
      return res.json({ sha: fallback.sha, source: 'log' });
    }
    res.status(404).json({ error: 'checkpoint not found' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/checkpoints/:sessionId/restore  { sha, cwd } */
router.post('/checkpoints/:sessionId/restore', async (req, res) => {
  try {
    assertSession(req.params.sessionId);
    const { sha, cwd } = req.body || {};
    if (!/^[a-f0-9]{7,40}$/.test(String(sha || ''))) throw new Error('invalid sha');
    const workTree = safe(cwd);
    // pre-restore 快照:shadow HEAD 停留在"发消息前"的 checkpoint,AI 之后新建的
    // 文件从未进过 shadow → 不在 headFiles 差集里,回滚后会残留。先把当前真实状态
    // commit 进 shadow(顺带留下一份可 redo 的快照),再算差集。失败不阻断主流程。
    try {
      await gitShadow(['add', '-A'], req.params.sessionId, workTree);
      await gitShadow(['commit', '--allow-empty', '-q', '-m', `pre-restore ${new Date().toISOString()}`],
        req.params.sessionId, workTree,
        { env: { GIT_AUTHOR_NAME: 'claude-gui', GIT_AUTHOR_EMAIL: 'gui@claude', GIT_COMMITTER_NAME: 'claude-gui', GIT_COMMITTER_EMAIL: 'gui@claude' } });
    } catch { /* 快照失败(嵌入式仓库等)→ 退回旧行为:新增文件可能残留 */ }
    const headFiles = await listTreeFiles(req.params.sessionId, workTree, 'HEAD').catch(() => []);
    const targetFiles = await listTreeFiles(req.params.sessionId, workTree, sha);
    const targetSet = new Set(targetFiles);
    // 空树快照:`checkout <sha> -- .` 会抛 pathspec 错,让下面的删除循环整个跳过 →
    // AI 新建文件全残留(用户报"回滚了但文件没动")。空树时不 checkout,只跑删除循环。
    if (targetFiles.length > 0) {
      await gitShadow(['checkout', sha, '--', '.'], req.params.sessionId, workTree);
    }
    for (const rel of headFiles) {
      if (!targetSet.has(rel)) await removeWorktreePath(workTree, rel);
    }
    // 不再 `git clean -fd`:未跟踪文件(用户手工建的 notes.txt 等)不属 shadow git 管辖,
    // 清掉会丢用户数据。已跟踪文件的删除由上面的 removeWorktreePath 循环处理。
    // 通知他端会话可能已变(打包版无 watcher)。回滚 UI 是 restore+trim 连发,trim 的
    // 广播已覆盖 jsonl;这里给单独 restore 的路径兜底,他端 refetch 幂等无害。
    // projectHash 推导与 chat.js:33 同式(cwd 非字母数字全换 '-');即便 resolveWorkspacePath
    // 规范化让 hash 与真实目录名有出入也无碍——客户端判据只看 `/projects/` 与 `/<sid>.jsonl` 后缀。
    try {
      const projectHash = String(workTree).replace(/[^A-Za-z0-9]/g, '-');
      broadcastSessionFileChange(join(homedir(), '.claude', 'projects', projectHash, `${req.params.sessionId}.jsonl`));
    } catch {}
    res.json({ ok: true, removedSinceCheckpoint: headFiles.filter((rel) => !targetSet.has(rel)).length });
  } catch (err) {
    // 区分"快照本身没文件"(pathspec 不匹配,工作区确实未动)、快照对象不存在(bad
    // object,文件一字未动)与其他失败(超时把 checkout 杀在半路=可能部分还原)。
    const msg = err.message || '';
    let code = 'restore_failed';
    if (/pathspec .* did not match/.test(msg)) code = 'empty_checkpoint';
    else if (/bad object|not a valid object|Not a valid object name/i.test(msg)) code = 'missing_snapshot';
    res.status(400).json({ error: msg, code });
  }
});

/** POST /api/checkpoints/:sessionId/restore-file  { sha, cwd, file, allowDelete } */
router.post('/checkpoints/:sessionId/restore-file', async (req, res) => {
  try {
    assertSession(req.params.sessionId);
    const { sha, cwd, file, allowDelete } = req.body || {};
    if (!/^[a-f0-9]{7,40}$/.test(String(sha || ''))) throw new Error('invalid sha');
    const workTree = safe(cwd);
    const absFile = safe(file);
    const rel = relativeToWorkTree(workTree, absFile);
    const targetFiles = await listTreeFiles(req.params.sessionId, workTree, sha);
    if (!targetFiles.includes(rel)) {
      // "快照里没有此文件"≠"该删除":shadow git 的 add -A 尊重 .gitignore,被
      // ignore 的文件(CLAUDE.local.md 等)永远不进快照——无条件删除等于把一次
      // "恢复"变成销毁(且 UI 报成功)。只有调用方显式声明(write 类=本轮新建)
      // 才允许走删除分支,否则 404 让前端如实报"快照中无此文件"。
      if (allowDelete !== true) {
        return res.status(404).json({ error: '该文件不在此快照中(可能被 .gitignore 排除),已保持原样' });
      }
      if (await fileExists(absFile)) await removeWorktreePath(workTree, rel);
      return res.json({ ok: true, deleted: true });
    }
    await gitShadow(['checkout', sha, '--', rel], req.params.sessionId, workTree);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** DELETE /api/checkpoints/:sessionId —— 删掉该会话的全部快照 */
router.delete('/checkpoints/:sessionId', async (req, res) => {
  let locked = null;
  try {
    const dir = sessionDir(req.params.sessionId);
    if (!(await pathExists(dir))) {
      return res.status(404).json({ error: 'checkpoint session not found', code: 'CHECKPOINT_NOT_FOUND' });
    }
    // r122:启动清扫可能正在收这个会话 —— 等它放手再删,免得 rm 与 repack 互踩(gcSession 对
    // 目录消失本就返回 removed:0,这里只是不让两路同时改)。
    await waitGc(req.params.sessionId); locked = req.params.sessionId;
    await rm(dir, { recursive: true, force: true });
    // 目录整个没了,meta 也随之消失,列表自然为空。
    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 'CHECKPOINT_NOT_FOUND' });
  } finally {
    if (locked) releaseGc(locked);
  }
});

/** DELETE /api/checkpoints/:sessionId/:sha —— 只删一条 */
router.delete('/checkpoints/:sessionId/:sha', async (req, res) => {
  let locked = null;
  try {
    const { sessionId, sha } = req.params;
    assertSession(sessionId);
    if (!/^[a-f0-9]{7,40}$/.test(String(sha || ''))) {
      return res.status(404).json({ error: 'checkpoint not found', code: 'CHECKPOINT_NOT_FOUND' });
    }
    const dir = await sessionDir_(sessionId);
    if (!dir) {
      return res.status(404).json({ error: 'checkpoint not found', code: 'CHECKPOINT_NOT_FOUND' });
    }
    await waitGc(sessionId); locked = sessionId;          // r122:与启动清扫互斥(同一仓不许两路同时改)
    const all = await listShas(sessionId);
    const target = all.find((s) => s === sha || s.startsWith(sha));
    if (!target) {
      return res.status(404).json({ error: 'checkpoint not found', code: 'CHECKPOINT_NOT_FOUND' });
    }
    // 删一条不存在的 sha 绝不能把整会话目录连带删掉(见验收 R3-5):这里只摘这一条。
    await detachShas(dir, [target], all.filter((s) => s !== target));
    const meta = await loadMeta(sessionId);
    await saveMeta(sessionId, meta.filter((e) => e.sha !== target));
    res.json({ ok: true, deleted: true, sha: target });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    if (locked) releaseGc(locked);
  }
});

/** GET /api/checkpoints-stats —— 总量 + 每会话明细(界面可见性) */router.get('/checkpoints-stats', async (req, res) => {
  try {
    let dirs = [];
    try { dirs = await readdir(CHECKPOINTS_ROOT, { withFileTypes: true }); }
    catch { return res.json({ totalBytes: 0, sessions: [] }); }        // 目录还不存在 = 空
    const sessions = [];
    let totalBytes = 0;
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      if (!SESSION_RE.test(id)) continue;
      const bytes = await dirBytes(join(CHECKPOINTS_ROOT, id));
      const count = (await listShas(id)).length;
      if (count === 0) continue;                   // 没快照的空仓不占用户空间认知,不列
      // 会话标题:光给 UUID 用户认不出是哪个会话。优先 custom/ai title(改名落盘),
      // 没有就取首条用户消息做前 80 字(大多数会话没改名)。
      let title = '';
      try {
        const f = await findSessionFile(id);
        if (f) {
          const t = await readSessionTitles(f);
          title = (t.customTitle || t.aiTitle || '').trim();
          if (!title) {
            await readJsonlEdges(f, 0, (raw) => {
              if (title || !raw.includes('"user"')) return;
              try {
                const r = JSON.parse(raw);
                if (r?.type !== 'user' || r?.isSidechain) return;
                const c = r?.message?.content;
                const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.find((b) => b?.type === 'text')?.text : '');
                if (!text || /^<(command-name|local-command)/.test(String(text).trim())) return;
                title = String(text).replace(/\s+/g, ' ').trim().slice(0, 80);
              } catch { /* 坏行跳过 */ }
            });
          }
        }
      } catch { /* 找不到就只显示 id */ }
      sessions.push({ sessionId: id, count, bytes, title });
      totalBytes += bytes;
    }
    sessions.sort((a, b) => b.bytes - a.bytes);
    res.json({ totalBytes, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 目录实际占用:只 stat,不读内容;深度/条目有上限(防呆本身不许变成卡顿)。 */
async function dirBytes(root) {
  let total = 0;
  let entries = 0;
  const maxEntries = envNum(['CGUI_CHECKPOINT_STATS_MAX_ENTRIES'], 200_000);
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = await readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (entries >= maxEntries) return total;
      entries += 1;
      const p = join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += (await stat(p)).size;
      } catch { /* 竞态忽略 */ }
    }
  }
  return total;
}

export default router;