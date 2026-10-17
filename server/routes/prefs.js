import { Router } from 'express';
import { readFile, writeFile, mkdir, rename, appendFile, unlink } from 'fs/promises';
import { readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { renameSession } from '@anthropic-ai/claude-agent-sdk';
import { broadcast } from '../broadcast.js';
import { findSessionFile, isSessionIdShape } from '../services/session-reader.js';
import { applySessionSyncPut, normalizeSessionSync, SYNC_KINDS } from '../session-sync.js';
import { ensureBackup } from '../utils/guarded-json.js';

// Server-side preferences that must be SHARED across devices (phone + Mac).
// Today this is just the hidden-projects list: it used to live in each
// browser's localStorage, so a phone (empty localStorage) showed every project
// the user had hidden on the Mac. Persisting it here makes the project list
// identical on every device. Device-local prefs (font, theme, pane widths)
// intentionally stay in localStorage.
const router = Router();
const PREFS_PATH = join(homedir(), '.claude-gui', 'prefs.json');

// 只读接口用:读不出 / 损坏回 {}(各 GET 回默认值)。写入路径("读 → 改 → 写")一律用 loadPrefsForWrite,
// 否则读失败当成空、写回时把其它偏好整份抹掉(r151e ②)。
export async function loadPrefs() {
  try { return JSON.parse(await readFile(PREFS_PATH, 'utf-8')); }
  catch { return {}; }
}

// r151a:第三方 provider 的「自动」档总开关(thirdPartyAuto,默认关)的同步读取。
// 同步是因为调用方都在同步路径上(cleanChildEnv、/chat 入口门控、审核状态组装)。
// 文件不存在、损坏、键缺失或值不是布尔 true → false;只读,不改写文件。
export function readThirdPartyAutoSync() {
  try { return JSON.parse(readFileSync(PREFS_PATH, 'utf-8'))?.thirdPartyAuto === true; }
  catch { return false; }
}

// r151b:跨会话消息总开关 xsEnabled(默认关,接口 X.3.5)的同步读取,同 readThirdPartyAutoSync 的口径:
// 文件不存在、损坏、键缺失或值不是布尔 true(含手写的 "true"、1)→ false;只读,不报错、不改写文件。
// 同步是因为 /api/xsession/* 的开关闸门与 /chat 入口钩子都在请求路径上直接判。
export function readXsEnabledSync() {
  try { return JSON.parse(readFileSync(PREFS_PATH, 'utf-8'))?.xsEnabled === true; }
  catch { return false; }
}

/**
 * r151c:跨会话的全部偏好键,一次读文件(接口 X.3.5 的读取规则;读到非法值不报错、不改写文件):
 * · enabled    —— xsEnabled === true(同 readXsEnabledSync);
 * · enabledAt  —— xsEnabledAt(内部键:xsEnabled 由关变开的同一次写入里记的 ISO 时刻);不是能解析成时刻的字符串 → null
 *                 (此时所有发送档案都不认);
 * · inbound    —— xsInbound,只留键是会话 id 形状、值是 "auto" 的条目;不是对象 → {};
 * · autoPaused —— xsAutoPaused === true。
 */
export function normalizeXsPrefs(prefs) {
  const p = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  const at = typeof p.xsEnabledAt === 'string' && !Number.isNaN(Date.parse(p.xsEnabledAt)) ? p.xsEnabledAt : null;
  const inbound = {};
  const raw = p.xsInbound;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, mode] of Object.entries(raw)) if (mode === 'auto' && isSessionIdShape(id)) inbound[id] = 'auto';
  }
  return { enabled: p.xsEnabled === true, enabledAt: at, inbound, autoPaused: p.xsAutoPaused === true };
}
export function readXsPrefsSync() {
  const { readFailed: _readFailed, ...prefs } = readXsPrefsDetailedSync();
  return prefs;
}
/**
 * r151d:发送档案写盘失败的会话(xsProfileWriteFailed,内部键;只记会话 id,不记档案内容)。读取规则同上(读到非法值不报错、
 * 不改写文件):不是数组 → [];只留会话 id 形状的字符串,转小写、去重(重复的按最后一次出现排);最多留最后
 * XS_PROFILE_WRITE_FAILED_MAX 个。写入由 services/xsession.js 经 updatePrefsStrict 做(并进盘上已有的名单;超上限时只写最近加入的)。
 */
export const XS_PROFILE_WRITE_FAILED_MAX = 256;
export function normalizeXsProfileWriteFailed(prefs) {
  const raw = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs.xsProfileWriteFailed : undefined;
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  for (const id of raw) {
    if (typeof id !== 'string' || !isSessionIdShape(id)) continue;
    const k = id.toLowerCase();
    ids.delete(k);
    ids.add(k);
  }
  return [...ids].slice(-XS_PROFILE_WRITE_FAILED_MAX);
}
/**
 * r151d 判官 R1:{ ids, readFailed }。这个键的默认值 [](没有标记)是放宽方向 —— 读不出时若当成 [],被标记的会话会按盘上那份
 * 较旧、可能更宽的档案判 —— 所以不套已有键"读不出按默认"的规则:文件不存在 → { ids: [], readFailed: false };文件在、却读不出
 * 或解析不了(Windows 上被杀毒 / 备份软件占着的 EBUSY / EPERM 等)→ { ids: [], readFailed: true },调用方在读到之前一律按没有档案判。
 * 读到的内容按上面的规则规范化(非法值不报错、不改写文件)。
 */
export function readXsProfileWriteFailedSync() {
  let prefs = null;
  let readFailed = false;
  try { prefs = JSON.parse(readFileSync(PREFS_PATH, 'utf-8')); } catch (e) { readFailed = e?.code !== 'ENOENT'; }
  return { ids: normalizeXsProfileWriteFailed(prefs), readFailed };
}
/**
 * 同 readXsPrefsSync,另给 readFailed:文件在、却读不出或解析不了时为 true(文件不存在不算,此时总开关就是关的),其余字段按默认。
 * r151c 审计 S1:发送档案的两个钩子据此区分"总开关真的关着"与"偏好读失败"(后者不能静默跳过)。
 */
export function readXsPrefsDetailedSync() {
  let prefs = null;
  let readFailed = false;
  try { prefs = JSON.parse(readFileSync(PREFS_PATH, 'utf-8')); } catch (e) { readFailed = e?.code !== 'ENOENT'; }
  return { ...normalizeXsPrefs(prefs), readFailed };
}
// 原子写:先写临时文件再 rename(rename 同目录原子)。此前 writeFile 直写,进程崩溃/
// 断电写一半 → JSON 损坏 → loadPrefs 回落 {} → 下一次任何 PUT 把整份 prefs 静默重置。
let tmpSeq = 0;
async function savePrefs(obj) {
  await mkdir(dirname(PREFS_PATH), { recursive: true });
  const tmp = `${PREFS_PATH}.tmp.${process.pid}.${tmpSeq++}`;
  try {
    await writeFile(tmp, JSON.stringify(obj, null, 2));
    await rename(tmp, PREFS_PATH);
  } catch (e) {
    // r151e 判官建议 1:最后一步覆盖原文件失败(Windows 上原文件被其它程序占用时 rename 抛 EPERM / EBUSY)或临时文件没写完 → 先删掉
    // 本次的临时文件再把原错误抛回;否则恢复定时器每次重试都留下一个 prefs.json.tmp.*。删不掉(例如根本没建成)只忽略,不掩盖原错误。
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
// 写串行化:所有 prefs 写都是 read-merge-write,并发(手机+桌面同时 PUT)会互相覆盖
// 丢一路。模块级 promise 链把「load→merge→save」整段排队,同一时刻只有一段在跑。
// ponytail: 进程内全局队列;prefs 写频率极低,不值得按 key 分锁。
let prefsQueue = Promise.resolve();
function withPrefsQueue(task) {
  const run = prefsQueue.then(task);
  prefsQueue = run.then(() => {}, () => {}); // 失败不断链
  return run;
}

// r151e ②:写入路径的严格读,只在写队列里调用(同一时刻只有一段"读 → 改 → 写"在跑):
// · 文件不存在 → {}(照旧新建);
// · 文件在、却读不出(EACCES / EBUSY / EPERM …,Windows 上被杀毒 / 备份软件占着)→ 原样抛错:整次放弃、不写盘,调用方回它已有的
//   写失败响应。之前 loadPrefs 回 {},写回时把其它偏好整份抹掉;
// · 内容不是合法的 JSON 对象(截断的 JSON、[]、null、数字…)→ 隔 PREFS_REREAD_DELAY_MS 重读一次(别的程序可能正写到一半);
//   仍然不对:rebuildCorrupt 为真时把原字节原样另存为同目录 prefs.json.corrupt-<毫秒时刻>(guarded-json 的 ensureBackup:临时文件 +
//   独占落名,同一份坏内容只备份一次),按 {} 返回(用户卡点 A 选"备份后从空白重建");备份失败按读不出抛错。rebuildCorrupt 为假时
//   抛 PREFS_UNREADABLE,不备份、不写。
// 开头的 UTF-8 BOM 先剥掉再解析(同 guarded-json r128:记事本 / PowerShell 存出的合法文件不算坏,写回时不带 BOM)。
const PREFS_REREAD_DELAY_MS = 100;
async function readPrefsBytes() {
  try { return await readFile(PREFS_PATH); } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}
function parsePrefsObject(raw) {
  try {
    const v = JSON.parse(raw.toString('utf-8').replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
async function loadPrefsForWrite({ rebuildCorrupt = true } = {}) {
  let raw = await readPrefsBytes();
  if (raw === null) return {};
  let prefs = parsePrefsObject(raw);
  if (prefs) return prefs;
  await new Promise((r) => setTimeout(r, PREFS_REREAD_DELAY_MS));
  raw = await readPrefsBytes();
  if (raw === null) return {};
  prefs = parsePrefsObject(raw);
  if (prefs) return prefs;
  if (!rebuildCorrupt) throw Object.assign(new Error('偏好文件的内容不是 JSON 对象'), { code: 'PREFS_UNREADABLE' });
  const backup = await ensureBackup(PREFS_PATH, raw);
  console.warn(`[prefs] prefs.json 不是合法的 JSON 对象:原内容已另存为 ${basename(backup)},本次写入从空白重建`);
  return {};
}

// r26-C6:prefs 共享写函数。其它 route(如 version-check 的 writeUpdateChannel)的 prefs 写
// 统一走这里 —— withPrefsQueue 串行化(与本文件所有 PUT 同一条队列,并发 read-merge-write
// 不互踩)+ savePrefs 原子写(tmp+rename)。签名契约见 PLAN C-C6:PKG-6 按 updatePrefs(mutator)
// 逐字消费。mutator 直接改传入的 prefs 对象,改完由这里统一落盘;mutator 抛错不会断队列链
// (withPrefsQueue 已兜),错误原样抛回调用方。
// r151e ②:与 r151d 的 updatePrefsStrict 合成同一个严格版本(读法见 loadPrefsForWrite):偏好文件在、却读不出时整次放弃、抛回调用方,
// 不再拿空对象整份覆盖;内容坏了先备份再从空白重建。
export async function updatePrefs(mutator, { rebuildCorrupt = true } = {}) {
  return withPrefsQueue(async () => {
    const p = await loadPrefsForWrite({ rebuildCorrupt });
    await mutator(p);
    await savePrefs(p);
  });
}
// 档案写失败名单(services/xsession.js,回合钩子里自动写)用的名字:同 updatePrefs,只是内容坏了时不重建、抛 PREFS_UNREADABLE
// (沿用 r151d:后台自动写入不替用户重建坏文件,见单测 check-r151d-xs-hardening 3e),落盘失败由调用方记日志、之后重试。
export const updatePrefsStrict = (mutator) => updatePrefs(mutator, { rebuildCorrupt: false });

// r151e ⑥:添加项目时把它的 hash 移出隐藏列表(settings.js 的 PUT /settings {_addProject})。之前那边直接 readFile + writeFile,
// 绕过写队列(与队列里的写入互相覆盖)、也不是原子写(写到一半崩溃留下坏文件)。现在同一条写队列、同一套严格读、原子写;
// 只有真的移出了条目才写盘。返回是否移出了;读不出 / 写不进时抛错(调用方只记日志,添加项目照旧成功)。
export async function unhideProjectInPrefs(hash) {
  return withPrefsQueue(async () => {
    const prefs = await loadPrefsForWrite();
    if (!Array.isArray(prefs.hiddenProjects) || !prefs.hiddenProjects.includes(hash)) return false;
    prefs.hiddenProjects = prefs.hiddenProjects.filter((h) => h !== hash);
    await savePrefs(prefs);
    return true;
  });
}

// 会话删除时的 prefs GC:清掉四处按 sessionId 挂的残留(1M 标记/自动标题/自定义标题/
// 置顶会话列表),否则 prefs.json 随删除只增不减,且被删 sid 的标记会污染未来复用同 id
// 的水合。走 withPrefsQueue 与常规 PUT 串行;只对真有变化的类别广播。
export async function removeSessionFromPrefs(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  await withPrefsQueue(async () => {
    const prefs = await loadPrefsForWrite();
    const changed = { context1m: false, autoTitles: false, customTitles: false };
    for (const key of ['context1m', 'autoTitles', 'customTitles']) {
      const m = prefs[key];
      if (m && typeof m === 'object' && sessionId in m) {
        delete m[sessionId];
        changed[key] = true;
      }
    }
    let pinnedChanged = false;
    const p = prefs.pinned;
    if (p && Array.isArray(p.sessions) && p.sessions.includes(sessionId)) {
      p.sessions = p.sessions.filter((id) => id !== sessionId);
      pinnedChanged = true;
    }
    // 审计批A2:会话级同步偏好(权限档/模型 pin/力度 pin)随会话删除一并 GC。
    let syncChanged = false;
    if (prefs.sessionSync && typeof prefs.sessionSync === 'object') {
      for (const mapKey of Object.values(SYNC_KINDS)) {
        const m = prefs.sessionSync[mapKey];
        if (m && typeof m === 'object' && sessionId in m) {
          delete m[sessionId];
          syncChanged = true;
        }
      }
    }
    // r151c:跨会话接收设置(xsInbound,只记"自动处理"的会话)随会话删除清掉;id 不分大小写。不广播(会话已不在)。
    let xsInboundChanged = false;
    const inbound = prefs.xsInbound;
    if (inbound && typeof inbound === 'object' && !Array.isArray(inbound)) {
      for (const k of Object.keys(inbound)) {
        if (k.toLowerCase() === sessionId.toLowerCase()) { delete inbound[k]; xsInboundChanged = true; }
      }
    }
    if (!changed.context1m && !changed.autoTitles && !changed.customTitles && !pinnedChanged && !syncChanged && !xsInboundChanged) return;
    await savePrefs(prefs);
    // r10-11:pinned 也有广播类型了,GC 掉被删会话的置顶时同步各端。
    if (pinnedChanged) {
      broadcast({
        type: 'pinned',
        projects: Array.isArray(prefs.pinned?.projects) ? prefs.pinned.projects : [],
        sessions: Array.isArray(prefs.pinned?.sessions) ? prefs.pinned.sessions : [],
      });
    }
    if (changed.context1m) broadcast({ type: 'context-1m', sessions: prefs.context1m });
    if (changed.autoTitles) broadcast({ type: 'auto-titles', titles: prefs.autoTitles });
    if (changed.customTitles) broadcast({ type: 'custom-titles', titles: prefs.customTitles });
    if (syncChanged) broadcast({ type: 'session-sync', ...normalizeSessionSync(prefs.sessionSync) });
  });
}

// GET /api/prefs/hidden-projects → { hidden: string[] }
router.get('/prefs/hidden-projects', async (_req, res) => {
  const prefs = await loadPrefs();
  res.json({ hidden: Array.isArray(prefs.hiddenProjects) ? prefs.hiddenProjects : [] });
});

// PUT /api/prefs/hidden-projects { hidden: string[] } → persist the full list.
router.put('/prefs/hidden-projects', async (req, res) => {
  const { hidden } = req.body || {};
  if (!Array.isArray(hidden) || !hidden.every((h) => typeof h === 'string')) {
    return res.status(400).json({ error: 'hidden 必须是字符串数组' });
  }
  try {
    await withPrefsQueue(async () => {
      const prefs = await loadPrefsForWrite();
      prefs.hiddenProjects = hidden;
      await savePrefs(prefs);
    });
    // r26-I2:补 WS 广播(照 pinned 同款)——此前手机端隐藏项目后桌面端要到下次拉取
    // 才收敛。payload 契约 C-I2 逐字固定 {type:'hidden-projects', hidden},客户端
    // (PKG-2 WS reducer → store.hiddenProjects;PKG-11 只读 store)按此形状消费。
    try {
      broadcast({ type: 'hidden-projects', hidden });
    } catch {}
    res.json({ ok: true, hidden });
  } catch (e) {
    res.status(500).json({ error: '写入偏好失败：' + e.message });
  }
});

// GET /api/prefs/hidden-providers → { hidden: string[] }
// Provider IDs the user "removed" from the GUI list. cc-switch providers can't
// be deleted from cc-switch.db (read-only), so hiding is how a delete sticks:
// the id is filtered out of GET /providers on the client. Custom providers are
// truly deleted; this is only for the cc-switch-imported ones.
router.get('/prefs/hidden-providers', async (_req, res) => {
  const prefs = await loadPrefs();
  res.json({ hidden: Array.isArray(prefs.hiddenProviders) ? prefs.hiddenProviders : [] });
});

// r151a:第三方 provider 的「自动」档总开关(INTERFACE Y.3.1)。默认关:关 = 第三方下没有「自动」档、
// 服务端把 auto 请求降成逐步确认、会话进程不注入 CLAUDE_CODE_AUTO_MODE_SERVER(与改动前逐字相同)。
// 读走同步 readThirdPartyAutoSync(与服务端门控同一个读取点);写走 updatePrefs(串行 + 原子写)。
router.get('/prefs/third-party-auto', (_req, res) => {
  res.json({ enabled: readThirdPartyAutoSync() });
});
router.put('/prefs/third-party-auto', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
    return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: 'enabled 必须是布尔值' });
  }
  const { enabled } = body;
  try {
    await updatePrefs((prefs) => { prefs.thirdPartyAuto = enabled; });
  } catch {
    return res.status(500).json({ ok: false, code: 'STORAGE_WRITE_FAILED', error: '保存失败，请重试' });
  }
  broadcast({ type: 'third-party-auto', enabled });
  res.json({ ok: true, enabled });
});

// P1: 关闭行为(ask|minimize|quit)。独立文件 ~/.claude-gui/close-behavior.json —
// Tauri Rust 侧在 CloseRequested 时直接读同一文件,不经 server。
const CLOSE_BEHAVIOR_PATH = join(homedir(), '.claude-gui', 'close-behavior.json');
// (已删)/prefs/auto-compact-pct:「压缩触发百分比」与设置页的「自动压缩窗口」是同一件事的
// 两个入口,且 CLI 的 autoCompactWindow 本就是【窗口】、由 CLI 自己扣固定预留得到触发线,
// GUI 再乘一遍百分比等于折上折。已合并为单一入口,联动逻辑见 chat.js resolveCompactWindowSettings。

router.get('/prefs/close-behavior', async (_req, res) => {
  try {
    const d = JSON.parse(await readFile(CLOSE_BEHAVIOR_PATH, 'utf-8'));
    res.json({ behavior: ['ask', 'minimize', 'quit'].includes(d.behavior) ? d.behavior : 'ask' });
  } catch { res.json({ behavior: 'ask' }); }
});
router.put('/prefs/close-behavior', async (req, res) => {
  const { behavior } = req.body || {};
  if (!['ask', 'minimize', 'quit'].includes(behavior)) {
    return res.status(400).json({ error: 'behavior 必须是 ask/minimize/quit' });
  }
  try {
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    await writeFile(CLOSE_BEHAVIOR_PATH, JSON.stringify({ behavior }, null, 2));
    res.json({ ok: true, behavior });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// F1: 全局截图热键配置。独立文件 ~/.claude-gui/hotkey.json {"enabled":bool,"accelerator":str} —
// Tauri Rust 侧在启动 setup 时读同一文件注册热键(改后需重启应用生效,MVP 不做实时重注册)。
const HOTKEY_PATH = join(homedir(), '.claude-gui', 'hotkey.json');
const DEFAULT_HOTKEY = { enabled: true, accelerator: 'CmdOrCtrl+Shift+2' };
// 与 Rust read_hotkey_config 的字符集校验一致:字母数字 + '+' + 空格。
const ACCEL_RE = /^[A-Za-z0-9+ ]+$/;
router.get('/prefs/hotkey', async (_req, res) => {
  try {
    const d = JSON.parse(await readFile(HOTKEY_PATH, 'utf-8'));
    res.json({
      enabled: d.enabled !== false,
      accelerator: (typeof d.accelerator === 'string' && ACCEL_RE.test(d.accelerator)) ? d.accelerator : DEFAULT_HOTKEY.accelerator,
    });
  } catch { res.json({ ...DEFAULT_HOTKEY }); }
});
router.put('/prefs/hotkey', async (req, res) => {
  const { enabled, accelerator } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled 必须是布尔值' });
  }
  const accel = typeof accelerator === 'string' ? accelerator.trim() : '';
  if (accel && !ACCEL_RE.test(accel)) {
    return res.status(400).json({ error: 'accelerator 只允许字母、数字、+ 和空格' });
  }
  const next = { enabled, accelerator: accel || DEFAULT_HOTKEY.accelerator };
  try {
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    await writeFile(HOTKEY_PATH, JSON.stringify(next, null, 2));
    res.json({ ok: true, ...next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// r17-2:「更新说明」弹窗已读到哪一版。落 prefs.json 而不是 localStorage —— localStorage
// 绑 WebView 数据目录,端口漂移/换目录会整份丢,同一版本就会反复弹。同版本只弹一次的
// 判定在前端(client/src/utils/releaseNotes.js 的 shouldShow),这里只负责持久化。
router.get('/prefs/release-notes-seen', async (_req, res) => {
  const prefs = await loadPrefs();
  res.json({ lastSeen: typeof prefs.releaseNotesSeen === 'string' ? prefs.releaseNotesSeen : null });
});
router.put('/prefs/release-notes-seen', async (req, res) => {
  const { version } = req.body || {};
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    return res.status(400).json({ error: 'version 必须是版本号字符串' });
  }
  try {
    await withPrefsQueue(async () => {
      const prefs = await loadPrefsForWrite();
      prefs.releaseNotesSeen = version;
      await savePrefs(prefs);
    });
    res.json({ ok: true, lastSeen: version });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/prefs/hidden-providers { hidden: string[] }
router.put('/prefs/hidden-providers', async (req, res) => {
  const { hidden } = req.body || {};
  if (!Array.isArray(hidden) || !hidden.every((h) => typeof h === 'string')) {
    return res.status(400).json({ error: 'hidden 必须是字符串数组' });
  }
  try {
    await withPrefsQueue(async () => {
      const prefs = await loadPrefsForWrite();
      prefs.hiddenProviders = hidden;
      await savePrefs(prefs);
    });
    res.json({ ok: true, hidden });
  } catch (e) {
    res.status(500).json({ error: '写入偏好失败：' + e.message });
  }
});

// Custom session titles { [sessionId]: title }. Used to live ONLY in each
// browser's localStorage, so a rename on the phone never reached the Mac (and
// vice-versa). Now server-backed + ws-broadcast so every device converges.
// GET /api/prefs/custom-titles → { titles: { [sessionId]: string } }
router.get('/prefs/custom-titles', async (_req, res) => {
  const prefs = await loadPrefs();
  const titles = (prefs.customTitles && typeof prefs.customTitles === 'object') ? prefs.customTitles : {};
  res.json({ titles });
});

// 改名同时落进会话 jsonl(SDK renameSession:纯本地追加一行 custom-title,零网络零
// 子进程),让 CLI / 其它客户端看到同一个标题。prefs 仍写:跨端广播、列表搜索、以及
// 未落盘的 draft 会话都只有它能兜住。
// 清空标题时 SDK 拒绝空 title(它没有"取消改名"的接口),自己追加一行空 customTitle
// 表达清除 —— 同一文件后写胜出,读侧把空串当作"无自定义标题"(见 takeTitleLine),
// 否则清空后 jsonl 里的旧标题会把它顶回来。
// 任何一步失败(会话未落盘/文件已删/权限)都只记日志:prefs 已经写成功,改名请求不该失败。
export async function writeJsonlTitle(sessionId, title) {
  try {
    if (title) {
      await renameSession(sessionId, title);
      return;
    }
    const file = await findSessionFile(sessionId);
    if (!file) throw new Error('session file not found');
    await appendFile(file, JSON.stringify({ type: 'custom-title', customTitle: '', sessionId }) + '\n');
  } catch (e) {
    console.warn(`[prefs] 标题未能写入会话 jsonl(${sessionId}):${e.message}`);
  }
}

// PUT /api/prefs/custom-titles { sessionId, title } → per-key MERGE (not a full
// replace) so two devices renaming different sessions can't clobber each other.
// Empty/whitespace title deletes the override. Broadcasts the full map so all
// connected clients update live without a refresh.
router.put('/prefs/custom-titles', async (req, res) => {
  const { sessionId, title } = req.body || {};
  if (typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'sessionId 必须是非空字符串' });
  }
  if (title != null && typeof title !== 'string') {
    return res.status(400).json({ error: 'title 必须是字符串' });
  }
  try {
    const map = await withPrefsQueue(async () => {
      const prefs = await loadPrefsForWrite();
      const m = (prefs.customTitles && typeof prefs.customTitles === 'object') ? prefs.customTitles : {};
      const trimmed = (title || '').trim();
      if (trimmed) m[sessionId] = trimmed;
      else delete m[sessionId];
      prefs.customTitles = m;
      await savePrefs(prefs);
      return m;
    });
    await writeJsonlTitle(sessionId, (title || '').trim());
    broadcast({ type: 'custom-titles', titles: map });
    res.json({ ok: true, titles: map });
  } catch (e) {
    res.status(500).json({ error: '写入标题失败：' + e.message });
  }
});

// W4:AI 自动标题同 custom-titles 一样服务端共享。此前只存生成端浏览器的
// localStorage —— 标题在 A 端(如另一台设备/另一个浏览器)生成后,B 端永远只能
// 看到首条消息。GET 启动时水合,PUT 按 key 合并并广播。
router.get('/prefs/auto-titles', async (_req, res) => {
  const prefs = await loadPrefs();
  const titles = (prefs.autoTitles && typeof prefs.autoTitles === 'object') ? prefs.autoTitles : {};
  res.json({ titles });
});

router.put('/prefs/auto-titles', async (req, res) => {
  const { sessionId, title } = req.body || {};
  if (typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'sessionId 必须是非空字符串' });
  }
  if (title != null && typeof title !== 'string') {
    return res.status(400).json({ error: 'title 必须是字符串' });
  }
  try {
    const map = await withPrefsQueue(async () => {
      const prefs = await loadPrefsForWrite();
      const m = (prefs.autoTitles && typeof prefs.autoTitles === 'object') ? prefs.autoTitles : {};
      const trimmed = (title || '').trim();
      if (trimmed) m[sessionId] = trimmed;
      else delete m[sessionId];
      prefs.autoTitles = m;
      await savePrefs(prefs);
      return m;
    });
    broadcast({ type: 'auto-titles', titles: map });
    res.json({ ok: true, titles: map });
  } catch (e) {
    res.status(500).json({ error: '写入自动标题失败：' + e.message });
  }
});

// 1M 上下文会话标记 { [sessionId]: true }。[1m] 后缀只存在前端 localStorage 的
// 会话模型 pin 里,重装/清缓存即丢(jsonl 历史消息的 model 字段不带该后缀,无法从
// 历史恢复)→ 服务端持久化这一位,前端启动水合兜底。
// GET /api/prefs/context-1m → { sessions: { [sessionId]: true } }
router.get('/prefs/context-1m', async (_req, res) => {
  const prefs = await loadPrefs();
  const sessions = (prefs.context1m && typeof prefs.context1m === 'object') ? prefs.context1m : {};
  res.json({ sessions });
});

// PUT /api/prefs/context-1m
//   { sessionId, on:bool } → per-key MERGE(on=false 删除该 key)
//   { clear:true }         → 清空全表(切 provider 时与前端 clearModelOverrides 对齐)
// 广播全量 map 供多端收敛(同 custom-titles 模式)。
router.put('/prefs/context-1m', async (req, res) => {
  const { sessionId, on, clear } = req.body || {};
  if (!clear && (typeof sessionId !== 'string' || !sessionId)) {
    return res.status(400).json({ error: 'sessionId 必须是非空字符串(或传 clear:true)' });
  }
  try {
    const map = await withPrefsQueue(async () => {
      const prefs = await loadPrefsForWrite();
      let m = (prefs.context1m && typeof prefs.context1m === 'object') ? prefs.context1m : {};
      if (clear) m = {};
      else if (on) m[sessionId] = true;
      else delete m[sessionId];
      prefs.context1m = m;
      await savePrefs(prefs);
      return m;
    });
    broadcast({ type: 'context-1m', sessions: map });
    res.json({ ok: true, sessions: map });
  } catch (e) {
    res.status(500).json({ error: '写入 1M 标记失败：' + e.message });
  }
});

// 审计批A2:会话级偏好跨设备同步 —— 三张 per-sessionKey map(权限档/模型 pin/
// 力度 pin)。仿 custom-titles 模式:GET 水合、PUT 单键合并(后写胜出)+ 全量广播。
// 只是「下次 spawn 用哪档」的偏好层,不碰 chat.js 的 slot.guiMode 运行时链路。
// GET /api/prefs/session-sync → { permissionModes, modelPins, effortPins }
router.get('/prefs/session-sync', async (_req, res) => {
  const prefs = await loadPrefs();
  res.json(normalizeSessionSync(prefs.sessionSync));
});

// PUT /api/prefs/session-sync
//   { kind:'permissionMode'|'modelPin'|'effortPin', sessionId, value } 单键合并(value=null 删除)
//   { clear:'modelPins' } 清空整表(切 provider 与前端 clearModelOverrides 对齐)
// 幂等:同 body 重放结果一致;无变化时不写盘不广播。
router.put('/prefs/session-sync', async (req, res) => {
  try {
    const out = await withPrefsQueue(async () => {
      const prefs = await loadPrefsForWrite();
      const r = applySessionSyncPut(prefs.sessionSync, req.body);
      if (r.error) return r;
      if (r.changed) {
        prefs.sessionSync = r.maps;
        await savePrefs(prefs);
      }
      return r;
    });
    if (out.error) return res.status(400).json({ error: out.error });
    if (out.changed) broadcast({ type: 'session-sync', ...out.maps });
    res.json({ ok: true, ...out.maps });
  } catch (e) {
    res.status(500).json({ error: '写入会话偏好失败：' + e.message });
  }
});

// r11-⑫:称呼(displayName)——Home 问候「下午好，{称呼}」用。≤20 字符可空,
// 存 prefs.json 多端共享(同 custom-titles 模式:GET 水合 + PUT + WS 广播收敛)。
router.get('/prefs/display-name', async (_req, res) => {
  const prefs = await loadPrefs();
  res.json({ displayName: typeof prefs.displayName === 'string' ? prefs.displayName : '' });
});

// PUT /api/prefs/display-name { displayName: string } → 去首尾空白截 20;空串=清除。
router.put('/prefs/display-name', async (req, res) => {
  const { displayName } = req.body || {};
  if (typeof displayName !== 'string') {
    return res.status(400).json({ error: 'displayName 必须是字符串' });
  }
  // r26-D12:按码点截断 —— String.prototype.slice 按 UTF-16 码元切,emoji(代理对)
  // 会从中间劈开产出孤代理(渲染为  、且与前端码点截断长度不一致)。
  const name = [...displayName.trim()].slice(0, 20).join('');
  try {
    await withPrefsQueue(async () => {
      const prefs = await loadPrefsForWrite();
      if (name) prefs.displayName = name;
      else delete prefs.displayName;
      await savePrefs(prefs);
    });
    broadcast({ type: 'display-name', displayName: name });
    res.json({ ok: true, displayName: name });
  } catch (e) {
    res.status(500).json({ error: '写入称呼失败：' + e.message });
  }
});

// r13-②:侧栏分组/排序视图偏好(多端共享;展开态刻意留 localStorage per-device)。
// { groupMode:'project'|'single', sortMode:'recent'|'manual', projectOrder:string[] }
const GROUP_MODES = ['project', 'single'];
const SORT_MODES = ['recent', 'manual'];
function normalizeSidebarView(v) {
  const o = (v && typeof v === 'object') ? v : {};
  return {
    groupMode: GROUP_MODES.includes(o.groupMode) ? o.groupMode : 'project',
    sortMode: SORT_MODES.includes(o.sortMode) ? o.sortMode : 'recent',
    projectOrder: Array.isArray(o.projectOrder) ? o.projectOrder.filter((h) => typeof h === 'string' && h) : [],
  };
}
router.get('/prefs/sidebar-view', async (_req, res) => {
  const prefs = await loadPrefs();
  res.json(normalizeSidebarView(prefs.sidebarView));
});
// PUT:部分字段合并(只传要改的键);幂等,广播全量。
router.put('/prefs/sidebar-view', async (req, res) => {
  const patch = req.body || {};
  if (patch.groupMode != null && !GROUP_MODES.includes(patch.groupMode)) return res.status(400).json({ error: 'groupMode 必须是 project/single' });
  if (patch.sortMode != null && !SORT_MODES.includes(patch.sortMode)) return res.status(400).json({ error: 'sortMode 必须是 recent/manual' });
  if (patch.projectOrder != null && !(Array.isArray(patch.projectOrder) && patch.projectOrder.every((h) => typeof h === 'string'))) {
    return res.status(400).json({ error: 'projectOrder 必须是字符串数组' });
  }
  try {
    const view = await withPrefsQueue(async () => {
      const prefs = await loadPrefsForWrite();
      const next = normalizeSidebarView({ ...normalizeSidebarView(prefs.sidebarView), ...patch });
      prefs.sidebarView = next;
      await savePrefs(prefs);
      return next;
    });
    broadcast({ type: 'sidebar-view', ...view });
    res.json({ ok: true, ...view });
  } catch (e) {
    res.status(500).json({ error: '写入侧栏视图偏好失败：' + e.message });
  }
});

// 置顶(pin):项目 + 会话各一份 id 列表,服务端共享(同 hidden-projects 跨设备一致)。
// 按 kind 单键合并,避免「置顶项目」的 PUT 覆盖掉「置顶会话」列表(反之亦然)。
router.get('/prefs/pinned', async (_req, res) => {
  const prefs = await loadPrefs();
  const p = (prefs.pinned && typeof prefs.pinned === 'object') ? prefs.pinned : {};
  res.json({
    projects: Array.isArray(p.projects) ? p.projects : [],
    sessions: Array.isArray(p.sessions) ? p.sessions : [],
  });
});

// PUT /api/prefs/pinned { kind:'project'|'session', id, pinned:bool }
router.put('/prefs/pinned', async (req, res) => {
  const { kind, id, pinned } = req.body || {};
  if (!['project', 'session'].includes(kind) || typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'kind 必须是 project/session,id 必须非空字符串' });
  }
  try {
    const p = await withPrefsQueue(async () => {
      const prefs = await loadPrefsForWrite();
      const cur = (prefs.pinned && typeof prefs.pinned === 'object') ? prefs.pinned : {};
      const key = kind === 'project' ? 'projects' : 'sessions';
      const list = new Set(Array.isArray(cur[key]) ? cur[key] : []);
      if (pinned) list.add(id); else list.delete(id);
      cur[key] = [...list];
      prefs.pinned = cur;
      await savePrefs(prefs);
      return cur;
    });
    // r10-11:补 pinned 广播(挂账清理)——常驻折叠面板不再靠重挂载拉取,
    // 手机/桌面任一端置顶后另一端即时收敛(applyPinned 同一 reducer 入位)。
    try {
      broadcast({
        type: 'pinned',
        projects: Array.isArray(p.projects) ? p.projects : [],
        sessions: Array.isArray(p.sessions) ? p.sessions : [],
      });
    } catch {}
    res.json({
      ok: true,
      projects: Array.isArray(p.projects) ? p.projects : [],
      sessions: Array.isArray(p.sessions) ? p.sessions : [],
    });
  } catch (e) {
    res.status(500).json({ error: '写入置顶失败：' + e.message });
  }
});

export default router;
