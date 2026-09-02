// r56/r87 生图参数能力表 —— 界面侧入口,【只是一层再导出】。
//
// 唯一副本在 server/utils/image-caps.js:能力表既要管界面显隐,又要管协议层下发哪些键
// (r87 审查:能力表只管显隐时,换模型后的残值会静默发上去,如 gpt-image-2 上设的
// quality/n 在切到 dall-e-3 后仍进请求体 → 上游 400 且界面已无控件可清)。两处各写一份
// 就会漂,故合成一份放服务端,前端经本文件取用。
//
// 先例:client/src/utils/providerList.js 同样再导出 server/utils/avatar.js。
// 注意 server/utils/image-protocols.js 不能直接给前端 import(它经 safe-path.js 拉 fs/os,
// 进不了浏览器包),所以能力表单独成文件、不带任何 node 内置模块依赖。
export {
  SIZE_OPTIONS, IMAGE_DIALECTS, IMAGE_RESOLUTIONS, IMAGE_QUALITIES, IMAGE_OUTPUT_FORMATS,
  IMAGE_BACKGROUNDS, IMAGE_MODERATIONS, IMAGE_N_MAX, APIMART_RATIOS,
  imageDialect, dialectForBaseURL, imageCount, sizeCapFor, sizeOptionsFor,
} from '../../../server/utils/image-caps.js';
