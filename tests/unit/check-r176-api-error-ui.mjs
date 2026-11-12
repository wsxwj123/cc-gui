#!/usr/bin/env node
// r176:接口报错下方的动作 / 补充提示判据(client/src/utils/apiErrorActions.js)。
// 判据原样搬自 App.jsx 报错分支;本地副本与历史回合共用。白盒,直接 import 纯函数。
import assert from 'node:assert/strict';
import {
  deriveApiErrorUi, deriveHistoryApiErrorUi, hintsAsQuoteSuffix, isApiErrorTurn,
  ONE_M_HINT, LOGIN_HINT, SIGNATURE_HINT,
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
const errTurn = (uuid, text, apiError) => turn(uuid, text, { model: '<synthetic>', ...(apiError ? { apiError } : {}) });

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

console.log(`check-r176-api-error-ui: ${n} passed`);
