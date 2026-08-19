// 生成 server/data/thinking-levels.json —— CC-GUI「思考强度按模型自适应」的实测数据表。
//
// 用途:server/utils/model-capabilities.js 以本表为主、家族正则为表外兜底,给 provider 的
//   modelMeta 自动预填(source:'catalog',用户手动声明永远压过它)。
// 数据来源:@earendil-works/pi-ai(MIT 许可),dsh 装机版内置。CC-GUI 只提取"每个模型
//   支持哪些思考档位"这一事实,不引入该包为依赖。
// 刷新方式(dsh 升级后重跑即可,输出直接覆盖 server/data/thinking-levels.json):
//   node scripts/gen-thinking-levels.mjs \
//     "<dsh 安装目录>/node_modules/@earendil-works/pi-ai/dist" \
//     server/data/thinking-levels.json
//
// 用法: node gen-thinking-levels.mjs <pi-ai/dist 目录> <输出文件>
//
// 键 = (协议, model id)。协议取 CC-GUI 的 provider.type 口径:pi-ai 的 4 种 OpenAI 系
// 端点归 openai、anthropic-messages 归 anthropic(其余协议 CC-GUI 不支持,忽略)。
// 必须分协议:实测同一模型两种口径可以完全不同,如 deepseek/deepseek-v4-flash
// openai=[high,xhigh] 而 anthropic=[minimal..high];kwaipilot/kat-coder-pro
// openai 下根本不能思考、anthropic 下全档。
// 同协议内同 id 多来源(不同聚合商/直连+网关)取并集——同协议下差异小且方向为"多给档"。
import fs from 'fs';
import path from 'path';
const DIST = process.argv[2], OUT = process.argv[3];
const { getSupportedThinkingLevels } = await import(path.join(DIST, 'models.js'));
const D = path.join(DIST, 'providers/data/');
// CLI 2.1.235 的 --effort 只认这五档(无 minimal/none),表里出现的 minimal 直接剔除。
const CGUI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PROTO = { 'openai-completions': 'openai', 'openai-responses': 'openai',
  'azure-openai-responses': 'openai', 'openai-codex-responses': 'openai',
  'anthropic-messages': 'anthropic' };

function toEntry(model) {
  // 'off'(关思考)与 'minimal' 丢弃:CLI 的 --effort 都不接受。
  const lv = getSupportedThinkingLevels(model).filter((l) => CGUI_EFFORTS.includes(l));
  if (!lv.length) return { reasoning: false };
  if (lv.length === CGUI_EFFORTS.length) return null; // 全档 = 不产生条目
  return { efforts: CGUI_EFFORTS.filter((e) => lv.includes(e)) };
}
// ── 手工补丁层(pi-ai 快照之后发布的模型;来源=各家官方 API 文档,核对日期 2026-08-19)──
// pi-ai 的表是发版快照,新模型出来后会缺条目。缺条目本身无害(落家族正则=全档,不锁死),
// 但有官方档位依据的直接补上更准。重跑本脚本时这层始终生效,不会被 pi-ai 数据覆盖。
// 依据:
//   glm-5.3     —— Z.AI Core Parameters:"GLM-5.3 … only supports max, high, low",思考不可关
//                  https://docs.z.ai/guides/overview/concept-param
//   qwen3.8-max —— QwenCloud OpenAI Chat API:"Qwen3.8-Max and Qwen3.8-Max-Preview:
//                  Options: low, medium, xhigh. Default: xhigh"
//                  https://docs.qwencloud.com/api-reference/chat/openai-chat
const MANUAL_OVERRIDES = {
  'glm-5.3': { efforts: ['low', 'high', 'max'] },
  'z-ai/glm-5.3': { efforts: ['low', 'high', 'max'] },
  'qwen3.8-max': { efforts: ['low', 'medium', 'xhigh'] },
  'qwen3.8-max-preview': { efforts: ['low', 'medium', 'xhigh'] },
  'qwen/qwen3.8-max': { efforts: ['low', 'medium', 'xhigh'] },
};

const raw = { openai: {}, anthropic: {} };
const mergeInto = (bag, id, entry) => {
  if (!(id in bag)) { bag[id] = entry; return; }
  const a = bag[id];
  if (a === null || entry === null) { bag[id] = null; return; }
  if (!a.efforts && !entry.efforts) return;
  const u = new Set([...(a.efforts || CGUI_EFFORTS), ...(entry.efforts || CGUI_EFFORTS)]);
  bag[id] = u.size === CGUI_EFFORTS.length ? null : { efforts: CGUI_EFFORTS.filter((e) => u.has(e)) };
};
for (const f of fs.readdirSync(D).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) {
  const j = JSON.parse(fs.readFileSync(D + f, 'utf8'));
  for (const [api, models] of Object.entries(j)) {
    const proto = PROTO[api];
    if (!proto) continue;
    for (const [id, m] of Object.entries(models)) mergeInto(raw[proto], id, toEntry(m));
  }
}
// 默认共用一张 byId 表:pi-ai 里"某模型没有 anthropic 条目"只说明它没收录那个端点,
// 不代表该模型经 anthropic 协议就没有思考档(用户的 DeepSeek/MiMo/Kimi Code 都是
// anthropic 协议中转,而 pi-ai 只有它们的 openai 端点数据——严格分表会全部落空)。
// 只有【两个协议都有数据且结论不同】的少数模型才进 byProto,按 provider.type 区分。
const byId = {}, byProto = {};
const ids = new Set([...Object.keys(raw.openai), ...Object.keys(raw.anthropic)]);
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
for (const id of ids) {
  const o = raw.openai[id], a = raw.anthropic[id];
  const hasO = id in raw.openai, hasA = id in raw.anthropic;
  if (hasO && hasA && !eq(o, a)) { byProto[id] = { openai: o, anthropic: a }; continue; }
  const v = hasO ? o : a;
  if (v !== null && v !== undefined) byId[id] = v;
}
for (const id of Object.keys(byProto)) {
  const e = byProto[id];
  if (e.openai === null) delete e.openai;      // null = 全档,省略即可
  if (e.anthropic === null) delete e.anthropic;
}
for (const [id, e] of Object.entries(MANUAL_OVERRIDES)) { byId[id] = e; delete byProto[id]; }
fs.writeFileSync(OUT, JSON.stringify({ source: '@earendil-works/pi-ai@0.82.1 (MIT) + 官方文档手工补丁', byId, byProto }));
console.log('byId:', Object.keys(byId).length, '条 | byProto(协议相关):', Object.keys(byProto).length,
  '条 | 体积:', (fs.statSync(OUT).size / 1024).toFixed(1), 'KB');
