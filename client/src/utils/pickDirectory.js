// 系统文件夹选择器(跨平台 helper)。
//
// 主路径:Tauri 环境下走官方 @tauri-apps/plugin-dialog 的 open(),进程内
// NSOpenPanel(mac)/IFileDialog(win) —— 秒开、天然置前、正确父窗口。
// 回退路径:浏览器模式(无 __TAURI_INTERNALS__)或 IPC 失败时,POST
// /api/pick-directory 走后端 osascript / PowerShell(server/routes/picker.js,
// 内含 mac activate / win TopMost hack,只服务这条回退)。
//
// 返回语义与后端接口一致:{ path: "/abs/path" } 选中(无尾斜杠),
// { path: null } 取消;两条路径都失败时抛错,由调用方决定兜底(手输路径框)。
import { open } from '@tauri-apps/plugin-dialog';

// withGlobalTauri=false,无 window.__TAURI__;__TAURI_INTERNALS__ 由 Tauri
// 注入脚本写入所有页面,是"跑在 Tauri 壳里"的判据(浏览器访问 6677 时不存在)。
export function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// 去尾斜杠,语义对齐 picker.js:mac 根目录保留 "/";win 盘根 "C:\" 保留反斜杠
// (裸 "C:" 在 node path 语义里是盘相对路径,不能截)。
function stripTrailingSlash(p) {
  const s = String(p);
  const trimmed = s.replace(/[/\\]+$/, '');
  if (!trimmed) return '/';
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
  return trimmed;
}

export async function pickDirectory({ prompt = '选择项目目录', startDir } = {}) {
  if (isTauri()) {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: prompt,
        defaultPath: startDir || undefined,
      });
      if (picked === null) return { path: null }; // 用户取消
      return { path: stripTrailingSlash(picked) };
    } catch {
      // IPC 被拒(capability 配置漂移)或插件异常 → 落回后端 picker,行为不劣化。
    }
  }
  const r = await fetch('/api/pick-directory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, startDir: startDir || undefined }),
  });
  if (!r.ok) throw new Error(`pick-directory ${r.status}`);
  return r.json();
}
