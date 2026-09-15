// 条带折叠 + 渐进挂载（2026-09-13）验收套件的会话夹具。
//
// 全部落在本套件自己的 .artifacts/runtime-data 下，不读用户 profile、不写别处。
//
// 记录形态**逐字照抄真实转写**（只抄形状，内容是自造的；形状来自本机 ~/.claude 里一份
// 真实会话的抽样，见 README「夹具怎么来的」）：
//   assistant 记录：parentUuid,isSidechain,message{model,id,type,role,content,stop_reason,stop_sequence,usage},
//                   apiBlockIndex,requestId,type,uuid,timestamp,userType,entrypoint,cwd,sessionId,version,gitBranch
//   思考块 {type:'thinking', thinking, signature} / 工具块 {type:'tool_use', id, name, input} /
//   正文块 {type:'text', text}
//   工具结果 = type:'user' + message.content:[{type:'tool_result', tool_use_id, content}]
//   每次 API 调用一个**不同的 message.id**（`usageCalls` 按它去重，见 INTERFACE §K.1）
//
// 四份夹具：
//   A（SFA）主夹具：3 轮，每轮 3 思考 + 4 工具 + 1 中间正文 + 1 最终正文 —— INTERFACE §I.0 的配方。
//   B（SFB）长会话：320 轮（挂载窗口按"行"裁剪，行数要够多）。
//   C（SFC）R114 防线 + 边界文案：Workflow 卡 / Task 卡 / 40 码点截断 / 空思考 / 纯正文轮 / 无 blocks 轮。
//   D（SFD）**破坏性用例专用**（回滚/导出会就地改写会话文件），不与 A/B/C 共享。
//
// 另写两份首启浮层的"已看过"状态：那三层整屏遮罩会吃掉第一次点击，与被测行为无关
// （r64 套件同样预置；键名是公开的既有约定，不是本功能的内部状态）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function suitePath(...parts) { return path.join(suiteDir, ...parts); }
export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
export function workspaceDir() { return path.join(dataRoot(), 'fixture-workspace'); }
export function fakebinDir() { return suitePath('.artifacts', 'fakebin'); }
export function fakeCtlDir() { return path.join(homeDir(), 'fake-claude'); }
export function manifestPath() { return suitePath('fixture-manifest.local.json'); }

export const SESSION_A = '5f000001-0000-4000-8000-0000000000a1';
export const SESSION_B = '5f000002-0000-4000-8000-0000000000b2';
export const SESSION_C = '5f000003-0000-4000-8000-0000000000c3';
export const SESSION_D = '5f000004-0000-4000-8000-0000000000d4';
export const MARKER_A = 'SF20260913STRIPA';
export const MARKER_B = 'SF20260913STRIPB';
export const MARKER_C = 'SF20260913STRIPC';
export const MARKER_D = 'SF20260913STRIPD';
export const PROJECT_NAME = 'fixture-workspace';

// ── 夹具 A 的文案（用例直接断言这些字符串，改这里就要改用例）────────────────
export const A = {
  rounds: 3,
  marker: MARKER_A,
  userText: (n) => `第 ${n} 轮：帮我把这个脚本的路径处理改一下，然后跑测试。`,
  think1: '先摸清工作区结构和内容…',
  think2: '目录看清楚了，入口是 scripts/release.local.sh',
  think3: '改完了，跑一遍测试确认没有回归。',
  midText: '我先看一下这个文件的实现，确认改动面之后再动手。',
  finalText: '这一轮的改动已经落地：脚本的路径处理改成从自身位置反推仓库根目录，不再依赖调用者当前的工作目录。'
    + '我用两个不同的入口各跑了一遍，输出一致；顺带把帮助文案里的旧路径也改掉了。'
    + '如果你希望保留旧行为，只要把 ROOT 那一行换回去就行。'
    + '接下来我会盯着 CI 的结果，有回归会继续跟进，也会把这次的判断写进说明里，免得下一个人再踩同一个坑。'
    + '另外提一句：这次的改动只碰了路径解析，测试与发布脚本的行为一个字没动。',
  toolNames: ['Bash', 'Read', 'Edit', 'Grep'],
  /** 每轮的 assistant 记录条数 = 每次 API 调用一条 = usageCalls.length（见 INTERFACE §I.0）。 */
  callsPerRound: 9,
  /** 被折块数 M：group 段里的过程块（3 思考 + 4 工具）。 */
  steps: 7,
  segments: ['group', 'text', 'group', 'text'],
  /** 摘要行逐字（INTERFACE §I.0 末尾那句）。 */
  headText: '思考与工具调用 · 9 轮 7 步 · 改完了，跑一遍测试确认没有回归。',
  /** 只折 group 段 → 收起态下带 hidden 的段数。 */
  foldableCount: 2,
};

// ── 夹具 C 的边界文案 ──────────────────────────────────────────────────────
export const C = {
  marker: MARKER_C,
  workflowLabel: '先看看工作流跑到哪一步了。',
  taskLabel: '让子代理去改这一处。',
  emoji41: '🙂'.repeat(41),
  emojiTail: '🙂'.repeat(40) + '…',
  messyTail: '修好了。\n\n  下一步跑测试',
  messyTailClean: '修好了。 下一步跑测试',
  // 〈2026-09-13 口径变更〉摘要尾句只剥**配对**的行内记号；零散的 / 未闭合的一律不动（INTERFACE §C.2）。
  /** 配对记号四种全在（`**粗**` / `` `码` `` / `~~删~~` / `*强*`）：全部要剥。 */
  mdTail: '**加粗** 与 `代码` 和 ~~删~~ 与 *强* 的记号都该剥掉。',
  mdTailClean: '加粗 与 代码 和 删 与 强 的记号都该剥掉。',
  /** 零散记号（下划线入标识符、乘号算式）：一个都不许动。 */
  scatteredTail: '零散记号 foo_bar_baz 2*3*4 x**2 + y**2 原样。',
  /** 零散记号之二：`_*_` 夹在标识符里，别当强调对。 */
  identTail: '列表里 ANTHROPIC_DEFAULT_*_MODEL 一个不动。',
  /** 未闭合的记号（按 CommonMark 就是字面量）：原样保留。 */
  unclosedTail: '未闭合的 **记号原样保留。',
  /** 最后一块是**工具**（不是正文）时，尾段仍取那条思考。 */
  toolLastThink: '最后一块是工具，也要取这条思考。',
  toolLastDoneText: '这一轮的正文在工具前面。',
  textOnlyText: '只有正文的一轮，没有任何过程块。',
  onlyTextTail: '先看文件再动手。',
  emptyThinkTurnText: '这一轮的思考块是空的（第三方 provider 落过这种记录）。',
  /** 空思考那一轮的收官正文。**这句在「轮行」里可见** —— 用户气泡的文字不在 turn 行内，
   *  所以定位那一轮必须用助手正文，不能用上面的用户话术（见 SF-109 的注释）。 */
  emptyThinkDoneText: '空思考那一轮收尾了：这一轮只调了一次工具。',
  /** 老形态记录（content 是纯字符串）那一轮的用户话术。 */
  legacyUserText: '再看一眼旧格式的那条记录。',
  /** 老形态记录的字符串正文（既是被测文字，也是 SF-110 定位那一轮的锚点）。 */
  legacyText: '这一条是老形态记录：正文直接是字符串，没有块数组。',
};

const ISO = (min) => new Date(Date.UTC(2026, 8, 13, 9, min, 0)).toISOString();
const rid = (p, n) => `${p}${String(n).padStart(6, '0')}`;

function encodeProjectDir(cwd) { return cwd.replace(/[/\\]/g, '-'); }
export function projectDir() { return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir())); }
function sessionFile(sid) { return path.join(projectDir(), `${sid}.jsonl`); }

function base({ sid, cwd, parentUuid }) {
  return {
    parentUuid: parentUuid ?? null, isSidechain: false, userType: 'external', entrypoint: 'cli',
    cwd, sessionId: sid, version: '2.1.267', gitBranch: 'codex/fix-batch-first-20260910',
  };
}

let userSeq = 0;
function userRecord({ sid, cwd, text, at, parentUuid }) {
  userSeq += 1;
  return {
    ...base({ sid, cwd, parentUuid }), promptId: `sf-prompt-${userSeq}`, type: 'user', isMeta: false,
    message: { role: 'user', content: text },
    uuid: `sf-u-${rid('', userSeq)}`,
    timestamp: at, permissionMode: 'default', promptSource: 'sdk',
  };
}

function assistantRecord({ sid, cwd, blocks, at, id, parentUuid }) {
  return {
    ...base({ sid, cwd, parentUuid }),
    message: {
      model: 'claude-sonnet-4-6', id, type: 'message', role: 'assistant', content: blocks,
      stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      stop_sequence: null, stop_details: null,
      usage: { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 },
    },
    apiBlockIndex: 0, requestId: `req_${id}`, type: 'assistant',
    uuid: `sf-a-${id}`, timestamp: at, effort: 'high',
  };
}

function toolResultRecord({ sid, cwd, toolUseId, content, at, parentUuid }) {
  return {
    ...base({ sid, cwd, parentUuid }), promptId: 'sf-prompt', type: 'user', isMeta: false, toolUseResult: content,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    uuid: `sf-tr-${toolUseId}`, timestamp: at, toolUseID: toolUseId,
  };
}

const think = (text) => ({ type: 'thinking', thinking: text, signature: 'sf-fixture-signature' });
const text_ = (text) => ({ type: 'text', text });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });

function writeJsonl(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 真实转写是一条 uuid 链（每条记录的 parentUuid = 上一条的 uuid）——回滚/裁剪那类
  // 历史操作要看这条链，链条断了它们会静默不生效。摘要行没有 uuid，跳过。
  let prev = null;
  const out = lines.map((l) => {
    const line = { ...l };
    if (prev !== null && 'parentUuid' in line) line.parentUuid = prev;
    if (line.uuid) prev = line.uuid;
    return line;
  });
  fs.writeFileSync(file, `${out.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** 主夹具 A：一轮 = 3 思考 + 4 工具 + 1 中间正文 + 1 最终正文（INTERFACE §I.0 配方）。 */
function buildSessionA() {
  const sid = SESSION_A;
  const cwd = workspaceDir();
  const lines = [{ type: 'summary', summary: `${MARKER_A} 条带折叠主夹具`, leafUuid: 'sf-leaf-a' }];
  for (let n = 1; n <= A.rounds; n += 1) {
    const m = (k) => ISO(n * 20 + k);
    lines.push(userRecord({
      sid, cwd, at: m(0), parentUuid: null,
      text: n === 1 ? `${MARKER_A} ${A.userText(n)}` : A.userText(n),
    }));
    const steps = [
      ['thinking', think(`${A.think1}（第 ${n} 轮）`)],
      ['tool', tool(`sfA-${n}-1`, 'Bash', { command: 'ls -la', description: '列出工作区' })],
      ['thinking', think(`${A.think2}（第 ${n} 轮）`)],
      ['tool', tool(`sfA-${n}-2`, 'Read', { file_path: '/tmp/sf-fixture/scripts/release.local.sh' })],
      ['text', text_(A.midText)],
      ['tool', tool(`sfA-${n}-3`, 'Edit', {
        file_path: '/tmp/sf-fixture/scripts/release.local.sh', old_string: 'ROOT=..', new_string: 'ROOT=$PWD',
      })],
      ['thinking', think(A.think3)],
      ['tool', tool(`sfA-${n}-4`, 'Grep', { pattern: 'ROOT=', path: '/tmp/sf-fixture' })],
      ['text', text_(`${A.finalText}（第 ${n} 轮）`)],
    ];
    let k = 0;
    for (const [kind, block] of steps) {
      k += 1;
      const id = `sfA_r${n}_c${k}`;
      lines.push(assistantRecord({ sid, cwd, blocks: [block], at: m(k), id, parentUuid: null }));
      if (kind === 'tool') {
        lines.push(toolResultRecord({ sid, cwd, toolUseId: block.id, at: m(k) , content: '（夹具）命令输出', parentUuid: null }));
      }
    }
  }
  writeJsonl(sessionFile(sid), lines);
}

/**
 * 长会话 B：320 轮。每 3 轮里有一轮带工具调用（节点密度要高，性能判据才有意义）。
 * 挂载窗口是按**行**裁的，所以行数（轮数 × 2）必须远大于 K（默认 30）。
 */
function buildSessionB() {
  const sid = SESSION_B;
  const cwd = workspaceDir();
  const lines = [{ type: 'summary', summary: `${MARKER_B} 长会话夹具（挂载窗口用）`, leafUuid: 'sf-leaf-b' }];
  const ROUNDS = 320;
  for (let n = 1; n <= ROUNDS; n += 1) {
    const minute = n % 60;
    const at = (k) => new Date(Date.UTC(2026, 8, 13, 10, minute, k)).toISOString();
    lines.push(userRecord({
      sid, cwd, at: at(0), parentUuid: null,
      text: n === 1 ? `${MARKER_B} 第 ${n} 轮：把这一段改一下。` : `第 ${n} 轮：把这一段改一下。`,
    }));
    if (n % 3 === 0) {
      const id1 = `sfB_r${n}_c1`;
      const id2 = `sfB_r${n}_c2`;
      lines.push(assistantRecord({ sid, cwd, at: at(1), id: id1, blocks: [think(`第 ${n} 轮先看一眼现场。`)] }));
      lines.push(assistantRecord({
        sid, cwd, at: at(2), id: id2,
        blocks: [tool(`sfB-${n}-1`, 'Bash', { command: `sed -n '1,40p' file-${n}.txt`, description: '看文件' })],
      }));
      lines.push(toolResultRecord({ sid, cwd, at: at(3), parentUuid: null, toolUseId: `sfB-${n}-1`, content: `（夹具）第 ${n} 轮输出` }));
      lines.push(assistantRecord({ sid, cwd, at: at(4), id: `sfB_r${n}_c3`, blocks: [text_(`第 ${n} 轮改好了，行为不变。`)] }));
    } else {
      lines.push(assistantRecord({
        sid, cwd, at: at(1), id: `sfB_r${n}_c1`,
        blocks: [text_(`第 ${n} 轮：这一段已经改好，没有别的改动。`)],
      }));
    }
  }
  writeJsonl(sessionFile(sid), lines);
  return ROUNDS;
}

/** 夹具 C：R114 防线（Workflow/Task 卡）+ 摘要文案的边界形态。 */
function buildSessionC() {
  const sid = SESSION_C;
  const cwd = workspaceDir();
  const lines = [{ type: 'summary', summary: `${MARKER_C} 边界与 R114 防线`, leafUuid: 'sf-leaf-c' }];
  let t = 0;
  const at = () => ISO((t += 1));
  const round = (userText, records) => {
    lines.push(userRecord({ sid, cwd, at: at(), parentUuid: null, text: userText }));
    for (const [id, blocks] of records) {
      lines.push(assistantRecord({ sid, cwd, at: at(), id, blocks }));
      // 每个 tool_use 都要有配对的 tool_result（缺了会被当成"已停止/未应用"的工具卡）。
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          lines.push(toolResultRecord({ sid, cwd, at: at(), parentUuid: null, toolUseId: b.id, content: `（夹具）${b.name} 输出` }));
        }
      }
    }
  };

  // ① 含 Workflow 卡的一轮（R114 的意图：工作流跑到哪一步必须看得见）
  round(`${MARKER_C} 跑一遍工作流看看阶段。`, [
    ['sfC_w1', [think(C.workflowLabel)]],
    ['sfC_w2', [tool('sfC-workflow-1', 'Workflow', { workflow: 'sf-fixture', args: 'stage=all' })]],
    ['sfC_w3', [text_('工作流跑完了，阶段如上。')]],
  ]);
  // ② 含 Task 卡的一轮
  round('让子代理去改这一处。', [
    ['sfC_t1', [tool('sfC-task-1', 'Task', { subagent_type: 'fixer', description: 'SF 夹具子代理', prompt: '改一处' })]],
    ['sfC_t2', [think(C.taskLabel)]],
    ['sfC_t3', [text_('子代理改完了。')]],
  ]);
  // ③ 41 个 emoji 的尾段（最后一块是正文 → 取最后一条思考）
  round('看个图。', [
    ['sfC_e1', [think(C.emoji41)]],
    ['sfC_e2', [text_('图看完了。')]],
  ]);
  // ④ 尾段含换行/缩进（空白折叠）
  round('修一下这个。', [
    ['sfC_m1', [think(C.messyTail)]],
    ['sfC_m2', [text_('好了，见上。')]],
  ]);
  // ④b 配对记号被剥（`**粗**` / `` `码` `` / `~~删~~` / `*强*`）
  round('再改一处。', [
    ['sfC_m3', [think(C.mdTail)]],
    ['sfC_m4', [text_('改完了，见上。')]],
  ]);
  // ④c 零散记号不许误伤（下划线入标识符 / 乘号算式）
  round('算式与下划线。', [
    ['sfC_m5', [think(C.scatteredTail)]],
    ['sfC_m6', [text_('算式那一轮看完了。')]],
  ]);
  round('环境变量名。', [
    ['sfC_m7', [think(C.identTail)]],
    ['sfC_m8', [text_('环境变量那一轮看完了。')]],
  ]);
  // ④d 未闭合的记号原样保留
  round('半个记号。', [
    ['sfC_m9', [think(C.unclosedTail)]],
    ['sfC_m10', [text_('未闭合那一轮看完了。')]],
  ]);
  // ⑤ 恒取最后一条思考：最后一块是**工具**（既不是正文也不是思考）→ 尾段仍取那条思考
  round('最后一块是工具。', [
    ['sfC_q1', [think(C.toolLastThink)]],
    ['sfC_q2', [text_(C.toolLastDoneText)]],
    ['sfC_q3', [tool('sfC-read-3', 'Read', { file_path: '/tmp/sf-fixture/b.txt' })]],
  ]);
  // ⑤b 取不到思考 → 省略尾段（**不回落取正文**；旧口径的"取最后一条正文"已废除）
  round('先看文件再动手。', [
    ['sfC_p1', [text_(C.onlyTextTail)]],
    ['sfC_p2', [tool('sfC-read-2', 'Read', { file_path: '/tmp/sf-fixture/a.txt' })]],
  ]);
  // ⑥ 纯正文轮：无可折块（M=0）
  round('只写一段话。', [['sfC_x1', [text_(C.textOnlyText)]]]);
  // ⑦ 空思考块 + 一个真工具 + 自己的收官正文：空块必须被跳过、不计入步数（那一轮 steps=1）。
  // 为什么这轮要一句**助手正文**：轮行（`[data-turn-role="turn"]`）里只有助手产出，
  // 用户气泡的文字在**另一行**，用用户话术定位这一轮永远找不到（SF-109 的锚点就栽在这里）。
  round(C.emptyThinkTurnText, [
    ['sfC_z1', [think('')]],
    ['sfC_z2', [tool('sfC-bash-9', 'Bash', { command: 'echo hi', description: '打个招呼' })]],
    ['sfC_z3', [text_(C.emptyThinkDoneText)]],
  ]);
  // ⑧ 老形态记录：content 是**纯字符串**（老 CLI 形态）。
  //    ⚠️ 它必须有自己的用户话术：没有 user 记录分隔时，读取器会把它并进**上一轮**
  //    （实测：并进去之后那一轮的 blocks = [tool:Bash, text:'这一条是老形态记录…']），
  //    于是"这条记录渲染成什么样"就测不清了。
  //    ⚠️ 它在读取器里会被**规范化成一条正文块**（server/services/session-reader.js 的
  //    normalizeContent），**不是** `turn.blocks` 为空的 legacy 轮 —— 见 SF-110 的注释。
  lines.push(userRecord({ sid, cwd, at: at(), parentUuid: null, text: C.legacyUserText }));
  lines.push({
    ...base({ sid, cwd, parentUuid: null }),
    message: {
      model: 'claude-sonnet-4-6', id: 'sfC_legacy_1', type: 'message', role: 'assistant',
      content: C.legacyText,
      stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    apiBlockIndex: 0, requestId: 'req_sfC_legacy_1', type: 'assistant', uuid: 'sf-a-sfC-legacy',
    timestamp: at(), effort: 'high',
  });
  writeJsonl(sessionFile(sid), lines);
}

/** 夹具 D：破坏性用例（回滚 / 导出）专用，形态最简，避免误伤别的用例的断言。 */
function buildSessionD() {
  const sid = SESSION_D;
  const cwd = workspaceDir();
  const lines = [{ type: 'summary', summary: `${MARKER_D} 破坏性用例专用`, leafUuid: 'sf-leaf-d' }];
  for (let n = 1; n <= 3; n += 1) {
    const at = (k) => ISO(n + 40 + k / 10);
    lines.push(userRecord({
      sid, cwd, at: at(0), parentUuid: null,
      text: n === 1 ? `${MARKER_D} 第 ${n} 轮：跑一遍。` : `第 ${n} 轮：跑一遍。`,
    }));
    lines.push(assistantRecord({ sid, cwd, at: at(1), id: `sfD_r${n}_c1`, blocks: [think(`第 ${n} 轮先看一眼。`)] }));
    lines.push(assistantRecord({
      sid, cwd, at: at(2), id: `sfD_r${n}_c2`,
      blocks: [tool(`sfD-${n}-1`, 'Bash', { command: `echo round-${n}`, description: '打印' })],
    }));
    lines.push(toolResultRecord({ sid, cwd, at: at(3), parentUuid: null, toolUseId: `sfD-${n}-1`, content: `（夹具）round-${n}` }));
    lines.push(assistantRecord({
      sid, cwd, at: at(4), id: `sfD_r${n}_c3`,
      blocks: [text_(`第 ${n} 轮的正文：${MARKER_D} 记录 ${n}。`)],
    }));
  }
  writeJsonl(sessionFile(sid), lines);
}

/** 首启三层浮层的「已看过」（与 r64 套件同一套做法，与被测行为无关）。 */
function writeOverlayState() {
  const version = JSON.parse(fs.readFileSync(suitePath('..', '..', '..', 'package.json'), 'utf8')).version;
  fs.mkdirSync(guiConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(guiConfigDir(), 'prefs.json'), `${JSON.stringify({ releaseNotesSeen: version })}\n`);
  fs.writeFileSync(path.join(guiConfigDir(), 'permission-guide-shown.flag'), `${new Date().toISOString()}\n`);
}

/** PATH 上的假 claude：一个 shell 薄壳，转交给 fake-claude.mjs（真回合的现场由它造）。 */
function writeFakeClaudeShim() {
  const bin = fakebinDir();
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

export function ensureFixtures({ force = false } = {}) {
  fs.mkdirSync(workspaceDir(), { recursive: true });
  fs.mkdirSync(projectDir(), { recursive: true });
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  const manifest = {
    dataRoot: dataRoot(),
    home: homeDir(),
    workspace: workspaceDir(),
    fakebin: fakebinDir(),
    fakeCtl: fakeCtlDir(),
    sessions: { a: SESSION_A, b: SESSION_B, c: SESSION_C, d: SESSION_D },
    markers: { a: MARKER_A, b: MARKER_B, c: MARKER_C, d: MARKER_D },
  };
  writeOverlayState();
  writeFakeClaudeShim();
  const stamp = manifestPath();
  let prev = null;
  if (fs.existsSync(stamp)) {
    try { prev = JSON.parse(fs.readFileSync(stamp, 'utf8')); } catch { prev = null; }
  }
  if (!force && prev && prev.version === 3 && fs.existsSync(sessionFile(SESSION_B))) {
    // 长会话（B）没被任何用例改写，不重生成（320 轮，重写一次几百毫秒，省下来）。
    // A/C/D **每次都重建**：回滚/重做那条用例会就地改写会话文件（跑第二遍时若不铺回去，
    // 它会拿着一份已被截断的夹具跑，红的原因就变成夹具污染而不是产品缺陷了）。
    buildSessionA();
    buildSessionC();
    buildSessionD();
    return { ...manifest, rounds: prev.rounds };
  }
  buildSessionA();
  const rounds = buildSessionB();
  buildSessionC();
  buildSessionD();
  fs.writeFileSync(stamp, `${JSON.stringify({ version: 3, rounds: { b: rounds }, ...manifest }, null, 2)}\n`);
  return { ...manifest, rounds: { b: rounds } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const m = ensureFixtures({ force: process.argv.includes('--force') });
  process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
}
