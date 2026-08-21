#!/usr/bin/env node
// 单测:r11-⑫ 自定义称呼 —— 问候组装矩阵(有/无称呼 × 时段 × 皮肤模板)+
// 服务端 prefs 端点/WS 收敛/设置入口/Home 渲染接线守卫。
// 变异哨兵(实际验证过红):homeGreetingParts 删 {name} 替换(占位符原样输出)→ t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homeGreeting, homeGreetingParts } from '../../client/src/utils/home.js';

const text = (parts) => parts.map((p) => p.text).join('');

// t1 组装矩阵
{
  // 无皮肤模板 × 无称呼:现状文案(时段×3)
  assert.equal(homeGreeting(9, null, ''), '早上好，从这里开始', 't1: 上午无称呼现状文案');
  assert.equal(homeGreeting(14, null, null), '下午好，从这里开始', 't1: 下午无称呼');
  assert.equal(homeGreeting(23, null, undefined), '晚上好，从这里开始', 't1: 夜间无称呼');
  // 无皮肤模板 × 有称呼:「{时段词}，{称呼}」,称呼独立成段(name:true → accent 渲染)
  const p1 = homeGreetingParts(14, null, '小明');
  assert.equal(text(p1), '下午好，小明', 't1: 下午+称呼');
  assert.deepEqual(p1, [{ text: '下午好，' }, { text: '小明', name: true }], 't1: 称呼独立成段');
  assert.equal(homeGreeting(6, null, '  阿追  '), '早上好，阿追', 't1: 称呼去空白');
  assert.equal(homeGreeting(9, null, 'x'.repeat(30)), `早上好，${'x'.repeat(20)}`, 't1: 称呼截 20');
  // 皮肤模板无占位符:整段原样(有无称呼一致)
  assert.equal(homeGreeting(9, '欢迎回来', '小明'), '欢迎回来', 't1: 模板无占位符原样');
  // 皮肤模板 {name} × 有称呼:替换,且称呼段标 name:true
  const p2 = homeGreetingParts(9, '你好，{name}，出发吧', '小明');
  assert.equal(text(p2), '你好，小明，出发吧', 't1: 模板占位符替换');
  assert.deepEqual(p2.filter((p) => p.name), [{ text: '小明', name: true }], 't1: 模板中称呼段可着色');
  const pMulti = homeGreetingParts(9, '{name}早{name}', '喵');
  assert.equal(text(pMulti), '喵早喵', 't1: 多占位符全部替换');
  // 皮肤模板 {name} × 无称呼:占位符整段优雅降级(连同紧邻分隔符,不留孤立标点)
  assert.equal(homeGreeting(14, '下午好，{name}', ''), '下午好', 't1: 尾部占位符降级不留逗号');
  assert.equal(homeGreeting(14, '{name}，欢迎回来', ''), '欢迎回来', 't1: 头部占位符降级');
  assert.equal(homeGreeting(14, 'A，{name}，B', ''), 'A，B', 't1: 中部占位符降级保留单侧分隔');
  assert.equal(homeGreeting(14, '{name}', ''), '下午好，从这里开始', 't1: 模板降级为空回落内置默认');
  // 两口径恒一致
  assert.equal(homeGreeting(14, '你好，{name}', '喵'), text(homeGreetingParts(14, '你好，{name}', '喵')), 't1: 纯文本=分段拼接');
}

// t2 接线守卫:服务端端点/WS/store/设置入口/Home 渲染
{
  const prefs = readFileSync(new URL('../../server/routes/prefs.js', import.meta.url), 'utf8');
  assert.match(prefs, /router\.get\('\/prefs\/display-name'/, 't2: GET 端点');
  assert.match(prefs, /router\.put\('\/prefs\/display-name'/, 't2: PUT 端点');
  // r26 换锚说明(r26-pkg6 交办):本行原锚 `/displayName\.trim\(\)\.slice\(0, 20\)/` 钉的是
  // D12 修复前的旧写法(UTF-16 码元截断,会把 emoji 代理对从中间劈开)。r26-D12 服务端半
  // (PKG-5)已把 prefs.js 改为码点截断 `[...displayName.trim()].slice(0, 20).join('')`,
  // 旧锚恒红。此处只换匹配形态,正则语义(钉住「去空白 + 截 20」这道服务端闸)与断言目的不变。
  assert.match(prefs, /\[\.\.\.displayName\.trim\(\)\]\.slice\(0, 20\)\.join\(''\)/, 't2: 服务端去空白按码点截 20(r26-D12)');
  assert.match(prefs, /broadcast\(\{ type: 'display-name', displayName: name \}\)/, 't2: WS 广播');
  assert.match(prefs, /else delete prefs\.displayName/, 't2: 空串=清除键(prefs 不留空值)');

  const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
  for (const k of ['hydrateDisplayName', 'applyRemoteDisplayName', 'putDisplayName']) {
    assert.ok(store.includes(k), `t2: store ${k}`);
  }

  const ws = readFileSync(new URL('../../client/src/hooks/useWebSocket.js', import.meta.url), 'utf8');
  assert.match(ws, /case 'display-name':/, 't2: WS case 收敛');

  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /hydrateDisplayName\(\)/, 't2: 启动/重连水合');
  assert.match(app, /homeGreetingParts\(new Date\(\)\.getHours\(\), custom\?\.greeting, displayName\)/, 't2: Home 问候接称呼+皮肤模板');
  assert.match(app, /from-accent to-accent-hover bg-clip-text/, 't2: 称呼段用主题 accent token 渐变(不硬编码色值)');

  const sp = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(sp, /id="set-display-name"/, 't2: 设置→通用 入口');
  assert.match(sp, /maxLength=\{20\}/, 't2: 输入框 20 字符上限');
  assert.match(sp, /id: 'set-display-name', tab: 'general'/, 't2: 设置搜索索引词条');
}

console.log('check-display-name-greeting: all passed');
