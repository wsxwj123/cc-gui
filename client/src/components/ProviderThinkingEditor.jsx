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
const EFFORT_LABELS = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '极限' };

export function ProviderThinkingEditor({ value, onChange, models, inputCls }) {
  const [pick, setPick] = useState('');
  // r15-3:只渲染【用户声明】的行。GET /api/providers 开始下发预填后,value 里混着服务端
  // 按目录判定的 catalog 条目(OpenRouter 这类 364 模型的 provider 能有几百条)——全渲染
  // 就是几百行 × 5 个复选框,把表单彻底淹掉,与本组件"只渲染已声明的"设计相悖。
  // catalog 条目折叠成一行只读摘要,用户仍可从下方下拉给它添加声明(即转成 user 条目)。
  const declared = Object.entries(value || {}).filter(([, e]) => e?.source !== 'catalog');
  const rows = declared.map(([id]) => id);
  const catalogCount = Object.keys(value || {}).length - rows.length;
  const undeclared = (models || []).filter((m) => !rows.includes(m));

  // r11-⑩:编辑器里的任何修改都盖 source:'user'(用户声明永不被目录预填覆盖;
  // 含"全默认"空声明——留着 source:'user' 墓碑压住目录)。source:'catalog' 只由
  // 服务端/fetch-models 预填产生,不单独成行(见上)。
  const addRow = (id) => {
    if (!id || rows.includes(id)) return;
    // 目录已判定过的模型:以目录判定为初值转成用户声明(保留原判定再让用户改,
    // 而不是一上来把它重置成全档)。
    onChange({ ...value, [id]: { ...(value?.[id] || {}), source: 'user' } });
    setPick('');
  };
  const removeRow = (id) => {
    // catalog 条目 delete 不掉:保存后服务端 applyCatalogPrefill 立刻把它补回来
    // (点了删除、保存、它又回来,且无任何反馈)。写 source:'user' 墓碑才压得住目录,
    // 语义正是按钮说的"回到全默认"。用户自己声明的行仍直接删。
    if (value?.[id]?.source === 'catalog') {
      onChange({ ...value, [id]: { source: 'user' } });
      return;
    }
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
          为模型声明思考支持情况。未声明的模型按内置目录自动判定，目录内查不到的视为支持全部档位。强度选择器将按此只列支持的档位；关闭思考的模型不传思考参数。
        </span>
      </div>
      {catalogCount > 0 && (
        <div className="rounded-lg border border-canvas-deep bg-canvas-warm/40 px-2.5 py-1.5 text-[11px] text-ink-faint"
          title="服务端按模型目录与实测数据表自动判定，不占用手动声明；在下方添加同名模型的声明即可覆盖该判定">
          已按模型目录自动判定 {catalogCount} 个模型的思考能力（含不支持思考与档位受限的型号）。若需覆盖某个判定，在下方为该模型添加声明。
        </div>
      )}
      {rows.map((id) => {
        const entry = value[id] || {};
        const think = entry.reasoning !== false;
        const efforts = Array.isArray(entry.efforts) && entry.efforts.length ? entry.efforts : EFFORT_ORDER;
        return (
          <div key={id} className="rounded-lg border border-canvas-deep bg-canvas-warm/60 px-2.5 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-[12px] font-mono text-ink truncate" title={id}>{id}</span>
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
