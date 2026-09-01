/**
 * r69 图表导出 —— 落盘通道。
 *
 * 两条路,照仓内既有先例(App.jsx 的 ExportSessionButton,那套写法是被真实用户
 * "导出点了没反应"逼出来的):
 *  - **Tauri 壳里**:WKWebView 拦 blob URL 的 `a[download]`,所以走系统保存对话框
 *    (@tauri-apps/plugin-dialog 的 save,权限已在 src-tauri/capabilities/dialog.json 里)
 *    拿绝对路径,再 POST /api/export-file 由后端写盘。
 *  - **浏览器里**(手机经局域网打开、或直接访问 6677):blob URL + a[download],正常工作。
 *
 * 判据用 `isTauri()`(utils/pickDirectory.js 里那份,查 __TAURI_INTERNALS__),
 * 不另造第二份探测。
 *
 * @module genui/host/export-save
 */
import { isTauri } from '../../utils/pickDirectory.js';

const FILTERS = {
  png: { name: 'PNG 图片', extensions: ['png'] },
  csv: { name: 'CSV 表格', extensions: ['csv'] },
  json: { name: 'JSON 数据', extensions: ['json'] },
};

/** Blob → base64(不含 data URL 前缀)。 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.onerror = () => reject(new Error('读取导出内容失败'));
    fr.readAsDataURL(blob);
  });
}

/**
 * 保存一份导出物。
 * @returns `{ canceled: true }` 用户在保存对话框里取消;`{ path, chosen }` Tauri 落盘完成
 *   (`chosen` = 路径是用户在系统对话框里选的,调用方据此决定要不要再报一次落点);
 *   `{ downloaded: true }` 浏览器已触发下载。失败一律抛错。
 */
export async function saveExport(blob, fileName, ext) {
  if (isTauri()) {
    let targetPath = null;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      targetPath = await save({ title: '保存导出文件', defaultPath: fileName, filters: [FILTERS[ext]] });
      if (targetPath === null) return { canceled: true };
    } catch {
      // 对话框不可用(capability 漂移)→ targetPath 留 null,后端回落 ~/Downloads,
      // 行为不劣化(与会话导出同一处理)。
    }
    const r = await fetch('/api/export-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: await blobToBase64(blob), ext, fileName, ...(targetPath ? { targetPath } : {}) }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `导出失败(${r.status})`);
    return { path: d.path, chosen: targetPath !== null };
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { downloaded: true };
}
