// r10-9:思考强度按模型自适应——能力查询与切模型回落(纯函数,单测钉住)。
// 数据源:GET /api/model 的 modelMeta(当前激活 provider 的 {[modelId]:{reasoning?,efforts?}};
// null/缺条目 = 无声明 = 全档可用,即官方与未声明模型维持现状)。
import { useEffect, useRef } from 'react';

// r15-2:五档,不含 minimal —— 依据是本机 CLI 2.1.235 的 `claude --help`,`--effort` 只接受
// low/medium/high/xhigh/max。与 server EFFORT_LEVEL_IDS / chat.js VALID_EFFORTS /
// ChatInput EFFORT_LEVELS 四处必须同一集合(单测钉住),漂了就会出现"算得出、传不过去"。
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

// r26-F6:per-model 力度记忆键带 provider 段 —— 旧键 `cgui-effort-<modelId>` 不带
// provider,同模型 id 在不同 provider 下力度记忆互相串。provider 取
// currentProvider.providerHint(与 sessionStore lastProviderBySession 同口径)。
// 旧键一次性忽略不迁移:旧键无 provider 段无法判定归属,记错的代价是一次重选,
// 迁移逻辑的正确性风险高于收益。
export function effortMemoryKey(providerHint, modelId) {
  const bare = String(modelId || '').replace(/\[1m\]/i, '');
  return `cgui-effort-${providerHint || 'anthropic'}-${bare}`;
}

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

// r26-F3:「当前档不被新模型支持时回落」的挂载钩子 —— 从 ChatInput EffortSelector
// 抽出,桌面顶栏与手机 MobileEffortPage 两端共用同一套判据(此前手机端只有显示层
// 过滤,没有持久化回落:选了不支持的档,界面说极高、发送静默摘空)。
// 语义逐字保留原 effect:
//   · permKey 变化(切窗格/会话/draft→真 sid)= 不算"换模型",但照样跑合法性检查;
//   · per-model 记忆只在真换了模型时参与(能力表变化路径要的是"拉回合法",不是拿
//     旧记忆覆盖用户刚选的档);
//   · meta(能力表)与 effort 在 deps 里:能力表异步到达 / 跨设备同步改档都触发重估。
// setEffort 由调用方注入(写哪个键它知道);onNotice 可选(桌面弹 toast,手机静默)。
export function useEffortFallback({ permKey, bareModelId, meta, effort, memoryKey, setEffort, onNotice }) {
  const lastModelRef = useRef({ permKey, model: bareModelId });
  useEffect(() => {
    const prev = lastModelRef.current;
    lastModelRef.current = { permKey, model: bareModelId };
    if (!bareModelId) return;
    const caps = effortCapsFor(meta, bareModelId);
    // 换了窗格/会话时两次的 model 不可比(是两个会话各自的模型),不算"换模型"。
    const paneChanged = prev.permKey !== permKey;
    const modelChanged = !paneChanged && !!prev.model && prev.model !== bareModelId;
    if (!modelChanged && effortAllowed(caps, effort || '')) return;
    let remembered = null;
    if (modelChanged && memoryKey) { try { remembered = localStorage.getItem(memoryKey); } catch {} }
    const r = resolveEffortOnModelChange(caps, effort, remembered);
    if (!r.changed) return;
    setEffort(r.effort);
    onNotice?.(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permKey, bareModelId, meta, effort, memoryKey]);
}
