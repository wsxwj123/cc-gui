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

import { PROVIDER_ICONS, PROVIDER_ICON_NAMES } from './provider-icons.js';

// 内置图标名 = provider-icons.js 那张表的键集合。r83 之前这里是一份手抄的名字数组,
// 与渲染端的 PROVIDER_AVATARS 靠单测对账;图标扩到 56 枚之后手抄必漏,改成直接引用
// 同一张表 —— 渲染端也从这张表生成,两边不可能再分叉。
export const AVATAR_MARKS = PROVIDER_ICON_NAMES;

/**
 * 图标选择器的模糊匹配。56 枚平铺找不着,按【键名 / 显示名 / 别名】三处任一命中。
 * 放在这里而不是组件里:纯函数、可单测,且与白名单同一张表,不会出现"搜得到却存不进"。
 * 空查询返回全表(顺序即表的定义顺序)。
 */
export function searchMarks(q) {
  const s = String(q ?? '').trim().toLowerCase();
  if (!s) return AVATAR_MARKS;
  return AVATAR_MARKS.filter((k) => {
    const def = PROVIDER_ICONS[k];
    return k.toLowerCase().includes(s)
      || String(def?.label ?? '').toLowerCase().includes(s)
      || String(def?.kw ?? '').toLowerCase().includes(s);
  });
}

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
