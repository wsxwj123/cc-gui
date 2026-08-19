// r13-p2-19:主题弹层选项卡(Windows 属性页式)——默认「字体」,其余点击才显示。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEME_TABS, DEFAULT_THEME_TAB, readThemeTab, writeThemeTab } from '../../client/src/utils/themeTabs.js';

// t1 清单与默认
{
  assert.deepEqual(THEME_TABS.map((t) => t.id), ['font', 'color', 'ui', 'skin'], 't1: 四页签固定顺序');
  assert.equal(DEFAULT_THEME_TAB, 'font', 't1: 默认字体页(最常调)');
}

// t2 记忆(本设备)与非法值回落
{
  const store = new Map();
  const fake = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(readThemeTab(fake), 'font', 't2: 无存值回默认');
  assert.equal(writeThemeTab('color', fake), true, 't2: 合法页签可写');
  assert.equal(readThemeTab(fake), 'color', 't2: 读回上次页签');
  assert.equal(writeThemeTab('不存在', fake), false, 't2: 非法页签拒写');
  assert.equal(readThemeTab(fake), 'color', 't2: 拒写后旧值不变');
  store.set('cgui-theme-tab', 'garbage');
  assert.equal(readThemeTab(fake), 'font', 't2: 存了脏值也回默认');
  // storage 抛异常不炸
  const boom = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.equal(readThemeTab(boom), 'font', 't2: storage 异常回默认');
  assert.equal(writeThemeTab('ui', boom), false, 't2: storage 异常写入返回 false');
}

// t3 接线守卫:页签条 + 各版块条件渲染 + 明暗常驻(不入页签)
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /role="tablist"/, 't3: 页签条(哨兵锚)');
  assert.match(app, /THEME_TABS\.map/, 't3: 页签来自清单');
  assert.match(app, /\{tab === 'color' && \(/, 't3: 配色页条件渲染');
  assert.match(app, /\{tab === 'ui' && <ChatModeToggle \/>\}/, 't3: 界面页');
  assert.match(app, /\{tab === 'skin' && <SkinSection \/>\}/, 't3: 皮肤页');
  // 明暗三态必须在页签之外(全局开关,任何页都能切)
  const toneIdx = app.indexOf('TONES.map');
  const tablistIdx = app.indexOf('role="tablist"');
  assert.ok(toneIdx > 0 && tablistIdx > toneIdx, 't3: 明暗三态在页签条之上(常驻)');
}

console.log('check-theme-tabs: all passed (r13-p2-19)');
