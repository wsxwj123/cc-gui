import { Router } from 'express';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  GRANTS_FILE, RUNTIME_DIR, SHOT_DIR, VENV_PY,
  capabilityReport, readGrants, runtimeReady, screenScopeGranted, setGrant,
} from '../computer-use/cu-common.js';

// computer use(cc-gui 桌面操控)的 GUI 侧管理端点。
// 安装/卸载/开关本体不在这里:注册走通用 POST/DELETE /api/mcp(claude mcp add -s user,
// 带缓存失效+换代戳+agents 同步),本路由只提供「装它需要知道的东西」:
//   GET  /api/computer-use/status  → 脚本绝对路径 / 是否已注册 / 运行时 / 能力与锁屏状态
//   POST /api/computer-use/doctor  → 跑 helper doctor,回屏幕读取/辅助功能/运行时/各应用授权
//   GET  /api/computer-use/grants  → 当前授权(按应用 + 主屏范围)
//   POST /api/computer-use/grants  → 用户显式启用/撤销(撤销立即使后续动作 CU_APP_NOT_ALLOWED)
//   GET  /api/computer-use/apps     → 只读:「常规应用」(有 Dock 图标)的身份名单,给面板选授权对象
//   GET  /api/computer-use/app-info → 只读:一个 bundleId 是否已安装(name/path 来自 bundle 本体)
// 客户端(MCPPanel 安装卡)拿 status 里的 nodePath+mcpPath 拼 commandLine 去调通用端点。

/** helper 的权限自查结果 -> 稳定状态词(ok/denied/unknown -> available/unavailable/unverified)。 */
function permissionStatus(value) {
  if (value === 'ok') return 'available';
  if (value === 'denied') return 'unavailable';
  return 'unverified';
}

const router = Router();
const HERE = dirname(fileURLToPath(import.meta.url));
// server/routes → server/computer-use
const CU_DIR = join(HERE, '..', 'computer-use');
const MCP_SERVER = join(CU_DIR, 'mcp-server.js');
const HELPER = join(CU_DIR, 'cu_helper.py');

async function registered() {
  try {
    const j = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf-8'));
    return !!(j.mcpServers || {})['ccgui-computer-use'];
  } catch { return false; }
}

// 只读 helper 调用(照 doctor 的门体例,但超时按子命令实测值收紧):
// runtimeReady() 先判 → spawn → 15s 定时 SIGKILL → 解析 stdout 最后一行 JSON。
// 失败一律回稳定 code,绝不抛出、绝不 spawn 别的进程、不写任何文件(I4)。
// 15s 的来历:本机实测 apps/app-info 均 0.07-0.13s(含 Python 启动),~100x 余量。
function runHelper(args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    if (!runtimeReady()) {
      // 合同:缺运行时直接如实报告,**绝不**建 venv / 装东西
      return resolve({
        ok: false, code: 'CU_RUNTIME_UNAVAILABLE',
        error: '运行时尚未就绪(首次调用工具时自动准备):缺少 venv 或依赖戳。',
      });
    }
    let child;
    try {
      child = spawn(VENV_PY, [HELPER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, code: 'CU_RUNTIME_UNAVAILABLE', error: String(e.message).slice(0, 300) });
    }
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'CU_RUNTIME_UNAVAILABLE', error: String(e.message).slice(0, 300) });
    });
    child.on('exit', () => {
      clearTimeout(timer);
      if (timedOut) {
        return resolve({ ok: false, code: 'CU_TIMEOUT', error: `helper ${args[0]} 15 秒未返回,已终止。` });
      }
      let parsed = null;
      try {
        const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
        parsed = JSON.parse(line);
      } catch {
        // 报告而非失败请求:HTTP 仍 200,错误详情取 stderr/stdout 末尾 300 字符(不含堆栈包装)
        return resolve({ ok: false, code: 'CU_RUNTIME_UNAVAILABLE',
          error: (stderr || stdout).trim().slice(-300) || `helper ${args[0]} 无输出` });
      }
      resolve({ ok: true, parsed });
    });
  });
}

// helper 自身回了 ok:false(如 die() 落到 {"ok":false,"error":…})→ 同一张三行表
function helperFailure(r, args) {
  if (!r.ok) return { code: r.code, error: r.error };
  if (r.parsed && r.parsed.ok === false) {
    return { code: 'CU_RUNTIME_UNAVAILABLE',
      error: String(r.parsed.error ?? `${args[0]} 失败`).slice(0, 300) };
  }
  return null;
}

router.get('/computer-use/status', async (req, res) => {
  const { capabilities, lockscreen } = capabilityReport();
  res.json({
    platform: process.platform,
    supported: process.platform === 'darwin',
    path: CU_DIR,               // 旧客户端读的字段:computer use 资产目录
    mcpPath: MCP_SERVER,
    helperPath: HELPER,
    nodePath: process.execPath, // GUI 后端自己跑在哪个 node,CLI spawn MCP 就用哪个(同款 ABI/同款 PATH 逻辑)
    runtimeDir: RUNTIME_DIR,
    shotsDir: SHOT_DIR,
    grantsPath: GRANTS_FILE,
    registered: await registered(),
    runtimeReady: runtimeReady(),
    capabilities,
    lockscreen,
  });
});

router.post('/computer-use/doctor', async (req, res) => {
  const grants = readGrants();
  const apps = Object.entries(grants.apps).map(([bundleId, entry]) => ({
    bundleId, id: bundleId, name: entry.name || bundleId, granted: true, allowed: true,
    grantedAt: entry.grantedAt || null,
  }));
  const base = {
    platform: process.platform,
    runtimeDir: RUNTIME_DIR,
    permissions: {
      screen: { status: 'unavailable', detail: null },
      accessibility: { status: 'unavailable', detail: null },
      apps,
    },
    screenScope: { granted: screenScopeGranted(grants) },
    grants,
  };
  if (!runtimeReady()) {
    // 合同:缺运行时给稳定 code(HTTP 仍 200;doctor 是报告,不是失败请求)
    return res.json({
      ...base,
      ok: false,
      code: 'CU_RUNTIME_UNAVAILABLE',
      error: '运行时尚未就绪(首次调用工具时自动安装):缺少 venv 或依赖戳;先让模型调用一次工具完成准备。',
      checks: { runtime: { status: 'unavailable', detail: 'venv 未就绪' } },
    });
  }
  const p = spawn(VENV_PY, [HELPER, 'doctor'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { p.kill('SIGKILL'); } catch { /* 已退出 */ }
  }, 60_000);
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('error', (e) => {
    clearTimeout(timer);
    res.json({ ...base, ok: false, code: 'CU_RUNTIME_UNAVAILABLE', error: e.message });
  });
  p.on('exit', () => {
    clearTimeout(timer);
    if (timedOut) {
      return res.json({ ...base, ok: false, code: 'CU_TIMEOUT', error: 'doctor 60 秒未返回,已终止。' });
    }
    let parsed = null;
    try {
      const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
      parsed = JSON.parse(line);
    } catch {
      return res.json({ ...base, ok: false, code: 'CU_RUNTIME_UNAVAILABLE',
        error: (stderr || stdout).slice(-300) || 'doctor 无输出' });
    }
    const checks = {
      screenRead: { status: permissionStatus(parsed.screen_recording),
        detail: parsed.screen_recording_detail || null },
      accessibility: { status: permissionStatus(parsed.accessibility),
        detail: parsed.accessibility_detail || null },
      runtime: { status: 'available', detail: null },
      captureTest: { status: parsed.capture_test || 'unknown', detail: parsed.capture_test_detail || null },
    };
    const ok = checks.screenRead.status === 'available' && checks.accessibility.status === 'available';
    return res.json({
      ...base,
      ok,
      ...(ok ? {} : { code: 'CU_PERMISSION_REQUIRED' }),
      checks,
      permissions: {
        screen: checks.screenRead,
        accessibility: checks.accessibility,
        apps,
      },
      raw: parsed,
    });
  });
});

router.get('/computer-use/grants', (req, res) => {
  const grants = readGrants();
  res.json({
    screenScope: grants.screenScope,
    apps: Object.entries(grants.apps).map(([bundleId, entry]) => ({
      bundleId, name: entry.name || bundleId, granted: true, grantedAt: entry.grantedAt || null,
    })),
    grantsPath: GRANTS_FILE,
  });
});

router.post('/computer-use/grants', (req, res) => {
  const { bundleId, name, granted, screenScope } = req.body || {};
  if (bundleId !== undefined && (typeof bundleId !== 'string' || bundleId.length === 0 || bundleId.length > 200)) {
    return res.status(400).json({ ok: false, code: 'CU_INVALID_ARGUMENT', error: 'bundleId 必须是非空字符串。' });
  }
  if (granted !== undefined && typeof granted !== 'boolean') {
    return res.status(400).json({ ok: false, code: 'CU_INVALID_ARGUMENT', error: 'granted 必须是布尔值。' });
  }
  if (screenScope !== undefined && typeof screenScope !== 'boolean') {
    return res.status(400).json({ ok: false, code: 'CU_INVALID_ARGUMENT', error: 'screenScope 必须是布尔值。' });
  }
  if (bundleId === undefined && screenScope === undefined) {
    return res.status(400).json({ ok: false, code: 'CU_INVALID_ARGUMENT', error: '至少要给 bundleId 或 screenScope。' });
  }
  const next = setGrant({
    bundleId: bundleId || null,
    name: typeof name === 'string' ? name : null,
    granted: granted !== false,
    screenScope: screenScope === undefined ? null : screenScope,
  });
  res.json({
    ok: true,
    screenScope: next.screenScope,
    apps: Object.entries(next.apps).map(([id, entry]) => ({
      bundleId: id, name: entry.name || id, granted: true, grantedAt: entry.grantedAt || null,
    })),
  });
});

// 面板「添加应用」的候选名单:只回应用身份(bundleId/name/granted),不回 pid/标题/几何/像素(I3)。
// 失败与 doctor 同体例:HTTP 恒 200 + 稳定 code(报告,不是失败请求);绝不建 venv、不写文件(I4)。
router.get('/computer-use/apps', async (req, res) => {
  const grantedIds = new Set(Object.keys(readGrants().apps)); // B5:请求开始时刻的一次读取
  const r = await runHelper(['apps']);
  const failure = helperFailure(r, ['apps']);
  if (failure) return res.json({ ok: false, ...failure, apps: [] });
  // B1/B2/B3/B4:恰好三键、按 bundleId 去重与升序、空 id 不列(helper 已做一遍,这里是收口)
  const byId = new Map();
  for (const entry of Array.isArray(r.parsed.apps) ? r.parsed.apps : []) {
    const id = typeof entry?.bundleId === 'string' ? entry.bundleId : '';
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      bundleId: id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : id,
      granted: grantedIds.has(id),
    });
  }
  const apps = [...byId.values()].sort((a, b) => (a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0));
  res.json({ ok: true, apps });
});

// 手填 bundleId 的校验("这个 id 到底是不是那个应用")。只读、幂等;底层是既有 helper 子命令 app-info。
// 校验失败**不**妨碍授权(D.4):本端点只回报,不做任何授权动作。
router.get('/computer-use/app-info', async (req, res) => {
  const { bundleId } = req.query;
  // 与 POST /grants 的既有口径一致(重复 query 会解析成数组 → 非字符串 → 400)
  if (typeof bundleId !== 'string' || bundleId.length === 0 || bundleId.length > 200) {
    return res.status(400).json({ ok: false, code: 'CU_INVALID_ARGUMENT', error: 'bundleId 必须是非空字符串。' });
  }
  const r = await runHelper(['app-info', '--bundle-id', bundleId]);
  const failure = helperFailure(r, ['app-info']);
  if (failure) return res.json({ ok: false, ...failure });
  res.json({
    ok: true,
    bundleId,
    installed: r.parsed.installed === true,
    name: typeof r.parsed.name === 'string' ? r.parsed.name : null,
    path: typeof r.parsed.path === 'string' ? r.parsed.path : null,
  });
});

export default router;
