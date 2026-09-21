// r123 生图接口地址规则 —— 界面侧入口,【只是一层再导出】。
//
// 唯一副本在 server/utils/image-url.js:表单里的「最终请求地址」预览与服务端真正打出去的请求
// (buildImageRequest)必须是同一份规则,两处各写一份早晚会漂 —— 用户看到的预览和实际请求对不上,
// 这个预览就成了误导。先例:client/src/utils/imageSizeCaps.js 再导出 server/utils/image-caps.js。
// image-url.js 不 import 任何 node 内置模块(它只依赖同样纯净的 mj-proxy.js / mj-params.js),进得了浏览器包。
export {
  previewImageRequestURL, hasVersionSegment, stripBaseURL, normalizeImageBaseURL,
} from '../../../server/utils/image-url.js';
