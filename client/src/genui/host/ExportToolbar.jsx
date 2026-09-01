/**
 * r69 图表导出 —— 悬停工具条。
 *
 * 挂在 render-node 的分发点上(一处包一层就覆盖全部可导出类型,组件自己不需要知道
 * 导出的存在,和 ActionFeedback 同一条思路)。
 *
 * 交互:桌面悬停浮出、键盘聚焦也浮出;窄屏(<768px,与全仓手机断点同)没有 hover,
 * 改成常显 —— 否则手机上永远点不到。按钮尺寸 32px,对齐 genui-responsive.css 里
 * 滑块那条触控线的量级。
 *
 * **零外发**:本文件只 import 数据/图片/落盘三个导出模块和剪贴板工具,
 * 不碰 action-context / action-send —— 导出是纯本地动作,一个字节都不进对话。
 *
 * @module genui/host/ExportToolbar
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
// 图标必须走仓内间接层 Icon.jsx(全仓 lucide 唯一出口,check-icon-indirection 守着;
// 皮肤替换机制也挂在那一层,直连 lucide 的图标换不了皮)。
import { Check, Copy, Download, Image as ImageIcon } from '../../components/Icon.jsx';
import { copyText } from '../../utils/clipboard.js';
import { confirmDialog } from '../../utils/confirmDialog.jsx';
import { buildCopyText, buildCsv, exportFileName, exportPlan } from './export-data.js';
import { saveExport } from './export-save.js';

// 不用 backdrop-blur-*:全局扁平化把裸磨砂工具类列为红线(check-flat-tokens t5),
// 而这里本来也不需要 —— 画布色不透明就够压住底下的图形。
const BTN = 'flex h-8 w-8 items-center justify-center rounded-lg border border-canvas-deep bg-canvas '
  + 'text-ink-muted transition-colors hover:text-ink hover:bg-canvas-warm '
  + 'disabled:opacity-40 disabled:cursor-default';

function ToolButton({ label, testid, busy, done, icon, onClick }) {
  return (
    <button
      type="button"
      data-testid={testid}
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={onClick}
      className={BTN}
    >
      {done ? <Check size={14} className="text-success" /> : icon}
    </button>
  );
}

export function GenuiExportFrame({ node, children }) {
  const plan = exportPlan(node);
  const ref = useRef(null);
  const timerRef = useRef(null);
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const flash = useCallback((which) => {
    clearTimeout(timerRef.current);
    setDone(which);
    timerRef.current = setTimeout(() => setDone(''), 1500);
  }, []);

  const run = useCallback(async (which, make) => {
    setBusy(true);
    try {
      const res = await make();
      if (res !== null) flash(which);
    } catch (e) {
      await confirmDialog(`导出失败：${String(e?.message || e)}`, { danger: false });
    } finally {
      setBusy(false);
    }
  }, [flash]);

  if (plan === null) return children;

  const onCopy = () => run('copy', async () => {
    const ok = await copyText(buildCopyText(node));
    if (!ok) throw new Error('浏览器拒绝了剪贴板访问');
    return true;
  });

  // 落盘公共尾巴:用户在系统对话框里自己选了路径就只闪一下对勾;回落到 ~/Downloads
  // 时才弹一次提示——不然用户不知道文件去了哪。取消不算失败,也不闪对勾。
  const finish = async (res) => {
    if (res.canceled) return null;
    if (res.path && !res.chosen) await confirmDialog(`已导出到：\n${res.path}`, { danger: false });
    return true;
  };

  const onCsv = () => run('csv', async () => finish(await saveExport(
    new Blob([buildCsv(node)], { type: 'text/csv;charset=utf-8' }),
    exportFileName(node, 'csv'),
    'csv',
  )));

  // export-image 动态 import:它会按需拉 echarts,静态引进来会把引擎钉进主 chunk。
  const onPng = () => run('png', async () => {
    const { nodePngBlob } = await import('./export-image.js');
    return finish(await saveExport(await nodePngBlob(ref.current, node), exportFileName(node, 'png'), 'png'));
  });

  return (
    <div ref={ref} className="relative group/genui-export" data-genui-export>
      {children}
      <div
        data-testid="genui-export-toolbar"
        className="pointer-events-none absolute right-1 top-1 z-10 flex gap-1 opacity-0 transition-opacity
          group-hover/genui-export:pointer-events-auto group-hover/genui-export:opacity-100
          focus-within:pointer-events-auto focus-within:opacity-100
          max-md:pointer-events-auto max-md:opacity-100"
      >
        <ToolButton
          label={plan.copyLabel} testid="genui-export-copy" busy={busy} done={done === 'copy'}
          icon={<Copy size={14} />} onClick={onCopy}
        />
        {plan.csv && (
          <ToolButton
            label="下载 CSV" testid="genui-export-csv" busy={busy} done={done === 'csv'}
            icon={<Download size={14} />} onClick={onCsv}
          />
        )}
        {plan.png && (
          <ToolButton
            label="导出 PNG" testid="genui-export-png" busy={busy} done={done === 'png'}
            icon={<ImageIcon size={14} />} onClick={onPng}
          />
        )}
      </div>
    </div>
  );
}
