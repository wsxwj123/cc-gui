import React, { useState } from 'react';
import { Terminal } from '../Icon.jsx';
import { Linkify } from '../../utils/linkify.jsx';
import { ToolResultImages } from './ToolResultImages.jsx';
import { ToolCardShell, cardStatusOf } from './ToolCardShell.jsx';
import { ThemedCopyButton } from '../ThemedCopyButton.jsx';

const MAX_OUTPUT_CHARS = 16000;
const COMMAND_SEPARATORS = new Set(['|', '||', '&&', ';', '&']);

// 命令三档着色:命令词(每段第一个词)ink 加粗 / 参数 ink-soft / 数字与 --flag accent。
// 只按空白切词,不做 shell 语法解析——着色是辅助阅读,切错也不影响命令原文。
function CommandTokens({ command }) {
  let expectCommandWord = true;
  return command.split(/(\s+)/).map((token, i) => {
    if (token === '' || /^\s+$/.test(token)) return token;
    let className = 'tc-tok-arg';
    if (COMMAND_SEPARATORS.has(token)) {
      expectCommandWord = true;
    } else if (expectCommandWord) {
      className = 'tc-tok-cmd';
      expectCommandWord = false;
    } else if (/^--\S/.test(token) || /^-?\d+(\.\d+)?$/.test(token)) {
      className = 'tc-tok-num';
    }
    return <span key={i} className={className}>{token}</span>;
  });
}

// 失败结果以「Exit code N」开头时,把这一行拿出来写进状态条,输出区不再重复显示。
function splitExitCode(output, isError) {
  if (!isError) return { exitCode: null, body: output };
  const m = /^Exit code (\d+)[^\S\n]*(?:\n|$)/.exec(output);
  if (!m) return { exitCode: null, body: output };
  return { exitCode: m[1], body: output.slice(m[0].length) };
}

function countLines(text) {
  const trimmed = text.replace(/\n+$/, '');
  return trimmed === '' ? 0 : trimmed.split('\n').length;
}

export function BashCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const cmd = toolCall.input?.command || '';
  const desc = toolCall.input?.description || '';
  const result = toolCall.result;
  const isError = !!result?.isError;
  const output = typeof result?.content === 'string' ? result.content : '';
  const { exitCode, body } = splitExitCode(output, isError);
  const lineCount = countLines(body);
  const linesText = lineCount > 0 ? `输出 ${lineCount} 行` : '无输出';
  let footText = '';
  if (result) {
    if (!isError) footText = lineCount > 0 ? `成功 · ${linesText}` : '无输出';
    else footText = `${exitCode != null ? `退出码 ${exitCode}` : '失败'} · ${linesText}`;
  }

  return (
    <ToolCardShell
      toolName={toolCall.name || 'Bash'}
      status={cardStatusOf(result)}
      Icon={Terminal}
      title={desc || cmd || '(empty)'}
      titleMono={!desc}
      titleHint={cmd}
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
    >
      {/* r132:工具结果里的图片(以前只有 MCP 卡出图) */}
      {result && (
        <ToolResultImages images={result.images} name={toolCall.name || 'Bash'} className="pb-2" />
      )}
      <div className="tc-term">
        <div className="tc-term-cmd" data-term-cmd="">
          <span className="tc-prompt" aria-hidden="true">$</span>
          <code>{cmd ? <CommandTokens command={cmd} /> : '(empty)'}</code>
          {cmd && <ThemedCopyButton text={cmd} />}
        </div>
        {result && body.trim() !== '' && (
          <pre className="tc-term-out" data-term-out="">
            <Linkify text={body.slice(0, MAX_OUTPUT_CHARS)} />
          </pre>
        )}
        {result && (
          <div className="tc-term-foot" data-term-foot="" data-ok={isError ? 'false' : 'true'}>
            {footText}
          </div>
        )}
      </div>
    </ToolCardShell>
  );
}
