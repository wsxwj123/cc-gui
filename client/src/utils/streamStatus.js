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

// 流式动态状态行文案:按流式 turn 的最后一个 block 推导当前动作。
const STREAM_VERBS = {
  Read: '正在读取', Bash: '正在运行命令', Grep: '正在搜索', Glob: '正在查找',
  Edit: '正在编辑', Write: '正在编辑', MultiEdit: '正在编辑',
  WebFetch: '正在检索', WebSearch: '正在检索',
};
export function streamStatusText(blocks) {
  const last = blocks && blocks.length ? blocks[blocks.length - 1] : null;
  if (!last) return null;
  if (last.type === 'thinking') return '正在思考…';
  if (last.type === 'text') return '正在回复…';
  if (last.type === 'tool_use' && last.toolCall) {
    const name = last.toolCall.name;
    if (name === 'Task' || name === 'Agent') return '正在派发子代理…';
    if (TASK_TOOL_NAMES.has(name)) return '正在整理任务清单…';
    const verb = STREAM_VERBS[name];
    const prev = formatInputPreview(last.toolCall.input);
    if (verb) return prev ? `${verb} ${prev}` : `${verb}…`;
    return `正在调用 ${name}…`;
  }
  return null;
}
