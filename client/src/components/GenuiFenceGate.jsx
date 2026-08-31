// genui 渲染开关的闸门(INTERFACE §4.1)。MarkdownRenderer 认出 cgui-ui / dsh-ui 后先过
// 这里,开着才把围栏交给 GenuiFence 渲染成组件,关掉就退回普通代码块。
//
// 为什么单独一层、不写进 GenuiFence:
//  - 开关是 store 里的值,读它要 hook。renderCode 是 react-markdown 给**每一个**代码节点
//    (含行内 `x`)调的,把 hook 塞那儿等于给全站每个反引号加一次订阅,且它有多条 return
//    分支,hook 只能无条件放最前面 —— 为一个 genui 专属开关污染公共热路径不划算。
//  - GenuiFence 里那几条降级分支各有自己的契约(§5.1/§5.2/§5.7),"整个功能被关掉"不是
//    降级,是根本没进来,分开写两边都少一个 if。
//
// 关掉后的形态与其它降级路一致:说明条没有(这不是错误,§4.1 末行),但**原文必须仍可见**
// —— 同一条安全网,所以照样打 genui-source 锚(§9.1)。
import React from 'react';
import { useStore } from '../stores/sessionStore.js';
import { CodeBlock } from './CodeBlock.jsx';
import { GenuiFence, normGenuiLang } from './GenuiFence.jsx';

export function GenuiFenceGate({ raw, lang = 'cgui-ui', settled = false }) {
  // store 订阅:关掉的那一刻整棵消息树重渲 —— 历史消息里的围栏与**正在流式写的那条**
  // 都当场退回代码块,不等回合结束(§4.1)。
  const on = useStore((s) => s.genuiRender);
  if (on) return <GenuiFence raw={raw} lang={lang} settled={settled} />;
  return (
    <div data-testid="genui-source">
      <CodeBlock lang={normGenuiLang(lang)} code={raw} />
    </div>
  );
}
