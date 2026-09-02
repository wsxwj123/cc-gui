// Midjourney 动作语汇:把上游按钮(customId)翻成 GUI 认识的动作,以及上游不给按钮时的回落。
// 纯函数、零依赖(不 import 任何 node 内置),前端 client/src/utils/mjParams.js 直接再导出。
//
// 两条不许破的线:
//  ① `upsample::` 是 Discord 的 U 按钮(从四宫格里取出这一张,像素不变),`upsample_*` 才是真放大。
//     两者严格互斥,不许用 startsWith('MJ::JOB::upsample') 一把抓。
//  ② upscale / reroll / zoom / pan / inpaint 只可能来自上游按钮:hash 段自己拼是假的,上游必拒。

export const MJ_ACTION_LABELS = {
  pick: '取出单图',
  variation: '变体',
  vary_strong: '强变体',
  vary_subtle: '弱变体',
  upscale: '真放大',
  reroll: '重新生成',
  zoom: '扩展画布',
  pan: '平移扩展',
  inpaint: '局部重绘',
};

export const MJ_NO_UPSCALE_NOTE = '该中转站不提供真放大:它的按钮里没有 Upscale(Subtle/Creative/2x/4x)命令,「取出单图」只是从四宫格取出这一张、像素不变。需要更大的图,请把版本切到 8.1 或 8.2 并勾选「高清(HD)」,可直接出 2 倍像素且不额外计费。';

// 本轮只渲染这三种;其余 kind 认得出来但不给按钮。
export const MJ_RENDERED_KINDS = ['pick', 'variation', 'upscale'];

// 命令段 → kind。用 Map 而不是对象字面量:命令段来自上游,查 'constructor' 之类的键不能命中原型。
const KIND_BY_COMMAND = new Map([
  ['upsample', 'pick'],
  ['variation', 'variation'],
  ['high_variation', 'vary_strong'],
  ['low_variation', 'vary_subtle'],
  ['reroll', 'reroll'],
  ['Outpaint', 'zoom'],
  ['CustomZoom', 'zoom'],
  ['Inpaint', 'inpaint'],
]);

const CHANGE_ACTION_BY_KIND = new Map([
  ['pick', 'UPSCALE'],
  ['variation', 'VARIATION'],
  ['vary_strong', 'VARIATION'],
  ['vary_subtle', 'VARIATION'],
  ['reroll', 'REROLL'],
]);

const MAX_ACTIONS = 32;
const MAX_INDEX = 4;

/**
 * 把上游按钮的 customId 分类。认不出来一律 'unknown',任何入参都不抛错。
 * 真机实测同一份按钮里两种前缀并存,命令段的位置不固定:
 *   三段式 MJ::JOB::<命令>::<序号>::<hash>
 *   两段式 MJ::<命令>::<序号>::<hash>(Outpaint / Inpaint / CustomZoom)
 * 所以只能先看第二段是不是 JOB 再决定命令段下标,按固定下标取会把两段式读成 '1'。
 */
export function classifyCustomId(customId) {
  if (typeof customId !== 'string') return 'unknown';
  const seg = customId.split('::');
  if (seg[0] !== 'MJ') return 'unknown';
  const cmd = seg[1] === 'JOB' ? seg[2] : seg[1];
  if (!cmd) return 'unknown';
  const exact = KIND_BY_COMMAND.get(cmd);
  if (exact) return exact;
  if (cmd.startsWith('upsample_')) return 'upscale';
  if (cmd.startsWith('pan_')) return 'pan';
  return 'unknown';
}

/**
 * 产出可点的动作列表。
 * 有 buttons:逐个翻译,customId 原样带走(绝不重拼),label 一律用本地中文名
 *   —— 上游的 label 是 U1/V1 或纯 emoji(⬅ ➡ ⬆ ⬇ 🔄),透传出去就是一排裸箭头。
 * 没 buttons:只回落出「取出单图」与「变体」,按 index 下发。两种协议的回落完全一样,
 *   proxy 原版虽有 reroll 模板但本轮不放行。
 * 入参里的 protocol 不参与判断(留着是为了调用点自解释)。
 */
export function mjActionsFor(input) {
  if (!input || typeof input !== 'object') return [];
  const actions = [];
  const buttons = Array.isArray(input.buttons) ? input.buttons : [];

  if (buttons.length) {
    const seen = new Set();
    for (const btn of buttons) {
      if (actions.length >= MAX_ACTIONS) break;
      const customId = btn && typeof btn.customId === 'string' ? btn.customId : '';
      if (!customId || seen.has(customId)) continue;
      const kind = classifyCustomId(customId);
      if (kind === 'unknown') continue;
      seen.add(customId);
      actions.push({ id: `${kind}:${customId}`, kind, label: MJ_ACTION_LABELS[kind], customId, mode: 'customId' });
    }
    return actions;
  }

  const count = Math.min(Number.isInteger(input.imageCount) ? input.imageCount : 0, MAX_INDEX);
  for (const kind of ['pick', 'variation']) {
    for (let i = 1; i <= count; i++) {
      actions.push({ id: `${kind}:${i}`, kind, label: MJ_ACTION_LABELS[kind], index: i, mode: 'index' });
    }
  }
  return actions;
}

/** kind → midjourney-proxy 原版 /submit/change 的 action 值;该协议不支持的 kind 返回 null。 */
export function changeActionFor(kind) {
  return CHANGE_ACTION_BY_KIND.get(kind) ?? null;
}
