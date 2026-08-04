import React, { useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { confirmDialog } from '../utils/confirmDialog.jsx';

// R3:Provider 表单里的「计价」编辑器 —— 用户为该 provider 的每个模型填实付单价。
// 存进 provider 条目的 modelPrices,查价时优先级最高(client/src/utils/pricing.js)。
//
// 为什么需要它:内置价表算不准两类情况 ——
//   ① 中转站按服务商自定价(通常低于官网),而 jsonl 不记 baseURL/provider,事后反推不了;
//   ② 套餐包月付的是月费,按 token 单价算出的金额没有意义。
// 只有用户知道实付多少。
//
// 交互按"懒"设计:provider 可能有几十个模型,**不给每个模型渲染一行**,只渲染用户已填价的,
// 其余用一个添加器按需加。
//
// 状态形态:{ [modelId]: { in, out, cacheRead, cacheWrite, plan } },四个价格字段是**字符串**
// (输入框原样,允许中途的 '1.'),plan 是布尔。父级保存时转数字。
const FIELDS = [
  ['in', '输入', '未命中缓存的新输入'],
  ['out', '输出', '模型生成的 token'],
  ['cacheRead', '缓存命中', '留空 = 输入价 × 0.1'],
  ['cacheWrite', '缓存写入', '留空 = 输入价 × 1.25'],
];

export function ProviderPriceEditor({ value, onChange, models, inputCls }) {
  const [pick, setPick] = useState('');      // 从模型列表选
  const [manual, setManual] = useState('');  // 手输不在列表里的 id
  const rows = Object.keys(value || {});
  const unpriced = (models || []).filter((m) => !rows.includes(m));

  const addRow = (id) => {
    const key = (id || '').trim();
    if (!key || rows.includes(key)) return;
    onChange({ ...value, [key]: { in: '', out: '', cacheRead: '', cacheWrite: '', plan: false } });
  };
  const patchRow = (id, patch) => onChange({ ...value, [id]: { ...value[id], ...patch } });
  const removeRow = async (id) => {
    // Tauri 的 WKWebView/WebView2 禁用了原生 window.confirm(点了没反应)→ 一律走 confirmDialog。
    const ok = await confirmDialog(`删除「${id}」的单价配置?该模型的费用将回落内置官网价。`, {
      danger: true, confirmText: '删除',
    });
    if (!ok) return;
    const next = { ...value };
    delete next[id];
    onChange(next);
  };
  // 价格框只收数字与小数点(负号/字母/多个点都挡掉),避免提交后被后端静默丢弃。
  const clean = (s) => s.replace(/[^\d.]/g, '').replace(/^(\d*\.?\d*).*$/, '$1');

  return (
    <div className="space-y-1.5 pt-0.5">
      <div className="text-[11px] text-ink-faint">
        计价（可选）
        <span className="text-ink-faint/70 ml-1">
          单位为人民币元 / 每百万 token。填写后该模型的费用按此单价计算，优先于内置官网价。
        </span>
      </div>
      {rows.length === 0 && (
        <div className="text-[11px] text-ink-faint/70 leading-relaxed">
          未填写任何模型单价。费用按内置官网价估算，并在费用提示中标注为估算。
          若经中转站接入或按套餐计费，则在此填写实付单价。
        </div>
      )}
      {rows.map((id) => {
        const row = value[id] || {};
        return (
          <div key={id} className="rounded-lg border border-canvas-deep bg-canvas-warm/60 px-2.5 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[12px] font-mono text-ink truncate" title={id}>{id}</span>
              <label className="flex items-center gap-1 text-[11px] text-ink-muted cursor-pointer shrink-0"
                title="若该模型按套餐或订阅计费，则勾选此项：费用栏只显示用量，不显示金额。">
                <input type="checkbox" checked={!!row.plan} className="accent-[var(--color-accent)]"
                  onChange={(e) => patchRow(id, { plan: e.target.checked })} />
                套餐包月
              </label>
              <button onClick={() => removeRow(id)} title="删除该模型的单价配置"
                className="p-1 text-ink-faint hover:text-red-500 shrink-0"><Trash2 size={13} /></button>
            </div>
            {row.plan ? (
              <div className="text-[10px] text-ink-faint/80">按套餐计费，费用栏只显示用量，不显示金额。</div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {FIELDS.map(([k, label, hint]) => (
                  <label key={k} className="flex items-center gap-1.5" title={hint}>
                    <span className="text-[10px] text-ink-faint shrink-0 w-11 text-right">{label}</span>
                    <input value={row[k] || ''} inputMode="decimal" placeholder="¥"
                      onChange={(e) => patchRow(id, { [k]: clean(e.target.value) })}
                      className={`${inputCls} font-mono !py-1 !text-[12px]`} />
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {rows.length > 0 && (
        <div className="text-[10px] text-ink-faint/70 leading-relaxed">
          输入价或输出价留空，则该项回落内置官网价；缓存命中价与缓存写入价留空，则分别按输入价的
          0.1 倍与 1.25 倍计算。留空不等于 0。
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <select value={pick} onChange={(e) => { addRow(e.target.value); setPick(''); }}
          className={`${inputCls} flex-1 min-w-0 cursor-pointer font-mono !py-1.5 !text-[12px]`}
          title="选一个模型为它填单价。选项来自上方「模型」框；不在列表里的 id 用右侧输入框手输。">
          <option value="">{unpriced.length ? '— 添加模型计价 —' : '— 模型均已配置 —'}</option>
          {unpriced.map((m) => (<option key={m} value={m}>{m}</option>))}
        </select>
        <input value={manual} onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(manual); setManual(''); } }}
          placeholder="或手输 model id"
          className={`${inputCls} flex-1 min-w-0 font-mono !py-1.5 !text-[12px]`}
          title="计价按消息里的真实 model id 匹配。上游返回的 id 与「模型」框里填的不一致时，在此手输真实 id。" />
        <button onClick={() => { addRow(manual); setManual(''); }} disabled={!manual.trim()}
          className="p-1.5 text-accent disabled:opacity-40 shrink-0" title="添加该 model id 的单价行">
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}
