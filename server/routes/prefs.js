import { Router } from 'express';
import { readFile, writeFile, mkdir, rename, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { renameSession } from '@anthropic-ai/claude-agent-sdk';
import { broadcast } from '../broadcast.js';
import { findSessionFile } from '../services/session-reader.js';
import { applySessionSyncPut, normalizeSessionSync, SYNC_KINDS } from '../session-sync.js';

// Server-side preferences that must be SHARED across devices (phone + Mac).
// Today this is just the hidden-projects list: it used to live in each
// browser's localStorage, so a phone (empty localStorage) showed every project
// the user had hidden on the Mac. Persisting it here makes the project list
// identical on every device. Device-local prefs (font, theme, pane widths)
// intentionally stay in localStorage.
const router = Router();
const PREFS_PATH = join(homedir(), '.claude-gui', 'prefs.json');

async function loadPrefs() {
  try { return JSON.parse(await readFile(PREFS_PATH, 'utf-8')); }
  catch { return {}; }
}
// 原子写:先写临时文件再 rename(rename 同目录原子)。此前 writeFile 直写,进程崩溃/
// 断电写一半 → JSON 损坏 → loadPrefs 回落 {} → 下一次任何 PUT 把整份 prefs 静默重置。
let tmpSeq = 0;
async function savePrefs(obj) {
  await mkdir(dirname(PREFS_PATH), { recursive: true });
  const tmp = `${PREFS_PATH}.tmp.${process.pid}.${tmpSeq++}`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, PREFS_PATH);
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

// r26-C6:prefs 共享写函数。其它 route(如 version-check 的 writeUpdateChannel)的 prefs 写
// 统一走这里 —— withPrefsQueue 串行化(与本文件所有 PUT 同一条队列,并发 read-merge-write
// 不互踩)+ savePrefs 原子写(tmp+rename)。签名契约见 PLAN C-C6:PKG-6 按 updatePrefs(mutator)
// 逐字消费。mutator 直接改传入的 prefs 对象,改完由这里统一落盘;mutator 抛错不会断队列链
// (withPrefsQueue 已兜),错误原样抛回调用方。
export async function updatePrefs(mutator) {
  return withPrefsQueue(async () => {
    const p = await loadPrefs();
    await mutator(p);
    await savePrefs(p);
  });
}

// 会话删除时的 prefs GC:清掉四处按 sessionId 挂的残留(1M 标记/自动标题/自定义标题/
// 置顶会话列表),否则 prefs.json 随删除只增不减,且被删 sid 的标记会污染未来复用同 id
// 的水合。走 withPrefsQueue 与常规 PUT 串行;只对真有变化的类别广播。
export async function removeSessionFromPrefs(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  await withPrefsQueue(async () => {
    const prefs = await loadPrefs();
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
    if (!changed.context1m && !changed.autoTitles && !changed.customTitles && !pinnedChanged && !syncChanged) return;
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
      const prefs = await loadPrefs();
      prefs.hiddenProjects = hidden;
      await savePrefs(prefs);
    });
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
      const prefs = await loadPrefs();
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
      const prefs = await loadPrefs();
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
      const prefs = await loadPrefs();
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
      const prefs = await loadPrefs();
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
      const prefs = await loadPrefs();
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
      const prefs = await loadPrefs();
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
      const prefs = await loadPrefs();
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
      const prefs = await loadPrefs();
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
      const prefs = await loadPrefs();
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
