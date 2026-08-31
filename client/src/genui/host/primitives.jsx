// 上游 `advanced.tsx:8` 从 `@deepseek-ai/dsh-client-ui-primitives` 取四件宿主组件,
// 这里是 CC-GUI 侧的四个替身(PLAN r64 §1.7)。
//
// 本文件是 upstream/ 与宿主之间**唯一**的转手点:按 §2.0.1-2,`genui/upstream/` 下任何
// 文件都不许直接 import `components/` 或 `utils/`,宿主件一律经 `genui/host/` 传进去。
// 上游改了签名 → 只改这一个文件,vendored 的 .tsx 保持"原样搬"好和上游 diff。
import React from 'react';
import { CodeBlock } from '../../components/CodeBlock.jsx';
import { DiffViewer } from '../../components/DiffViewer.jsx';
import { unifiedDiff } from '../../utils/unifiedDiff.js';
import { copyText } from '../../utils/clipboard.js';

// ① CodeBlock —— 宿主签名 {lang, code} 与上游调用 <CodeBlock code lang /> 正好对上,直接转出。
export { CodeBlock };

// ② DiffBlock —— 上游给的是 `{path, oldText, newText}[]`,宿主 DiffViewer 吃 unified 文本。
// 多个文件**一个文件一个 DiffViewer**(照 EditDiffCard 的既有惯例):DiffViewer 只把前两行的
// `---`/`+++` 认成文件头,几份拼一起后面的文件头会被当成删/增行染红染绿。
export function DiffBlock({ diffs }) {
  const list = Array.isArray(diffs) ? diffs : [];
  if (list.length === 0) return null;
  return (
    <div className="my-2 flex flex-col gap-2">
      {list.map((d, i) => (
        <div key={`${d?.path ?? ''}::${i}`} className="rounded-lg border border-canvas-deep overflow-hidden">
          <DiffViewer diff={unifiedDiff(d?.path, d?.oldText, d?.newText)} />
        </div>
      ))}
    </div>
  );
}

// ③ JsonTree —— 仓内没有 JSON 树组件,全仓惯例就是 JSON.stringify(v, null, 2) 塞代码块,
// 照这个惯例接(为 genui 单独造一个树组件属 BRIEF 排除的"给 genui 扩设计系统")。
// 上游还传了 `copyable`:CodeBlock 头上恒有复制按钮,这个 prop 无需接。
export function JsonTree({ data }) {
  let text;
  // spec 已经过 guard,循环引用/BigInt 属够不着的边角;但 stringify 抛出来会连整块界面一起崩,
  // 兜一下比让围栏白屏划算。
  try { text = JSON.stringify(data, null, 2); } catch { text = undefined; }
  return <CodeBlock lang="json" code={text ?? String(data)} />;
}

// ④ writeClipboard —— 必须是 copyText,不是 navigator.clipboard.writeText:手机经明文 http
// 走局域网/Tailscale 打开 GUI 时不是安全上下文,navigator.clipboard 是 undefined,复制会
// 静默失效(而决策 5 就是手机端降级、公开版默认开局域网)。copyText 自带 execCommand 兜底,
// 返回布尔,正好对上上游 `await writeClipboard(text)` 的 Promise<boolean> 契约。
export const writeClipboard = copyText;
