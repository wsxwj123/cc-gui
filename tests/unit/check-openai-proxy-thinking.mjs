#!/usr/bin/env node
// R9 复现测试:openai-proxy 消息转换必须保留 thinking 块 → reasoning_content。
// 修 bug 前跑必须红(case a 断言 reasoning_content 存在必失败),修后必须绿。
// 纯 node:assert/strict,无框架,无网络请求。
import assert from 'node:assert/strict';

const m = await import('../../server/services/openai-proxy.js');

// 模块必须导出被测函数(开发阶段导出;未导出时报可读错误而非隐晦 import 失败)
if (typeof m.anthropicToOpenAIMessages !== 'function') {
  throw new Error(
    `module 未导出 anthropicToOpenAIMessages。现有导出:${Object.keys(m).join(', ')}`
  );
}
if (typeof m.upstreamNoVision !== 'function') {
  throw new Error(
    `module 未导出 upstreamNoVision。现有导出:${Object.keys(m).join(', ')}`
  );
}

const anthropicToOpenAIMessages = m.anthropicToOpenAIMessages;

let passed = 0;
const skipped = [];

function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    throw e;
  }
}

// ---- 用例 a(★修前必红的复现用例):单个 thinking + text 并存 ----
run('a assistant 单 thinking + text → reasoning_content 与 content 并存', () => {
  const out = anthropicToOpenAIMessages([
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '让我想想这个方案' },
        { type: 'text', text: '答案是 42' },
      ],
    },
  ]);
  const msg = out.find((x) => x.role === 'assistant');
  // 修前:thinking 块被静默丢弃,reasoning_content 不存在 → 此处断言必红
  assert.equal(
    msg.reasoning_content,
    '让我想想这个方案',
    'reasoning_content 必须等于 thinking 内容(修前缺失=复现 bug)'
  );
  assert.equal(msg.content, '答案是 42', 'content 只保留 text 块文本');
  assert.equal(msg.role, 'assistant', 'role 不变');
  // 关键契约 2:reasoning_content 与 content 并存,互不排斥
  assert.ok(msg.reasoning_content !== undefined && msg.content !== undefined, '两者并存');
});

// ---- 用例 b:多个 thinking 块拼接 ----
run('b assistant 多 thinking → reasoning_content 拼接全部', () => {
  const out = anthropicToOpenAIMessages([
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '第一步' },
        { type: 'thinking', thinking: '第二步' },
        { type: 'text', text: '结论' },
      ],
    },
  ]);
  const msg = out.find((x) => x.role === 'assistant');
  assert.equal(msg.reasoning_content, '第一步第二步', '多 thinking 按顺序拼接');
  assert.equal(msg.content, '结论', 'text 仍进 content');
});

// ---- 用例 c:thinking + tool_use 并存 ----
run('c assistant thinking + tool_use → reasoning_content 与 tool_calls 并存', () => {
  const out = anthropicToOpenAIMessages([
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '需要查文件' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: '/x' } },
      ],
    },
  ]);
  const msg = out.find((x) => x.role === 'assistant');
  assert.equal(msg.reasoning_content, '需要查文件', 'thinking 转 reasoning_content');
  assert.ok(Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1, 'tool_use 转 tool_calls');
  assert.equal(msg.tool_calls[0].id, 'toolu_1', 'tool_calls 保留原 id');
});

// ---- 用例 d(不回归):无 thinking → 不产生 reasoning_content 字段 ----
run('d assistant 无 thinking → 输出无 reasoning_content 字段', () => {
  const out = anthropicToOpenAIMessages([
    { role: 'assistant', content: [{ type: 'text', text: '普通回答' }] },
  ]);
  const msg = out.find((x) => x.role === 'assistant');
  assert.equal(msg.content, '普通回答');
  assert.ok(!('reasoning_content' in msg), '无 thinking 时不得产生多余 reasoning_content 字段');
});

// ---- 用例 e:user 图片 → image_url(有 vision 上游) ----
run('e user text+image → image_url 数据 URI', () => {
  const out = anthropicToOpenAIMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
        },
      ],
    },
  ]);
  const msg = out.find((x) => x.role === 'user');
  assert.equal(msg.role, 'user');
  const img = msg.content.find((c) => c.type === 'image_url');
  assert.ok(img, 'image 块必须转成 image_url 项');
  assert.ok(
    typeof img.image_url?.url === 'string' &&
      img.image_url.url.startsWith('data:image/png;base64,'),
    'image_url.url 应为 data URI 形态'
  );
});

// ---- 附加契约:system 参数转换(字符串 + 数组两种形态) ----
run('s1 system 字符串 → OpenAI system 消息', () => {
  const out = anthropicToOpenAIMessages([{ role: 'user', content: 'hi' }], 'You are helpful');
  assert.deepEqual(
    out.find((x) => x.role === 'system'),
    { role: 'system', content: 'You are helpful' }
  );
});
run('s2 system block 数组 → OpenAI system 消息', () => {
  const out = anthropicToOpenAIMessages(
    [{ role: 'user', content: 'hi' }],
    [{ type: 'text', text: 'Hi' }]
  );
  assert.deepEqual(
    out.find((x) => x.role === 'system'),
    { role: 'system', content: 'Hi' }
  );
});
run('s3 user content 为纯字符串 → 保持字符串', () => {
  const out = anthropicToOpenAIMessages([{ role: 'user', content: 'hello' }]);
  const msg = out.find((x) => x.role === 'user');
  assert.equal(msg.role, 'user');
  assert.equal(msg.content, 'hello');
});

// ---- 用例 f:upstreamNoVision() 判定 ----
// 该函数无参,依赖 proxy 持有的「当前上游 baseURL + 当前模型」状态。
// 黑盒方式:在模块导出里找 setter(含 upstream 关键字),存在则驱动场景;缺失则本组用例视为接口缺口而失败。
const setterNames = Object.keys(m).filter(
  (n) => /upstream/i.test(n) && /set|config|update|init|activate|use/i.test(n)
);

function trySetUpstream(baseURL, model) {
  // 试多种调用形态,适配不同 setter 签名;任一成功即视为可驱动
  const shapes = [
    (fn) => fn({ baseURL, model }),
    (fn) => fn(baseURL, model),
  ];
  for (const n of setterNames) {
    const fn = m[n];
    if (typeof fn !== 'function') continue;
    for (const call of shapes) {
      try {
        const r = call(fn);
        if (r && typeof r.then === 'function') {
          // 异步 setter:await 内层在 run 里同步无法支持,标记跳过
          return { ok: false, reason: `setter ${n} 是异步的,本组同步用例无法驱动` };
        }
        return { ok: true };
      } catch {
        // 该 setter 不接受此调用形态,换下一种
      }
    }
  }
  return { ok: false, reason: `未找到可用的 upstream 状态 setter(现有导出含 upstream 关键字者:${setterNames.join(', ') || '无'})` };
}

if (setterNames.length === 0) {
  console.error(
    '\n!! upstreamNoVision 用例被阻断:module 未导出任何可设置「当前上游」状态的函数(含 upstream 关键字:无)。\n' +
      '!! 这是接口缺口:upstreamNoVision() 无参、状态在模块内部,测试无法驱动。\n' +
      '!! 需开发导出一个测试钩子(如 setUpstreamForTest({baseURL, model}) 或同名 setter)。'
  );
  process.exit(1);
}

const scopes = [
  {
    name: 'f1 deepseek 上游 → 无 vision(true)',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    expect: true,
  },
  {
    name: 'f2 opencode 上游 + deepseek 系模型 → 无 vision(true,★修复目标,修前=false)',
    baseURL: 'http://127.0.0.1:8798/opencode',
    model: 'deepseek-v4-flash',
    expect: true,
  },
  {
    name: 'f3 普通上游(openai) → 有 vision(false)',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    expect: false,
  },
];

for (const { name, baseURL, model, expect } of scopes) {
  const r = trySetUpstream(baseURL, model);
  if (!r.ok) {
    skipped.push(`${name}(原因:${r.reason})`);
    continue;
  }
  run(name, () => {
    const got = m.upstreamNoVision();
    assert.equal(got, expect, `upstreamNoVision() 应为 ${expect},实际 ${got}`);
  });
}

// ---- 汇总 ----
console.log(`\n✓ check-openai-proxy-thinking: ${passed} 用例通过`);
if (skipped.length) {
  console.warn(`!! 跳过 ${skipped.length} 个 upstreamNoVision 用例(接口缺口):\n    - ${skipped.join('\n    - ')}`);
  process.exit(1);
}
