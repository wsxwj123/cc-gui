#!/usr/bin/env node
// 假的 cu_helper 解释器(顶替 venv 里的 python3):只记录 mcp-server 传来的 argv、按剧本回一行 JSON。
// 不跑任何 Python、不装任何包、不碰桌面。
//   argv 形态:[node, 本文件, <HELPER 路径>, <子命令>, ...参数]   或   [node, 本文件, '-m', 'pip', ...]
//   环境:CU_STUB_LOG(argv 记录,jsonl)/ CU_STUB_SIGLOG(收到的信号)/ CU_STUB_SCENARIO(剧本 JSON)
//   剧本:{ "<子命令>": { "reply": {...}, "sleepMs": n, "exitCode": n } }
import fs from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === '-m') process.exit(0); // 万一 stamp 不匹配走到 pip install:装作成功,绝不真装

const HELPER_PATH = argv[0];
const subcmd = argv[1];
const rest = argv.slice(2);
const log = process.env.CU_STUB_LOG;
const sigLog = process.env.CU_STUB_SIGLOG;
if (log) fs.appendFileSync(log, `${JSON.stringify({ subcmd, args: rest, helper: HELPER_PATH, at: Date.now() })}\n`);

let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(process.env.CU_STUB_SCENARIO, 'utf8')); } catch { scenario = {}; }
const sc = scenario[subcmd] || {};

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (sigLog) fs.appendFileSync(sigLog, `${JSON.stringify({ subcmd, signal: sig, at: Date.now() })}\n`);
    process.exit(0);
  });
}

const DEFAULTS = {
  windows: { ok: true, frontmost: null, windows: [] },
  'app-info': { ok: true, installed: true, path: '/Applications/Granted.app', name: 'Granted' },
  'ax-state': { ok: true, state: { readable: false, reason: 'no-text-element' } },
  'ax-type': { ok: true, method: 'value', before: { readable: true, text: '', selStart: 0, selEnd: 0 }, after: { readable: true, text: '', selStart: 0, selEnd: 0 }, expected: '' },
  'ax-key': { ok: true, before: { readable: false, reason: 'no-text-element' }, after: { readable: false, reason: 'no-text-element' }, ax_equivalent: null },
  type: { ok: true, mode: 'global-event', chars: 0, method: 'typewrite', foreground_affected: true },
  key: { ok: true, mode: 'global-event', keys: [], foreground_affected: true },
  cursor: { ok: true, point: [0, 0] },
  doctor: { ok: true, platform: 'darwin', screen_recording: 'ok', accessibility: 'ok', capture_test: 'ok' },
};

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function finish() {
  if (subcmd === 'screenshot') {
    // 真 helper 会把 --out 的 png 转成 jpg 落盘;这里直接写一个几字节的 jpg 占位。
    const png = rest[rest.indexOf('--out') + 1] || '';
    const jpg = png.replace(/\.png$/, '.jpg');
    fs.mkdirSync(dirname(jpg), { recursive: true });
    fs.writeFileSync(jpg, Buffer.from('ffd8ffd9', 'hex'));
    emit({
      ok: true, path: jpg, mime: 'image/jpeg', pixel: { w: 100, h: 50 }, logical: { w: 100, h: 50 },
      bounds: { x: 0, y: 0, w: 100, h: 50 }, displayId: 1, scale: 1, ...(sc.reply || {}),
    });
  } else if (sc.reply) {
    emit(sc.reply);
  } else {
    emit(DEFAULTS[subcmd] || { ok: true });
  }
  process.exit(sc.exitCode ?? 0);
}

if (sc.sleepMs) setTimeout(finish, sc.sleepMs); else finish();
