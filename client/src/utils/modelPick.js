// r52 模型勾选的纯逻辑(与 React 无关,单测直击;组件在 components/ModelPickModal.jsx)。
// 勾选态 = 白名单数组:在列表里 = 被勾选,全量目录只进弹窗不落盘。

// 中转站的 /v1/models 噪音极大(嵌入/语音/视频/重排模型混在里面)。只过滤**拉取候选**,
// 手输永不受限 —— 这些关键词也可能出现在正经生图/文本模型名里,拦手输会挡住合法用法。
export const JUNK_MODEL_RE = /embedding|tts|whisper|video|flux|rerank/i;

export function stripJunkModels(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id) => typeof id === 'string' && id.trim() && !JUNK_MODEL_RE.test(id));
}

// 子串过滤,不区分大小写(不做 fuzzy:模型 id 是精确串,模糊匹配只会把噪音排前面)。
export function filterModels(candidates, query) {
  const list = Array.isArray(candidates) ? candidates : [];
  const q = (query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((id) => String(id).toLowerCase().includes(q));
}

// 「全选」的目标:**只**当前筛选结果内、且尚未添加的。上百模型时这是唯一不炸的语义 ——
// 全选整个目录会把几百条噪音一次性灌进白名单,且已添加项被重复勾选毫无意义。
export function selectAllTargets(filtered, existing) {
  const set = existing instanceof Set ? existing : new Set(Array.isArray(existing) ? existing : []);
  return (Array.isArray(filtered) ? filtered : []).filter((id) => !set.has(id));
}

// 合并:保留原行序 → 追加新勾选的 → 去重。**绝不删除**已有项:重新拉取只增不减,
// 删除权只在用户手上(手动改文本域/编辑 provider)。入参数组不就地修改。
export function mergeModelLines(existingLines, checkedIds) {
  const out = [];
  const seen = new Set();
  for (const raw of [...(existingLines || []), ...(checkedIds || [])]) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
