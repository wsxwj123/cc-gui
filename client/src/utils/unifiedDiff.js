// 把「一份旧文本 + 一份新文本」拼成 DiffViewer 吃得下的 unified diff 文本。
// 原来是 components/tools/EditDiffCard.jsx 里的私有函数,r64 M3 提到这里:genui 的
// diff 节点(`{path, oldText, newText}`)也要拼同一种文本喂 DiffViewer,不该在
// genui/host 里再写一份(PLAN r64 §1.7)。放 utils/*.js 而不是 DiffViewer.jsx,是因为
// 纯函数在 .js 里能被裸 node 直接 import 做单测,.jsx 不行。
//
// 不做逐行 LCS:两侧整段分别当删除/新增行输出。DiffViewer 只按行首符号上色,拿不到
// 更精细的信息也不会错,而 Edit/genui 两个调用方喂进来的本来就是"一段换一段"。
// ponytail: 真需要行级最小差异时再引 diff 算法,现在两个调用点都不需要。
export function unifiedDiff(filePath, oldStr, newStr, label = 'change') {
  const file = String(filePath || label).replace(/^[/\\]+/, '');
  const oldLines = oldStr == null ? [] : String(oldStr).split('\n');
  const newLines = newStr == null ? [] : String(newStr).split('\n');
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@',
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}
