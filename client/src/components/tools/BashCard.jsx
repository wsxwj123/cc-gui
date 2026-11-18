import React, { useContext, useState } from 'react';
import { Terminal, Layers } from '../Icon.jsx';
import { Linkify } from '../../utils/linkify.jsx';
import { ToolResultImages } from './ToolResultImages.jsx';
import { ToolCardShell, cardStatusOf } from './ToolCardShell.jsx';
import { ThemedCopyButton } from '../ThemedCopyButton.jsx';
import { TaskOwnerContext } from './TaskCard.jsx';
import { useStore } from '../../stores/sessionStore.js';
import { confirmDialog } from '../../utils/confirmDialog.jsx';
import {
  isMovedToBackground, parseBackgroundDeadline, buttonMoveDialogText, canMoveToBackground, ownedMovedEntry,
  MOVE_TO_BG_HINT, LONG_FG_TIMEOUT_MS, longTimeoutConfirmText,
} from '../../utils/movedToBackground.js';

// r198:「移到后台」按钮。只转这一条(请求带 toolUseId);前台时限超过 30 分钟的先确认。点击期间禁用,结果按归一表
// 弹框(转成了不弹,卡片自己会变)。挂在卡头 / 工作组头行的 <button> 里,所以写成 role=button 的 span 并拦住冒泡
// (不开合卡片或工作组)。工作组收起时由头行挂(TurnBubble 的 WorkGroup),展开后由命令卡片自己挂,同一时刻只有一个。
export function MoveToBgButton({ toolCall, sessionId }) {
  const [busy, setBusy] = useState(false);
  const run = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    const timeoutMs = toolCall.input?.timeout;
    if (typeof timeoutMs === 'number' && timeoutMs > LONG_FG_TIMEOUT_MS) {
      if (!(await confirmDialog(longTimeoutConfirmText(timeoutMs)))) return;
    }
    setBusy(true);
    let result = null;
    try { result = await useStore.getState().moveToBackground(sessionId, toolCall.id); }
    finally { setBusy(false); }   // 先恢复可点,再弹框(弹框不挡按钮状态)
    const text = buttonMoveDialogText(result);
    if (text) void confirmDialog(text);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label="移到后台"
      aria-disabled={busy ? 'true' : undefined}
      title={MOVE_TO_BG_HINT}
      data-cgui="move-to-bg-btn"
      onClick={run}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') run(e); }}
      className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-ink-muted hover:text-ink hover:bg-canvas-warm transition-colors ${busy ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
    >
      <Layers size={12} />
    </span>
  );
}

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
  const cmd = toolCall.input?.command || '';
  const desc = toolCall.input?.description || '';
  const result = toolCall.result;
  const ownerSid = useContext(TaskOwnerContext);
  // r198:被转到后台的前台命令:卡头写「已移到后台」,底栏写任务编号与能从原句读到的后台时限,不出现「成功」;
  // 默认展开(底栏就是这张卡要交代的事),用户手动开合以手动为准。判定两个来源:工具结果上的结构化标记(直播与
  // 回看历史同一口径),或状态库里按 tool_use_id 记的已转走记录 —— 两个窗格开同一会话时,没收到这条流里工具
  // 结果的那个窗格靠它与另一窗格一致。
  const movedEntry = ownedMovedEntry(useStore((s) => s.bgTasks[toolCall.id]), ownerSid);
  const moved = isMovedToBackground(result) || !!movedEntry;
  const [expandedByUser, setExpanded] = useState(null);
  const expanded = expandedByUser ?? moved;
  // 「移到后台」按钮:前台任务表里有这条、还没出结果、没被记为已转走、卡片属主与任务所属会话一致(分支复制出的卡片不显示)。
  const fgEntry = useStore((s) => s.fgTasks[toolCall.id]);
  const showMoveBtn = !movedEntry && canMoveToBackground(toolCall, fgEntry, ownerSid);
  const isError = !!result?.isError;
  const output = typeof result?.content === 'string' ? result.content : '';
  const { exitCode, body } = splitExitCode(output, isError);
  const lineCount = countLines(body);
  const linesText = lineCount > 0 ? `输出 ${lineCount} 行` : '无输出';
  let footText = '';
  if (moved) {
    const taskId = result?.bgTaskId || movedEntry?.shellId || null;
    const deadline = parseBackgroundDeadline(output) || movedEntry?.deadline || null;
    footText = `已移到后台运行${taskId ? ` · 任务 ${taskId}` : ''}${deadline ? ` · 后台最长 ${deadline},到点由命令行停止` : ''}`;
  } else if (result) {
    if (!isError) footText = lineCount > 0 ? `成功 · ${linesText}` : '无输出';
    else footText = `${exitCode != null ? `退出码 ${exitCode}` : '失败'} · ${linesText}`;
  }

  return (
    <ToolCardShell
      toolName={toolCall.name || 'Bash'}
      status={moved && !result ? 'ok' : cardStatusOf(result)}
      Icon={Terminal}
      title={desc || cmd || '(empty)'}
      titleMono={!desc}
      titleHint={cmd}
      meta={moved ? '已移到后台' : null}
      headExtra={showMoveBtn ? <MoveToBgButton toolCall={toolCall} sessionId={fgEntry.sessionId || ownerSid} /> : null}
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
            <Linkify text={body} />
          </pre>
        )}
        {(result || moved) && (
          <div className="tc-term-foot" data-term-foot="" data-ok={isError ? 'false' : 'true'}>
            {footText}
          </div>
        )}
      </div>
    </ToolCardShell>
  );
}
