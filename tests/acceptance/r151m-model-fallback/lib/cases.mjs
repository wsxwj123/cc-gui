// r151m 行为清单 1–10 的黑盒用例。规格只来自 .devflow/r151m-model-fallback-接口.md:
// 第 5 节行为清单 1–11 + 第 1–3 节公开入口/映射规则。
// 第 11 条是既有代理单测/验收回归,按任务约定不在本套件重复跑,只写进报告。
import {
  ANTHROPIC_TOKEN,
  OPENAI_KEY,
  captureLogs,
  makeChatBody,
  parseSSE,
  postMessages,
  sleep,
} from './harness.mjs';

function firstRecord(upstream) {
  return upstream?.fake?.records?.[0] || null;
}

function lastRecord(upstream) {
  const records = upstream?.fake?.records || [];
  return records[records.length - 1] || null;
}

export const CASES = {
  1: {
    name: 'OpenAI 映射:列表外的 claude 名 → provider 默认模型',
    async run(ctx, c) {
      const up = await ctx.prepareOpenAI({ model: 'deepseek/x', models: ['deepseek/x'] });
      const res = await postMessages(up.base, makeChatBody('claude-opus-4-7'));
      const rec = firstRecord(up);
      c.equal('客户端状态码', res.status, 200);
      c.equal('假上游请求数', up.fake.records.length, 1);
      c.check('假上游路径含 /chat/completions', Boolean(rec?.path?.endsWith('/chat/completions')), rec?.path, '以 /chat/completions 结尾');
      c.equal('假上游收到的 body.model', rec?.json?.model, 'deepseek/x');
      c.equal('客户端响应 type', res.json?.type, 'message');
      c.includes('客户端响应内容', JSON.stringify(res.json?.content || ''), 'openai-fake-ok');
    },
  },

  2: {
    name: 'OpenAI 列表内模型(含 claude 名):原样转发',
    async run(ctx, c) {
      const up = await ctx.prepareOpenAI({ model: 'deepseek/x', models: ['deepseek/x'] });
      const res = await postMessages(up.base, makeChatBody('deepseek/x'));
      const rec = firstRecord(up);
      c.equal('客户端状态码', res.status, 200);
      c.equal('假上游收到的 body.model', rec?.json?.model, 'deepseek/x');

      // 规则 2 优先于规则 3:名字形如 claude,但显式在 models 列表里 → 不映射。
      const listed = await ctx.prepareOpenAI({
        model: 'deepseek/x',
        models: ['claude-opus-4-7', 'deepseek/x'],
      });
      const res2 = await postMessages(listed.base, makeChatBody('claude-opus-4-7'));
      c.equal('列表内 claude 名客户端状态码', res2.status, 200);
      c.equal('列表内 claude 名不被改写', lastRecord(listed)?.json?.model, 'claude-opus-4-7');
    },
  },

  3: {
    name: 'OpenAI 非 claude/缺失/非字符串 model:原样转发,不映射',
    async run(ctx, c) {
      const up = await ctx.prepareOpenAI({ model: 'deepseek/x', models: ['deepseek/x'] });
      const res = await postMessages(up.base, makeChatBody('gpt-not-in-list'));
      const rec = firstRecord(up);
      c.equal('客户端状态码', res.status, 200);
      c.equal('假上游收到的 body.model', rec?.json?.model, 'gpt-not-in-list');

      // 规则 1:没有 model / 空串 / 非字符串 → 不映射,按原值转发。
      const r2 = await postMessages(up.base, {
        max_tokens: 64,
        messages: [{ role: 'user', content: 'r151m acceptance ping' }],
      });
      c.equal('缺失 model 客户端状态码', r2.status, 200);
      c.check(
        '缺失 model 不凭空补 model',
        !Object.prototype.hasOwnProperty.call(lastRecord(up)?.json || {}, 'model'),
        lastRecord(up)?.json,
        '上游 body 不含 model 字段',
      );

      const r3 = await postMessages(up.base, makeChatBody(''));
      c.equal('空字符串 model 客户端状态码', r3.status, 200);
      c.equal('空字符串 model 原样转发', lastRecord(up)?.json?.model, '');

      const r4 = await postMessages(up.base, makeChatBody(42));
      c.equal('非字符串 model 客户端状态码', r4.status, 200);
      c.equal('非字符串 model 原样转发', lastRecord(up)?.json?.model, 42);
    },
  },

  4: {
    name: 'Anthropic 映射:列表外的 claude 名 → provider 默认模型',
    async run(ctx, c) {
      const up = await ctx.prepareAnthropic({ model: 'deepseek/x', models: ['deepseek/x'] });
      const res = await postMessages(up.base, makeChatBody('claude-sonnet-4-6'));
      const rec = firstRecord(up);
      c.equal('客户端状态码', res.status, 200);
      c.equal('假上游请求数', up.fake.records.length, 1);
      c.equal('假上游路径', rec?.path, '/v1/messages');
      c.equal('假上游收到的 body.model', rec?.json?.model, 'deepseek/x');
      c.equal('客户端响应 type', res.json?.type, 'message');
    },
  },

  5: {
    name: 'Anthropic 列表内模型(含 claude 名):原样转发',
    async run(ctx, c) {
      const up = await ctx.prepareAnthropic({ model: 'deepseek/x', models: ['deepseek/x'] });
      const res = await postMessages(up.base, makeChatBody('deepseek/x'));
      const rec = firstRecord(up);
      c.equal('客户端状态码', res.status, 200);
      c.equal('假上游路径', rec?.path, '/v1/messages');
      c.equal('假上游收到的 body.model', rec?.json?.model, 'deepseek/x');

      // 规则 2 优先于规则 3:显式在 models 列表里的 claude 名不映射。
      const listed = await ctx.prepareAnthropic({
        model: 'deepseek/x',
        models: ['claude-sonnet-4-6', 'deepseek/x'],
      });
      const res2 = await postMessages(listed.base, makeChatBody('claude-sonnet-4-6'));
      c.equal('列表内 claude 名客户端状态码', res2.status, 200);
      c.equal('列表内 claude 名不被改写', lastRecord(listed)?.json?.model, 'claude-sonnet-4-6');
    },
  },

  6: {
    name: 'default/models 组合:缺失/空数组用 default;default 缺失用 models[0]',
    async run(ctx, c) {
      // 先测“default 缺失”:必须在任何带 model 的 set 之前,避免 setter 合并旧默认模型。
      const modelsOnly = await ctx.prepareOpenAI({ models: ['deepseek/x'] });
      const r1 = await postMessages(modelsOnly.base, makeChatBody('claude-3-5-haiku-20241022'));
      c.equal('default 缺失客户端状态码', r1.status, 200);
      c.equal('default 缺失时用 models[0]', lastRecord(modelsOnly)?.json?.model, 'deepseek/x');

      const missing = await ctx.prepareOpenAI({ model: 'deepseek/x' });
      const r2 = await postMessages(missing.base, makeChatBody('claude-3-5-haiku-20241022'));
      c.equal('models 缺失客户端状态码', r2.status, 200);
      c.equal('models 缺失:上游收到 body.model', lastRecord(missing)?.json?.model, 'deepseek/x');

      const empty = await ctx.prepareOpenAI({ model: 'deepseek/x', models: [] });
      const r3 = await postMessages(empty.base, makeChatBody('claude-3-5-haiku-20241022'));
      c.equal('models 空数组客户端状态码', r3.status, 200);
      c.equal('models 空数组:上游收到 body.model', lastRecord(empty)?.json?.model, 'deepseek/x');
    },
  },

  7: {
    name: 'default/models 都缺:原样转发,不凭空猜',
    async run(ctx, c) {
      const oa = await ctx.prepareOpenAI({});
      const r1 = await postMessages(oa.base, makeChatBody('claude-opus-4-7'));
      c.equal('OpenAI 客户端状态码', r1.status, 200);
      c.equal('OpenAI 假上游收到的 body.model', firstRecord(oa)?.json?.model, 'claude-opus-4-7');

      const an = await ctx.prepareAnthropic({});
      const r2 = await postMessages(an.base, makeChatBody('claude-opus-4-7'));
      c.equal('Anthropic 客户端状态码', r2.status, 200);
      c.equal('Anthropic 假上游收到的 body.model', firstRecord(an)?.json?.model, 'claude-opus-4-7');
    },
  },

  8: {
    name: '响应 model 不因映射改写:客户端仍看到请求原名',
    async run(ctx, c) {
      const up = await ctx.prepareOpenAI({ model: 'deepseek/x', models: ['deepseek/x'] });
      const res = await postMessages(up.base, makeChatBody('claude-opus-4-7'));
      c.equal('客户端状态码', res.status, 200);
      c.equal('客户端响应 model', res.json?.model, 'claude-opus-4-7');
      c.equal('客户端响应 type', res.json?.type, 'message');
    },
  },

  9: {
    name: '流式:上游请求 model 映射,回译事件正常',
    async run(ctx, c) {
      const up = await ctx.prepareOpenAI({ model: 'deepseek/x', models: ['deepseek/x'] });
      const res = await postMessages(up.base, makeChatBody('claude-opus-4-7', { stream: true }));
      const rec = firstRecord(up);
      c.equal('客户端状态码', res.status, 200);
      c.includes('客户端 content-type', res.headers['content-type'] || '', 'text/event-stream');
      c.equal('假上游请求数', up.fake.records.length, 1);
      c.equal('假上游 body.stream', rec?.json?.stream, true);
      c.equal('假上游收到的流式 body.model', rec?.json?.model, 'deepseek/x');

      const events = parseSSE(res.text);
      const names = events.map((e) => e.event);
      c.check('回译事件含 message_start', names.includes('message_start'), names, '包含 message_start');
      c.check('回译事件含 content_block_delta', names.includes('content_block_delta'), names, '包含 content_block_delta');
      c.check('回译事件含 message_stop', names.includes('message_stop'), names, '包含 message_stop');
      const start = events.find((e) => e.event === 'message_start');
      c.equal('message_start.message.model 保持原名', start?.data?.message?.model, 'claude-opus-4-7');
    },
  },

  10: {
    name: '同一映射组合只记一次日志,且不含 key/token',
    async run(ctx, c) {
      const up = await ctx.prepareOpenAI({ model: 'deepseek/x', models: ['deepseek/x'] });
      // 专用请求名,避免和本套件其它用例的组合在实现层去重状态里撞车(本用例单独进程也保持自洽)。
      const requested = 'claude-log-once-r151m';
      const body = makeChatBody(requested);
      const capture = captureLogs();
      let r1;
      let r2;
      try {
        r1 = await postMessages(up.base, body);
        r2 = await postMessages(up.base, body);
        // 给实现里的日志落盘/去重留一点异步时间。
        await sleep(300);
      } finally {
        capture.stop();
      }
      const text = capture.text();
      const lines = text
        .split(/\n/)
        .filter((line) => line.includes(requested) && line.includes('deepseek/x'));

      c.equal('两次请求都成功', `${r1.status},${r2.status}`, '200,200');
      c.equal('同一组合的映射日志条数', lines.length, 1);
      if (lines.length > 0) {
        c.includes('日志同时含两个模型名', lines[0], requested);
        c.includes('日志同时含两个模型名(映射后)', lines[0], 'deepseek/x');
      }
      c.check('日志不含 OpenAI apiKey', !text.includes(OPENAI_KEY), text.includes(OPENAI_KEY) ? '发现 key 原文' : '未见 key', '不含 apiKey');
      c.check('日志不含 Anthropic authToken', !text.includes(ANTHROPIC_TOKEN), text.includes(ANTHROPIC_TOKEN) ? '发现 token 原文' : '未见 token', '不含 authToken');
      c.equal(
        '假上游两次都收到映射模型',
        up.fake.records.map((r) => r.json?.model).join(','),
        'deepseek/x,deepseek/x',
      );
    },
  },
};

export const CASE_IDS = Object.keys(CASES).map(Number).sort((a, b) => a - b);
