import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, stat, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const router = Router();
const execFileP = promisify(execFile);

// F1 截图热键:落图到 cgui-attachments/(与 upload.js 同目录,复用其 7 天清理),
// 返回和 /api/upload 一致的附件形状 { path, kind:'image', bytes, preview },前端直接进
// ChatInput 的附件卡片链路。preview 是内联 base64 dataUrl,免前端再回读一次文件。
const SHOT_DIR = join(tmpdir(), 'cgui-attachments');

// mac 交互式截图:screencapture -i 弹十字选区/点窗口。用户按 Esc 取消 → 进程退出 0 但不写文件,
// 据「文件是否存在」判取消(非报错)。Windows 无交互取消,PowerShell 全屏抓主屏兜底。
async function captureMac(outPath) {
  // -i 交互选区/点窗口;-x 静音(无快门声)。取消时不产文件。
  await execFileP('screencapture', ['-i', '-x', outPath]);
}

async function captureWindows(outPath) {
  // 单引号包路径:PowerShell 单引号内不做转义/变量展开。文件名是 UUID.png 不含单引号,但
  // tmpdir 前缀含 Windows 用户名可能带撇号(如 O'Brien)→ 提前闭合命令,故按 PS 规则把 ' 转成 ''。
  // (记忆 windows-porting-gotchas:execFile 内嵌路径用单引号,别用双引号)。MVP 只抓主屏。
  const psPath = outPath.replace(/'/g, "''");
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
    "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
    "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
    "$g=[System.Drawing.Graphics]::FromImage($bmp);",
    "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
    `$bmp.Save('${psPath}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    "$g.Dispose();$bmp.Dispose()",
  ].join(' ');
  await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
}

/**
 * POST /api/screenshot
 * 触发系统截图,成功返回 { path, kind:'image', bytes, preview }。
 * 用户取消(mac Esc)返回 { canceled: true }。
 * 失败/空文件返回 4xx { error, needsScreenRecording? }(mac 屏幕录制未授权的常见形态)。
 */
router.post('/screenshot', async (_req, res) => {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'win32') {
    return res.status(501).json({ error: `不支持的平台: ${platform}` });
  }
  await mkdir(SHOT_DIR, { recursive: true });
  const outPath = join(SHOT_DIR, `${randomUUID()}.png`);

  let cmdError = null;
  try {
    if (platform === 'darwin') await captureMac(outPath);
    else await captureWindows(outPath);
  } catch (err) {
    // screencapture 取消不会报错;这里的报错是真失败(命令缺失/权限被拒/PowerShell 异常)。
    cmdError = err;
  }

  // 以「文件是否存在且非空」为准判定结果 —— 比退出码可靠(screencapture 取消也退出 0)。
  let size = 0;
  try { size = (await stat(outPath)).size; } catch { /* 文件不存在 */ }

  if (size > 0) {
    try {
      const buf = await readFile(outPath);
      const preview = `data:image/png;base64,${buf.toString('base64')}`;
      return res.json({ path: outPath, url: outPath, kind: 'image', bytes: size, preview });
    } catch (err) {
      return res.status(500).json({ error: '读取截图失败: ' + err.message });
    }
  }

  // 无文件 / 空文件:清理残留空文件
  try { await unlink(outPath); } catch {}

  // mac:命令正常退出但没产文件 = 用户按 Esc 取消(静默)。
  if (platform === 'darwin' && !cmdError) {
    return res.json({ canceled: true });
  }

  // 其余(命令报错 / Windows 抓不到 / 空文件):失败。mac 上最常见根因是屏幕录制未授权。
  const body = { error: cmdError ? ('截图命令失败: ' + cmdError.message) : '截图为空,未生成图片' };
  if (platform === 'darwin') {
    body.needsScreenRecording = true;
    body.error = '截图失败或为空图。若首次使用,请在 系统设置 → 隐私与安全性 → 屏幕录制 勾选 Claude GUI 后重新打开应用再试。';
  }
  return res.status(500).json(body);
});

export default router;
