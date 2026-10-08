// 输入法按键判定(纯函数;tests/unit/check-r147-ime-guard.mjs 锁)。
//
// 这一下按键属于输入法吗 —— 是的话,页面不得把它当成"提交 / 保存 / 关闭":
//   · 组字过程中的按键:isComposing = true;
//   · macOS 应用跑在 WebKit 内核,输入法按 Enter 上屏 / 按 Esc 取消候选那一下,compositionend 先于
//     keydown 到达,keydown 是 key='Enter' / 'Escape'、isComposing=false、keyCode=229;
//   · Chromium / WebView2 此时 key='Process'、keyCode=229。
// 只判 isComposing 拦不住第二种。中文输入法开着时打英文、按 Enter 上屏原文走的也是第二种,
// 所以"纯 ASCII 字段"同样会中招;password / number 输入框输入法不介入,不必判。
// 口径与 ChatInput.jsx handleKeyDown 首行的写法一致。
//
// 两种写法,按拿到的事件选:
//   isImeKeydown(e)      原生 KeyboardEvent(addEventListener 拿到的)
//   isImeReactKeydown(e) React 合成事件(onKeyDown 拿到的;isComposing 只挂在 e.nativeEvent 上)
export function isImeKeydown(e) {
  if (!e) return false;
  return !!e.isComposing || e.key === 'Process' || e.keyCode === 229;
}

export function isImeReactKeydown(e) {
  if (!e) return false;
  return isImeKeydown(e.nativeEvent) || e.key === 'Process' || e.keyCode === 229;
}
