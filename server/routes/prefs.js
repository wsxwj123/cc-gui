import { Router } from 'express';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { broadcast } from '../broadcast.js';

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

// 会话删除时的 prefs GC:清掉四处按 sessionId 挂的残留(1M 标记/自动标题/自定义标题/
// 置顶会话列表),否则 prefs.json 随删除只增不减,且被删 sid 的标记会污染未来复用同 id
// 的水合。走 withPrefsQueue 与常规 PUT 串行;只对真有变化的类别广播(pinned 无广播类型,
// 客户端只在挂载时拉取,残留 sid 无害)。
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
    if (!changed.context1m && !changed.autoTitles && !changed.customTitles && !pinnedChanged) return;
    await savePrefs(prefs);
    if (changed.context1m) broadcast({ type: 'context-1m', sessions: prefs.context1m });
    if (changed.autoTitles) broadcast({ type: 'auto-titles', titles: prefs.autoTitles });
    if (changed.customTitles) broadcast({ type: 'custom-titles', titles: prefs.customTitles });
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
// 自动压缩触发百分比(默认 80,范围 50-95)。第三方 provider 下 chat.js 按
// 「模型真实窗口 × pct%」换算 autoCompactWindow 下发(per-spawn --settings 联动)。
router.get('/prefs/auto-compact-pct', async (_req, res) => {
  const p = Number((await loadPrefs()).autoCompactPct);
  res.json({ pct: (Number.isFinite(p) && p >= 50 && p <= 95) ? p : 80 });
});
router.put('/prefs/auto-compact-pct', async (req, res) => {
  const p = Number(req.body?.pct);
  if (!Number.isFinite(p) || p < 50 || p > 95) return res.status(400).json({ error: 'pct 必须在 50-95 之间' });
  try {
    await withPrefsQueue(async () => {
      const prefs = await loadPrefs();
      prefs.autoCompactPct = Math.round(p);
      await savePrefs(prefs);
    });
    res.json({ ok: true, pct: Math.round(p) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
