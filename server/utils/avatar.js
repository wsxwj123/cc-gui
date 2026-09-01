// r78:provider 头像的形态判定(纯函数,前后端共用)。
//
// 共享核心放在 server/utils/ 而不是 client/src/utils/ —— Tauri 只打包
// `../server` 与 `../client/dist`,server 反向 import client/src 在安装包里
// 必然 ERR_MODULE_NOT_FOUND(plan.js 文件头记着这次事故)。客户端经
// client/src/utils/providerList.js 再导出。
//
// 存盘形态 = 一个字符串(custom-providers.json 的可选 `avatar` 字段),三形态靠
// 一张正则表分辨,不用 {kind,value} 对象、也不用 `mark:` / `file:` 前缀:
//   ① 内置图标名  'deepseek'         → { kind:'mark' }
//   ② 上传文件名  '<uuid>.png'       → { kind:'file' }(服务端生成,客户端只持有名字)
//   ③ emoji/短文字 '🐋' / 'DS'        → { kind:'text' }
// 三者互斥:emoji 不可能匹配文件名正则,也不会落进 mark 白名单。
// 老条目没有这个键 = 未设置,走默认回落(关键字命中 → 首字母色块)。

// 内置图标名 = client/src/components/ModelBadge.jsx 的 PROVIDER_AVATARS 键集合。
// 这里是白名单的真相源;渲染端按名取图,取不到就当没设。
export const AVATAR_MARKS = [
  'anthropic', 'deepseek', 'gemini', 'openai', 'mimo',
  'qwen', 'zhipu', 'moonshot', 'meta', 'system',
];

// 上传文件名:uuid 生成的名字只含 [A-Za-z0-9-],扩展名限四种位图。
// 刻意不含 .svg —— SVG 可内嵌脚本,头像不需要矢量。正则本身排除路径分隔符与
// `..`,回源时 isPathInside 再兜一层。
export const AVATAR_FILE_RE = /^[A-Za-z0-9-]+\.(png|jpe?g|webp)$/;

// 文字形态的长度上限(码点计)。超长的串不是头像,判为非法 —— 这条同时让
// parseAvatar 成为服务端的合法性判据:parseAvatar(v) 为 null 即拒绝入库。
export const AVATAR_TEXT_MAX = 8;

/** 判形态。非法/空 → null。 */
export function parseAvatar(s) {
  const v = String(s ?? '').trim();
  if (!v) return null;
  if (AVATAR_FILE_RE.test(v)) return { kind: 'file', value: v };
  if (AVATAR_MARKS.includes(v)) return { kind: 'mark', value: v };
  // 不截断:ZWJ 组合 emoji(🧑‍🔬)按码点切会切出半个字素,宁可整条拒绝也不存半截。
  if ([...v].length > AVATAR_TEXT_MAX) return null;
  return { kind: 'text', value: v };
}

/** 入库前的清洗:合法则返回原样字符串,否则 null(= 不写 / 清除)。 */
export function sanitizeAvatar(s) {
  const parsed = parseAvatar(s);
  return parsed ? String(s).trim() : null;
}
