// r200-subagent-model-switch 套件的转写造数据工具:只按接口文件「数据形态」一节造记录,供假命令行(直播时落盘)与夹具(历史用例直接铺文件)共用。
// 不 import 产品代码。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ARROW = ' → ';
export const OPEN_VIEW_TITLE = '在子代理会话窗口打开';

/** 由用例标记派生出的固定 id(子代理 id、父会话里 Agent 调用的 id、描述文字)。 */
export function subIds(tag) {
  const hex = crypto.createHash('sha1').update(`r200-${tag}`).digest('hex');
  return {
    agentId: `a${hex.slice(0, 15)}`,
    toolUseId: `toolu_r200_${tag}`,
    description: `R200 子代理 ${tag}`,
    prompt: `请去做 R200 的事 ${tag}`,
  };
}

const iso = (offsetSec) => new Date(Date.now() - 900_000 + offsetSec * 1000).toISOString();
const uid = () => crypto.randomUUID();

const FILLER_TYPES = ['attachment', 'api-request-shape', 'api-request-blob', 'api-request'];

/**
 * 子代理转写的全部记录。
 *   models   每次 API 调用用的模型,按先后顺序(一项 = 一次调用 = 一条 assistant 记录)
 *   format   'new'(命令行 2.1.312 起:第一条 assistant 在第 17 条)| 'old'(2.1.311 及更早:第一条 assistant 在第 3 条)
 *   refuse   null | { at: 第几次调用被拦(0 起), category: 'bio' | undefined(= 没有类别) }
 *   synthetic  true = 在第一次调用之后插入一条 model 为 "<synthetic>" 的报错助手记录
 *   usage    每次调用的 { input_tokens, output_tokens }(不带缓存读写)
 */
export function buildSubagentRecords({ sid, agentId, cwd, tag, models, format = 'new', refuse = null, synthetic = false, usage = { input_tokens: 120, output_tokens: 34 } }) {
  const ids = subIds(tag);
  const base = { isSidechain: true, agentId, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.328', gitBranch: '' };
  const recs = [];
  let prev = null;
  let sec = 0;
  const push = (rec) => {
    const uuid = uid();
    recs.push({ ...base, parentUuid: prev, ...rec, uuid, timestamp: iso(sec += 1) });
    prev = uuid;
    return uuid;
  };
  push({ type: 'user', message: { role: 'user', content: ids.prompt } });
  const leading = format === 'new' ? 16 : 2;
  for (let i = recs.length; i < leading; i += 1) push({ type: FILLER_TYPES[i % FILLER_TYPES.length], note: `r200-filler-${i}` });

  const advisor = models[0];
  models.forEach((model, k) => {
    const last = k === models.length - 1;
    const refused = Boolean(refuse) && refuse.at === k;
    const msgId = `msg_r200_${tag}_${k}`;
    const toolId = `toolu_r200_${tag}_c${k}`;
    let content;
    let stop = 'end_turn';
    let details = null;
    if (refused) {
      content = [{ type: 'text', text: 'R200-PARTIAL' }];
      stop = 'refusal';
      details = { type: 'refusal', explanation: 'r200 fixture' };
      if (refuse.category !== undefined) details.category = refuse.category;
    } else if (last) {
      content = [{ type: 'text', text: `R200-SUB-DONE-${k}` }];
    } else {
      content = [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/dev/null' } }];
      stop = 'tool_use';
    }
    push({
      type: 'assistant',
      message: { id: msgId, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, stop_details: details, usage: { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      ...(format === 'new' ? { requestedModel: model, advisorModel: advisor } : {}),
      requestId: `req_${msgId}`,
    });
    if (refused) {
      push({
        type: 'user', isMeta: true, refusedMessageId: msgId,
        message: { role: 'user', content: 'Your response above was stopped by a safety classifier — this is not a tool or API error. Please continue with a different approach.' },
      });
    } else if (!last) {
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok', is_error: false }] } });
      if (format === 'new') push({ type: 'api-request', note: `r200-after-${k}` });
    }
    if (synthetic && k === 0) {
      push({
        type: 'assistant', isApiErrorMessage: true, error: 'unknown',
        message: { id: `msg_r200_${tag}_syn`, type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500 r200-synthetic' }], stop_reason: 'stop_sequence', stop_sequence: '', stop_details: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      });
    }
  });
  return recs;
}

/** 把子代理的 jsonl 与 meta.json 写到 <项目目录>/<父会话 id>/subagents/ 下。 */
export function writeSubagentFiles({ projectDir, sid, metaModel = 'opus', ...opts }) {
  const ids = subIds(opts.tag);
  const dir = path.join(projectDir, sid, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const recs = buildSubagentRecords({ sid, agentId: ids.agentId, ...opts });
  fs.writeFileSync(path.join(dir, `agent-${ids.agentId}.jsonl`), `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, `agent-${ids.agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: ids.description, toolUseId: ids.toolUseId, model: metaModel, spawnDepth: 1 }));
}

/** 主会话里「命令行原文」(接口文件第 6 条的例子)。category 为空时不带 Details 行。 */
export function fallbackContent(category) {
  const head = "Opus 5.5's safeguards flagged this session. You may be seeing this for the first time: Opus 5.5 is more capable and has stronger safeguards as a result, which can sometimes flag biology-research-adjacent work. We're improving these safeguards to reduce the amount of incorrectly flagged messages. Opus 5 is answering instead, or you can edit and retry with Opus 5.5. Send feedback with /feedback or learn more: https://support.claude.com/en/articles/8106465";
  return category ? `${head}\n\nDetails: \`[${category}]\`` : head;
}

/** 主会话落盘的换模型通知记录(接口文件数据形态第 6 条)。category 为 null = 没有类别。 */
export function mainFallbackRecord({ sid, cwd, parentUuid, refusedUserMessageUuid, category }) {
  return {
    type: 'system', subtype: 'model_refusal_fallback', content: fallbackContent(category), level: 'warning',
    trigger: 'refusal', direction: 'retry', scope: 'session',
    originalModel: 'claude-opus-5-5', fallbackModel: 'claude-opus-5', requestId: 'req_r200_fallback',
    apiRefusalCategory: category, apiRefusalExplanation: null, refusedUserMessageUuid,
    isMeta: false, uuid: uid(), timestamp: iso(40), parentUuid, isSidechain: false,
    userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.328', gitBranch: '',
  };
}
