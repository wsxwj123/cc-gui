// r200:命令行中途换了模型(原模型的回复被安全检查拦下)时页面显示的说明。主对话(命令行的换模型通知)与
// 子代理页(读历史时从转写里认出的被拦记录)共用一句话。纯逻辑,node 可直跑。

/** 说明文字:含原模型、新模型、「安全检查」、类别(没有类别写「未知」)。 */
export function modelRefusalText({ originalModel, fallbackModel, category } = {}) {
  const from = originalModel || '原模型';
  const to = fallbackModel || '另一个模型';
  return from + ' 的回复被安全检查拦下（类别：' + (category || '未知') + '），命令行已改用 ' + to + ' 继续';
}
