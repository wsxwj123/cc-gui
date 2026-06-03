import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { copyText } from '../utils/clipboard.js';

export function CodeBlock({ code, language }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    // copyText falls back to execCommand on non-secure contexts (phone over
    // plain-http LAN / Tailscale), where navigator.clipboard is unavailable.
    if (await copyText(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="relative group my-3">
      {/* Language label + copy */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-canvas-deep border border-canvas-sunken rounded-t-lg">
        <span className="text-[10px] font-mono text-ink-faint uppercase tracking-wider">
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink-muted transition-colors"
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="bg-canvas-warm border border-t-0 border-canvas-sunken rounded-b-lg p-4 overflow-x-auto text-[13px] leading-relaxed font-mono text-ink-soft">
        <code>{code}</code>
      </pre>
    </div>
  );
}
