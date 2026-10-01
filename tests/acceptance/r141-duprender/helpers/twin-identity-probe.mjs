#!/usr/bin/env node
// r141 离线探针(不依赖浏览器/实例):把"本地定稿副本的拼法"与"历史孪生的拼法"
// 按方案 §3.0 的判据定义算一遍,回答两个问题:
//   ① 弱键(`${type}|${text.slice(0,80)}`)为什么会落空 —— 即"红"的结构基础;
//   ② 修法 A1 的判据②(逐块拼接 + 去空白)为什么必然命中 —— 即"修后必绿"的机械证据。
// 跑法:node tests/acceptance/r141-duprender/helpers/twin-identity-probe.mjs
import { dup } from './fixtures.mjs';

const sid = 'a1180608-0000-4000-8000-000000000608';
// 客户端:App.jsx:6282 `accumulatedText = accumulatedText ? `${acc}\n${block.text}` : block.text`
const localText = dup.full(sid);                       // 三块用 \n 拼
const localBlocks = [dup.chunk1(sid), dup.chunk2(sid), dup.final(sid)].map((t) => ({ type: 'text', content: t }));
// 历史:session-reader 逐条 push 进 turn.text,前端 msgTextOf 用 '' join;blocks 逐块
const histText = dup.fullHistory(sid);
const histBlocks = [...localBlocks];

const weakKey = (m) => `${m.type}|${String(m.text).slice(0, 80)}`;
const local = { type: 'turn', text: localText, blocks: localBlocks };
const hist = { type: 'turn', text: histText, blocks: histBlocks };

// A1:blocksText = blocks 里 type==='text' 的 content 按序直接拼接;strip = 去掉全部空白
const blocksText = (m) => (m.blocks || []).filter((b) => b?.type === 'text').map((b) => b.content || '').join('');
const strip = (s) => String(s || '').replace(/\s+/g, '');
// v1 的错口径(折叠空白):留着做反例,证明"折叠"在夹具里永远不相等
const fold = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const rows = [
  ['本地副本 text 前 80 字', JSON.stringify(local.text.slice(0, 80))],
  ['历史孪生 text 前 80 字', JSON.stringify(hist.text.slice(0, 80))],
  ['弱键(本地)', JSON.stringify(weakKey(local))],
  ['弱键(历史)', JSON.stringify(weakKey(hist))],
  ['弱键命中?', String(weakKey(local) === weakKey(hist))],
  ['判据② 指纹(本地)', JSON.stringify(strip(blocksText(local)))],
  ['判据② 指纹(历史)', JSON.stringify(strip(blocksText(hist)))],
  ['判据② 命中?', String(strip(blocksText(local)) === strip(blocksText(hist)))],
  ['反例:v1 的"折叠空白"口径命中?', `${fold(local.text) === fold(hist.text)}(对 text 折叠:本地 "${fold(local.text)}" vs 历史 "${fold(hist.text)}")`],
];
for (const [k, v] of rows) console.log(`${k.padEnd(34, ' ')} ${v}`);

const weakHit = weakKey(local) === weakKey(hist);
const fp2Hit = strip(blocksText(local)) === strip(blocksText(hist));
if (weakHit) { console.error('\n✗ 弱键竟然命中 —— 夹具文案没把块边界压进 80 字窗口,红会变假绿'); process.exit(1); }
if (!fp2Hit) { console.error('\n✗ 判据② 不命中 —— 修后藏不掉,红不会被治好'); process.exit(1); }
console.log('\n✓ 弱键结构性落空(红成立) 且 判据② 必然命中(修后必绿)');
