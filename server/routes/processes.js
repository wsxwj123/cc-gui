import { Router } from 'express';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getActiveChatProcesses } from './chat.js';

const execFileP = promisify(execFile);
const router = Router();
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

// 解析 wmic CSV 输出为 {COL: value} 行数组。wmic /format:csv 首列恒为 Node(主机名)。
// 注:naive split(',') 对 CommandLine 含逗号会错位 —— 已由下面 CIM(JSON)主路径规避,
// 此函数仅作 wmic 回落路径的解析,老系统上凑合用。
function parseWmicCsv(output) {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex((l) => /,/.test(l) && /Node/i.test(l));
  if (headerIdx < 0) return [];
  const headers = lines[headerIdx].split(',');
  return lines.slice(headerIdx + 1).map((line) => {
    const cols = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (cols[i] || '').trim(); });
    return row;
  });
}

// Windows 进程查询:PowerShell CIM 为主 + wmic 回落。
// 根因:wmic 自 Win 10 21H1 起弃用,**Win 11 24H2 已作为"按需功能"从默认镜像移除**,
// 新机器可能整个没有 wmic.exe → 纯 wmic 的进程面板/claude 进程列表在新 Windows 上全坏。
// CIM(Get-CimInstance)在 PowerShell 3+(Win 8+)恒可用,是官方替代。顺带用 JSON 输出
// 规避 parseWmicCsv 的逗号错位 bug。filter:null=全量,数字=按 ProcessId。
// 返回统一形状 [{ProcessId, ParentProcessId, CommandLine, CreationDate(yyyyMMddHHmmss)}]。
async function winQueryProcesses(filter = null) {
  // -Filter 用【单引号】:整个 -Command 串因此不含任何双引号,Node 在 Windows 上把它当
  // 单个 argv 传给 powershell 时无需转义内嵌双引号(execFile 的 Windows 引号处理对内嵌
  // 双引号很脆)。ProcessId 是 Number() 过的纯数字,单引号内无注入风险。
  const where = filter != null ? `-Filter 'ProcessId=${Number(filter)}'` : '';
  // CreationDate 是 CIM DateTime,ConvertTo-Json 会序列化成 /Date(...)/;显式转成
  // 与 wmic 同款的 yyyyMMddHHmmss 字符串,下游 startedAt 消费方无需分平台。
  const ps = `Get-CimInstance Win32_Process ${where} | Select-Object ProcessId,ParentProcessId,CommandLine,@{N='CreationDate';E={ if($_.CreationDate){$_.CreationDate.ToString('yyyyMMddHHmmss')}else{''} }} | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 15000 });
    const t = stdout.trim();
    if (!t) return [];
    const parsed = JSON.parse(t);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((r) => ({
      ProcessId: r.ProcessId != null ? String(r.ProcessId) : '',
      ParentProcessId: r.ParentProcessId != null ? String(r.ParentProcessId) : '',
      CommandLine: r.CommandLine || '',
      CreationDate: r.CreationDate || '',
    }));
  } catch {
    // 回落 wmic(老系统上 CIM 不在或被策略禁 → 仍有 wmic)。
    try {
      const args = filter != null
        ? ['process', 'where', `ProcessId=${Number(filter)}`, 'get', 'ProcessId,ParentProcessId,CommandLine,CreationDate', '/format:csv']
        : ['process', 'get', 'ProcessId,ParentProcessId,CommandLine,CreationDate', '/format:csv'];
      const { stdout } = await execFileP('wmic', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 15000 });
      return parseWmicCsv(stdout);
    } catch { return []; }
  }
}

// 毫秒间隔 → ps etime 同款 [[dd-]hh:]mm:ss,前端"运行 xx"直接展示。
function formatElapsedMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}-${pad(h)}:${pad(m)}:${pad(sec)}`;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

// CIM/wmic 的 CreationDate(yyyyMMddHHmmss,本机时区)→ Date;解析失败返回 null。
function parseWmiDate(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// ps 输出单行 → 统一形状 { pid, ppid, cpu, mem, elapsed, startedAt, command }。
// 列固定为 pid,ppid,pcpu,pmem,etime,lstart(5 段),command(剩余)。lstart 形如
// "Wed Jul 23 10:00:00 2026" 恒 5 个空白分隔段,按段数切比按正则稳。
function parsePsLine(line, withPpid) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < (withPpid ? 10 : 9)) return null;
  let i = 0;
  const pid = parseInt(parts[i++]);
  const ppid = withPpid ? parseInt(parts[i++]) : null;
  const cpu = parts[i++];
  const mem = parts[i++];
  const elapsed = parts[i++];
  const startedAt = parts.slice(i, i + 5).join(' '); i += 5;
  const command = parts.slice(i).join(' ');
  if (!Number.isFinite(pid)) return null;
  return { pid, ppid: Number.isFinite(ppid) ? ppid : null, cpu, mem, elapsed, startedAt, command };
}

async function getProcessInfo(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (process.platform === 'win32') {
    // Windows 无 ps。CIM(wmic 回落)取 ppid/命令行/启动时间;cpu/mem 不便取→给 null 不崩。
    try {
      const rows = await winQueryProcesses(n);
      if (!rows.length) return null;
      const r = rows[0];
      const start = parseWmiDate(r.CreationDate);
      return {
        pid: parseInt(r.ProcessId) || n,
        ppid: r.ParentProcessId ? parseInt(r.ParentProcessId) : null,
        cpu: null,
        mem: null,
        elapsed: start ? formatElapsedMs(Date.now() - start.getTime()) : null, // 由 CreationDate 推算(etime 语义)
        startedAt: r.CreationDate || null,  // WMI 形如 20260619141700.000000+480
        command: r.CommandLine || null,
      };
    } catch {
      return null;
    }
  }
  try {
    // etime=运行时长(别用 ps aux 的 TIME 列,那是累计 CPU 时间);lstart=启动时间。
    // LC_ALL=C:parsePsLine 按英文 locale 解析 lstart,非英文系统整批解析失败。
    const { stdout: output } = await execFileP('ps', ['-p', String(n), '-o', 'pid=,ppid=,pcpu=,pmem=,etime=,lstart=,command='], { encoding: 'utf-8', env: { ...process.env, LC_ALL: 'C' } });
    const line = output.trim();
    if (!line) return null;
    return parsePsLine(line, true);
  } catch {
    return null;
  }
}

// GET /api/processes — list all Claude Code processes
router.get('/processes', async (req, res) => {
  try {
    let sessionFiles = [];
    try {
      sessionFiles = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.json'));
    } catch {}

    // Index chat.js's in-memory map so we can attach the actual prompt / model /
    // mode the GUI launched the process with. CG-5:SDK 引擎下 chat.pid 是合成 'sdk-N',
    // 与 session 的真实 OS pid 对不上 → 按 pid 查永远 null → GUI 元数据丢。改按 sessionId
    // 索引为主,pid 索引保留作旧路径兜底。
    const chatByPid = {};
    const chatBySession = {};
    for (const c of getActiveChatProcesses()) {
      chatByPid[String(c.pid)] = c;
      if (c.sessionId) chatBySession[c.sessionId] = c;
    }

    const processes = [];
    for (const file of sessionFiles) {
      try {
        const raw = await readFile(join(SESSIONS_DIR, file), 'utf-8');
        const session = JSON.parse(raw);
        const pid = session.pid;
        const alive = pid ? isProcessAlive(pid) : false;
        const psInfo = alive ? await getProcessInfo(pid) : null;
        const sid = session.sessionId || file.replace('.json', '');
        const chat = (sid && chatBySession[sid]) || chatByPid[String(pid)] || null;

        processes.push({
          sessionId: session.sessionId || file.replace('.json', ''),
          pid,
          alive,
          cwd: session.cwd || null,
          startedAt: session.startedAt || chat?.startedAt || null,
          kind: session.kind || (chat ? 'gui-chat' : null),
          entrypoint: session.entrypoint || null,
          // Rich metadata when GUI spawned this process
          promptPreview: chat?.promptPreview || null,
          model: chat?.model || null,
          permissionMode: chat?.permissionMode || null,
          status: chat ? (chat.attached ? 'streaming' : 'starting') : (alive ? 'running' : 'ended'),
          psInfo,
        });
      } catch {}
    }

    // Also find claude processes — no shell, filter in JS to avoid a shell pipe
    // (`ps aux | grep`) spawning /bin/sh on every poll.
    let claudeProcesses = [];
    if (process.platform === 'win32') {
      // Windows 无 ps。CIM(wmic 回落)取全量进程命令行,按命令行匹配 claude;cpu/mem→null。
      try {
        claudeProcesses = (await winQueryProcesses())
          .filter((r) => r.CommandLine && /\bclaude\b/i.test(r.CommandLine) && !/claude-gui/i.test(r.CommandLine))
          .map((r) => {
            const start = parseWmiDate(r.CreationDate);
            return {
              pid: parseInt(r.ProcessId) || null,
              ppid: r.ParentProcessId ? parseInt(r.ParentProcessId) : null,
              cpu: null, // CIM 全量查 cpu/mem 代价高,面板只展示 null 占位
              mem: null,
              elapsed: start ? formatElapsedMs(Date.now() - start.getTime()) : null,
              startedAt: r.CreationDate || null,
              command: r.CommandLine,
            };
          });
      } catch {}
    } else {
      try {
        // 不用 ps aux:其第 9 列 TIME 是累计 CPU 时间不是运行时长(elapsed 语义错),
        // 且没有 startedAt。显式列输出与 getProcessInfo 同口径解析。ppid 前端不展示,
        // 全量列表省去一列(parsePsLine 第二参 false → ppid:null)。
        // LC_ALL=C 同上:固定英文 locale 输出供 parsePsLine 解析。
        const { stdout: psOutput } = await execFileP('ps', ['-ax', '-o', 'pid=,pcpu=,pmem=,etime=,lstart=,command='], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
        claudeProcesses = psOutput.trim().split('\n').filter((line) => {
          return /\bclaude\b/.test(line) && !/claude-gui/.test(line) && !/\bgrep\b/.test(line);
        }).map((line) => parsePsLine(line, false)).filter(Boolean);
      } catch {}
    }

    res.json({ sessionProcesses: processes, claudeProcesses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/processes/:pid/kill — SIGTERM then SIGKILL fallback.
// Only honored for PIDs that show up in our session registry OR are visibly
// claude/node children — refuses arbitrary PIDs to avoid being a kill-anything
// service when bound to 0.0.0.0.
router.post('/processes/:pid/kill', async (req, res) => {
  const pid = Number(req.params.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return res.status(400).json({ error: 'invalid pid' });
  }
  // Whitelist check: must be in ~/.claude/sessions/*.json
  let allowed = false;
  try {
    const files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const raw = await readFile(join(SESSIONS_DIR, f), 'utf-8');
        const s = JSON.parse(raw);
        if (Number(s.pid) === pid) { allowed = true; break; }
      } catch {}
    }
  } catch {}
  if (!allowed) {
    return res.status(403).json({ error: 'pid not in claude session registry — refused' });
  }
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {} }, 5000).unref();
    res.json({ ok: true, pid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
