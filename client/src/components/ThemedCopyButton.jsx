import React, { useEffect, useRef, useState } from 'react';
import { copyText } from '../utils/clipboard.js';

// r158:跟随主题的文字版「复制」按钮(终端命令行用;第三段代码块也复用)。
// 点后文字变「已复制」约 1.5 秒后恢复;连点清旧计时,保住新状态的完整时长。
// stopPropagation:按钮常放在可点击的行里,复制不该顺带触发外层的展开 / 收起。
export function ThemedCopyButton({ text, className = 'tc-copy', label = '复制', doneLabel = '已复制' }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <button
      type="button"
      className={className}
      data-copied={copied ? 'true' : 'false'}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(String(text ?? ''))) {
          clearTimeout(timerRef.current);
          setCopied(true);
          timerRef.current = setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? doneLabel : label}
    </button>
  );
}
