// B1-B10:授权写入口加固 —— 面板凭证、禁止类别、输入校验、启动清理、WS 凭证帧、CORS 预检(HTTP / WebSocket 面)。
// 全程跑在假家目录里的隔离实例上(见 helpers/world.mjs),授权文件是套件自己的,不碰真实 ~/.claude-gui。
// 取不到凭证(修前这条帧不存在)时,用例用"具体断言失败"报告,而不是超时或抛错。
import { test, expect } from '@playwright/test';
import {
  ID, makeWorld, startServer, stopInstance, httpRequest, postGrants, getGrants, getStatus, postDoctor,
  grantedIds, screenScopeGranted, getToken, expectValidToken, openWs, tokenFrames,
} from './helpers/world.mjs';

const FORBIDDEN_IDS = [
  'com.apple.Terminal', 'COM.APPLE.TERMINAL', 'com.claudegui.desktop', 'com.claudegui.desktop.ds', 'COM.CLAUDEGUI.DESKTOP.DS',
  'com.googlecode.iterm2', 'com.apple.systempreferences', 'com.apple.ScriptEditor2',
  'com.apple.keychainaccess', 'com.1password.1password',
];

let world;
let server;
test.beforeAll(async () => {
  world = makeWorld('http');
  server = await startServer(world, { label: 'http' });
});
test.afterAll(async () => { await stopInstance(server); });
test.beforeEach(() => { world.setGrants({}); }); // 每条用例从空授权开始,互不依赖

test('B1 无凭证 / 错误凭证 / 同名头重复发送的授权请求 → 403 CU_GRANT_FORBIDDEN,授权列表与授权文件都不变', async () => {
  const before = world.rawGrants();
  const token = await getToken(server.base);
  expectValidToken(token, { soft: true });
  const attempts = [
    ['不带请求头', { bundleId: ID.textedit, granted: true }, undefined],
    ['不带请求头且 granted 缺省(缺省按授权处理)', { bundleId: ID.textedit }, undefined],
    ['错误的凭证值', { bundleId: ID.textedit, granted: true }, `wrong-${'x'.repeat(48)}`],
  ];
  if (typeof token === 'string') {
    attempts.push(['同名头重复发两次(正确值×2)', { bundleId: ID.textedit, granted: true }, [token, token]]);
    attempts.push(['同名头重复发两次(错误值+正确值)', { bundleId: ID.textedit, granted: true }, ['wrong-token', token]]);
  }
  for (const [name, body, header] of attempts) {
    const r = await postGrants(server.base, body, header);
    expect.soft(r.status, `${name}:HTTP 状态应为 403,实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(403);
    expect.soft(r.json?.code, `${name}:code`).toBe('CU_GRANT_FORBIDDEN');
    expect.soft(r.json?.ok, `${name}:ok 应为 false`).toBe(false);
    expect.soft(world.rawGrants(), `${name}:授权文件应零变化`).toBe(before);
    expect.soft(await grantedIds(server.base), `${name}:随后 GET 的应用列表不应含 TextEdit`).not.toContain(ID.textedit);
  }
});

test('B2 带正确凭证(取自 WS 握手后的 cu:grant-token 帧)的授权请求 → 200,GET 的应用列表含 TextEdit', async () => {
  const token = await getToken(server.base);
  expectValidToken(token);
  const r = await postGrants(server.base, { bundleId: ID.textedit, granted: true }, token);
  expect(r.status, `HTTP 状态,响应 ${r.text.slice(0, 160)}`).toBe(200);
  expect(r.json?.ok, '响应 ok').toBe(true);
  expect(Array.isArray(r.json?.apps), '响应形状不变:有 apps 数组').toBe(true);
  expect(r.json, '响应形状不变:有 screenScope 字段').toHaveProperty('screenScope');
  expect(await grantedIds(server.base), '随后 GET 的应用列表应含 TextEdit').toContain(ID.textedit);
  const dflt = await postGrants(server.base, { bundleId: ID.notes }, token); // granted 缺省 = 授权
  expect(dflt.status, `granted 缺省按授权处理,响应 ${dflt.text.slice(0, 160)}`).toBe(200);
  expect(await grantedIds(server.base)).toContain(ID.notes);
  // 契约:凭证正确的合法授权 → 200,apps 为"有效授权"(文件里另有旧的终端条目时,响应里不该出现它)
  world.setGrants({ apps: [ID.terminal, ID.notes] });
  const eff = await postGrants(server.base, { bundleId: ID.textedit, granted: true }, token);
  expect.soft(eff.status, `文件里另有旧终端条目时,带凭证的合法授权应为 200,响应 ${eff.text.slice(0, 160)}`).toBe(200);
  const effIds = (eff.json?.apps || []).map((a) => String(typeof a === 'string' ? a : a?.bundleId).toLowerCase());
  expect.soft(effIds, '响应里的 apps 应是有效授权:含 TextEdit 与 Notes').toEqual(expect.arrayContaining(['com.apple.textedit', 'com.apple.notes']));
  expect.soft(effIds, '响应里的 apps 应是有效授权:不含旧的终端条目').not.toContain('com.apple.terminal');
});

test('B3 主屏范围开关:无凭证 → 403 且 screenScope 仍为 false;带凭证 → 200 且为 true', async () => {
  const noToken = await postGrants(server.base, { screenScope: true });
  expect.soft(noToken.status, `无凭证 HTTP 状态应为 403,实际 ${noToken.status}`).toBe(403);
  expect.soft(noToken.json?.code, '无凭证 code').toBe('CU_GRANT_FORBIDDEN');
  expect.soft(await screenScopeGranted(server.base), '无凭证被拒后 screenScope.granted 应仍为 false').toBe(false);
  world.setGrants({}); // 复位:别让"修前无凭证也成功"的副作用污染下半段
  const token = await getToken(server.base);
  expectValidToken(token);
  const withToken = await postGrants(server.base, { screenScope: true }, token);
  expect(withToken.status, `带凭证 HTTP 状态,响应 ${withToken.text.slice(0, 160)}`).toBe(200);
  expect(await screenScopeGranted(server.base), '带凭证后 screenScope.granted 应为 true').toBe(true);
});

test('B4 纯撤销不需要凭证:撤销 TextEdit → 200 且从列表消失;{screenScope:false} → 200 且为 false;两者都撤销的请求体同样 200', async () => {
  world.setGrants({ apps: [ID.textedit], screenScope: true });
  const a = await postGrants(server.base, { bundleId: ID.textedit, granted: false });
  expect(a.status, `撤销应用的 HTTP 状态,响应 ${a.text.slice(0, 160)}`).toBe(200);
  expect(a.json?.ok, '撤销应用 ok').toBe(true);
  expect(Array.isArray(a.json?.apps), '响应形状不变:有 apps 数组').toBe(true);
  expect(await grantedIds(server.base), '撤销后 TextEdit 应从列表消失').not.toContain(ID.textedit);
  const b = await postGrants(server.base, { screenScope: false });
  expect(b.status, `撤销主屏范围的 HTTP 状态,响应 ${b.text.slice(0, 160)}`).toBe(200);
  expect(b.json?.ok, '撤销主屏范围 ok').toBe(true);
  expect(await screenScopeGranted(server.base), '撤销后 screenScope.granted 应为 false').toBe(false);
  world.setGrants({ apps: [ID.textedit], screenScope: true });
  const c = await postGrants(server.base, { bundleId: ID.textedit, granted: false, screenScope: false }); // 术语:两者都是撤销,仍是纯撤销
  expect(c.status, `两者都是撤销的请求体应为 200,响应 ${c.text.slice(0, 160)}`).toBe(200);
  expect(await grantedIds(server.base), '两者都撤销后 TextEdit 应从列表消失').not.toContain(ID.textedit);
  expect(await screenScopeGranted(server.base), '两者都撤销后 screenScope.granted 应为 false').toBe(false);
});

test('B5 无凭证的混合体(撤销 TextEdit + 开主屏)→ 403,TextEdit 仍在、screenScope 仍为 false(零副作用)', async () => {
  world.setGrants({ apps: [ID.textedit], screenScope: false });
  const before = world.rawGrants();
  const r = await postGrants(server.base, { bundleId: ID.textedit, granted: false, screenScope: true });
  expect.soft(r.status, `HTTP 状态应为 403,实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(403);
  expect.soft(r.json?.code, 'code').toBe('CU_GRANT_FORBIDDEN');
  expect.soft(world.rawGrants(), '授权文件应零变化(含混合体里的撤销部分)').toBe(before);
  expect.soft(await grantedIds(server.base), 'TextEdit 应仍在授权列表里').toContain(ID.textedit);
  expect.soft(await screenScopeGranted(server.base), 'screenScope 应仍为 false').toBe(false);
});

test('B6 带凭证授权禁止类别 → 403 CU_APP_FORBIDDEN(error 含"禁止");混合体整体拒绝;无凭证时仍是 CU_GRANT_FORBIDDEN', async () => {
  const token = await getToken(server.base);
  expectValidToken(token);
  const before = world.rawGrants();
  for (const id of FORBIDDEN_IDS) {
    const r = await postGrants(server.base, { bundleId: id, granted: true }, token);
    expect.soft(r.status, `${id}:HTTP 状态应为 403,实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(403);
    expect.soft(r.json?.code, `${id}:code`).toBe('CU_APP_FORBIDDEN');
    expect.soft(String(r.json?.error ?? ''), `${id}:error 文本应含"禁止"`).toContain('禁止');
    expect.soft(world.rawGrants(), `${id}:授权文件应零变化`).toBe(before);
  }
  const mixed = await postGrants(server.base, { bundleId: ID.terminal, granted: true, screenScope: true }, token);
  expect.soft(mixed.status, '带凭证的混合体 HTTP 状态应为 403').toBe(403);
  expect.soft(mixed.json?.code, '带凭证的混合体 code').toBe('CU_APP_FORBIDDEN');
  expect.soft(await screenScopeGranted(server.base), '混合体被拒后 screenScope 不得改变').toBe(false);
  const noTok = await postGrants(server.base, { bundleId: ID.terminal, granted: true });
  expect.soft(noTok.status, '无凭证 + 禁止应用:HTTP 状态应为 403').toBe(403);
  expect.soft(noTok.json?.code, '没有凭证时,即使目标是禁止应用,返回的也应是 CU_GRANT_FORBIDDEN').toBe('CU_GRANT_FORBIDDEN');
  expect.soft(await grantedIds(server.base), '以上请求之后授权列表仍应为空').toEqual([]);
  expect.soft(world.rawGrants(), '以上请求之后授权文件零变化').toBe(before);
  world.setGrants({ apps: [ID.terminal] }); // 旧数据:文件里已有终端
  const legacyBefore = world.rawGrants();
  const again = await postGrants(server.base, { bundleId: ID.terminal, granted: true }, token);
  expect.soft(again.status, '对已存在的旧条目重复授权:HTTP 状态应为 403').toBe(403);
  expect.soft(again.json?.code, '对已存在的旧条目重复授权:code').toBe('CU_APP_FORBIDDEN');
  expect.soft(world.rawGrants(), '对已存在的旧条目重复授权:授权文件零变化').toBe(legacyBefore);
});

test('B7 参数校验先于凭证检查:非法入参(不带凭证)一律 400 CU_INVALID_ARGUMENT;多余字段被忽略', async () => {
  const bad = [
    ['空对象 {}', {}],
    ['bundleId 是数字 123', { bundleId: 123 }],
    ['bundleId 含逗号 "a,b"', { bundleId: 'a,b' }],
    ['bundleId 含换行', { bundleId: 'com.apple.Text\nEdit' }],
    ['bundleId 含零宽空格 U+200B', { bundleId: 'com.apple.Text\u200bEdit' }],
    ['bundleId 含零宽连接符 U+200D', { bundleId: 'com.apple.Text\u200dEdit' }],
    ['bundleId 含零宽不换行空格 U+FEFF', { bundleId: 'com.apple.Text\ufeffEdit' }],
    ['bundleId 含制表符(控制符)', { bundleId: 'com.apple.Text\tEdit' }],
    ['bundleId 为空串', { bundleId: '' }],
    ['bundleId 超过 200 字符(201)', { bundleId: `com.${'a'.repeat(197)}` }],
    ['bundleId 含空格(字符集外)', { bundleId: 'com.apple. TextEdit' }],
    ['bundleId 含斜杠(字符集外)', { bundleId: 'com/apple' }],
    ['bundleId 含非 ASCII 字符(字符集外)', { bundleId: 'com.苹果.文本' }],
    ['granted 不是布尔', { bundleId: ID.textedit, granted: 'yes' }],
    ['screenScope 不是布尔', { screenScope: 'true' }],
  ];
  const before = world.rawGrants();
  for (const [name, body] of bad) {
    const r = await postGrants(server.base, body);
    expect.soft(r.status, `${name}:HTTP 状态应为 400(先于凭证检查),实际 ${r.status} ${r.text.slice(0, 100)}`).toBe(400);
    expect.soft(r.json?.code, `${name}:code`).toBe('CU_INVALID_ARGUMENT');
    expect.soft(r.json?.ok, `${name}:ok 应为 false`).toBe(false);
    expect.soft(typeof r.json?.error === 'string' && r.json.error.length > 0, `${name}:要给出人读的 error 文本`).toBe(true);
  }
  expect.soft(world.rawGrants(), '非法入参不得改动授权文件').toBe(before);
  const token = await getToken(server.base);
  if (expectValidToken(token, { soft: true })) {
    const r = await postGrants(server.base, { bundleId: ID.textedit, granted: true, foo: 1, nested: { a: [1, 2] } }, token);
    expect.soft(r.status, `多带未知字段的合法带凭证授权应为 200,实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(200);
    expect.soft(await grantedIds(server.base), '多余字段被忽略,授权照常生效').toContain(ID.textedit);
    const edge = `com.${'a'.repeat(196)}`; // 恰好 200 字符:长度上限内的合法 id,不该被当成"超过 200"
    const e = await postGrants(server.base, { bundleId: edge, granted: true }, token);
    expect.soft(e.status, `恰好 200 字符的合法 bundleId 带凭证授权应为 200,实际 ${e.status} ${e.text.slice(0, 120)}`).toBe(200);
    expect.soft(await grantedIds(server.base), '恰好 200 字符的 bundleId 应已授权').toContain(edge);
  }
});

test('B8a 授权文件里预置 Terminal(旧版数据)→ 服务启动后条目已被移除,服务日志有一行提到它', async () => {
  const w = makeWorld('b8a');
  w.setGrants({ apps: [ID.terminal, ID.textedit] });
  const s = await startServer(w, { label: 'b8a' });
  try {
    await expect.poll(() => w.fileAppIds().map((x) => x.toLowerCase()).includes('com.apple.terminal'), {
      timeout: 6000, message: '启动后授权文件里不应再有 com.apple.Terminal',
    }).toBe(false);
    expect(w.fileAppIds(), '普通应用 TextEdit 不应被误删').toContain(ID.textedit);
    const lines = s.readLog().split('\n').filter((l) => l.toLowerCase().includes('com.apple.terminal'));
    expect(lines.length, `服务日志里应有一行提到被移除的 ${ID.terminal};日志尾部:${s.readLog().slice(-300)}`).toBeGreaterThanOrEqual(1);
  } finally {
    await stopInstance(s);
  }
});

test('B8b 服务启动后文件里才出现 Terminal:不带凭证的纯撤销 → 200,且该条目从授权文件里被移除', async () => {
  world.setGrants({ apps: [ID.terminal, ID.textedit] }); // 启动之后写入,不经启动清理
  const r = await postGrants(server.base, { bundleId: ID.terminal, granted: false });
  expect(r.status, `HTTP 状态,响应 ${r.text.slice(0, 160)}`).toBe(200);
  expect(r.json?.ok, 'ok').toBe(true);
  expect(world.fileAppIds().map((x) => x.toLowerCase()), '授权文件里不应再有 Terminal').not.toContain('com.apple.terminal');
  expect(world.fileAppIds(), 'TextEdit 不受影响').toContain(ID.textedit);
});

test('B9 两个 WS 连接各收到一条同值的 cu:grant-token(≥32 位);外来 Origin 被拒且收不到;凭证不出现在响应体与服务日志', async () => {
  const [a, b] = await Promise.all([openWs(server.base, { lingerMs: 500 }), openWs(server.base, { lingerMs: 500 })]);
  const fa = tokenFrames(a);
  const fb = tokenFrames(b);
  expect.soft(fa.length, '连接 A 应恰好收到 1 条 cu:grant-token 帧').toBe(1);
  expect.soft(fb.length, '连接 B 应恰好收到 1 条 cu:grant-token 帧').toBe(1);
  const ta = fa[0]?.json?.token;
  const tb = fb[0]?.json?.token;
  expectValidToken(ta, { soft: true, who: '连接 A:' });
  expectValidToken(tb, { soft: true, who: '连接 B:' });
  expect.soft(ta, '同一服务实例上两个连接的凭证值应相同').toBe(tb);
  const evil = await openWs(server.base, { origin: 'http://evil.example', waitMs: 2000 });
  expect.soft(evil.opened, `外来 Origin 的握手应被拒绝(实际 opened=${evil.opened} status=${evil.status} close=${evil.closeCode} err=${evil.error})`).toBe(false);
  expect.soft(tokenFrames(evil).length, '外来 Origin 不应收到 cu:grant-token 帧').toBe(0);
  if (typeof ta === 'string' && ta.length >= 32) {
    const views = [['GET /grants', await getGrants(server.base)], ['GET /status', await getStatus(server.base)], ['POST /doctor', await postDoctor(server.base)]];
    for (const [name, r] of views) expect.soft(r.text.includes(ta), `${name} 的响应体不应含凭证值`).toBe(false);
    await postGrants(server.base, { bundleId: ID.textedit, granted: true }, ta);        // 带凭证的合法授权(走完整成功路径)
    await postGrants(server.base, { bundleId: ID.terminal, granted: true }, ta);        // 带凭证但被拒(禁止类别)
    await postGrants(server.base, { bundleId: ID.textedit, granted: true }, `wrong-${'y'.repeat(40)}`); // 错误凭证被拒
    expect.soft(server.readLog().includes(ta), '服务日志(含上面三类请求之后)不应含凭证值').toBe(false);
  }
});

test('B10 对 /api/computer-use/grants 的 OPTIONS 预检(外来 Origin)→ 响应里没有任何 access-control-allow-* 头', async () => {
  const r = await httpRequest(server.base, {
    method: 'OPTIONS', pathname: '/api/computer-use/grants',
    headers: {
      Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'x-cgui-grant-token,content-type',
    },
  });
  const allow = Object.entries(r.headers).filter(([h]) => h.toLowerCase().startsWith('access-control-allow-'));
  expect(allow, `不应有任何 access-control-allow-* 头(HTTP ${r.status}),实际 ${JSON.stringify(allow)}`).toEqual([]);
});
