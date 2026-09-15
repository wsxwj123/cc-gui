// r116 界面验收的夹具:隔离 HOME、夹具会话、PATH 上的假 claude。幂等(只写文件,不删目录)。
// 依据只有 .devflow/BRIEF-r116.md 与 .devflow/INTERFACE-r116.md;会话记录按 claude CLI 的 JSONL 形态手写。
//
//   node helpers/fixtures.mjs     # run.sh 会先跑这一步
//
// 工作目录(夹具项目的 cwd)放在本套件 .artifacts 里。实测:cwd 在 /private/tmp 下的项目
// 不进侧栏(GET /api/projects 不列),所以不能放 /tmp。projects 目录名按真 CLI 的规则编码
// (非字母数字一律换成 -),假 CLI 用同一个函数,两边落点一致。
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
// run.sh 每次给一个全新的数据根(R116_DATA_ROOT),上一轮的会话/缓存不会混进来
export const dataRoot = () => process.env.R116_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const WORKSPACE_RAW = path.join(suiteDir, '.artifacts', 'runtime-data', 'fixture-workspace');
export const PROJECT_LABEL = /fixture-workspace/;   // 侧栏里项目名的可见文字
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// ── 真能解码的 PNG(每张尺寸不同 = 放大层里"是不是同一张图"按天然尺寸认)──────────
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
function png(w, h, pixel) {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * row + 1 + x * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const gradient = (a, b) => (x, y) => [(x * a) & 255, (y * b) & 255, ((x + y) * 3) & 255];
let lcg = 116;
// Math.imul:普通乘法会超出 2^53 丢低位,序列很快退化成短循环(实测压到 1.3 万字符,不够"大截图")
const noise = () => { lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0; return lcg >>> 24; };

/** 每张图:尺寸 + base64(不带 data: 前缀)+ 一段取自中部的"编码指纹"(用来查页面上有没有出现编码文字)。 */
const img = (w, h, pixel) => {
  const data = png(w, h, pixel);
  return { w, h, data, probe: data.slice(Math.floor(data.length / 2), Math.floor(data.length / 2) + 48) };
};
export const IMG = {
  histAnth: img(160, 100, gradient(5, 7)),   // 读历史 · Anthropic 形态
  histMcp: img(120, 90, gradient(11, 3)),     // 读历史 · MCP 直传形态
  live: img(140, 80, gradient(2, 9)),         // 回复进行中(假 CLI 发出)
  userImg: img(100, 70, gradient(7, 13)),     // 用户消息里的图(聊天图片放大 = 应用共享的看大图视图,作对照)
  big: img(380, 280, () => [noise(), noise(), noise()]), // 大截图:噪点不可压缩,编码约 42 万字符
};

export const MARK = { hist: 'R116HISTSHOT', big: 'R116BIGSHOT', userImg: 'R116USERIMG' };
export const TEXT = {
  histAnth: 'R116 截图完成:主屏 1 张',
  histMcp: 'R116 第二张(MCP 直传)',
  bash: 'R116-BASH-OUTPUT 普通文字输出',
  textOnly1: 'R116 纯文字第一行',
  textOnly2: 'R116 纯文字第二行',
  histDone: 'R116HIST 收尾:截图都看完了。',
  big: 'R116 大图截好了',
  bigDone: 'R116BIG 收尾:大图看完了。',
  live: 'R116LIVE 截图完成',
  liveDone: 'R116LIVE 收尾:看完了。',
};
export const CU_TOOL = 'mcp__ccgui-computer-use__screenshot';
// 会话 id 必须是十六进制 UUID:侧栏只列合法 id 的会话(实测带 r 的 id 整个项目都不出现)
export const SESSION = { hist: 'a1160001-0000-4000-8000-0000000000a1', big: 'a1160002-0000-4000-8000-0000000000b2', userImg: 'a1160003-0000-4000-8000-0000000000c3' };

const text = (t) => ({ type: 'text', text: t });
const anthImg = (i) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: i.data } });
const mcpImg = (i) => ({ type: 'image', mimeType: 'image/png', data: i.data });

function sessionLines(sid, cwd, userContent, steps, doneText) {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '' };
  const ts = (n) => new Date(Date.UTC(2026, 8, 15, 8, 0, n)).toISOString();
  const label = typeof userContent === 'string' ? userContent : (userContent.find((b) => b.type === 'text')?.text || '');
  let n = 0;
  let parent = `${sid}-u0`;
  const lines = [
    { type: 'summary', summary: label.slice(0, 40), leafUuid: parent },
    { ...base, type: 'user', uuid: parent, parentUuid: null, timestamp: ts(n++), message: { role: 'user', content: userContent } },
  ];
  const assistant = (content, stop) => {
    const uuid = `${sid}-a${n}`;
    lines.push({ ...base, type: 'assistant', uuid, parentUuid: parent, timestamp: ts(n++), requestId: `req_${sid.slice(0, 8)}_${n}`,
      message: { id: `msg_${sid.slice(0, 8)}_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content,
        stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    parent = uuid;
  };
  for (const s of steps) {
    assistant([{ type: 'tool_use', id: s.id, name: s.name, input: s.input || {} }], 'tool_use');
    const uuid = `${sid}-r${n}`;
    lines.push({ ...base, type: 'user', uuid, parentUuid: parent, timestamp: ts(n++), toolUseResult: s.content,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: s.id, content: s.content }] } });
    parent = uuid;
  }
  assistant([text(doneText)], 'end_turn');
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function buildFixtures() {
  fs.mkdirSync(WORKSPACE_RAW, { recursive: true });
  const cwd = fs.realpathSync(WORKSPACE_RAW);   // 与服务端起假 CLI 时子进程拿到的 cwd 一致(防软链差异)
  const home = homeDir();
  const proj = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  for (const d of [proj, path.join(home, '.claude-gui'), fakeCtlDir(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });

  // 首启浮层预置成"已看过"(与被测行为无关,只为不吃第一次点击);网络钉回环(公开版首启会自愈成 0.0.0.0)
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));

  fs.writeFileSync(path.join(proj, `${SESSION.hist}.jsonl`), sessionLines(SESSION.hist, cwd, `${MARK.hist} 帮我截一张屏看看`, [
    { id: 'toolu_r116_hist_anth', name: CU_TOOL, content: [text(TEXT.histAnth), anthImg(IMG.histAnth)] },
    { id: 'toolu_r116_hist_mcp', name: CU_TOOL, content: [mcpImg(IMG.histMcp), text(TEXT.histMcp)] },
    { id: 'toolu_r116_hist_bash', name: 'Bash', input: { command: 'echo R116' }, content: TEXT.bash },
    { id: 'toolu_r116_hist_text', name: 'mcp__docs__lookup', input: { q: 'r116' }, content: [text(TEXT.textOnly1), text(TEXT.textOnly2)] },
  ], TEXT.histDone));
  fs.writeFileSync(path.join(proj, `${SESSION.big}.jsonl`), sessionLines(SESSION.big, cwd, `${MARK.big} 截一张大图`, [
    { id: 'toolu_r116_big', name: CU_TOOL, content: [text(TEXT.big), anthImg(IMG.big)] },
  ], TEXT.bigDone));
  fs.writeFileSync(path.join(proj, `${SESSION.userImg}.jsonl`), sessionLines(SESSION.userImg, cwd,
    [text(`${MARK.userImg} 看这张图`), anthImg(IMG.userImg)], [], 'R116USERIMG 收到这张图了。'));

  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r116] 夹具就绪:HOME=${r.home} 项目=${r.cwd} 大截图编码 ${IMG.big.data.length} 字符`);
}
