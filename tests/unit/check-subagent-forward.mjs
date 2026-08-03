#!/usr/bin/env node
// 批M M1:子代理正文转发 + 进度摘要。
// 症状:监控面板里的子代理只有工具名、没有正文/思考,长任务也看不出"正在做什么"。
// 根因:SDK 默认只转发子代理的 tool_use/tool_result(够做心跳计数),text/thinking 要
// forwardSubagentText 才发;进度摘要要 agentProgressSummaries 才发(落 task_progress.summary)。
// 客户端分流通路本来就在(assistant 事件按 parent_tool_use_id 进 activeAgents 后 continue),
// 所以服务端两个开关 + 放宽 task_progress 守卫即可,不需要新渲染路径。
// node tests/unit/check-subagent-forward.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chat = readFileSync(join(root, 'server/routes/chat.js'), 'utf8');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');

// ── 1. 服务端:两个开关必须落在真正传给 query() 的 options 对象里 ──────────
{
  const i = chat.indexOf('const options = {');
  assert.ok(i > 0, 'chat.js 必须仍有 SDK options 字面量');
  // options 字面量到 query({ prompt, options }) 之间即是它的构造区间(其后是条件性附加项)。
  const seg = chat.slice(i, chat.indexOf('q = query({', i));
  assert.ok(seg.length > 0 && seg.length < 8000, 'options 构造区间定位失败,断言会失真');
  assert.ok(/forwardSubagentText:\s*true/.test(seg),
    'options 必须开 forwardSubagentText,否则子代理的 text/thinking 根本不发到客户端');
  assert.ok(/agentProgressSummaries:\s*true/.test(seg),
    'options 必须开 agentProgressSummaries,否则 task_progress 不带 summary(子代理无进度描述)');
  // 两个开关都是布尔常量、对所有请求一致 —— 不得混进兼容键(会让常驻 MCP 进程无谓重开)。
  const compatKeyIdx = chat.indexOf('chatCompatKey');
  if (compatKeyIdx > 0) {
    const keySeg = chat.slice(compatKeyIdx, compatKeyIdx + 2000);
    assert.ok(!/forwardSubagentText|agentProgressSummaries/.test(keySeg),
      '恒定常量不得进兼容键');
  }
}

// ── 2. 客户端:task_progress 守卫放宽,summary 优先 ────────────────────────
{
  const i = app.indexOf("subtype === 'task_progress'");
  assert.ok(i > 0, 'App.jsx 必须仍有 task_progress 分支');
  const seg = app.slice(i, i + 500);
  assert.ok(/event\.summary \|\| event\.description/.test(seg),
    'task_progress 必须优先取 summary(现在时的进度摘要),description 是静态派发描述');
  assert.ok(!/activeAgents\[event\.tool_use_id\]\?\.workflow/.test(seg),
    '守卫必须放宽:原来只更新 workflow 条目,普通子代理的 summary 被整条丢弃');
  assert.ok(/_st\.activeAgents\[event\.tool_use_id\]/.test(seg),
    '仍需条目存在性守卫:不得凭空 upsert 出一张没有来源的子代理卡');
}

// ── 3. 主消息流零污染:带 parent_tool_use_id 的 assistant 必须分流后 continue ──
// 开了 forwardSubagentText 之后子代理正文会大量到达,这条 continue 是"不进主气泡、
// 不打穿 MessageList memo"的唯一保障 —— 掉了就是满屏串话。
{
  const i = app.indexOf("if (event.type === 'assistant' && event.message?.content)");
  assert.ok(i > 0, 'App.jsx 必须仍有 assistant 快照分支');
  const seg = app.slice(i, i + 3000);
  const p = seg.indexOf('if (event.parent_tool_use_id)');
  assert.ok(p > 0, '必须仍按 parent_tool_use_id 分流子代理整条消息');
  const branch = seg.slice(p, p + 2200);
  assert.ok(/appendAgentText/.test(branch) && /appendAgentThinking/.test(branch),
    '子代理分支必须把 text/thinking 追加进 activeAgents(否则开了转发也没地方显示)');
  assert.ok(/\n\s*continue;\n/.test(branch),
    '子代理分支末尾必须 continue —— 否则子代理正文会继续落进主消息流');
}

// ── 4. 批M M2:自动拒绝(system/permission_denied)渲染成一行系统提示 ──────
// 服务端不需要改(消息泵 deliverLine 原样透传所有 system 事件),客户端此前零处理:
// auto 档分类器拒 / deny 规则 / dontAsk 档拒 / 后台代理自动判定四条路径都不弹卡片,
// 界面上只剩一条 is_error 的 tool_result,看不到拒绝原因。
{
  const i = app.indexOf("subtype === 'permission_denied'");
  assert.ok(i > 0, "App.jsx 必须处理 system/permission_denied");
  const seg = app.slice(i, i + 900);
  assert.ok(/type: 'denial'/.test(seg), '拒绝提示必须作为独立条目类型进 chatMessages');
  assert.ok(/event\.tool_use_id/.test(seg) && /some\(\(m\) => m\.uuid === dUuid\)/.test(seg),
    '必须按 tool_use_id 去重(同一次调用只渲染一行)');
  assert.ok(/ownerKey: streamOwnerSid\(\)/.test(seg),
    '必须带流归属 ownerKey,否则拒绝提示会串到别的会话(visibleChat 按 ownerKey 门控)');
  assert.ok(/event\.message \|\| event\.decision_reason/.test(seg),
    '原因文本取 message(给模型的人话拒绝语),缺失时回落 decision_reason');
  // 两个渲染点必须对称(历史列表 memo 组件 + 流式列表),漏一处就是"有数据不显示"。
  assert.equal(app.split("msg.type === 'denial'").length - 1, 2,
    "denial 分支必须在 MessageList 与流式列表两处都有(与 goal/compact 同款对称)");
  assert.ok(/function DenialNotice/.test(app), '必须有独立的拒绝提示组件');
}

console.log('check-subagent-forward: all assertions passed');
