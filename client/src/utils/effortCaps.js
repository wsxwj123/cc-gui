// r10-9:思考强度按模型自适应——能力查询与切模型回落(纯函数,单测钉住)。
// 数据源:GET /api/model 的 modelMeta(当前激活 provider 的 {[modelId]:{reasoning?,efforts?}};
// null/缺条目 = 无声明 = 全档可用,即官方与未声明模型维持现状)。

export const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 当前模型的能力。查询剥 [1m] 后缀(1M 变体与本体同能力)。
export function effortCapsFor(modelMeta, modelId) {
  const bare = String(modelId || '').replace(/\[1m\]/i, '');
  const entry = modelMeta && typeof modelMeta === 'object' ? modelMeta[bare] : null;
  return {
    reasoning: entry?.reasoning === false ? false : true,
    efforts: Array.isArray(entry?.efforts) && entry.efforts.length ? entry.efforts : null,
  };
}

// 某档在该模型下是否可用。''(默认档=不传 --effort)在支持思考时恒可用;
// reasoning:false 时任何非空档都不可用(锁 off)。
export function effortAllowed(caps, effortId) {
  if (!effortId) return caps.reasoning !== false;
  if (caps.reasoning === false) return false;
  return !caps.efforts || caps.efforts.includes(effortId);
}

// 切模型时的档位解算:锁思考 → 清档;该模型的记忆档合法 → 优先;当前档合法 → 保留;
// 否则回落该模型最高可用档(无 efforts 声明时不会走到 fallback——任何档都合法)。
export function resolveEffortOnModelChange(caps, current, remembered) {
  if (caps.reasoning === false) {
    return { effort: '', changed: !!current, reason: 'locked' };
  }
  if (remembered != null && remembered !== current && effortAllowed(caps, remembered)) {
    return { effort: remembered, changed: true, reason: 'remembered' };
  }
  if (effortAllowed(caps, current || '')) {
    return { effort: current || '', changed: false, reason: 'kept' };
  }
  const supported = caps.efforts || EFFORT_ORDER;
  const highest = [...EFFORT_ORDER].reverse().find((e) => supported.includes(e)) || '';
  return { effort: highest, changed: true, reason: 'fallback' };
}
