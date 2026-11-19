// r200:命令行中途换了模型(原模型的回复被安全检查拦下)时页面显示的说明。主对话(命令行的换模型通知)与
// 子代理页(读历史时从转写里认出的被拦记录)共用一句话。纯逻辑,node 可直跑。

/** 说明文字:含原模型、新模型、「安全检查」、类别(没有类别写「未知」)。 */
export function modelRefusalText({ originalModel, fallbackModel, category } = {}) {
  const from = originalModel || '原模型';
  const to = fallbackModel || '另一个模型';
  return from + ' 的回复被安全检查拦下（类别：' + (category || '未知') + '），命令行已改用 ' + to + ' 继续';
}

const pickText = (v) => (typeof v === 'string' && v ? v : null);

/**
 * 命令行的换模型通知(system/model_refusal_fallback)→ 对话里一条 'model-fallback' 条目,与服务端读历史给的同形。
 * 直播数据流里字段是 original_model / fallback_model / api_refusal_category,落盘记录是 originalModel /
 * fallbackModel / apiRefusalCategory,两种写法都认。uuid 用通知自己的(与落盘那条对账)。
 */
export function modelFallbackNoticeOf(ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  return {
    type: 'model-fallback',
    uuid: pickText(e.uuid) || 'model-fallback-' + (pickText(e.request_id) || pickText(e.requestId) || String(Date.now())),
    timestamp: pickText(e.timestamp) || new Date().toISOString(),
    originalModel: pickText(e.originalModel) || pickText(e.original_model),
    fallbackModel: pickText(e.fallbackModel) || pickText(e.fallback_model),
    category: pickText(e.apiRefusalCategory) || pickText(e.api_refusal_category),
    content: typeof e.content === 'string' ? e.content : '',
  };
}
