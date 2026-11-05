#!/usr/bin/env node
// r154 验收套件的假 helper(顶替 venv 里的 python3):只读 argv/stdin、按剧本回一行 JSON;
// 不跑 Python、不装包、不碰桌面、不联网。每次调用记一行到 R154_STUB_LOG(jsonl)。
//   argv 形态:[node, 本文件, <HELPER 路径>, <子命令>, ...参数]  或  [node, 本文件, '-m'|'-c'|'--version', ...]
//   剧本 scenario.json:
//     windows:[{id,pid,app,bundleId,title,bounds,displayId}]  frontmost:{pid,name,bundleId}|null
//     cursor:{point:[x,y], over:{bundleId,pid,windowId,x,y}|null}  apps:[{bundleId,name,pid}]
//     overrides:{"<子命令>":{reply,exitCode,sleepMs}}
// 过滤模拟:真 helper 若按调用方传来的授权清单过滤窗口/光标命中,这里等价处理 ——
//   argv/stdin 里只要出现 reverse-DNS 形的应用 id(com./org./net./io. 开头),就只放行 bundleId 被提到的窗口;
//   一个都没提到则全放行(此时由被测一侧自己过滤)。
import fs from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const logFile = process.env.R154_STUB_LOG;
const note = (o) => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...o })}\n`); };
const emit = (obj, code = 0) => process.stdout.write(`${JSON.stringify(obj)}\n`, () => process.exit(code));

const DEFAULTS = {
  'app-info': { ok: true, installed: true, path: '/Applications/Fixture.app', name: 'Fixture' },
  'ax-state': { ok: true, state: { readable: false, reason: 'no-text-element' } },
  'ax-type': { ok: true, method: 'value', before: { readable: true, text: '', selStart: 0, selEnd: 0 }, after: { readable: true, text: '', selStart: 0, selEnd: 0 }, expected: '' },
  'ax-key': { ok: true, before: { readable: false, reason: 'no-text-element' }, after: { readable: false, reason: 'no-text-element' }, ax_equivalent: null },
  type: { ok: true, mode: 'global-event', chars: 0, method: 'typewrite', foreground_affected: true },
  key: { ok: true, mode: 'global-event', keys: [], foreground_affected: true },
  doctor: { ok: true, platform: 'darwin', screen_recording: 'ok', accessibility: 'ok', capture_test: 'ok' },
};

function readStdin(ms) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let buf = '';
    const done = () => { clearTimeout(timer); try { process.stdin.pause(); } catch { /* 已关 */ } resolve(buf); };
    const timer = setTimeout(done, ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function main() {
  const subcmd = argv[1];
  const rest = argv.slice(2);
  const stdinText = await readStdin(150);
  note({ kind: 'helper', subcmd, args: rest, stdin: stdinText ? stdinText.slice(0, 300) : undefined });
  let scenario = {};
  try { scenario = JSON.parse(fs.readFileSync(process.env.R154_STUB_SCENARIO, 'utf8')); } catch { scenario = {}; }
  const mentioned = new Set((`${rest.join(' ')} ${stdinText}`.match(/\b(?:com|org|net|io)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/gi) || []).map((s) => s.toLowerCase()));
  const keep = (bundleId) => mentioned.size === 0 || mentioned.has(String(bundleId).toLowerCase());
  const ov = scenario.overrides?.[subcmd] || {};
  let reply;
  if (ov.reply) {
    reply = ov.reply;
  } else if (subcmd === 'windows') {
    reply = { ok: true, frontmost: scenario.frontmost ?? null, windows: (scenario.windows || []).filter((w) => keep(w.bundleId)) };
  } else if (subcmd === 'cursor') {
    const c = scenario.cursor || {};
    reply = { ok: true, point: c.point || [0, 0] };
    if (c.over && keep(c.over.bundleId)) reply.local = { bundleId: c.over.bundleId, pid: c.over.pid, windowId: c.over.windowId, x: c.over.x, y: c.over.y };
  } else if (subcmd === 'apps') {
    reply = { ok: true, apps: scenario.apps || [] };
  } else if (subcmd === 'screenshot') {
    const png = rest[rest.indexOf('--out') + 1] || '';
    const jpg = png.replace(/\.png$/, '.jpg');
    fs.mkdirSync(dirname(jpg), { recursive: true });
    fs.writeFileSync(jpg, Buffer.from('ffd8ffd9', 'hex'));
    reply = { ok: true, path: jpg, mime: 'image/jpeg', pixel: { w: 100, h: 50 }, logical: { w: 100, h: 50 }, bounds: { x: 0, y: 0, w: 100, h: 50 }, displayId: 1, scale: 1 };
  } else {
    reply = DEFAULTS[subcmd] || { ok: true };
  }
  const go = () => emit(reply, ov.exitCode ?? 0);
  if (ov.sleepMs) setTimeout(go, ov.sleepMs); else go();
}

if (['-m', '-c', '--version', '-V'].includes(argv[0])) {
  note({ kind: 'py', args: argv.slice(0, 3) }); // 万一 stamp 不匹配走到 pip/venv:装作成功,绝不真装
  if (argv[0] === '--version' || argv[0] === '-V') process.stdout.write('Python 3.12.0\n', () => process.exit(0)); else process.exit(0);
} else {
  main();
}
