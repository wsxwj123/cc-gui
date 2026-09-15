// 唯一 preset registry 的客户端入口:真相源住在仓库根的 server/utils/builtin-providers.js。
//
// 方向不能反过来(与 client/src/utils/plan.js 同一先例):安装包只带 server + client/dist,
// 没有 client/src —— server 反向 import 会让打包版后端启动即 ERR_MODULE_NOT_FOUND。
// 价格模块(server/services/pricing-*)按 registry 枚举预设全集,与前端同一份数据,不维护平行清单。
// dev 下这条跨根 import 走 /@fs/,已由 client/vite.config.js 的 fs.allow 放行 ../server/utils。
import { BUILTIN_PROVIDERS, findBuiltin, matchPresetByBaseURL } from '../../../server/utils/builtin-providers.js';

export { BUILTIN_PROVIDERS, findBuiltin, matchPresetByBaseURL };

/**
 * E 项(INTERFACE §10.8)的提示判据:保存表单时,用户手填的 baseURL 撞上内置预设的入口
 * 就该问一句「要不要切过去」—— 自建 provider 拿不到预设带的计价规则与额度接口(额度候选
 * 按预设身份挂)。**只回答"要不要提示、提示哪条"**:纯函数、零副作用,切不切由用户点。
 *
 * 两条抑制条件(防空弹,任一成立即不提示):
 *   ① baseURL 与打开表单时的初值逐字相同 —— 编辑模式没动 URL,每次改别的字段不该再问一遍;
 *   ② baseURL 与最近一次经「内置模板」下拉填充的值逐字相同且命中同一预设 —— 用户刚选完这个
 *      模板,提示里没有任何新信息。
 *
 * @param {unknown} baseURL 用户填的 Base URL
 * @param {{type?: string|null, initialBaseURL?: string|null, template?: {id:string, baseURL:string}|null}} [ctx]
 * @returns {null | {matched:true, host:string, preset:object, candidates:object[]}} null = 不提示
 */
export function presetSuggestion(baseURL, ctx = {}) {
  const hit = matchPresetByBaseURL(baseURL, { type: ctx.type });
  if (!hit.matched) return null;
  if (typeof baseURL === 'string' && baseURL === ctx.initialBaseURL) return null;
  if (ctx.template && ctx.template.baseURL === baseURL && ctx.template.id === hit.preset.id) return null;
  return hit;
}
