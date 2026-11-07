import React, { useMemo } from 'react';
import { buildWordDiffMap } from '../utils/wordDiff.js';

export function parseDiffLines(diffText) {
  // ---/+++ 文件头只在前两行:正文里被删/增的行本身以 `--`/`++` 开头(SQL 注释等)
  // 拼上 diff 符号后同为 ---/+++ 前缀,全局按前缀判会把它渲染成灰色文件头。
  return String(diffText || '').split('\n').map((text, i) => {
    if (i < 2 && (text.startsWith('+++') || text.startsWith('---'))) return { type: 'file', text };
    if (text.startsWith('@@')) return { type: 'hunk', text };
    if (text.startsWith('+')) return { type: 'add', text };
    if (text.startsWith('-')) return { type: 'del', text };
    return { type: 'ctx', text };
  });
}

// 文件头里取路径:优先 +++ b/<path>,新建 / 删除时 /dev/null 那侧不用。
function fileLabelOf(lines) {
  const pick = (prefix) => {
    const line = lines.find((l) => l.type === 'file' && l.text.startsWith(prefix));
    if (!line) return '';
    const p = line.text.slice(4).trim();
    return p === '/dev/null' ? '' : p.replace(/^[ab]\//, '');
  };
  return pick('+++') || pick('---');
}

const SIGN = { add: '+', del: '−', ctx: '' };

// r158:diff 跟随主题(设计稿 v8 ② Diff)。符号列单独成元素,整行底色取 --cg-add / --cg-del,
// 成对的删 / 增行做字级高亮;文件头一行带增删统计;没有内容的 @@ 行不画;不画行号(没有真实行号)。
// 对外签名(diff / maxHeight)与 parseDiffLines 导出保持:Edit 卡、文件改动面板、界面生成的 diff 共用。
export function DiffViewer({ diff, maxHeight = 'max-h-72' }) {
  const parsed = useMemo(() => {
    const lines = parseDiffLines(diff).filter((line) => line.text !== '');
    const rows = [];
    let adds = 0;
    let dels = 0;
    for (const line of lines) {
      if (line.type === 'file') continue;
      if (line.type === 'hunk') {
        const rest = line.text.replace(/^@@.*?@@/, '').trim();
        const label = /^@@.*@@/.test(line.text) ? rest : line.text.slice(2).trim();
        // 只有 `@@`、或 `@@ -a,b +c,d @@` 后面没有说明文字的行,对读者没有信息,不画
        if (label) rows.push({ type: 'hunk', content: label });
        continue;
      }
      if (line.type === 'add') { adds += 1; rows.push({ type: 'add', content: line.text.slice(1) }); continue; }
      if (line.type === 'del') { dels += 1; rows.push({ type: 'del', content: line.text.slice(1) }); continue; }
      rows.push({ type: 'ctx', content: line.text.startsWith(' ') ? line.text.slice(1) : line.text });
    }
    return { rows, adds, dels, fileLabel: fileLabelOf(lines), words: buildWordDiffMap(rows) };
  }, [diff]);

  const { rows, adds, dels, fileLabel, words } = parsed;
  if (rows.length === 0) {
    return <div className="text-[11px] text-ink-faint font-body px-3 py-2">没有可显示的 diff</div>;
  }

  return (
    <div className="tc-diff">
      <div className="tc-diff-file">
        <span title={fileLabel || undefined}>{fileLabel}</span>
        {(adds > 0 || dels > 0) && (
          <span className="tc-diff-stat" data-diff-stat="">
            {adds > 0 && <span className="tc-add">+{adds}</span>}
            {dels > 0 && <span className="tc-del">{'−'}{dels}</span>}
          </span>
        )}
      </div>
      <div className={`tc-diff-rows ${maxHeight}`}>
        {/* 内层网格宽 = 最宽那一行(至少铺满容器):横向滚动时短行的红绿底也铺到最右 */}
        <div className="tc-diff-inner">
          {rows.map((row, i) => {
            if (row.type === 'hunk') {
              return <div key={i} className="px-2.5 py-px text-ink-muted whitespace-pre">{row.content}</div>;
            }
            const segments = words.get(i);
            return (
              <div key={i} className="tc-dl" data-diff-line={row.type}>
                <span className="tc-sg" data-diff-sign="" aria-hidden="true">{SIGN[row.type]}</span>
                <span className="tc-tx">
                  {segments
                    ? segments.map((seg, k) => (seg.changed
                      ? <span key={k} className={row.type === 'add' ? 'tc-wd-add' : 'tc-wd-del'} data-diff-word={row.type}>{seg.text}</span>
                      : <React.Fragment key={k}>{seg.text}</React.Fragment>))
                    : (row.content || ' ')}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
