#!/usr/bin/env node
// r176:接口报错下方的动作 / 补充提示判据(client/src/utils/apiErrorActions.js)。
// 判据原样搬自 App.jsx 报错分支;本地副本与历史回合共用。白盒,直接 import 纯函数。
import assert from 'node:assert/strict';
import {
  deriveApiErrorUi, deriveHistoryApiErrorUi, hintsAsQuoteSuffix, isApiErrorTurn,
  shouldSkipLocalErrorBlock, ONE_M_HINT, LOGIN_HINT, SIGNATURE_HINT,
} from '../../client/src/utils/apiErrorActions.js';
import { OFFICIAL_LOGIN_HINT } from '../../client/src/utils/officialAuth.js';

let n = 0;
const t = (name, fn) => { fn(); n++; };

const AUTH = 'Failed to authenticate. API Error: 401 Authentication Fails, Your api key: ****0000 is invalid (request_id: x)';
const RISK = 'API Error: 400 Content Exists Risk';
const EMPTY = 'API Error: 400 messages.1.content.0.text: text content blocks must be non-empty';
const EMPTY_THINK = 'API Error: 400 each thinking block must contain non-whitespace thinking';

// ── 三种动作:正例 ──
t('鉴权文字 → provider', () => assert.equal(deriveApiErrorUi(AUTH).action, 'provider'));
t('unauthorized 文字 → provider', () => assert.equal(deriveApiErrorUi('API Error: Unauthorized').action, 'provider'));
t('结构化 401 → provider(文字不含鉴权字样)', () => assert.equal(deriveApiErrorUi('API Error: boom', { status: 401 }).action, 'provider'));
t('结构化 403 → provider', () => assert.equal(deriveApiErrorUi('API Error: boom', { status: 403 }).action, 'provider'));
t('结构化 authentication_failed → provider', () => assert.equal(deriveApiErrorUi('boom', { kind: 'authentication_failed' }).action, 'provider'));
t('内容审核 → content-risk', () => assert.equal(deriveApiErrorUi(RISK).action, 'content-risk'));
t('空 text 块 → repair-official', () => assert.equal(deriveApiErrorUi(EMPTY).action, 'repair-official'));
t('空 thinking 块 → repair-official', () => assert.equal(deriveApiErrorUi(EMPTY_THINK).action, 'repair-official'));

// ── 反例 ──
t('普通 500 → 无动作', () => assert.equal(deriveApiErrorUi('API Error: 500 overloaded').action, null));
t('结构化 400 unknown 不算鉴权', () => assert.equal(deriveApiErrorUi('API Error: 400 bad', { status: 400, kind: 'unknown' }).action, null));
t('空串 → 无动作无提示', () => assert.deepEqual(deriveApiErrorUi(''), { action: null, hints: [] }));

// ── 优先级:内容审核 > 鉴权 > 空内容块 ──
t('内容审核压过结构化 401', () => assert.equal(deriveApiErrorUi(RISK, { status: 401 }).action, 'content-risk'));
t('鉴权压过空内容块', () => assert.equal(deriveApiErrorUi('401 text content blocks must be non-empty').action, 'provider'));

// ── 三条补充提示 ──
t('1M 提示', () => assert.deepEqual(deriveApiErrorUi('API Error: 400 long context beta not available').hints, [ONE_M_HINT]));
t('$1m 金额不算 1M', () => assert.deepEqual(deriveApiErrorUi('budget $1m exceeded').hints, []));
t('官方未登录提示', () => {
  assert.deepEqual(deriveApiErrorUi('Not logged in · Please run /login').hints, [LOGIN_HINT]);
  assert.equal(LOGIN_HINT, `${OFFICIAL_LOGIN_HINT}。`);
});
t('签名提示', () => assert.deepEqual(deriveApiErrorUi('400 Invalid `signature` in `thinking` block').hints, [SIGNATURE_HINT]));
t('提示顺序 1M → 登录 → 签名', () => {
  const ui = deriveApiErrorUi('[1m] Not logged in invalid signature in thinking block');
  assert.deepEqual(ui.hints, [ONE_M_HINT, LOGIN_HINT, SIGNATURE_HINT]);
});
t('拼到 ❌ 块的后缀与改动前逐字相同', () => {
  assert.equal(hintsAsQuoteSuffix([ONE_M_HINT]),
    '\n\n> 该会话被识别为 1M 上下文；若账户不支持,请在模型弹层关闭 1M 后重试。');
  assert.equal(hintsAsQuoteSuffix([SIGNATURE_HINT]),
    '\n\n> 会话历史里有其他模型留下的思考内容，当前接口不接受。切回原来的 provider,在此会话执行 /compact 后再切回;或新开会话。');
  assert.equal(hintsAsQuoteSuffix([]), '');
});

// ── 历史回合 ──
const user = (uuid, text) => ({ type: 'user', uuid, text });
const turn = (uuid, text, extra = {}) => ({ type: 'turn', uuid, text: [text], model: 'deepseek-flash', ...extra });
// 后端带出的 apiError.text = 那条合成消息自己的原文(默认与回合正文相同)。
const errTurn = (uuid, text, apiError) => turn(uuid, text, {
  model: '<synthetic>', ...(apiError ? { apiError: { text, ...apiError } } : {}),
});
// 回合里先有正常正文、随后是接口报错(模型取正文那条的真模型)。
const mixedTurn = (uuid, bodyText, errText, apiError) => ({
  type: 'turn', uuid, model: 'deepseek-flash', text: [bodyText, errText],
  blocks: [{ type: 'text', content: bodyText }, { type: 'text', content: errText }],
  apiError: { text: errText, ...apiError },
});
const E500 = 'API Error: 500 Internal Server Error';
const M500 = { status: 500, kind: 'server_error' };

t('普通助手回合正文含 401 / api key 不派生', () => {
  assert.equal(isApiErrorTurn(turn('a', 'HTTP 401 means bad api key')), false);
  assert.equal(deriveHistoryApiErrorUi([user('u', 'q'), turn('a', 'HTTP 401 means bad api key')]), null);
});
t('最后一个回合带 apiError → 派生 provider', () => {
  const ui = deriveHistoryApiErrorUi([user('u', 'q'), errTurn('a', AUTH, { status: 401, kind: 'authentication_failed' })]);
  assert.equal(ui.action, 'provider');
  assert.equal(ui.uuid, 'a');
});
t('老文件无标记按 <synthetic> 兜底', () => {
  assert.equal(deriveHistoryApiErrorUi([user('u', 'q'), errTurn('a', RISK)]).action, 'content-risk');
});
t('结构化标记独自判鉴权', () => {
  assert.equal(deriveHistoryApiErrorUi([user('u', 'q'), errTurn('a', 'boom', { status: 401, kind: 'authentication_failed' })]).action, 'provider');
});
t('报错之后对话成功 → 不派生', () => {
  assert.equal(deriveHistoryApiErrorUi([user('u1', 'q'), errTurn('a1', AUTH, { status: 401 }), user('u2', '你好'), turn('a2', '好的')]), null);
});
t('报错之后有新的用户消息还没回复 → 不派生', () => {
  assert.equal(deriveHistoryApiErrorUi([user('u1', 'q'), errTurn('a1', AUTH, { status: 401 }), user('u2', '你好')]), null);
});
t('尾部的非回合条目(如任务通知)不挡派生', () => {
  assert.equal(deriveHistoryApiErrorUi([user('u', 'q'), errTurn('a', EMPTY, { status: 400, kind: 'unknown' }), { type: 'task-notice', uuid: 'n' }]).action, 'repair-official');
});
t('报错无动作也无提示 → null', () => {
  assert.equal(deriveHistoryApiErrorUi([user('u', 'q'), errTurn('a', 'API Error: 500 overloaded', { status: 500 })]), null);
});
t('只有 blocks 没有 text 的回合也能取到正文', () => {
  const m = { type: 'turn', uuid: 'a', model: '<synthetic>', blocks: [{ type: 'text', content: RISK }] };
  assert.equal(deriveHistoryApiErrorUi([m]).action, 'content-risk');
});
t('非数组输入 → null', () => assert.equal(deriveHistoryApiErrorUi(null), null));

// ── 判据只看报错原文,不看同回合前面的正常正文 ──
t('正文含 API key、随后 500 → 不派生', () => {
  assert.equal(deriveHistoryApiErrorUi([user('u', '帮我看下配置'),
    mixedTurn('t1', '我先读一下你的配置文件,里面的 API key 看起来没问题。', E500, M500)]), null);
});
t('正文含 must be non-empty、随后 500 → 不派生', () => {
  assert.equal(deriveHistoryApiErrorUi([user('u', 'q'),
    mixedTurn('t1', '日志里有一句 text content blocks must be non-empty。', E500, M500)]), null);
});
t('正文含 Content Exists Risk、随后 500 → 不派生', () => {
  assert.equal(deriveHistoryApiErrorUi([user('u', 'q'),
    mixedTurn('t1', '上次报的是 Content Exists Risk。', E500, M500)]), null);
});
t('正文在前、随后 401 → 仍派生 provider', () => {
  const ui = deriveHistoryApiErrorUi([user('u', 'q'),
    mixedTurn('t1', '我先读一下配置。', AUTH, { status: 401, kind: 'authentication_failed' })]);
  assert.equal(ui.action, 'provider');
});
t('标记里没带原文时不回落到整回合文字(只剩结构化标记)', () => {
  const m = { type: 'turn', uuid: 't1', model: 'x', text: ['正文提到 api key', E500], apiError: M500 };
  assert.equal(deriveHistoryApiErrorUi([user('u', 'q'), m]), null);
});
t('无标记的 <synthetic> 兜底只取最后一段文字', () => {
  const m = { type: 'turn', uuid: 't1', model: '<synthetic>', text: ['正文提到 api key', E500] };
  assert.equal(deriveHistoryApiErrorUi([user('u', 'q'), m]), null);
  const m2 = { type: 'turn', uuid: 't2', model: '<synthetic>', text: ['正文', RISK] };
  assert.equal(deriveHistoryApiErrorUi([user('u', 'q'), m2]).action, 'content-risk');
});

// ── 报错分支要不要省掉本地 ❌ 块(shouldSkipLocalErrorBlock) ──
const EXIT = 'Claude Code process exited with code 1';
t('出现过合成报错、正文包含这次报错原文 → 省', () => {
  assert.equal(shouldSkipLocalErrorBlock(`我先读一下配置。\n\n${AUTH}\n`, `  ${AUTH}  `, true), true);
});
t('出现过合成报错、这次报错原文不同 → 不省', () => {
  assert.equal(shouldSkipLocalErrorBlock(`我先读一下配置。\n\n${AUTH}`, EXIT, true), false);
  assert.equal(shouldSkipLocalErrorBlock(AUTH, EXIT, true), false);
});
t('没出现过合成报错、正文与报错原文完全相等 → 省', () => {
  assert.equal(shouldSkipLocalErrorBlock(`\n${AUTH}  `, ` ${AUTH}`, false), true);
});
t('没出现过合成报错、正文只是包含报错原文 → 不省', () => {
  assert.equal(shouldSkipLocalErrorBlock(`我先读一下配置。\n\n${AUTH}`, AUTH, false), false);
});
t('累积正文为空 → 不省', () => {
  assert.equal(shouldSkipLocalErrorBlock('', AUTH, true), false);
  assert.equal(shouldSkipLocalErrorBlock('   \n', AUTH, false), false);
  assert.equal(shouldSkipLocalErrorBlock(null, AUTH, true), false);
});
t('报错原文去空白后为空 → 不省', () => {
  assert.equal(shouldSkipLocalErrorBlock(AUTH, '   ', true), false);
  assert.equal(shouldSkipLocalErrorBlock(AUTH, '', false), false);
  assert.equal(shouldSkipLocalErrorBlock(AUTH, undefined, true), false);
});

console.log(`check-r176-api-error-ui: ${n} passed`);
