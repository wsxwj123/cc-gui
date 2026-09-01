#!/usr/bin/env node
// r83:provider 头像改简约风 + 内置图标扩到 56 枚。
//
// 这个文件锁三件容易被后续改动悄悄推翻的事:
//   ① 图标表与入库白名单是**同一张表**(r83 之前是两份手抄,扩到 56 枚后必分叉);
//   ② 每一枚都有真的 path 数据(空壳会渲染成一个空框,肉眼在小尺寸下看不出来);
//   ③ 样式回归锁:头像不许再出现品牌渐变底、不许写死颜色(用户就是嫌渐变丑才改的)。
//
// ③ 是本轮的头号回归风险:渐变是"看着挺花哨"的写法,后来人加一个新 provider 时
// 顺手写回 gradient 完全不会有人拦,除非这里红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROVIDER_ICONS, PROVIDER_ICON_NAMES } from '../../server/utils/provider-icons.js';
import { AVATAR_MARKS, parseAvatar, searchMarks } from '../../server/utils/avatar.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
let n = 0;
const eq = (a, b, m) => { n++; assert.deepEqual(a, b, m); };
const ok = (v, m) => { n++; assert.ok(v, m); };

// ── ① 一张表,不是两份 ────────────────────────────────────────────
eq(AVATAR_MARKS, PROVIDER_ICON_NAMES, '入库白名单的内容 = 图标表的键');
// 内容相等还不够:一份手抄的名字数组"今天"也内容相等,明天加图标时就漏。所以再锁
// 源码形态 —— 白名单必须是那张表本身,不是抄出来的。
ok(/export const AVATAR_MARKS = PROVIDER_ICON_NAMES;/.test(read('server/utils/avatar.js')),
  '白名单直接引用图标表,不许出现手抄的名字数组');
eq([...new Set(PROVIDER_ICON_NAMES)].length, PROVIDER_ICON_NAMES.length, '键不重复');
ok(PROVIDER_ICON_NAMES.length >= 53, `内置图标 ≥53 枚(当前 ${PROVIDER_ICON_NAMES.length})`);

// 白名单里的每个名字都必须能被 parseAvatar 判成 mark —— 否则用户在选择器里点得到、
// 存进去却被拒(r78 的 8 码点上限对 cloudflare_workers_ai 这种长名字是致命的,
// 幸好白名单判定排在长度判定之前;这条断言把那个顺序钉死)。
for (const k of PROVIDER_ICON_NAMES) {
  eq(parseAvatar(k), { kind: 'mark', value: k }, `选择器里选得到的 ${k} 必须存得进`);
}
ok(PROVIDER_ICON_NAMES.some((k) => [...k].length > 8), '白名单里确实有超过文字上限的长名字(否则上面那条断言是空转)');

// r78 就存在的 10 个名字必须一个不少:老用户库里可能已经存着它们,丢一个 = 那一行
// 头像静默变回首字母。
for (const legacy of ['anthropic', 'deepseek', 'gemini', 'openai', 'mimo', 'qwen', 'zhipu', 'moonshot', 'meta', 'system']) {
  ok(PROVIDER_ICON_NAMES.includes(legacy), `r78 的老图标名 ${legacy} 不许消失(库里可能已存着)`);
}

// 目标名单(对齐 ChatWise 的 53 枚)。deepbricks 未收录 —— lobe/simple-icons 都没有,
// 厂商官网只有一枚无许可证声明的 favicon,手工转 path 属二次创作,故跳过回落首字母档。
// 这条断言的意义是:将来谁"顺手"删掉其中一枚,这里立刻点名。
const WANTED = `302ai aihubmix alibaba aliyun amazon anthropic azure baseten bytedance cerebras chatglm claude
cloudflare_workers_ai codex cohere copilot custom deepseek docker doubao elevenlabs fireworks gemini github google
grok groq huggingface hunyuan hyperbolic jina kimi lmstudio mcp minimax mistral nvidia ollama openai opencode_zen
openrouter poe pplx qwen raycast siliconflow together vercel vertex xai zai zhipu`.split(/\s+/).filter(Boolean);
eq(WANTED.filter((k) => !PROVIDER_ICON_NAMES.includes(k)), [], '目标名单里的图标一枚都不许缺');
ok(!PROVIDER_ICON_NAMES.includes('deepbricks'), 'deepbricks 明确未收录(有干净来源了再加,别偷偷手描)');

// ── ② 每一枚都有真的 path ────────────────────────────────────────
for (const [k, def] of Object.entries(PROVIDER_ICONS)) {
  ok(typeof def.d === 'string' && def.d.length >= 20, `${k} 的 path 不是空壳`);
  ok(/^[Mm]/.test(def.d.trim()), `${k} 的 path 以 moveto 开头(合法 path 数据)`);
  ok(!/[<>"]/.test(def.d), `${k} 的 path 里没有尖括号/引号(整段 svg 误粘进来会渲染成空)`);
  ok(typeof def.label === 'string' && def.label.trim(), `${k} 有显示名`);
  ok(!def.color || /^#[0-9A-Fa-f]{3,6}$/.test(def.color), `${k} 的品牌色是十六进制或不写`);
}
// 品牌色不许是渐变字符串(表里写 gradient 同样是本轮要根除的形态)。
ok(!Object.values(PROVIDER_ICONS).some((d) => /gradient/i.test(String(d.color ?? ''))), '图标表里没有渐变色');

// ── ③ 样式回归锁 ────────────────────────────────────────────────
{
  const badge = read('client/src/components/ModelBadge.jsx');
  // 头像那段(从图标表生成到 ProviderMark 结束)不许再有渐变。整文件排除 MODEL_STYLES
  // 那张模型徽章配色表 —— 那是另一个东西,本轮不动它。
  const from = badge.indexOf('function iconMark');
  const to = badge.indexOf('export function useAssistantProvider');
  ok(from > 0 && to > from, '定位得到头像那一段(改动后请同步这两个锚点)');
  const seg = badge.slice(from, to);
  ok(!/gradient/i.test(seg), '头像不许再有任何 gradient(用户就是嫌品牌渐变底丑)');
  // chip 本身(底色 + 描边 + 尺寸)一个写死颜色都不许有 —— 深浅色模式各写一套是本仓
  // 反复踩过的坑,底色/描边必须是主题变量。品牌色与首字母配色不在此列:那些是"标识
  // 本身的颜色",本来就该是固定的十六进制。
  const chip = seg.slice(seg.indexOf('const chip = {'), seg.indexOf('const cls ='));
  ok(chip.length > 40, '定位得到 chip 定义');
  ok(!/#[0-9A-Fa-f]{3,6}/.test(chip), 'chip 的底色/描边不许写死颜色(深色下白底刺眼就是这么来的)');
  ok(!/rgba?\(/.test(chip), 'chip 也不许用写死的 rgb/rgba 绕过上一条');
  ok(/background: 'var\(--color-canvas\)'/.test(seg), '底色取主题变量');
  ok(/border: '0\.5px solid var\(--color-canvas-deep\)'/.test(seg), '0.5px 细边框,描边取主题变量');
  ok(/spec\.markColor \|\| 'var\(--color-ink\)'/.test(seg), '标识本身留品牌色,单色标识跟随主题字色');
  ok(/Object\.entries\(PROVIDER_ICONS\)/.test(seg), 'PROVIDER_AVATARS 从图标表生成');
  // 四种形态共用同一枚 chip:三个渲染分支都摊开 chip,且都挂 provider-mark
  // (iOS 把只有 viewBox 的 svg 渲染成 0×0,靠 .provider-mark svg{width:100%} 撑开)。
  // 图片分支直接 style={chip}(不需要额外键),另两个分支摊开后再补字号/字色。
  eq((seg.match(/\.\.\.chip/g)?.length ?? 0) + (seg.match(/style=\{chip\}/g)?.length ?? 0), 3,
    '图标 / 图片 / emoji 三个分支共用同一枚 chip');
  eq(seg.match(/\$\{cls\}/g)?.length, 3, 'provider-mark 由 cls 一处下发,三个分支各用一次');
  ok(/const cls = `shrink-0 provider-mark/.test(seg), '每种形态都挂 provider-mark(漏挂 = 手机上头像整片消失)');
}
{
  // 四个消费点都走同一枚 ProviderMark —— 样式改一处四处齐动,不许谁自己画一个。
  const app = read('client/src/App.jsx');
  const sel = read('client/src/components/SessionSelectors.jsx');
  const badge = read('client/src/components/ModelBadge.jsx');
  eq(app.match(/<ProviderMark row=\{p\}/g)?.length, 2, '桌面管理列表 + 手机 Provider 页');
  ok(/<ProviderMark row=\{p\}/.test(sel), '顶栏切换卡片');
  ok(/export function ProviderAvatar[\s\S]{0,400}?<ProviderMark/.test(badge), '气泡头像');
  eq(badge.match(/export function ProviderMark/g)?.length, 1, '只有一个 ProviderMark 定义');
}

// ── ④ 选择器搜索 ────────────────────────────────────────────────
eq(searchMarks(''), AVATAR_MARKS, '空查询 = 全表');
eq(searchMarks('   '), AVATAR_MARKS, '纯空白同上');
eq(searchMarks(null), AVATAR_MARKS, 'null 不炸');
ok(searchMarks('qwen').includes('qwen'), '按键名命中');
ok(searchMarks('千问').includes('qwen'), '按中文别名命中');
ok(searchMarks('DeepSeek').includes('deepseek'), '大小写不敏感');
ok(searchMarks('深度求索').includes('deepseek'), '中文别名');
ok(searchMarks('kimi').includes('moonshot'), '别名跨键命中(kimi → moonshot)');
eq(searchMarks('这个名字不存在'), [], '搜不到就是空数组,不回落全表');
ok(searchMarks('open').length >= 3 && searchMarks('open').every((k) => AVATAR_MARKS.includes(k)), '结果恒是白名单子集');
{
  const app = read('client/src/App.jsx');
  ok(/searchMarks\(markQ\)/.test(app), '选择器用 searchMarks 过滤');
  ok(/\{markList\.map\(\(m\) =>/.test(app), '渲染过滤后的结果而不是整表');
  ok(/max-h-\[168px\] overflow-y-auto/.test(app), '列表有高度上限(56 枚会把表单撑爆)');
  ok(/setAvatarOpen\(false\); setMarkQ\(''\)/.test(app), 'reset 一并清搜索词');
}

// ── 变异哨兵(实测:每条都能把上面对应的断言从绿变红)─────────────
// 哨兵1:avatar.js 把 AVATAR_MARKS 改回手抄的名字数组(r83 之前的形态)
//        → ① 内容断言 + 源码形态断言双红。注意内容断言单独不够:刚抄完时内容是
//        相等的,分叉发生在下一次加图标时,所以必须同时锁源码形态。
// 哨兵2:给任意一枚图标把 d 改成 ''(或删掉 d)
//        → ② 那一枚的"不是空壳"红。空 path 在 16px 下肉眼就是个空框。
// 哨兵3:ModelBadge 的 chip 里把 background 改回 'linear-gradient(...)'
//        → ③ "不许再有任何 gradient" + "底色取主题变量" 两条红。
// 哨兵4:把 chip 的 background 写成 '#fff'
//        → ③ "不许写死颜色" 红(深色主题下白底刺眼,正是这条要拦的)。
// 哨兵5:cls 里删掉 provider-mark
//        → ③ 计数与 "每种形态都挂" 两条红(手机上头像整片消失)。
// 哨兵6:searchMarks 搜不到时 return AVATAR_MARKS(常见的"友好回落"写法)
//        → ④ "搜不到就是空数组" 红 —— 那种回落会让用户以为搜索坏了。

console.log(`✓ check-r83-avatar-mono: ${n} assertions passed`);
