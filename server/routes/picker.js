import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { platform, homedir } from 'os';

const execFileP = promisify(execFile);
const router = Router();

/**
 * POST /api/pick-directory
 * Opens the OS-native folder picker, blocks until the user chooses or cancels.
 * Returns: { path: "/abs/path" } on pick, { path: null } on cancel.
 *
 * macOS uses AppleScript (`choose folder`). Windows uses PowerShell +
 * System.Windows.Forms.FolderBrowserDialog. The Express server must be
 * running under a GUI session (not headless / SSH) for the dialog to appear.
 */
router.post('/pick-directory', async (req, res) => {
  // Windows — PowerShell + .NET WinForms FolderBrowserDialog.
  if (platform() === 'win32') {
    const promptText = String(req.body?.prompt || '选择项目目录');
    const startDirRaw = (req.body?.startDir && typeof req.body.startDir === 'string')
      ? req.body.startDir
      : `${homedir()}\\Desktop`;
    // PowerShell single-quoted strings don't interpolate $vars; the only
    // escape is doubling embedded single quotes. Drop newlines too so a
    // crafted prompt can't break out of the literal.
    const escPS = (s) => s.replace(/[\r\n]+/g, ' ').replace(/'/g, "''");
    const script = [
      // UTF-8 stdout so Chinese paths survive the round-trip (Windows
      // PowerShell 5's default is the system code page → garbled CJK).
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new()",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dlg.Description = '${escPS(promptText)}'`,
      `$dlg.SelectedPath = '${escPS(startDirRaw)}'`,
      "$dlg.ShowNewFolderButton = $true",
      "if ($dlg.ShowDialog() -eq 'OK') { Write-Output $dlg.SelectedPath }",
    ].join('; ');
    try {
      // -Sta: WinForms REQUIRES single-threaded apartment; PowerShell defaults
      // to MTA which crashes ShowDialog with "OLE called on a thread that
      // hasn't been initialized as STA".
      const { stdout } = await execFileP('powershell.exe', [
        '-NoProfile', '-Sta', '-Command', script,
      ], { timeout: 120000, encoding: 'utf8' });
      const dir = stdout.trim();
      if (!dir) return res.json({ path: null });  // user cancelled
      res.json({ path: dir });
    } catch (err) {
      res.status(500).json({ error: String(err.stderr || err.message || '') });
    }
    return;
  }
  if (platform() !== 'darwin') {
    return res.status(501).json({ error: 'native picker only supported on macOS / Windows — paste an absolute path instead' });
  }
  try {
    const promptText = String(req.body?.prompt || '选择项目目录');
    // Two practical issues with the previous one-line incantation:
    //
    // 1) `choose folder` without `default location` makes the OS remember
    //    wherever the user last picked. After one pick inside
    //    ~/Desktop/claude/, every subsequent project-add dialog reopens
    //    there — gives users the impression that "every new project gets
    //    forced into claude/". Pin the start to ~/Desktop (or a caller-
    //    supplied dir) so the picker always starts in a sane neutral spot.
    //
    // 2) `POSIX path of (choose folder ...)` returns paths with a trailing
    //    slash. A trailing slash propagates into the project's hash
    //    (`path.replace(/[/\s]/g, '-')` yields an extra trailing dash),
    //    which breaks CLI session resume + downstream git operations.
    //    Strip it here.
    const startDirRaw = (req.body?.startDir && typeof req.body.startDir === 'string')
      ? req.body.startDir
      : `${homedir()}/Desktop`;
    // Proper AppleScript string escaping: backslash FIRST (else we'd double-
    // escape the quotes we add next), then double-quote, then drop newlines/
    // control chars so a crafted prompt can't break out of the quoted literal
    // and append `& (do shell script ...)`.
    const escAS = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
    const safeStart = escAS(startDirRaw);
    const safePrompt = escAS(promptText);
    const { stdout } = await execFileP(
      'osascript',
      ['-e', `POSIX path of (choose folder with prompt "${safePrompt}" default location POSIX file "${safeStart}")`],
      { timeout: 120000 },
    );
    let dir = stdout.trim();
    if (!dir) return res.json({ path: null });
    dir = dir.replace(/\/+$/, '') || '/';
    res.json({ path: dir });
  } catch (err) {
    const msg = String(err.stderr || err.message || '');
    if (/(?:User canceled|cancelled|user gave up)/i.test(msg)) {
      return res.json({ path: null });
    }
    res.status(500).json({ error: msg });
  }
});

export default router;
