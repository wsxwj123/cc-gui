// r56/r87 生图参数能力表(纯函数,零依赖,可直接被单测 import)。
//
// 【落点】本文件是能力表与取值白名单的【唯一副本】,前后端共用:
//  - 服务端:server/utils/image-protocols.js 转出这里的常量,并在 buildImageRequest 里
//    按它门控要下发哪些键;server/routes/image.js 的 validateBody 用同一份白名单校验;
//  - 客户端:client/src/utils/imageSizeCaps.js 只是一层再导出(仿 r83 avatar.js 的先例:
//    client/src/utils/providerList.js 再导出 server/utils/avatar.js)。
// 之所以不直接让前端 import image-protocols.js:那个模块经 safe-path.js 拉进 fs / os,
// 进不了浏览器包。故【本文件不许出现任何 node 内置模块的 import】。
// r87 首版曾把这张表和白名单在前后端各写一份、靠单测比对防漂;审查指出能力表还必须门控
// 【下发】(不只是显隐),两份副本就不够用了 —— 合成一份。
//
// r87 起判据是 **(上游方言, 模型) 二元**,不再只看模型名 —— 因为同一个 `size` 键在两个
// 上游上【同名反义】:OpenAI 官方的 size 是像素串(`1536x1024`),apimart 的 size 是宽高比
// 串(`16:9`)、像素档位另由 `resolution`(1k/2k/4k)控制。r56 那版只按模型名判,于是
// apimart 上的 `gpt-image-2` 被按官方语义过滤,比例 token 与 K 档全被去掉 —— 用户唯一
// 能用的候选一个不剩。这是 r87 修掉的既有缺陷。
//
// 能力发现的现状(r56 那句"生图 API 没有查询能力的接口"已被推翻,别再照它做假设):
//  - apimart 有两条:`GET /v1/models?expand=parameters&category=image`(需 key,每模型一份
//    JSON Schema)与免鉴权的 `GET /api/pricing/model?model=X`(给 supported_sizes /
//    supported_qualities)。r87 【没有】接动态能力发现,仍用下面这张静态表把已知模型做对;
//    要接的话入口是上面两个,不是猜。
//  - OpenAI 官方没有这类接口,官方那半仍然只能是静态表。
//
// 红线:
//  - 手动输入永不受限 —— 候选只是候选,用户照样能填任何值,上游报错是可见兜底;
//  - 拿不准的值【宁可保留不过滤】:过滤错 = 用户填不出本来能用的尺寸(功能性伤害),
//    漏过滤 = 上游一句报错(可见、可自纠),两者代价不对称;
//  - 官方方言那半与 r56 【逐字不变】(存量 provider 没有 dialect 字段 = 官方语义)。
//
// 与服务端的关系:取值白名单与方言判定的权威副本在 server/utils/image-protocols.js
// (那里才是校验闸与请求组装);本文件是界面侧的同一份值(前端不 import 服务端代码),
// tests/unit/check-r87-image-params.mjs 比对两处。
export const SIZE_OPTIONS = [
  'auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792',
  '1920x1080', '2048x1152', '2048x2048', '2560x1440', '3840x2160', '2160x3840', '4096x4096',
  '1K', '2K', '4K', '1:1', '16:9', '9:16', '4:3', '3:4', '21:9',
];

const isWxH = (s) => /^\d+x\d+$/i.test(s);
const isRatio = (s) => s.includes(':'); // 1:1 / 16:9 …(K 档位 1K/2K/4K 既非 WxH 也非比例)

// ───────────────────────────── 方言(与服务端同源) ─────────────────────────────
export const IMAGE_DIALECTS = ['openai', 'apimart'];
const APIMART_HOST = 'api.apimart.ai';

/** provider → 上游方言。缺省/未知值一律 'openai'(= r87 之前的语义)。 */
export function imageDialect(provider) {
  return provider?.dialect === 'apimart' ? 'apimart' : 'openai';
}

/** baseURL → 预选方言(新建/编辑时的默认值,用户可手改)。认不出 URL 一律 'openai'。 */
export function dialectForBaseURL(baseURL) {
  try {
    return new URL(String(baseURL)).hostname.toLowerCase() === APIMART_HOST ? 'apimart' : 'openai';
  } catch { return 'openai'; }
}

// 取值范围。全部是【两边文档的交集】口径:只收两个上游都明列的值,拿不准的一律不进
// 白名单(白名单外的值静默不发键,见 image-protocols.js 的 buildImageRequest)。
//  - resolution:apimart 独有,`1k`/`2k`/`4k`(official.md「分辨率档位(新增字段)」)
//  - quality:两边都有 auto/low/medium/high(官方另有 dall-e-3 的 standard/hd,本轮不做)
//  - output_format / background / moderation:两边同名同义(报告 §B 对照表「一致」)
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'];
export const IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp'];
export const IMAGE_BACKGROUNDS = ['auto', 'opaque', 'transparent'];
export const IMAGE_MODERATIONS = ['auto', 'low'];
// 张数上限取两边的【小值】:apimart G2O/G1O 明列 1~4,官方是 1~10。放到 10 会让 apimart
// 用户填出必然 400 的值;要更多张就发多次任务(并发闸本来就是 3)。
export const IMAGE_N_MAX = 4;

/**
 * 张数:1..IMAGE_N_MAX 的整数才认,其余(空 / 越界 / 小数 / 非数)一律 1。
 * 越界【回落 1 而不是钳到上限】:把用户填的 9 静默改成 4 是在替他做一个会计费的决定。
 */
export function imageCount(n) {
  const v = typeof n === 'string' ? Number(n.trim()) : Number(n);
  return Number.isInteger(v) && v >= 1 && v <= IMAGE_N_MAX ? v : 1;
}

/** 枚举值归一:去空白 + 小写,在白名单里才返回,否则 ''(= 不发该键)。 */
export function pickEnum(v, allowed) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return allowed.includes(s) ? s : '';
}

// apimart 的分辨率档位(小写,是 `resolution` 字段的值)。注意与 SIZE_OPTIONS 里的
// 大写 `1K/2K/4K` 不是一回事 —— 后者是火山方舟 Seedream 的 size 取值。
export const IMAGE_RESOLUTIONS = ['1k', '2k', '4k'];

// apimart 的 15 种比例 + auto,顺序取自文档 gpt-image-2 页的枚举原文。
// 第二列是用途标签,只为说明该比例常用于什么 —— 比例值本身可任填(界面另有自定义两格)。
export const APIMART_RATIOS = [
  ['auto', '由上游取默认'], ['1:1', '头像 / 方图'], ['3:2', '相机横幅'], ['2:3', '相机竖幅'],
  ['4:3', '公众号配图'], ['3:4', '社交媒体'], ['5:4', '相框横幅'], ['4:5', '社交媒体竖图'],
  ['16:9', '电脑壁纸'], ['9:16', '手机壁纸'], ['2:1', '横幅广告'], ['1:2', '竖幅长图'],
  ['3:1', '页头横条'], ['1:3', '竖条'], ['21:9', '带鱼屏'], ['9:21', '超长竖图'],
];
const APIMART_RATIO_VALUES = APIMART_RATIOS.map(([v]) => v);

// 界面上可显隐的参数字段名(= provider 上的存储字段名)。
// size 与 resolution 在首屏,其余进「高级参数」折叠区。
const ALL_FIELDS = ['size', 'resolution', 'n', 'quality', 'outputFormat', 'background', 'moderation', 'nsfwCheck'];

// ───────────────────────────── 官方方言(OpenAI 直连)的能力表 ─────────────────────────────
// 与 r56 逐字相同,只多了 fields / qualities / formats 三个说明字段(r56 时面板还没有
// 这些参数控件)。这几条的出处是 OpenAI 官方 Images API 文档,r56 的调研过程存 PROJECT.md。
// 匹配按数组顺序,先命中先用(gpt-image-2 必须排在 gpt-image-1 系之前)。
// 每条二选一:pick = 在全量候选上做排除式过滤;options = 封闭清单(值可以不在全量表里)。
// 官方的 output_format / background / moderation 【只有 GPT image 系支持】(官方文档原文),
// 故 DALL·E 两条不放开任何新参数 —— 它们的行为与 r87 之前一字不变。
const OPENAI_FAMILIES = [
  {
    // OpenAI gpt-image-2:size 收任意 WxH(官方约束:宽高被 16 整除、比例 1:3~3:1、
    // 不超过 3840x2160,>2560x1440 标注为实验性),【无比例参数、无 K 档位】。
    // 出处:OpenAI 官方 Images API 的 CreateImageRequest(gpt-image-2 size 约束)。
    // 故排除三类:4096x4096(总像素 16.7M,超其 8,294,400 上限)、1K/2K/4K、全部比例 token。
    re: /^gpt-image-2/,
    family: 'gpt-image-2',
    pick: (s) => s === 'auto' || (isWxH(s) && s !== '4096x4096'),
    fields: ['size', 'n', 'quality', 'outputFormat', 'background', 'moderation'],
    qualities: ['low', 'medium', 'high'],
    formats: ['png', 'jpeg', 'webp'],
  },
  {
    // gpt-image-1 / 1.5 / mini 与 ChatGPT 同源型号:size 是【枚举】,只认
    // auto / 1024x1024 / 1536x1024(横)/ 1024x1536(竖)。
    // 出处:OpenAI 官方 Images API 文档的 size 参数枚举。
    re: /^(gpt-image-1(\.5|-mini)?|chatgpt-image)/,
    family: 'gpt-image-1 系',
    options: ['auto', '1024x1024', '1536x1024', '1024x1536'],
    fields: ['size', 'n', 'quality', 'outputFormat', 'background', 'moderation'],
    qualities: ['low', 'medium', 'high'],
    formats: ['png', 'jpeg', 'webp'],
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

// ───────────────────────────── apimart 方言的能力表 ─────────────────────────────
// 支持矩阵逐条出自 .devflow/RESEARCH-r87-image-params.md §A-3(每格都有文档 URL)。
// 顺序敏感:`-official` 必须排在裸模型名之前,否则 gpt-image-2-official 会被 /^gpt-image-2/ 吞掉。
const APIMART_FAMILIES = [
  {
    // gpt-image-2 官方渠道:字段最全(截图里那 8 个控件就是它)。
    re: /^gpt-image-2-official/,
    family: 'gpt-image-2 官方渠道',
    options: APIMART_RATIO_VALUES,
    resolutions: IMAGE_RESOLUTIONS,
    fields: ALL_FIELDS,
    qualities: ['low', 'medium', 'high'],
    formats: ['png', 'jpeg', 'webp'],
  },
  {
    // gpt-image-2 中转渠道(含别名 -ext):文档 Body 只列了 size / resolution / n /
    // nsfw_check / image_urls / official_fallback —— 【没有】quality / background /
    // moderation / output_format,这里就不放开(放开 = 让用户填出必然被忽略或 400 的值)。
    // n 在这一渠道文档自相矛盾(Body 定义写「取值:1」,同页示例却给 n:2)→ 一并不放开,
    // 等真机验证过再说。
    re: /^gpt-image-2/,
    family: 'gpt-image-2 中转渠道',
    options: APIMART_RATIO_VALUES,
    resolutions: IMAGE_RESOLUTIONS,
    fields: ['size', 'resolution', 'nsfwCheck'],
  },
  {
    // gpt-image-1 / 1.5 官方渠道:比例只有三种、【无 resolution 档】、output_format 无 webp。
    re: /^gpt-image-1(\.5)?(-official)?/,
    family: 'gpt-image-1 系官方渠道',
    options: ['auto', '1:1', '3:2', '2:3'],
    fields: ['size', 'n', 'quality', 'outputFormat', 'background', 'moderation', 'nsfwCheck'],
    qualities: ['low', 'medium', 'high'],
    formats: ['png', 'jpeg'],
  },
];

// apimart 上的未知模型:【不】回落"不过滤" —— 用户已经明说了上游是 apimart,size 就是
// 比例语义,给像素候选是错的。但只放开三个通用字段(nsfw_check 三个渠道都有;size 与 n
// 是最常用的),模型专属的 resolution / quality / background / moderation 一律不猜。
const APIMART_UNKNOWN = {
  family: 'apimart 未登记模型',
  options: APIMART_RATIO_VALUES,
  fields: ['size', 'n', 'nsfwCheck'],
};

function entry(f, sizeMode) {
  const options = f.options || SIZE_OPTIONS.filter(f.pick);
  // 过滤把候选清空(能力表写错/全量表改动过头)时按"不确定就不过滤"回落,
  // 绝不给用户一个空的候选列表。
  if (!options.length) return null;
  return {
    family: f.family,
    sizeMode,
    options,
    resolutions: f.resolutions || null,
    qualities: f.qualities || null,
    formats: f.formats || null,
    fields: f.fields || [],
  };
}

/**
 * (方言, 模型) → 能力表条目。
 * 返回 { family, sizeMode:'pixel'|'ratio', options, resolutions, qualities, formats, fields }。
 *  - 官方方言 + 未知模型 → null(= 不过滤,回落全量候选;与 r56 一致);
 *  - apimart 方言 → 永不为 null(方言是用户显式指定的,比例语义是确定的),未登记模型
 *    走 APIMART_UNKNOWN 只放开通用字段。
 * 匹配前统一 trim + 小写(用户手输大小写不定),正则按小写形态写。
 */
export function sizeCapFor(dialect, model) {
  const id = String(model || '').trim().toLowerCase();
  if (dialect === 'apimart') {
    if (!id) return entry(APIMART_UNKNOWN, 'ratio');
    for (const f of APIMART_FAMILIES) {
      if (f.re.test(id)) return entry(f, 'ratio') || entry(APIMART_UNKNOWN, 'ratio');
    }
    return entry(APIMART_UNKNOWN, 'ratio');
  }
  if (!id) return null;
  for (const f of OPENAI_FAMILIES) {
    if (!f.re.test(id)) continue;
    return entry(f, 'pixel');
  }
  return null;
}

/** 适用候选数组;官方方言下未匹配任何家族 → null(调用方回落全量 SIZE_OPTIONS)。 */
export function sizeOptionsFor(dialect, model) {
  return sizeCapFor(dialect, model)?.options || null;
}
