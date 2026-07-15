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

// ── #1 cowork 分组(纯逻辑,母会话与子代理共用)────────────────────
// 把一轮有序 blocks 切成"段":每段正文之前连续的 [思考 + 通用工具] 打包成一个
// group(渲染为折叠),正文/子代理派发/Skill 横幅各自成段(折叠外醒目渲染)。
// 返回段数组,渲染逻辑(WorkGroup 折叠、TaskCard、SkillCard)由组件消费。
// getSkillDocReadName:可选,识别"读 skills/<name>/SKILL.md"当技能加载横幅;
// 不传则该类调用当普通工具进 group。段的 key = 首个 block 的下标(稳定,供折叠态)。
export function groupCoworkBlocks(blocks, { getSkillDocReadName } = {}) {
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
      const docName = getSkillDocReadName ? getSkillDocReadName(tc) : null;
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
