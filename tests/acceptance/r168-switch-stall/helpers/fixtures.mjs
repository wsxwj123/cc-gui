// r168-switch-stall 夹具：全部写成 Claude Code 会话文件格式，落在本套件 .artifacts/runtime-data 下（不读用户 profile）。
//   X / Y   工具输出很大：100 轮，每轮 1 用户 + 1 思考 + 2 次工具调用（结果各 ~125KB 日志行）+ 1 正文
//   P / Q   截图很多：70 轮，每轮 1 用户 + 3 次截图工具调用 + 1 正文；image 块里是真实 PNG（1024x640，~250KB，每张不同）
//           会话文件里 base64 同时出现在 message.content 与顶层 toolUseResult（真实转写就是这样），所以单个文件 ~140MB
//   L       300 轮短对话；S2/S4/S5/S10/S14 各用例专属的小会话（互不共用，回复会往里追加）；T14 分屏用
// 每个会话：第 1 轮用户消息与 summary 里放开头标记 BEG，最后一条回复正文里放结束标记 END（都只在本会话出现）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...p) { return path.join(suiteDir, ...p); }
export const dataRoot = () => suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const guiConfigDir = () => path.join(homeDir(), '.claude-gui');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const cacheDir = () => suitePath('.artifacts', 'cache');

/** 三个工作区（侧栏上显示的就是目录名；同一工作区的会话数控制在 7 条以内，免得被侧栏折叠）。 */
export const WS = { big: 'r168big', shots: 'r168shots', plain: 'r168plain' };
export const workspaceDir = (ws) => path.join(dataRoot(), WS[ws]);
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

const defs = {
  X: { ws: 'big', kind: 'tools', rounds: 100 },
  Y: { ws: 'big', kind: 'tools', rounds: 100 },
  P: { ws: 'shots', kind: 'shots', rounds: 70 },
  Q: { ws: 'shots', kind: 'shots', rounds: 70 },
  L: { ws: 'plain', kind: 'chat', rounds: 300 },
  S2: { ws: 'big', kind: 'small', rounds: 3 },
  S4: { ws: 'big', kind: 'small', rounds: 3 },
  S5: { ws: 'shots', kind: 'small', rounds: 3 },
  S10: { ws: 'big', kind: 'small', rounds: 3 },
  S14: { ws: 'big', kind: 'small', rounds: 3 },
  T14: { ws: 'big', kind: 'small', rounds: 3 },
};
export const KEYS = Object.keys(defs);
export const SESSIONS = Object.fromEntries(KEYS.map((k, i) => [k, {
  key: k,
  ...defs[k],
  sid: `a1681${String(i + 1).padStart(3, '0')}-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  beg: `R168v2BEG${k}Z`,
  end: `R168v2END${k}Z`,
  wsName: WS[defs[k].ws],
  projectHash: encodeProjectDir(workspaceDir(defs[k].ws)),
}]));

const GEN_VERSION = 'v2';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };
const T0 = Date.UTC(2026, 10, 7, 9, 0, 0);
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();

// ───────────── PNG（真实可解码；前 82 行是随机噪声 ≈ 252KB 不可压缩，其余是色块）─────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function makePng(seed, w = 1024, h = 640) {
  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(rowLen * h);
  let s = ((seed + 1) * 2654435761) >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  const NOISE_ROWS = 82;
  for (let y = 0; y < h; y += 1) {
    const base = y * rowLen;
    raw[base] = 0;
    if (y < NOISE_ROWS) {
      for (let x = 0; x + 4 <= w * 3; x += 4) raw.writeUInt32LE(rnd(), base + 1 + x);
    } else {
      for (let x = 0; x < w; x += 1) {
        const v = ((x >> 6) * 37 + (y >> 6) * 91 + seed * 13) & 0xff;
        raw[base + 1 + x * 3] = v; raw[base + 2 + x * 3] = (v * 3) & 0xff; raw[base + 3 + x * 3] = 255 - v;
      }
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// ───────────── 会话文件写入 ─────────────
function sessionWriter(fd, key) {
  const { sid, ws } = SESSIONS[key];
  const cwd = workspaceDir(ws);
  const common = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: 'r168' };
  let prev = null; let n = 0; let sec = 0;
  const put = (o) => { fs.writeSync(fd, `${JSON.stringify(o)}\n`); };
  const link = (uuid) => { const p = prev; prev = uuid; return p; };
  return {
    summary(text) { put({ type: 'summary', summary: text, leafUuid: `r168-leaf-${key}` }); },
    user(text) {
      n += 1; sec += 1; const uuid = `r168-u-${key}-${n}`;
      put({ ...common, parentUuid: link(uuid), promptId: 'r168-prompt', type: 'user', isMeta: false, message: { role: 'user', content: text }, uuid, timestamp: iso(sec), permissionMode: 'default', promptSource: 'sdk' });
    },
    assistant(block, stop) {
      n += 1; sec += 1; const uuid = `r168-a-${key}-${n}`; const id = `r168_${key}_${n}`;
      put({ ...common, parentUuid: link(uuid), message: { model: 'claude-sonnet-4-6', id, type: 'message', role: 'assistant', content: [block], stop_reason: stop, stop_sequence: null, stop_details: null, usage: USAGE }, apiBlockIndex: 0, requestId: `req_${id}`, type: 'assistant', uuid, timestamp: iso(sec), effort: 'high' });
      return uuid;
    },
    toolResult(toolId, content) {
      n += 1; sec += 1; const uuid = `r168-tr-${key}-${n}`;
      put({ ...common, parentUuid: link(uuid), promptId: 'r168-prompt', type: 'user', isMeta: false, toolUseResult: content, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content }] }, uuid, timestamp: iso(sec), toolUseID: toolId });
    },
  };
}

const logBlock = (key, r, k) => { // ~125KB 纯文本日志行，每轮每次内容不同
  const lines = []; let x = (r * 7919 + k * 104729 + key.charCodeAt(0)) >>> 0;
  for (let i = 0; i < 1250; i += 1) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; lines.push(`2026-11-07T09:${String(r % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z INFO worker-${i % 8} job=${key}-${r}-${k} step=${i} processed batch checksum=${x.toString(16)} ok`); }
  return lines.join('\n');
};
const filler = (r) => `这是第 ${r} 轮的对话内容，用来凑够几百字的篇幅。`.repeat(14);

function writeSession(key, file) {
  const d = SESSIONS[key];
  const fd = fs.openSync(file, 'w');
  try {
    const w = sessionWriter(fd, key);
    w.summary(`${d.beg} r168 夹具`);
    for (let r = 1; r <= d.rounds; r += 1) {
      const last = r === d.rounds;
      w.user(r === 1 ? `${d.beg} 第 1 轮：开头` : `第 ${r} 轮提问：${d.kind === 'chat' ? filler(r) : '请继续'}`);
      if (d.kind === 'tools') {
        w.assistant({ type: 'thinking', thinking: `R168 第 ${r} 轮先想一想。`, signature: 'r168-sig' }, 'tool_use');
        for (let k = 1; k <= 2; k += 1) {
          const id = `toolu_${key}_${r}_${k}`;
          w.assistant({ type: 'tool_use', id, name: 'Bash', input: { command: `tail -n 1250 /var/log/job-${r}-${k}.log`, description: `读日志 ${r}-${k}` } }, 'tool_use');
          w.toolResult(id, logBlock(key, r, k));
        }
      } else if (d.kind === 'shots') {
        for (let k = 1; k <= 3; k += 1) {
          const id = `toolu_${key}_${r}_${k}`;
          w.assistant({ type: 'tool_use', id, name: 'mcp__browser__screenshot', input: { note: `shot ${r}-${k}` } }, 'tool_use');
          const png = makePng(SESSIONS[key].sid.charCodeAt(7) * 100000 + r * 10 + k);
          w.toolResult(id, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }]);
        }
      }
      w.assistant({ type: 'text', text: last ? `第 ${r} 轮回复：全部完成。${d.end}` : `第 ${r} 轮回复：${d.kind === 'chat' ? filler(r) : '本轮完成。'}` }, 'end_turn');
    }
  } finally { fs.closeSync(fd); }
}

function projectFile(key) {
  const d = SESSIONS[key];
  return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir(d.ws)), `${d.sid}.jsonl`);
}

function writeOverlayState() {
  const version = JSON.parse(fs.readFileSync(suitePath('..', '..', '..', 'package.json'), 'utf8')).version;
  fs.mkdirSync(guiConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(guiConfigDir(), 'prefs.json'), `${JSON.stringify({ releaseNotesSeen: version })}\n`);
  fs.writeFileSync(path.join(guiConfigDir(), 'permission-guide-shown.flag'), `${new Date().toISOString()}\n`);
}

function writeFakeClaudeShim() {
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

/** 整套重建会话文件：大的（X/Y/P/Q）生成一次放 .artifacts/cache 复用，其余每次现写。 */
export function ensureFixtures() {
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  fs.mkdirSync(cacheDir(), { recursive: true });
  writeOverlayState();
  writeFakeClaudeShim();
  for (const key of KEYS) {
    const d = SESSIONS[key];
    fs.mkdirSync(workspaceDir(d.ws), { recursive: true });
    const target = projectFile(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (d.kind === 'tools' || d.kind === 'shots') {
      const cached = path.join(cacheDir(), `${GEN_VERSION}-${key}.jsonl`);
      if (!fs.existsSync(cached)) { const tmp = `${cached}.tmp`; writeSession(key, tmp); fs.renameSync(tmp, cached); }
      fs.copyFileSync(cached, target);
    } else {
      writeSession(key, target);
    }
  }
  return Object.fromEntries(KEYS.map((k) => [k, { sid: SESSIONS[k].sid, bytes: fs.statSync(projectFile(k)).size }]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
