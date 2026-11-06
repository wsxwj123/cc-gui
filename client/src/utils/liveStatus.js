// r154:底部状态行的状态词(纯函数,零 React、零 DOM)。
// 由现有流式状态推出 { phase, verb, object }:verb 是客观动词,object 是入参里最有辨识度的一项。
// 文案约定:不随时间换俏皮词;verb / object 一律不带省略号「…」,object 只截前 50 个字符。

// 工具名 → 动词。没列出的工具走「调用 + 工具名」。
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

/**
 * 优先级:stopping > compacting > pendingTool > text > thinking > 其余。
 * pendingTool = 最后一个还没结果的工具调用 { name, input };没有时传 null。
 */
export function liveStatusLabel({
  stopping = false,
  compacting = false,
  pendingTool = null,
  text = false,
  thinking = false,
  sawModelOutput = true,
} = {}) {
  if (stopping) return { phase: 'stopping', verb: '停止中', object: '' };
  if (compacting) return { phase: 'compacting', verb: '正在压缩上下文', object: '' };
  if (pendingTool) return { phase: 'tool', ...toolLabel(pendingTool) };
  if (text) return { phase: 'text', verb: '正在输出', object: '' };
  if (thinking) return { phase: 'thinking', verb: '正在思考', object: '' };
  if (sawModelOutput === false) return { phase: 'connecting', verb: '连接中', object: '' };
  return { phase: 'thinking', verb: '正在思考', object: '' };
}
