// r151b 基线单测专用:替换 server/routes/chat.js 引入的 SDK `query()`,记录它收到的 options,
// 并模拟一个最小会话(收到第一条输入 → init;每条输入 → 一条 assistant + 一条 result)。
// 其余导出原样转自真实 SDK(本文件里的 import 不会被重定向,见 registerR151bSdkStub)。
// 不起任何进程、不连网络。记录落在 globalThis.__r151bSdkCalls(同一线程,测试直接读)。
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';

export * from '@anthropic-ai/claude-agent-sdk';

const STUB_URL = import.meta.url;

/** 只把 server/routes/chat.js 对 SDK 的引入换成本文件;其它模块(含本文件自身)照常解析。必须在 import chat.js 之前调用。 */
export function registerR151bSdkStub() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@anthropic-ai/claude-agent-sdk' && /\/server\/routes\/chat\.js$/.test(context.parentURL || '')) {
        return { url: STUB_URL, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

const calls = (globalThis.__r151bSdkCalls ||= []);

export function query({ prompt, options = {} } = {}) {
  const record = { options, inputs: [], closed: false };
  calls.push(record);
  const sessionId = options.resume || randomUUID();
  const signal = options.abortController?.signal;
  const inputIterator = prompt[Symbol.asyncIterator]();
  const aborted = new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve({ done: true });
    else signal.addEventListener('abort', () => resolve({ done: true }), { once: true });
  });
  const base = () => ({ session_id: sessionId, uuid: randomUUID() });
  async function* run() {
    let initSent = false;
    while (!record.closed) {
      const next = await Promise.race([inputIterator.next(), aborted]);
      if (next.done || record.closed) return;
      record.inputs.push(next.value);
      if (!initSent) {
        initSent = true;
        yield {
          type: 'system', subtype: 'init', ...base(), cwd: options.cwd, model: options.model,
          permissionMode: options.permissionMode, tools: [], mcp_servers: [], slash_commands: [],
          apiKeySource: 'none', claude_code_version: '0.0.0-r151b-stub', output_style: 'default',
        };
      }
      yield {
        type: 'assistant', ...base(), parent_tool_use_id: null,
        message: {
          id: `msg_r151b_${record.inputs.length}`, type: 'message', role: 'assistant', model: options.model,
          content: [{ type: 'text', text: 'R151B-STUB-REPLY' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      };
      yield {
        type: 'result', subtype: 'success', ...base(), is_error: false, duration_ms: 1, duration_api_ms: 1,
        num_turns: 1, result: 'R151B-STUB-REPLY', total_cost_usd: 0, permission_denials: [], modelUsage: {},
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    }
  }
  const generator = run();
  const noop = async () => {};
  return Object.assign(generator, {
    setPermissionMode: noop,
    setModel: noop,
    interrupt: noop,
    stopTask: noop,
    applyFlagSettings: noop,
    getContextUsage: async () => ({}),
    close: () => { record.closed = true; },
  });
}
