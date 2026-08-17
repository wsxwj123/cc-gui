import React, { useState } from 'react';
import { Trash2 } from './Icon.jsx';
import { EFFORT_ORDER } from '../utils/effortCaps.js';

// r10-9:Provider 表单里的「思考能力」编辑器 —— 为每个模型声明是否支持思考、支持哪些档。
// 存进 provider 条目的 modelMeta;强度选择器按当前模型自适应(锁灰/只列支持档/回落)。
// 交互沿用 ProviderPriceEditor 的"懒"设计:不给每个模型渲染一行,只渲染已声明的,
// 其余用添加器按需加。未声明 = 全档可用(现状,向后兼容)。
//
// 状态形态(与后端 modelMeta 同构):{ [modelId]: { reasoning?:false, efforts?:string[] } }。
// 行内空对象 {} = 全默认(保存时后端 sanitize 自然丢弃,不落盘)。
const EFFORT_LABELS = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '极限' };

export function ProviderThinkingEditor({ value, onChange, models, inputCls }) {
  const [pick, setPick] = useState('');
  const rows = Object.keys(value || {});
  const undeclared = (models || []).filter((m) => !rows.includes(m));

  // r11-⑩:编辑器里的任何修改都盖 source:'user'(用户声明永不被目录预填覆盖;
  // 含"全默认"空声明——留着 source:'user' 墓碑压住目录)。source:'catalog' 只由
  // 服务端/fetch-models 预填产生,行上显示"目录预填,可修改"。
  const addRow = (id) => {
    if (!id || rows.includes(id)) return;
    onChange({ ...value, [id]: { source: 'user' } });
    setPick('');
  };
  const removeRow = (id) => {
    const next = { ...value };
    delete next[id];
    onChange(next);
  };
  const setThink = (id, on) => {
    onChange({ ...value, [id]: on ? { source: 'user' } : { reasoning: false, source: 'user' } });
  };
  const toggleEffort = (id, effortId) => {
    const entry = value[id] || {};
    const cur = Array.isArray(entry.efforts) && entry.efforts.length ? entry.efforts : [...EFFORT_ORDER];
    const next = cur.includes(effortId) ? cur.filter((e) => e !== effortId) : [...cur, effortId];
    const ordered = EFFORT_ORDER.filter((e) => next.includes(e));
    // 全选/全不选 = 回到全默认(不声明档位);部分选中才写 efforts。
    onChange({ ...value, [id]: (ordered.length === 0 || ordered.length === EFFORT_ORDER.length) ? { source: 'user' } : { efforts: ordered, source: 'user' } });
  };

  return (
    <div className="space-y-1.5 pt-0.5">
      <div className="text-[11px] text-ink-faint">
        思考能力（可选）
        <span className="text-ink-faint/70 ml-1">
          为模型声明思考支持情况。未声明的模型视为支持全部档位。强度选择器将按此只列支持的档位；关闭思考的模型不传思考参数。
        </span>
      </div>
      {rows.map((id) => {
        const entry = value[id] || {};
        const think = entry.reasoning !== false;
        const efforts = Array.isArray(entry.efforts) && entry.efforts.length ? entry.efforts : EFFORT_ORDER;
        return (
          <div key={id} className="rounded-lg border border-canvas-deep bg-canvas-warm/60 px-2.5 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-[12px] font-mono text-ink truncate" title={id}>{id}</span>
              {entry.source === 'catalog' && (
                <span className="text-[10px] text-ink-faint shrink-0" title="按模型家族目录自动预填的声明；任意修改后即视为手动声明，不再被目录覆盖">目录预填，可修改</span>
              )}
              <label className="flex items-center gap-1 text-[11px] text-ink-muted cursor-pointer shrink-0">
                <input type="checkbox" checked={think} onChange={(e) => setThink(id, e.target.checked)} className="accent-[var(--color-accent)]" />
                支持思考
              </label>
              <button onClick={() => removeRow(id)} title="移除声明(回到全默认)"
                className="p-1 text-ink-faint hover:text-error shrink-0"><Trash2 size={12} /></button>
            </div>
            {think && (
              <div className="flex items-center gap-2 flex-wrap">
                {EFFORT_ORDER.map((e) => (
                  <label key={e} className="flex items-center gap-1 text-[11px] text-ink-muted cursor-pointer">
                    <input type="checkbox" checked={efforts.includes(e)} onChange={() => toggleEffort(id, e)} className="accent-[var(--color-accent)]" />
                    {EFFORT_LABELS[e]}
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {undeclared.length > 0 && (
        <select value={pick} onChange={(e) => addRow(e.target.value)}
          className={`${inputCls} cursor-pointer font-mono`} title="为某个模型添加思考能力声明">
          <option value="">— 添加模型的思考声明 —</option>
          {undeclared.map((m) => (<option key={m} value={m}>{m}</option>))}
        </select>
      )}
    </div>
  );
}
