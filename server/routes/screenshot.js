import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, stat, readFile, unlink, writeFile } from 'fs/promises';
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
// 据「文件是否存在」判取消(非报错)。
async function captureMac(outPath) {
  // -i 交互选区/点窗口;-x 静音(无快门声)。取消时不产文件。
  await execFileP('screencapture', ['-i', '-x', outPath]);
}

// Windows 交互式截图:ms-screenclip: 协议拉起系统区域截取(Snipping,Win10 1809+),用户框选后
// 结果进剪贴板 → 轮询「剪贴板序列号变化 且 含图片」存 PNG。取舍:截图会占用用户剪贴板,不做
// 备份/恢复(剪贴板回写不可靠,且会覆盖截图本身)。系统 overlay 天然支持多显示器与 per-monitor DPI。
// 取消/超时语义:正常退出但不写文件 → 路由按 canceled 处理,绝不静默降级成全屏。
// Esc 快速判定:overlay 进程(Win10=ScreenClippingHost / Win11=SnippingTool)出现过又消失、
// 宽限 3s 内仍无新图 → 取消;进程名不匹配的机型 sawOverlay 恒 false,60s 后与「overlay
// 从未出现」同走报错(exit 1),**不是取消**(取消判定依赖认得出 overlay 进程名)。
const WIN_SNIP_PS1 = `param([string]$OutPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -Namespace CgUi -Name U32 -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
$seq0 = [CgUi.U32]::GetClipboardSequenceNumber()
Start-Process -FilePath 'explorer.exe' -ArgumentList 'ms-screenclip:'
$deadline = [DateTime]::UtcNow.AddSeconds(60)
$sawOverlay = $false
$goneAt = $null
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $img = $null
  try {
    if ([CgUi.U32]::GetClipboardSequenceNumber() -ne $seq0 -and [System.Windows.Forms.Clipboard]::ContainsImage()) {
      $img = [System.Windows.Forms.Clipboard]::GetImage()
    }
  } catch { }
  if ($img -ne $null) {
    # Save 失败不能被剪贴板容错 catch 吞掉:用户已框选,吞了会误报「取消」→ 抛出走 exit 1 报错
    try { $img.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png); $img.Dispose(); exit 0 }
    catch { throw ('clipboard image save failed: ' + $_.Exception.Message) }
  }
  $procs = @(Get-Process -Name 'SnippingTool','ScreenClippingHost' -ErrorAction SilentlyContinue)
  if ($procs.Count -gt 0) { $sawOverlay = $true; $goneAt = $null }
  elseif ($sawOverlay) {
    if ($goneAt -eq $null) { $goneAt = [DateTime]::UtcNow }
    elseif (([DateTime]::UtcNow - $goneAt).TotalSeconds -ge 3) { exit 0 }
  }
}
if (-not $sawOverlay) { throw 'ms-screenclip overlay not launched (Snipping Tool missing or protocol unsupported)' }
exit 0
`;

async function captureWindows(outPath) {
  // 脚本落临时 .ps1 用 -File 传参:P/Invoke 定义必须含双引号,走 -Command 内嵌会撞 execFile
  // 双引号转义坑(记忆 windows-porting-gotchas)。-Sta 保证 Clipboard API 可用。
  const scriptPath = join(SHOT_DIR, `${randomUUID()}.ps1`);
  await writeFile(scriptPath, WIN_SNIP_PS1, 'utf8');
  try {
    await execFileP('powershell', [
      '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, outPath,
    ], { timeout: 70_000, windowsHide: true });
  } finally {
    try { await unlink(scriptPath); } catch {}
  }
}

/**
 * POST /api/screenshot
 * 触发系统截图,成功返回 { path, kind:'image', bytes, preview }。
 * 用户取消(mac/win Esc、win 超时)返回 { canceled: true }。
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

  // 命令正常退出但没产文件 = 用户取消(mac Esc / win Esc 或超时,脚本正常退出不写文件)。
  if (!cmdError) {
    return res.json({ canceled: true });
  }

  // 其余(命令报错 / 空文件):失败。mac 上最常见根因是屏幕录制未授权。
  const body = { error: cmdError ? ('截图命令失败: ' + cmdError.message) : '截图为空,未生成图片' };
  if (platform === 'darwin') {
    body.needsScreenRecording = true;
    body.error = '截图失败或为空图。若首次使用,请在 系统设置 → 隐私与安全性 → 屏幕录制 勾选 cc-gui 后重新打开应用再试。';
  }
  return res.status(500).json(body);
});

export default router;
