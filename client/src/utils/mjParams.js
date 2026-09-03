// r94 Midjourney 参数编译层与动作语汇 —— 界面侧入口,【只是两层再导出】。
//
// 唯一副本在 server/utils/mj-params.js 与 server/utils/mj-actions.js:同一份规则既要管
// 界面显隐(哪个版本有 --q、8.x 的 turbo 要不要禁),又要管真正下发的 flag 与动作端点。
// 两处各写一份就会漂 —— 界面说"该版本支持",服务端却把它丢进 dropped,用户只看到"填了没生效"。
//
// 先例:client/src/utils/imageSizeCaps.js 同样再导出 server/utils/image-caps.js。
// 这两个服务端模块【零 node 内置依赖】(源码锁 §7.1 / §7.2 钉着),所以进得了浏览器包;
// server/utils/image-protocols.js 则不行(它经 safe-path.js 拉 fs/os),别顺手从那边导。
export {
  MJ_PARAM_FIELDS, MJ_REF_MODES, MJ_REF_MODE_DEFAULT,
  compileMjFlags, mjCapsFor, mjEffectiveSpeed, mjRefModeFor,
} from '../../../server/utils/mj-params.js';
export {
  MJ_ACTION_LABELS, MJ_NO_UPSCALE_NOTE, MJ_RENDERED_KINDS,
  classifyCustomId, mjActionsFor, changeActionFor,
} from '../../../server/utils/mj-actions.js';
