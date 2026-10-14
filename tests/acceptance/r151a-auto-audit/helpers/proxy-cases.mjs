// r151a F 组用的输入(Anthropic 协议请求体)。基线录制脚本与 spec 共用同一份,不会各写一份对不上。
// 基线 = 改动前(0.2.421,未改动的工作树)的 openai 协议代理收到这些输入后发往上游的请求体原文,
// 由 helpers/capture-proxy-baseline.mjs 录进 fixtures/proxy-baseline.json。
const TOOLS = [{ name: 'Bash', description: '执行命令', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }];
const HISTORY = [
  { role: 'user', content: '帮我看看目录 R151' },
  { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 'toolu_r151_a', name: 'Bash', input: { command: 'ls' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r151_a', content: 'a.txt\nb.txt' }] },
];

/** 流式输入(stream === true):改动后整个输出必须与基线逐字节相同。 */
export const STREAM_CASES = {
  'stream-basic': { model: 'r151-chat', max_tokens: 256, stream: true, system: '你是测试助手', messages: [{ role: 'user', content: '你好 R151' }] },
  'stream-tools': {
    model: 'r151-chat', max_tokens: 1024, stream: true, temperature: 0.3, top_p: 0.9, metadata: { user_id: 'r151-user' },
    system: [{ type: 'text', text: '系统提示一', cache_control: { type: 'ephemeral' } }, { type: 'text', text: '系统提示二' }],
    tools: TOOLS, tool_choice: { type: 'auto' }, messages: HISTORY,
  },
  'stream-with-stop': { model: 'r151-chat', max_tokens: 64, stream: true, stop_sequences: ['</block>', 'STOP'], system: 'sys', messages: [{ role: 'user', content: 'x' }] },
  'stream-thinking': { model: 'r151-reasoner', max_tokens: 4096, stream: true, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: '想一想 R151' }] },
};

/** 非流式输入的基本形(像审核请求:没有 stream 键、带 stop_sequences)。各变体只改 stream / stop_sequences。 */
export const NOSTREAM_BASE = {
  model: 'r151-audit', max_tokens: 2112, system: '审核系统提示 R151',
  messages: [{ role: 'user', content: '<transcript>\nUser: 删掉临时文件\n</transcript>\n请判断' }],
  stop_sequences: ['</block>'], metadata: { user_id: 'r151-user' },
};
export const NOSTREAM_TOOLS = { model: 'r151-chat', max_tokens: 512, temperature: 0.2, tools: TOOLS, messages: HISTORY };

/** 基线要录的全部输入(名字 → 请求体)。 */
export const BASELINE_INPUTS = { ...STREAM_CASES, 'nostream-base': NOSTREAM_BASE, 'nostream-tools': NOSTREAM_TOOLS };
