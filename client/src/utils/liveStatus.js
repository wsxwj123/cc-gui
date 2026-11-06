// r154 / ui-live-line-v2:底部状态行的状态词(纯函数,零 React、零 DOM)。
// 由现有流式状态推出 { phase, verb, object }。ui-live-line-v2 起只按「最后一块」判阶段:
// 工具阶段直接显示该工具调用的标题(与折叠行同一个 toolTitle),不再加「运行 / 委派子代理」前缀;
// 思考阶段显示「思考 · 一行预览」;正文才是「正在输出」。
import { toolTitle, cleanTailText } from './streamStatus.js';

// 工具名 → 动词。**只作回落**:取不到工具标题(description / 文件名 / pattern …)时,
// 仍显示原来的动词短语(如 AskUserQuestion → 「等待你的回答」),不让底部行空着。
// 没列出的工具走「调用 + 工具名」。
export const TOOL_VERBS = Object.freeze({
  Read: '读取',
  Edit: '编辑',
  MultiEdit: '编辑',
  NotebookEdit: '编辑',
  Write: '写入',
  Bash: '运行',
  BashOutput: '运行',
  KillShell: '运行',
  Grep: '搜索',
  Glob: '查找',
  WebFetch: '抓取',
  WebSearch: '联网搜索',
  Task: '委派子代理',
  Agent: '委派子代理',
  TaskCreate: '更新任务清单',
  TaskUpdate: '更新任务清单',
  TodoWrite: '更新任务清单',
  Skill: '调用技能',
  ExitPlanMode: '提交计划',
  AskUserQuestion: '等待你的回答',
});

const OBJECT_MAX = 50;
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write']);

// 截前 50 个字符(按码点截,不切坏 emoji / 生僻字),去掉省略号,空白折成单个空格。
function clip(v) {
  if (v == null) return '';
  const s = String(v).replace(/…/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, OBJECT_MAX).join('').trim();
}

// 路径最后一段;'/' 与 '\' 都认(Windows 路径),结尾分隔符忽略。
function baseName(p) {
  if (typeof p !== 'string') return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function hostOf(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  try {
    const host = new URL(url.trim()).hostname;
    if (host) return host;
  } catch { /* 解析失败取原串 */ }
  return url;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function toolObject(name, input) {
  const inp = input && typeof input === 'object' ? input : {};
  if (FILE_TOOLS.has(name)) return clip(baseName(str(inp.file_path) || str(inp.notebook_path) || str(inp.path)));
  switch (name) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell': {
      const desc = clip(inp.description);
      if (desc) return desc;
      return clip(str(inp.command).split(/\r?\n/).find((l) => l.trim()) || '');
    }
    case 'Grep':
    case 'Glob':
      return clip(inp.pattern);
    case 'WebFetch':
      return clip(hostOf(inp.url));
    case 'WebSearch':
      return clip(inp.query);
    case 'Task':
    case 'Agent':
      return clip(inp.description);
    case 'Skill':
      return clip(str(inp.skill) || str(inp.name));
    default:
      return '';
  }
}

// 旧回落:动词 + 对象。只在 toolTitle 取不到标题时用。
function toolLabel(tool) {
  const name = str(tool && tool.name).trim();
  const input = tool && tool.input;
  // mcp__服务__工具:取最后一段作为对象,动词统一「调用」
  if (name.startsWith('mcp__')) {
    const segs = name.split('__').filter(Boolean);
    return { verb: '调用', object: clip(segs.length > 1 ? segs[segs.length - 1] : name) };
  }
  if (Object.prototype.hasOwnProperty.call(TOOL_VERBS, name)) {
    return { verb: TOOL_VERBS[name], object: toolObject(name, input) };
  }
  return { verb: '调用', object: clip(name) };
}

// 工具阶段:标题优先(与折叠行、头行同一个 toolTitle,单一来源),标题在 object 里、verb 留空
// —— 底部行文字恰为标题,不带「运行 / 委派子代理」这类动词前缀。取不到标题才回落旧动词短语。
function pendingToolLabel(tool) {
  const title = toolTitle(tool);
  if (title) return { verb: '', object: title };
  return toolLabel(tool);
}

/**
 * 优先级:stopping > compacting > pendingTool > lastType > 兼容布尔 > connecting。
 * lastType = 生成中整轮 blocks 最后一块的类型('text' | 'thinking' | 'tool' | null),
 * 见 streamStatus.tailBlockInfo(子代理视图与主会话共用)。
 * lastThinkingText = 最后一块是思考时的内容,取一行预览(与折叠条末句同一套清洗)。
 * text / thinking 两个布尔是旧调用点的兼容入口:没有 lastType 时才参与判断。
 */
export function liveStatusLabel({
  stopping = false,
  compacting = false,
  pendingTool = null,
  lastType = null,
  lastThinkingText = '',
  text = false,
  thinking = false,
  sawModelOutput = true,
} = {}) {
  if (stopping) return { phase: 'stopping', verb: '停止中', object: '' };
  if (compacting) return { phase: 'compacting', verb: '正在压缩上下文', object: '' };
  if (pendingTool) return { phase: 'tool', ...pendingToolLabel(pendingTool) };
  const stage = lastType || (text ? 'text' : thinking ? 'thinking' : null);
  if (stage === 'text') return { phase: 'text', verb: '正在输出', object: '' };
  // thinking = 最后一块是思考;tool = 最后一块是工具但结果已回(空窗期,下一条消息未到)。
  // 两种都显示「思考 · 预览」,预览取最后一条思考,取不到只写「思考」。
  if (stage === 'thinking' || stage === 'tool') {
    const preview = cleanTailText(lastThinkingText);
    return { phase: 'thinking', verb: '思考', object: preview || '' };
  }
  if (sawModelOutput === false) return { phase: 'connecting', verb: '连接中', object: '' };
  return { phase: 'thinking', verb: '思考', object: '' };
}
