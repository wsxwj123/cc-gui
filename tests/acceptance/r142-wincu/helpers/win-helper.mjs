#!/usr/bin/env node
// r142-wincu 夹具:假的 Windows helper 解释器(顶替 venv-win/Scripts/python.exe)。
// 与 tests/unit/r142-helpers/win-helper-stub.mjs 同一体例,但只保留验收需要的最小面:
//   - `-m venv <dir>`:真的把 Windows venv 布局造出来(否则 /prepare 之后 VENV_PY 仍不存在);
//   - `-m pip install …`:装作成功,把依赖表记进 argv 日志;
//   - `<HELPER> <子命令>`:按 scenario.json 回一行 JSON,并记 argv。
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const log = process.env.CU_STUB_LOG;
const scenarioPath = process.env.CU_STUB_SCENARIO;
const record = (obj) => { if (log) fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...obj })}\n`); };

if (argv.includes('--version')) { record({ kind: 'py', subcmd: '--version', pyname: process.env.CU_STUB_PYNAME || null }); process.stdout.write('Python 3.12.0\n'); process.exit(0); }

if (argv[0] === '-m') {
  record({ kind: 'py', subcmd: `-m ${argv[1]}`, args: argv.slice(1) });
  if (argv[1] === 'venv') {
    const dir = argv[2];
    fs.mkdirSync(path.join(dir, 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pyvenv.cfg'), 'home = C:\\Fake\n');
    fs.copyFileSync(process.argv[1], path.join(dir, 'Scripts', 'python.exe'));
    fs.chmodSync(path.join(dir, 'Scripts', 'python.exe'), 0o755);
  }
  process.exit(0);
}

const subcmd = argv[1];
record({ kind: 'helper', subcmd, args: argv.slice(2), helper: path.basename(String(argv[0])) });
let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')); } catch { scenario = {}; }

const DEFAULTS = {
  'uia-probe': { ok: true, uia: true, comtypes: '1.4.11' },
  windows: { ok: true, frontmost: null, windows: [] },
  apps: { ok: true, apps: [] },
  'app-info': { ok: true, installed: true, name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe' },
  doctor: { ok: true, platform: 'win32', screen_recording: 'ok', accessibility: 'not-applicable', capture_test: 'ok',
    dpi_awareness: 'per-monitor-v2', scale: 1, integrity_level: 'medium', python: '3.12.0', deps: 'mss/Pillow/comtypes' },
  cursor: { ok: true, point: [0, 0], local: null },
  'release-hold': { ok: true, released: [] },
};
const reply = scenario[subcmd]?.reply ?? DEFAULTS[subcmd] ?? { ok: true };
process.stdout.write(`${JSON.stringify(reply)}\n`);
process.exit(scenario[subcmd]?.exitCode ?? 0);
