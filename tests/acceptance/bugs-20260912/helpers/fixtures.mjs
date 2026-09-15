// 夹具准备：全部落在本套件的 .artifacts/runtime-data 下，只动这里。
//
// 本套件需要的四份夹具：
//   ① 一个普通会话（T1 排队条 / T2 面板坞要先有会话在面前）；
//   ② 一个 ~16MB 的大会话（T4：历史操作会为它写一份同体积的 .histbak-* 备份，
//      点「查看备份」把整份原文塞进 DOM —— 复现用户报的卡死）；
//   ③ 一个生图 provider 配置 + 一条 status=done 的出图历史 + 一张真实 PNG（T3 预览）；
//   ④ fixture-workspace 目录（会话记录的 cwd，须真实存在）。
//
// 会话 jsonl 记录形态照抄真实转写（type/message/uuid/timestamp/cwd/sessionId）。
// 幂等：跑第二遍不重写已有的 16MB 文件（体积大，重生成慢）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suitePath } from './runtime.mjs';

export const SESSION_SMALL = 'b0000001-0000-4000-8000-0000000000a1';
export const SESSION_BIG = 'b0000002-0000-4000-8000-0000000000b2';
export const MARKER_SMALL = 'BUGS20260912QUEUE';
export const MARKER_BIG = 'BUGS20260912BIG';
export const PROJECT_HASH = '-bugs20260912-fixture';
export const IMAGE_JOB_ID = 'bugs20260912-job-1';
export const IMAGE_PROVIDER_ID = 'bugs20260912-img';

/** T4 备份体积目标：与用户实报的那份 16.9MB 会话同量级。 */
const BIG_SESSION_BYTES = 16 * 1024 * 1024;

// 一张真实可解码的 1x1 PNG（<img> 的 naturalWidth 会 > 0，不是空占位）。
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function projectsRoot() { return path.join(homeDir(), '.claude', 'projects'); }
export function projectDir() { return path.join(projectsRoot(), PROJECT_HASH); }
export function workspaceDir() { return path.join(dataRoot(), 'fixture-workspace'); }
export function imagesDir() { return path.join(dataRoot(), 'fixture-images'); }
export function imageFile() { return path.join(imagesDir(), 'bugs20260912-shot.png'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
export function manifestPath() { return suitePath('fixture-manifest.local.json'); }

const ISO = (min) => new Date(Date.UTC(2026, 8, 12, 10, min, 0)).toISOString();
const uuid = (n) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function userRecord({ sid, n, text, minute }) {
  return {
    parentUuid: null, isSidechain: false, type: 'user',
    message: { role: 'user', content: text },
    uuid: uuid(n), timestamp: ISO(minute), userType: 'external', entrypoint: 'cli',
    cwd: workspaceDir(), sessionId: sid, version: '2.1.267', gitBranch: 'HEAD',
  };
}

function assistantRecord({ sid, n, blocks, minute }) {
  return {
    parentUuid: null, isSidechain: false,
    message: {
      model: 'claude-sonnet-5', id: `msg_bugs_${n}`, type: 'message', role: 'assistant',
      content: blocks, stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 34 },
    },
    requestId: `req_bugs_${n}`, type: 'assistant', uuid: uuid(10000 + n), timestamp: ISO(minute + 1),
    userType: 'external', entrypoint: 'cli', cwd: workspaceDir(), sessionId: sid,
  };
}

function writeJsonl(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** 大会话的"出厂"副本：历史操作会就地改写会话文件（并把空块清掉），
 *  要用例之间互不影响，每次开跑前从这份副本原样铺回去。 */
export function pristineBigFile() { return path.join(dataRoot(), 'big-session.pristine.jsonl'); }

/**
 * 把大会话恢复成出厂状态：清掉上一轮留下的 .histbak-* 备份，铺回副本。
 * 只动本套件 .artifacts/runtime-data 下的文件。
 */
export function primeBigSession() {
  const target = path.join(projectDir(), `${SESSION_BIG}.jsonl`);
  const dir = projectDir();
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (name.startsWith(`${SESSION_BIG}.jsonl.histbak-`) || name.startsWith(`${SESSION_BIG}.jsonl.bak`)) {
      fs.unlinkSync(path.join(dir, name)); // 本套件自己的夹具产物，不是用户数据
    }
  }
  if (!fs.existsSync(pristineBigFile())) buildBigSession({ force: true }); // 出厂副本必须含空块（体检要判 found）
  fs.copyFileSync(pristineBigFile(), target);
  return { file: target, bytes: fs.statSync(target).size };
}

/** ① 普通会话：侧栏搜 MARKER_SMALL 就能打开。 */
function buildSmallSession() {
  const sid = SESSION_SMALL;
  const lines = [
    userRecord({ sid, n: 1, text: `${MARKER_SMALL} 先把这条会话打开，用来观察输入区与顶栏。`, minute: 0 }),
    assistantRecord({ sid, n: 1, blocks: [{ type: 'text', text: '已收到，这是夹具会话的第一轮回复。' }], minute: 1 }),
    userRecord({ sid, n: 2, text: '再补一轮，让会话里有两条来往。', minute: 2 }),
    assistantRecord({ sid, n: 2, blocks: [{ type: 'text', text: '好的，第二条回复。' }], minute: 3 }),
  ];
  writeJsonl(path.join(projectDir(), `${sid}.jsonl`), lines);
}

/**
 * ② 大会话（T4）：总量 ~16MB，但记录条数刻意不多（每条塞大段正文）——
 * 文件体积 = 备份体积（要复现卡死），又不会让消息列表自身变成瓶颈把原因搞混。
 * 其中一条 assistant 记录带空 text 块，让「官方兼容体检」判定为"有东西可清理"，
 * 从而给出「清理（自动备份原文件）」按钮 —— 这是用户点得到「查看备份」的真实入口。
 */
function buildBigSession({ force = false } = {}) {
  const file = path.join(projectDir(), `${SESSION_BIG}.jsonl`);
  if (!force && fs.existsSync(file) && fs.statSync(file).size > BIG_SESSION_BYTES * 0.9) return; // 已有，跳过重生成
  const sid = SESSION_BIG;
  // 刻意用 ASCII 填充：真实转写基本是英文/代码，一个字节一个字符 —— 「文件 16MB」与
  // 「倒进 DOM 的字符数 16M」才对得上（中文 3 字节/字符会让排版代价只有真实情况的三分之一）。
  const FILLER_BYTES = 80 * 1024;
  const filler = 'Fixture transcript filler line used to reproduce a large session backup. '
    .repeat(Math.ceil(FILLER_BYTES / 69)).slice(0, FILLER_BYTES);
  const lines = [
    userRecord({ sid, n: 1, text: `${MARKER_BIG} 这是一条用于历史操作备份体积复现的大会话。`, minute: 10 }),
    // 空 text 块（历史里真实出现过：第三方残缺回合）→ 体检判 found → 出现清理按钮。
    assistantRecord({ sid, n: 1, blocks: [{ type: 'text', text: '' }, { type: 'text', text: filler }], minute: 11 }),
  ];
  const bytes = (l) => Buffer.byteLength(JSON.stringify(l), 'utf8') + 1;
  let total = lines.reduce((n, l) => n + bytes(l), 0);
  let i = 2;
  while (total < BIG_SESSION_BYTES) {
    const u = userRecord({ sid, n: i, text: `${filler} 第 ${i} 轮。`, minute: 10 + i });
    const a = assistantRecord({ sid, n: i, blocks: [{ type: 'text', text: `${filler} 第 ${i} 轮回复。` }], minute: 10 + i });
    lines.push(u, a);
    total += bytes(u) + bytes(a);
    i += 1;
  }
  writeJsonl(file, lines);
}

/** ③ 生图夹具：provider 配置 + 一条已完成历史 + 真实 PNG。 */
function buildImageFixtures() {
  fs.mkdirSync(imagesDir(), { recursive: true });
  if (!fs.existsSync(imageFile())) fs.writeFileSync(imageFile(), Buffer.from(PNG_BASE64, 'base64'));
  const dir = guiConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const provider = {
    id: IMAGE_PROVIDER_ID,
    name: 'BUGS 夹具生图',
    protocol: 'openai',
    baseURL: 'https://fixture.invalid/v1',
    apiKey: 'fixture-key-not-a-real-secret',
    model: 'fixture-image-model',
    size: '1024x1024',
    savePath: imagesDir(),
  };
  fs.writeFileSync(path.join(dir, 'image-providers.json'), `${JSON.stringify([provider], null, 2)}\n`);
  const file = imageFile();
  const history = [
    {
      id: IMAGE_JOB_ID,
      prompt: '夹具：一张已经生成完成的图（用于验证清空后切面板再切回）',
      providerId: IMAGE_PROVIDER_ID,
      status: 'done',
      file,
      previewUrl: `/api/image/preview?file=${encodeURIComponent(file)}`,
      bytes: fs.statSync(file).size,
      createdAt: ISO(20),
      finishedAt: ISO(21),
    },
  ];
  fs.writeFileSync(path.join(dir, 'image-history.json'), `${JSON.stringify(history, null, 2)}\n`);
}

export function ensureFixtures({ force = false } = {}) {
  fs.mkdirSync(workspaceDir(), { recursive: true });
  fs.mkdirSync(path.join(homeDir(), '.claude'), { recursive: true });
  const file = manifestPath();
  if (!force && fs.existsSync(file)) {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (fs.existsSync(path.join(projectDir(), `${m.sessions.small}.jsonl`))
      && fs.existsSync(pristineBigFile())
      && fs.existsSync(imageFile())) {
      primeBigSession(); // 大会话恢复出厂（上一轮的历史操作改写/备份都不留痕）
      return m;
    }
  }
  buildSmallSession();
  buildBigSession();
  buildImageFixtures();
  // 出厂副本（含空块）+ 每轮开跑前把大会话铺回出厂状态：历史操作会就地改写它。
  if (!fs.existsSync(pristineBigFile())) {
    buildBigSession({ force: true });
    fs.copyFileSync(path.join(projectDir(), `${SESSION_BIG}.jsonl`), pristineBigFile());
  }
  fs.copyFileSync(pristineBigFile(), path.join(projectDir(), `${SESSION_BIG}.jsonl`));
  const manifest = {
    dataRoot: dataRoot(),
    projectHash: PROJECT_HASH,
    workspace: workspaceDir(),
    sessions: { small: SESSION_SMALL, big: SESSION_BIG },
    markers: { small: MARKER_SMALL, big: MARKER_BIG },
    image: { providerId: IMAGE_PROVIDER_ID, jobId: IMAGE_JOB_ID, file: imageFile() },
    bigSessionBytes: fs.statSync(path.join(projectDir(), `${SESSION_BIG}.jsonl`)).size,
  };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const m = ensureFixtures({ force: process.argv.includes('--force') });
  process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
}
