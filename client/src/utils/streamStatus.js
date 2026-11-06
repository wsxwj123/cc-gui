// #2 思考折叠摘要 + 流式动态状态 的纯逻辑(无 JSX/React,便于单测)。
// TurnBubble/MessageBubble 共用。
import { TASK_TOOL_NAMES } from './todos.js';

// 工具入参预览:取最有辨识度的一个字段(命令/文件名/pattern/query)。
export function formatInputPreview(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input.command) return input.command;
  if (input.file_path) return input.file_path.split(/[/\\]+/).pop();
  if (input.pattern) return input.pattern;
  if (input.query) return input.query;
  return '';
}

// 折叠态思考块摘要:取首个非空行、去 markdown 标记、截断到 ~60 字。
// 空/极短/纯符号 → 返回 null,调用处回退"思考过程"。只扫前 400 字,不全文 scan。
export function thinkingSummary(text) {
  if (!text) return null;
  const firstLine = text.slice(0, 400).split('\n').map((l) => l.trim()).find(Boolean);
  if (!firstLine) return null;
  const clean = firstLine
    .replace(/^#{1,6}\s+/, '')   // 标题符
    .replace(/^>\s*/, '')         // 引用
    .replace(/^[-*+]\s+/, '')     // 列表符
    .replace(/[*_`~]/g, '')       // 强调/代码标记
    .trim();
  if (clean.length < 2) return null;
  return clean.length > 60 ? clean.slice(0, 60) + '…' : clean;
}

export function thinkingLabel(text) {
  const s = thinkingSummary(text);
  return s ? `已思考 · ${s}` : '思考过程';
}

// AI 有时不走 Skill 工具，而是直接用读取类工具读 <skill>/SKILL.md 加载技能 —
// 这种调用也按 skill 横幅渲染(否则用户只看到一行普通 Read,不知道技能被加载)。
// 只认读取类工具(Read / mcp 各家 read_file);Edit/Write 碰 SKILL.md 是在开发
// 技能,不算加载。路径须含 skills/<name>/SKILL.md(兼容 Windows 反斜杠),
// skill 名取 SKILL.md 的上一级目录名;命中返回名字,否则 null。
// **本函数是唯一实现**:TurnBubble 渲染与 stripSummary 都从这里取(不许各留一份)。
const SKILL_DOC_PATH_RE = /[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/i;
export function getSkillDocReadName(toolCall) {
  const name = toolCall?.name || '';
  // Read 原生工具,或 mcp 工具名末段形如 read_file / readfile(desktop-commander 等)
  const tail = name.split('__').pop() || '';
  const isReader = name === 'Read' || /^read_?file$/i.test(tail);
  if (!isReader) return null;
  const p = toolCall.input?.file_path || toolCall.input?.path;
  if (typeof p !== 'string') return null;
  const m = SKILL_DOC_PATH_RE.exec(p);
  return m ? m[1] : null;
}

// ── #1 cowork 分组(纯逻辑,母会话与子代理共用)────────────────────
// 把一轮有序 blocks 切成"段":每段正文之前连续的 [思考 + 通用工具] 打包成一个
// group(渲染为折叠),正文/子代理派发/Skill 横幅各自成段(折叠外醒目渲染)。
// 返回段数组,渲染逻辑(WorkGroup 折叠、TaskCard、SkillCard)由组件消费。
// skilldoc 识别(**恒开**,见 getSkillDocReadName)是分组口径的一部分 —— 摘要(stripSummary)
// 与渲染(TurnBubble)必须走同一个函数,否则"可折段集合"两边不一致:读了一次 SKILL.md 的轮
// 会在摘要侧被算成可折块(多一步、hasFold=true),屏幕上却没有任何段可折(2026-09-13 修)。
// 组的 key = 首个 block 的下标(稳定,供折叠态)。
export function groupCoworkBlocks(blocks) {
  const segs = [];
  let group = null; // { kind:'group', key, items:[] }
  const flush = () => { if (group && group.items.length) segs.push(group); group = null; };
  const pushGroup = (block, key) => {
    if (!group) group = { kind: 'group', key, items: [] };
    group.items.push(block);
  };
  const list = Array.isArray(blocks) ? blocks : [];
  const skillOf = (t) => t?.input?.skill || t?.input?.name || t?.name;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.type === 'text') {
      if (!b.content) continue;
      flush();
      segs.push({ kind: 'text', key: i, index: i, content: b.content });
      continue;
    }
    if (b.type === 'thinking') {
      if (!b.content) continue;
      pushGroup(b, i);
      continue;
    }
    if (b.type === 'tool_use' && b.toolCall) {
      const tc = b.toolCall;
      // 任务清单工具:只作 group 边界,不成段(清单走输入框上方常驻面板)。
      if (TASK_TOOL_NAMES.has(tc.name)) { flush(); continue; }
      if (tc.name === 'Task' || tc.name === 'Agent') {
        flush();
        segs.push({ kind: 'task', key: i, index: i, toolCall: tc });
        continue;
      }
      // 工作流独立成段:它在聊天里要展开成阶段/助手视图。折进 group 折叠区 = 用户
      // 看不到这次跑到哪个阶段、哪些助手还在跑(一次工作流能派几十个)。
      if (tc.name === 'Workflow') {
        flush();
        segs.push({ kind: 'workflow', key: i, index: i, toolCall: tc });
        continue;
      }
      if (tc.name === 'Skill') {
        // 连续同一 skill 合并成一张横幅(带次数),中间隔了别的块则另起。
        const prev = list[i - 1];
        if (prev?.type === 'tool_use' && prev.toolCall?.name === 'Skill' && skillOf(prev.toolCall) === skillOf(tc)) continue;
        flush();
        const calls = [tc];
        for (let j = i + 1; j < list.length; j++) {
          const nb = list[j];
          if (nb?.type === 'tool_use' && nb.toolCall?.name === 'Skill' && skillOf(nb.toolCall) === skillOf(tc)) calls.push(nb.toolCall);
          else break;
        }
        segs.push({ kind: 'skill', key: i, index: i, calls });
        continue;
      }
      const docName = getSkillDocReadName(tc);
      if (docName) {
        flush();
        segs.push({ kind: 'skilldoc', key: i, index: i, toolCall: tc, name: docName });
        continue;
      }
      pushGroup(b, i);
      continue;
    }
  }
  flush();
  return segs;
}

// 活跃 group 的 key:仅流式中、且最后一段是 group(其后还没出现正文/其它边界)时,
// 该 group 默认展开(随流实时刷新);其余段默认折叠。历史轮(isLive=false)全折叠。
export function activeGroupKey(segments, isLive) {
  if (!isLive || !segments || !segments.length) return null;
  const last = segments[segments.length - 1];
  return last.kind === 'group' ? last.key : null;
}

// ── 条带折叠(2026-09-13):可折段判据 + 摘要行取值(纯函数,零 DOM)──────────
// 写死为 kind === 'group'(思考 + 通用工具)。**不是** kind !== 'text' ——
// task/workflow/skill/skilldoc 段恒显不折(R114 的既有决策:工作流/子代理跑到哪一步必须看得见)。
// 单独导出是为了语义显式 + 测试 + 将来放宽折叠范围只有一个改动点。
export function isFoldableSegment(seg) {
  return seg?.kind === 'group';
}

// 摘要行的三个值。blocks 形状照 turn.blocks 原样读(不造字段、不改入参)。
//   rounds: usageCalls 是数组 → 条数;否则 null(直播期恒无此字段 → 不显示「N 轮」)
//   steps : **可折段内**会渲染的过程块数(thinking 要有非空 content、tool_use 要有 toolCall)。
//           task/workflow/skill/skilldoc 段里的块不计入 —— 它们不参与折叠,计进去会让
//           "展开后能看到的东西"与这个数字对不上账。
//   tail  : 位置判据取的末句(见下),取不到 → null
//   doneTitle / liveTitle(r152a):可折段里「最新工具调用」的标题,回合已结束 / 回合在生成两种
//           口径(见 latestToolTitles);可折段里一个工具都没有 → 都是 null(调用方回落 tail)。
export function stripSummary(blocks, usageCalls) {
  const list = Array.isArray(blocks) ? blocks : [];
  let steps = 0;
  const foldedCalls = []; // 可折段里的工具调用,按出现顺序(只用来选「最新工具标题」,不影响 steps)
  for (const seg of groupCoworkBlocks(list)) {
    if (!isFoldableSegment(seg)) continue;
    for (const b of seg.items) {
      if (b?.type === 'thinking' && b.content) steps += 1;
      else if (b?.type === 'tool_use' && b.toolCall) {
        steps += 1;
        foldedCalls.push(b.toolCall);
      }
    }
  }
  const { doneTitle, liveTitle } = latestToolTitles(foldedCalls);
  return {
    rounds: Array.isArray(usageCalls) ? usageCalls.length : null,
    steps,
    tail: stripSummaryTail(list),
    doneTitle,
    liveTitle,
  };
}

// ── r152a 折叠条末尾的「最新工具调用标题」(纯函数,零 DOM)──────────────
// 标题规则(按序取第一个非空):
//   ① 入参 description(字符串、去空白后非空;任何工具有就用它)
//   ② 按工具名的"动词 + 对象"模板,用词与展开卡片一致:Bash 取 command 第一个非空行;
//      Read 读取 / Edit、MultiEdit 编辑 / Write 新建 <文件名>;Grep 搜索、Glob 查找文件 <pattern>;
//      WebFetch 抓取 <url>;WebSearch 搜索网页 <query>
//   ③ 其它工具:入参 summary,再 title
// 清洗按来源分两类(两类都按码点截到 60 + …):
//   说明性文字(① description、③ summary / title)是模型写的句子,走思考尾句那套 cleanTailText
//   (剥成对记号 → 空白折叠);其余(命令首行、文件名、pattern、url、query 与拼好的"动词 + 对象")
//   是内容本身,星号 / 反引号 / 下划线都有含义(`src/**/*.test.*`、echo `date`),只折叠空白、不去记号。
// 取不到真标题 → null,由调用方决定沿用上一个工具的标题还是退回工具名(toolDisplayName)。
// 标题在渲染路径上,不许抛:入参不是对象 / 字段不是字符串 / 无原型对象一律当"取不到"。
const TOOL_TITLE_MAX = 60;

function nonBlankString(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

// 路径最后一段:按 / 与 \ 两种分隔符切(Windows 路径);末尾带分隔符时取上一段。
function pathBaseName(p) {
  const s = nonBlankString(p);
  if (!s) return null;
  const parts = s.split(/[/\\]+/).filter((x) => x.trim());
  return parts.length ? parts[parts.length - 1] : null;
}

// 返回 { text, prose } 或 null:prose = 说明性文字(决定清洗时去不去成对记号,见上)。
function rawToolTitle(name, input) {
  const description = nonBlankString(input.description);
  if (description) return { text: description, prose: true };
  const literal = (text) => (text ? { text, prose: false } : null);
  const verbObject = (verb, object) => literal(object ? `${verb} ${object}` : null);
  switch (name) {
    case 'Bash': {
      const command = nonBlankString(input.command);
      return literal(command ? command.split(/[\r\n]+/).map((l) => l.trim()).find(Boolean) || null : null);
    }
    case 'Read': return verbObject('读取', pathBaseName(input.file_path));
    case 'Edit':
    case 'MultiEdit': return verbObject('编辑', pathBaseName(input.file_path));
    case 'Write': return verbObject('新建', pathBaseName(input.file_path));
    case 'Grep': return verbObject('搜索', nonBlankString(input.pattern));
    case 'Glob': return verbObject('查找文件', nonBlankString(input.pattern));
    case 'WebFetch': return verbObject('抓取', nonBlankString(input.url));
    case 'WebSearch': return verbObject('搜索网页', nonBlankString(input.query));
    default: {
      const text = nonBlankString(input.summary) || nonBlankString(input.title);
      return text ? { text, prose: true } : null;
    }
  }
}

// 非说明性文字的清洗:String 转换不抛 → 连续空白折叠成一个空格 → trim → 按码点截到 max + …;
// 不去任何记号(与 cleanTailText 的区别只在这一点)。清洗后为空 → null。
function cleanLiteralText(src, max) {
  if (src == null) return null;
  let raw;
  try { raw = String(src); } catch { return null; }
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const cps = Array.from(flat);
  return cps.length > max ? cps.slice(0, max).join('') + '…' : flat;
}

export function toolTitle(toolCall) {
  try {
    if (!toolCall || typeof toolCall !== 'object') return null;
    const input = toolCall.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const raw = rawToolTitle(typeof toolCall.name === 'string' ? toolCall.name : '', input);
    if (!raw) return null;
    return raw.prose ? cleanTailText(raw.text, TOOL_TITLE_MAX) : cleanLiteralText(raw.text, TOOL_TITLE_MAX);
  } catch {
    return null;
  }
}

// 工具原名;MCP 工具(mcp__服务名__工具名)取最后一段。没有名字 → null。
function toolDisplayName(toolCall) {
  const name = typeof toolCall?.name === 'string' ? toolCall.name.trim() : '';
  if (!name) return null;
  return name.startsWith('mcp__') ? (name.split('__').pop() || name) : name;
}

const titleOrName = (toolCall) => toolTitle(toolCall) ?? toolDisplayName(toolCall);

// 入参还没到:直播时 content_block_start 先放 input:{},入参 JSON 流完整才换成真对象。
// 「还是空的、也还没有结果」= 这个工具刚开始,标题还定不下来。
function isInputPending(toolCall) {
  if (toolCall?.result != null) return false;
  const input = toolCall?.input;
  if (input == null || input === '') return true;
  if (typeof input !== 'object') return false;
  try { return Object.keys(input).length === 0; } catch { return false; }
}

// 「最新」怎么选(calls = 可折段里的工具调用,按出现顺序):
//   doneTitle(回合已结束):最后一个工具;最后一块是思考也一样,不切回思考预览。
//   liveTitle(回合在生成):最后一个还没结果的工具(并行时 = 还在跑的最后一个);都有结果时同 doneTitle。
//     它的入参还没到 → 不拿它,沿用它之前最近一个入参已到的工具;之前一个都没有就用它的工具名。
//     入参传完后它自己的标题立刻顶上(避免"上一个标题 → 工具名 → 新标题"闪一下)。
function latestToolTitles(calls) {
  if (!calls.length) return { doneTitle: null, liveTitle: null };
  const doneTitle = titleOrName(calls[calls.length - 1]);
  let running = -1;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i]?.result == null) { running = i; break; }
  }
  if (running < 0) return { doneTitle, liveTitle: doneTitle };
  if (!isInputPending(calls[running])) return { doneTitle, liveTitle: titleOrName(calls[running]) };
  for (let i = running - 1; i >= 0; i -= 1) {
    if (isInputPending(calls[i])) continue;
    const title = titleOrName(calls[i]);
    if (title) return { doneTitle, liveTitle: title };
  }
  return { doneTitle, liveTitle: toolDisplayName(calls[running]) };
}

// 尾段取值:**恒取最后一条思考**(不看最后一块是什么)。
// 为什么恒定取思考(2026-09-13 改口径):正文段在任何折叠态都**不隐藏**(只折 group 段),
// 拿正文当摘要尾句 → 摘要行与它下面那行正文必然逐字重复(用户实报);思考在收起态是藏着的,
// 拿它当尾句才补充信息。取不到思考(或清洗后为空)→ null → 省略尾段(F2/F4),不回落取正文。
function stripSummaryTail(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const b = list[i];
    if (b?.type !== 'thinking') continue;
    return cleanTailText(b.content);
  }
  return null;
}

// 清洗四步(顺序固定):非字符串先转(第三方 provider 会落盘怪块)→ **剥配对的行内标记**
// → 空白折叠成单个空格 → trim → 按 Unicode 码点截断到 max(不得劈开代理对),超出补一个 `…`。
// max:思考尾句 40(默认,与改动前一致)、工具标题 60(r152a,TOOL_TITLE_MAX)。
// 剥在截断**之前**:配对跨越 40 码点边界时,先截会让开记号留在行上、闭记号被切掉。
// 只剥配对的强调/删除线/行内码,零散的单个记号一律不碰(见 stripPairedMarkers);
// 与 thinkingSummary 的"全字符类扫射"口径**故意不同**,别复用也别改 thinkingSummary。
const THINK_TAIL_MAX = 40;
export function cleanTailText(src, max = THINK_TAIL_MAX) {
  if (src == null) return null;
  // String(src) 对 Object.create(null) 这类无原生 toString 的对象会抛 —— 摘要在渲染路径上,
  // 抛出去就是整列表白屏。取不到就当作没有尾段。
  let raw;
  try { raw = String(src); } catch { return null; }
  const flat = stripPairedMarkers(raw).replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const cps = Array.from(flat);
  return cps.length > max ? cps.slice(0, max).join('') + '…' : flat;
}

// 只剥**成对**的行内标记:`**粗**` / `__粗__` / `~~删~~` / `` `码` `` / `*强*` / `_强_`。
// 单个零散的 `*` `_` `~` 一个不动 —— 全字符类扫射(thinkingSummary 那种 `[*_`~]`)会误伤
// `foo_bar_baz` / `~/edirect/` / `ANTHROPIC_DEFAULT_*_MODEL` 这类真内容。
// 开闭两侧还要求"不直接贴单词字符":挡 `2*3*4`(算式,不是强调)与 `MY__VAR__X`(标识符)。
// 未闭合的记号(截断掉的)按 CommonMark 就是字面量,保留原样 —— 这里不做二次清理。
// ponytail: 正则配对,不引 markdown 解析器;斜体嵌套(***x***)与跨行配对不做,真需要再说。
function stripPairedMarkers(s) {
  return s
    .replace(/`([^`\n]+)`/g, '$1')                                        // 行内码
    .replace(/(^|[^\w*])\*\*([^\s*](?:[^*]*[^\s*])?)\*\*(?![\w*])/g, '$1$2') // 粗体(先于单 `*`,免得拆出两个单记号)
    .replace(/(^|[^\w_])__([^\s_](?:[^_]*[^\s_])?)__(?![\w_])/g, '$1$2')
    .replace(/(^|[^\w~])~~([^\s~](?:[^~]*[^\s~])?)~~(?![\w~])/g, '$1$2')     // 删除线
    .replace(/(^|[^\w*])\*([^\s*](?:[^*]*[^\s*])?)\*(?![\w*])/g, '$1$2')     // 单字符强调
    .replace(/(^|[^\w_])_([^\s_](?:[^_]*[^\s_])?)_(?![\w_])/g, '$1$2');
}

// ── ui-live-line-v2:底部状态行只看「最后一块」────────────────────────
// 入参 = 生成中整轮的 blocks(与 stripSummary 同一形状)。返回最后一块的类型与
// 「最后一块是思考」时的内容(供状态行取一行预览)。多轮回合里整轮累计的 text
// 不能代表此刻在做什么 —— 前面出现过正文不代表现在还在输出。
// 空块(还没有 content / toolCall)跳过,避免 content_block_start 的空壳抢走判定。
export function tailBlockInfo(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const b = list[i];
    if (!b) continue;
    if (b.type === 'text' && b.content) return { lastType: 'text', lastThinkingText: '' };
    if (b.type === 'thinking' && b.content) return { lastType: 'thinking', lastThinkingText: b.content };
    if (b.type === 'tool_use' && b.toolCall) return { lastType: 'tool', lastThinkingText: '' };
  }
  return { lastType: null, lastThinkingText: '' };
}
