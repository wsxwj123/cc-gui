// computer use 的共享配置层:MCP 进程(由 CLI spawn)与 GUI 后端(server route)都读这一份。
//
// 为什么 runtime 目录不直接用 os.homedir():GUI 后端与 CLI 常由不同 launcher 启动,
// 两者的 $HOME 可能不同(打包后 tauri 启动的后端、终端里的 CLI)。授权/运行时/截图目录
// 必须落在同一个用户级位置,否则"面板里授权了、MCP 却说不允许"。所以优先用
// os.userInfo().homedir(登录用户在 /etc/passwd 里的家目录,不受 $HOME 影响)。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir, userInfo } from 'os';
import { join } from 'path';

export const RUNTIME_DIR = cuRuntimeDir();
export const VENV_DIR = join(RUNTIME_DIR, 'venv');
export const VENV_PY = join(VENV_DIR, 'bin', 'python3');
export const STAMP_FILE = join(RUNTIME_DIR, 'venv.stamp');
export const SHOT_DIR = join(RUNTIME_DIR, 'shots');
export const GRANTS_FILE = join(RUNTIME_DIR, 'grants.json');

function cuRuntimeDir() {
  let home = null;
  try {
    home = userInfo().homedir;
  } catch {
    home = null;
  }
  return join(home || homedir(), '.claude-gui', 'cu-runtime');
}

// ── 能力状态(合同第 9 段:不得含糊) ────────────────────────────────────
// available / unsupported / unverified + reason(非 available 必须给 reason)。
// 锁屏路径当前没有已验证的授权组件接口,只能 disabled/unverified。
export function capabilityReport({ platformName = process.platform } = {}) {
  const mac = platformName === 'darwin';
  const capabilities = {
    screenshot: mac
      ? { status: 'available' }
      : { status: 'unsupported', reason: 'computer use 当前只实现 macOS;Windows 无桌面执行层' },
    screenshotTarget: {
      status: 'unverified',
      reason: '按应用/窗口截图尚未在真机验证;能力未证明前不返回前台其他应用的画面顶替',
    },
    windowList: mac ? { status: 'available' } : { status: 'unsupported', reason: '仅 macOS' },
    cursorPosition: mac ? { status: 'available' } : { status: 'unsupported', reason: '仅 macOS' },
    backgroundClick: mac ? { status: 'available' } : { status: 'unsupported', reason: '仅 macOS' },
    backgroundType: mac
      ? { status: 'available' }
      : { status: 'unsupported', reason: '仅 macOS' },
    backgroundKey: mac ? { status: 'available' } : { status: 'unsupported', reason: '仅 macOS' },
    screenScope: {
      status: 'unverified',
      reason: '需要单独授权「允许主屏全部可见内容」后才允许主屏截图;当前只能通过 POST /api/computer-use/grants 设置 screenScope:true,图形界面尚未提供该入口',
    },
    lockscreen: {
      status: 'unverified',
      reason: '锁屏持续/遮蔽显示器需要已验证的授权组件,当前无公开可复用接口;未证明前不声明可用',
    },
  };
  return {
    capabilities,
    lockscreen: {
      state: 'disabled',
      reason: '本构建不提供锁屏操控;显式启用锁屏需要独立授权组件,尚未验证(见 capabilityReport.lockscreen)',
    },
  };
}

// ── 授权(按应用 + 全屏范围) ────────────────────────────────────────────
// 存储形态:
// { version:1, screenScope:{granted:bool, grantedAt}, apps:{ [bundleId]: {name, grantedAt} } }
export const EMPTY_GRANTS = { version: 1, screenScope: { granted: false, grantedAt: null }, apps: {} };

export function readGrants() {
  try {
    const raw = JSON.parse(readFileSync(GRANTS_FILE, 'utf8'));
    return normalizeGrants(raw);
  } catch {
    return { version: 1, screenScope: { granted: false, grantedAt: null }, apps: {} };
  }
}

function normalizeGrants(raw) {
  const out = { version: 1, screenScope: { granted: false, grantedAt: null }, apps: {} };
  if (raw && typeof raw === 'object') {
    if (raw.screenScope && raw.screenScope.granted === true) {
      out.screenScope = { granted: true, grantedAt: raw.screenScope.grantedAt || null };
    }
    for (const [bundleId, entry] of Object.entries(raw.apps || {})) {
      if (!bundleId || typeof entry !== 'object' || entry === null) continue;
      out.apps[bundleId] = { name: typeof entry.name === 'string' ? entry.name : bundleId,
        grantedAt: entry.grantedAt || null };
    }
  }
  return out;
}

export function writeGrants(next) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const tmp = `${GRANTS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalizeGrants(next), null, 2)}\n`);
  renameSync(tmp, GRANTS_FILE); // 原子替换:并发读到的永远是完整 JSON
  return readGrants();
}

/** 单次授权变更。bundleId=null 表示只改全屏范围。granted=false 即撤销。 */
export function setGrant({ bundleId = null, name = null, granted = true, screenScope = null } = {}) {
  const current = readGrants();
  const next = { ...current, apps: { ...current.apps }, screenScope: { ...current.screenScope } };
  if (screenScope !== null) {
    next.screenScope = screenScope
      ? { granted: true, grantedAt: new Date().toISOString() }
      : { granted: false, grantedAt: null };
  }
  if (bundleId) {
    if (granted) {
      next.apps[bundleId] = { name: name || current.apps[bundleId]?.name || bundleId,
        grantedAt: new Date().toISOString() };
    } else {
      delete next.apps[bundleId];
    }
  }
  return writeGrants(next);
}

export function appGranted(grants, bundleId) {
  return Boolean(bundleId && grants.apps && grants.apps[bundleId]);
}

export function screenScopeGranted(grants) {
  return Boolean(grants.screenScope && grants.screenScope.granted === true);
}

export function runtimeReady() {
  return existsSync(VENV_PY) && existsSync(STAMP_FILE);
}
