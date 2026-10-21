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

// 可选控制 globalThis.__r151bSdkControl(只有 check-r151b-runtime-hooks 设它;没设 = 下面的原行为,基线照旧):
//   throwOnQuery: true → 下一次 query() 直接抛错(进程起不来),用一次即复位;
//   reply(input) → 'ok'(默认)| 'error'(结果为错误)| 'exit'(不给结果就结束)| 'hold'(不回应,直到被 abort),
//   或一个之后兑现为上述之一的 Promise(r151c:兑现前算回合在跑);
//   onInputEnd(record) → 可选 Promise(r151d):输入流被关(常驻进程被要求退出)后等它兑现再结束,模拟旧进程推迟退出;被 abort 时立即结束;
//   setModel(record, model) → 可选 Promise(r151d):替换热切模型的应答时刻,模拟热切期间让出事件循环;
//   setPermissionMode(record, mode) → 可选 Promise(r151d):替换热切档位的应答(record.inputEnded = 输入流已被关,真 SDK 此时的
//   控制请求送不到 CLI,要等进程退出才以失败收场)。
export function query({ prompt, options = {} } = {}) {
  const ctl = globalThis.__r151bSdkControl;
  if (ctl?.throwOnQuery) { ctl.throwOnQuery = false; throw new Error('r151b stub: query() 起不来'); }
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
      if (next.done || record.closed) {
        record.inputEnded = true;
        if (!record.closed && !signal?.aborted && typeof ctl?.onInputEnd === 'function') await Promise.race([ctl.onInputEnd(record), aborted]);
        return;
      }
      record.inputs.push(next.value);
      if (!initSent) {
        initSent = true;
        yield {
          type: 'system', subtype: 'init', ...base(), cwd: options.cwd, model: options.model,
          permissionMode: options.permissionMode, tools: [], mcp_servers: [], slash_commands: [],
          apiKeySource: 'none', claude_code_version: '0.0.0-r151b-stub', output_style: 'default',
        };
      }
      let mode = typeof ctl?.reply === 'function' ? ctl.reply(next.value) : 'ok';
      // r151c:reply 可返回 Promise(到点才回应;被 abort 时按结束处理),用来模拟"会忙一阵的回合";返回字符串的照旧同步
      if (mode && typeof mode.then === 'function') {
        const r = await Promise.race([mode, aborted.then(() => 'aborted')]);
        if (r === 'aborted') return;
        mode = r;
      }
      if (mode === 'exit') return;
      if (mode === 'hold') { await aborted; return; }
      yield {
        type: 'assistant', ...base(), parent_tool_use_id: null,
        message: {
          id: `msg_r151b_${record.inputs.length}`, type: 'message', role: 'assistant', model: options.model,
          content: [{ type: 'text', text: 'R151B-STUB-REPLY' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      };
      yield {
        type: 'result', subtype: mode === 'error' ? 'error_during_execution' : 'success', ...base(), is_error: mode === 'error', duration_ms: 1, duration_api_ms: 1,
        num_turns: 1, result: 'R151B-STUB-REPLY', total_cost_usd: 0, permission_denials: [], modelUsage: {},
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
      // r151q:afterResult(record) → 可选,返回异步可迭代对象(或 null):结果之后不等新输入就接着吐的事件(各自补上 session_id/uuid),
      // 模拟回合收尾后主 agent 复活续跑;被 abort 时立即结束。没设 = 原行为。
      const extra = typeof ctl?.afterResult === 'function' ? ctl.afterResult(record) : null;
      if (extra) {
        const it = extra[Symbol.asyncIterator]();
        for (;;) {
          const step = await Promise.race([it.next(), aborted]);
          if (step.done) break;
          yield { ...base(), ...step.value };
        }
        if (signal?.aborted) return;
      }
    }
  }
  const generator = run();
  const noop = async () => {};
  return Object.assign(generator, {
    setPermissionMode: async (m) => {
      if (typeof ctl?.setPermissionMode !== 'function') return;
      const r = await Promise.race([Promise.resolve(ctl.setPermissionMode(record, m)).then(() => 'ok'), aborted.then(() => 'aborted')]);
      if (r === 'aborted') throw new Error('r151b stub:进程被中止,控制请求没有送达'); // 同真 SDK:中止时挂着的控制请求以失败收场
    },
    setModel: async (m) => { if (typeof ctl?.setModel === 'function') await ctl.setModel(record, m); },
    interrupt: noop,
    stopTask: noop,
    applyFlagSettings: noop,
    getContextUsage: async () => ({}),
    close: () => { record.closed = true; },
  });
}
