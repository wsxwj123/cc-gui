// r56 尺寸候选按模型家族过滤(纯函数,零依赖,可直接被单测 import)。
//
// 事实前提:生图 API 【没有】"查询某模型支持哪些尺寸"的接口 —— 做不到真·自动检测。
// 这里是【已知模型家族的能力表】,每条注明官方出处(调研过程存 PROJECT.md);
// 未匹配任何家族一律返回 null = 不过滤,走全量候选(现状)。
//
// 红线:
//  - 手动输入永不受限 —— datalist 只是候选,用户照样能填任何值,上游报错是可见兜底;
//  - 拿不准的值【宁可保留不过滤】:过滤错 = 用户填不出本来能用的尺寸(功能性伤害),
//    漏过滤 = 上游一句报错(可见、可自纠),两者代价不对称。故 gpt-image-2 与 seedream
//    走【排除式】(只去掉官方明确不支持的),只有候选集封闭的老模型才用固定清单。
export const SIZE_OPTIONS = [
  'auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792',
  '1920x1080', '2048x1152', '2048x2048', '2560x1440', '3840x2160', '2160x3840', '4096x4096',
  '1K', '2K', '4K', '1:1', '16:9', '9:16', '4:3', '3:4', '21:9',
];

const isWxH = (s) => /^\d+x\d+$/i.test(s);
const isRatio = (s) => s.includes(':'); // 1:1 / 16:9 …(K 档位 1K/2K/4K 既非 WxH 也非比例)

// 匹配按数组顺序,先命中先用(gpt-image-2 必须排在 gpt-image-1 系之前才不会被前缀误吞)。
// 每条二选一:pick = 在全量候选上做排除式过滤;options = 封闭清单(值可以不在全量表里)。
const FAMILIES = [
  {
    // OpenAI gpt-image-2:size 收任意 WxH(官方约束:宽高被 16 整除、比例 1:3~3:1、
    // 不超过 3840x2160,>2560x1440 标注为实验性),【无比例参数、无 K 档位】。
    // 出处:OpenAI 官方 Images API(gpt-image-2 size 约束),调研结论存 PROJECT.md。
    // 故排除三类:4096x4096(总像素 16.7M,超其 8,294,400 上限)、1K/2K/4K、全部比例 token。
    re: /^gpt-image-2/,
    family: 'gpt-image-2',
    pick: (s) => s === 'auto' || (isWxH(s) && s !== '4096x4096'),
  },
  {
    // gpt-image-1 / 1.5 / mini 与 ChatGPT 同源型号:size 是【枚举】,只认
    // auto / 1024x1024 / 1536x1024(横)/ 1024x1536(竖)。
    // 出处:OpenAI 官方 Images API 文档的 size 参数枚举。
    re: /^(gpt-image-1(\.5|-mini)?|chatgpt-image)/,
    family: 'gpt-image-1 系',
    options: ['auto', '1024x1024', '1536x1024', '1024x1536'],
  },
  {
    // DALL·E 3:size 仅 1024x1024 / 1792x1024 / 1024x1792(无 auto)。
    // 出处:OpenAI 官方 Images API 文档(dall-e-3 size 枚举)。
    re: /^dall-e-3/,
    family: 'DALL·E 3',
    options: ['1024x1024', '1792x1024', '1024x1792'],
  },
  {
    // DALL·E 2:size 仅 256x256 / 512x512 / 1024x1024。这两个小尺寸只有本家族用得上,
    // 故只登记在这里,不进全量候选表(其它模型看不到它们)。
    // 出处:OpenAI 官方 Images API 文档(dall-e-2 size 枚举)。
    re: /^dall-e-2/,
    family: 'DALL·E 2',
    options: ['256x256', '512x512', '1024x1024'],
  },
  {
    // 火山方舟 Seedream 系:size 收 WxH 与 1K/2K/4K 档位,【不认 16:9 这类比例 token】
    // (要控比例得直接给 WxH)。出处:火山方舟 图片生成 API 的 size 参数说明。
    // 只排除比例 token —— 其余(含 4096x4096,本就是 Seedream 系的值)全部保留。
    re: /seedream/,
    family: 'Seedream',
    pick: (s) => !isRatio(s),
  },
];

/**
 * 模型 → 能力表条目。返回 { family, options } 或 null(未知家族 = 不过滤)。
 * 匹配前统一 trim + 小写(用户手输大小写不定),正则按小写形态写。
 */
export function sizeCapFor(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return null;
  for (const f of FAMILIES) {
    if (!f.re.test(id)) continue;
    const options = f.options || SIZE_OPTIONS.filter(f.pick);
    // 过滤把候选清空(能力表写错/全量表改动过头)时按"不确定就不过滤"回落全量,
    // 绝不给用户一个空的候选列表。
    return options.length ? { family: f.family, options } : null;
  }
  return null;
}

/** 适用候选数组;未匹配任何家族 → null(调用方回落全量 SIZE_OPTIONS)。 */
export function sizeOptionsFor(model) {
  return sizeCapFor(model)?.options || null;
}
