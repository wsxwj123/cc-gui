// Midjourney 参数编译层:面板控件 → 提示词末尾的 `--flag`。
// 纯函数、零依赖(不 import 任何 node 内置),前端经 client/src/utils/mjParams.js 再导出。
//
// 为什么一律编译成 flag:`--s/--c/--seed` 这套是 Midjourney 自己的语法,不管中转站是
// apimart 还是 midjourney-proxy 都原样吃;结构化 body 字段则每家一套。所以通用层是 flag,
// body 字段只在 apimart(carrier 'mj')那条上作为"承载方式"记在 viaBody 里。
//
// 三条不许破的线:
//  ① 越界【丢弃】不钳位 —— 把用户填的 9999 悄悄改成 1000 是替他做一个会计费的决定;
//  ② 提示词里手写过同名 flag 就不再产出 —— 两个 `--ar` 上游只认一个,谁赢说不准;
//  ③ 空值不发,无例外 —— 裸 `--p` 之类是上游 400 的常客。

export const MJ_PARAM_FIELDS = [
  'stylize', 'chaos', 'weird', 'seed', 'quality', 'stop', 'tile', 'styleRaw',
  'draft', 'hd', 'negative', 'repeat', 'profile', 'extraFlags',
];

// 垫图传法(仅 apimart 形态的 `mj` 协议有意义):各站对 base64 的接受度不一致,
// 写死等于把适配权从用户手里拿走。
export const MJ_REF_MODES = ['upload', 'inline', 'url'];
export const MJ_REF_MODE_DEFAULT = { mj: 'upload', 'mj-proxy': '' };

const SPEED_VALUES = ['', 'relax', 'fast', 'turbo'];

// 恒定区间(与版本无关)。[min, max],闭区间。
const FIXED_RANGES = {
  stylize: [0, 1000], chaos: [0, 100], weird: [0, 3000], seed: [0, 4294967295],
  stop: [10, 100], repeat: [2, 40], cw: [0, 100], ow: [1, 1000], sw: [0, 1000],
};

// 版本档 → 能力。fields 只列"控件/可编译字段";ar 与 extraFlags 不受版本门管(见 ALWAYS)。
const COMMON = ['stylize', 'chaos', 'weird', 'seed', 'tile', 'styleRaw', 'negative', 'repeat', 'iw'];
const ALWAYS = ['ar', 'extraFlags'];
const FAMILIES = {
  v5: { fields: [...COMMON, 'stop'], quality: null, iw: [0.5, 2] },
  v6: { fields: [...COMMON, 'quality', 'stop', 'cref', 'cw', 'sref', 'sw', 'profile'], quality: ['0.5', '1', '2'], iw: [0, 3] },
  v7: { fields: [...COMMON, 'quality', 'draft', 'oref', 'ow', 'sref', 'sw', 'profile'], quality: ['1', '2', '4'], iw: [0, 3] },
  v8: { fields: [...COMMON, 'hd', 'sref', 'sw', 'profile'], quality: ['1', '2', '4'], iw: [0, 3],
    disabled: {
      quality: '8.x 不支持 --q(质量档由上游固定)',
      draft: '--draft 只在 v7 可用',
      speedTurbo: '该版本不支持 turbo:提交时按 fast 下发并按 fast 计费',
    } },
  niji6: { fields: [...COMMON, 'quality', 'stop', 'cref', 'cw', 'sref', 'sw', 'profile'], quality: ['0.5', '1', '2'], iw: [0, 3] },
  niji7: { fields: [...COMMON, 'quality', 'sref', 'sw', 'profile'], quality: ['1', '2', '4'], iw: [0, 2] },
};
// 版本下拉值 → 档。未登记/空/非串一律按 8.2(= 上游默认档)。
const VERSION_TABLE = {
  5.1: ['v5', '5.1', false], 5.2: ['v5', '5.2', false], 6.1: ['v6', '6.1', false],
  7: ['v7', '7', false], 8.1: ['v8', '8.1', false], 8.2: ['v8', '8.2', false],
  niji6: ['niji6', '6', true], niji7: ['niji7', '7', true],
};

/** 版本 → { family, base, niji, fields, ranges, disabled }。未知输入一律 8.2 档。 */
export function mjCapsFor(version) {
  const key = typeof version === 'string' ? version.trim() : '';
  const [family, base, niji] = VERSION_TABLE[key] || ['v8', '8.2', false];
  const f = FAMILIES[family];
  return {
    family,
    base,
    niji,
    fields: [...f.fields],
    ranges: { ...FIXED_RANGES, iw: [...f.iw], ...(f.quality ? { quality: [...f.quality] } : {}) },
    disabled: { ...(f.disabled || {}) },
  };
}

/**
 * 8.x + turbo:官方不支持,而 apimart 实测【照 turbo 收钱且耗时无差】(实付 2.22 倍)——
 * 所以降级不只是避免上游不认,是实打实省钱。
 * 只作用于"下发与预览",【不改落盘值】:改写用户配置的话,版本切回 7 时 turbo 再也回不来。
 */
export function mjEffectiveSpeed(version, speed) {
  const s = typeof speed === 'string' ? speed.trim().toLowerCase() : speed;
  if (!SPEED_VALUES.includes(s)) return { speed, note: '' };
  if (s === 'turbo' && mjCapsFor(version).family === 'v8') {
    return { speed: 'fast', note: '该版本不支持 turbo:提交时按 fast 下发并按 fast 计费。' };
  }
  return { speed, note: '' };
}

/** provider → 垫图传法。mj-proxy 固定走 base64Array,恒返回空串(忽略用户填的任何值)。 */
export function mjRefModeFor(provider) {
  const protocol = provider && typeof provider === 'object' ? provider.protocol : '';
  const fallback = MJ_REF_MODE_DEFAULT[protocol];
  if (!fallback) return '';
  const mode = provider.mjRefMode;
  return MJ_REF_MODES.includes(mode) ? mode : fallback;
}

// ───────────────────────────── 编译层 ─────────────────────────────
// 声明序 = 输出顺序(与传入键序无关:同一份参数在两台机器上必须编出同一个串)。
// kind:num 数值 / bool 开关 / enum 枚举 / text 自由文本 / url 参考图链接 / ratio 宽高比。
const SPEC = [
  { field: 'ar', flag: '--ar', kind: 'ratio' },
  { field: 'stylize', flag: '--s', kind: 'num' },
  { field: 'chaos', flag: '--c', kind: 'num' },
  { field: 'weird', flag: '--weird', kind: 'num' },
  { field: 'seed', flag: '--seed', kind: 'num' },
  { field: 'quality', flag: '--q', kind: 'enum' },
  { field: 'stop', flag: '--stop', kind: 'num' },
  { field: 'tile', flag: '--tile', kind: 'bool' },
  { field: 'styleRaw', flag: '--style raw', kind: 'bool' },
  { field: 'draft', flag: '--draft', kind: 'bool' },
  { field: 'hd', flag: '--hd', kind: 'bool' },
  { field: 'negative', flag: '--no', kind: 'text' },
  { field: 'repeat', flag: '--r', kind: 'num', needsFast: true },
  { field: 'profile', flag: '--p', kind: 'text' },
  { field: 'iw', flag: '--iw', kind: 'num' },
  { field: 'cref', flag: '--cref', kind: 'url' },
  { field: 'cw', flag: '--cw', kind: 'num' },
  { field: 'oref', flag: '--oref', kind: 'url' },
  { field: 'ow', flag: '--ow', kind: 'num' },
  { field: 'sref', flag: '--sref', kind: 'url', allowCode: true },
  { field: 'sw', flag: '--sw', kind: 'num' },
  { field: 'extraFlags', flag: '', kind: 'raw' },
];

const MAX_FLAGS_LEN = 512;             // 我方保守值,只数 flags 段(prompt 本体不计入)
const CTRL_RE = /[\u0000-\u001f\u007f]/; // 换行 / 回车 / 制表符 / 其它控制字符
const RATIO_RE = /^\d+:\d+$/;
const URL_RE = /^https?:\/\/\S+$/;

const isBlank = (v) => v === '' || v === null || v === undefined;
// 假值开关:false / 'false' / 0 都算"没开",不进 dropped(没填不是填错)。
const isOff = (v) => v === false || v === 0 || v === '0' || String(v).trim().toLowerCase() === 'false';

/** 提示词里是否已手写同名 flag。`--seedling` 不算命中 `--seed`(按 token 边界比)。 */
function inPrompt(prompt, flag) {
  const head = flag.split(' ')[0];
  if (!head) return false;
  const esc = head.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(^|\\s)${esc}(\\s|$)`).test(prompt);
}

function compileOne(spec, raw, caps, ctx) {
  const { field, kind } = spec;
  if (kind === 'bool' ? isOff(raw) || isBlank(raw) : isBlank(raw)) return null; // 未填
  const gated = ALWAYS.includes(field) || caps.fields.includes(field);
  if (!gated) return { drop: 'unsupported-version' };
  if (spec.needsFast && !['fast', 'turbo'].includes(ctx.speed)) return { drop: 'needs-fast-speed' };
  if (spec.flag && inPrompt(ctx.prompt, spec.flag)) return { drop: 'already-in-prompt' };

  if (kind === 'bool') return { value: '' };
  if (kind === 'num') {
    const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
    const [min, max] = caps.ranges[field] || [-Infinity, Infinity];
    if (!Number.isFinite(n) || n < min || n > max) return { drop: 'out-of-range' };
    return { value: String(n) };
  }
  if (kind === 'enum') {
    const s = String(raw).trim();
    const allowed = caps.ranges[field];
    if (!Array.isArray(allowed) || !allowed.includes(s)) return { drop: 'out-of-range' };
    return { value: s };
  }
  if (kind === 'ratio') {
    const s = String(raw).trim();
    return RATIO_RE.test(s) ? { value: s } : { drop: 'out-of-range' };
  }
  // 以下都是字符串:注入过滤统一在这里 —— 用户填的值会原样拼进提示词,
  // 混进一个 `--` 就等于让他改写别的参数(甚至塞上游不认的命令)。
  const s = String(raw);
  // extraFlags 是逃生口:它【本来就该】含 `--`,只挡控制字符与换行。
  if (kind === 'raw') return CTRL_RE.test(s) ? { drop: 'illegal-chars' } : { value: s.trim() };
  if (s.includes('--') || CTRL_RE.test(s)) return { drop: 'illegal-chars' };
  if (kind === 'url') {
    const v = s.trim();
    // --sref 另收 style code 与 random(官方语义,不是 URL)。
    if (spec.allowCode && (v === 'random' || /^\d+$/.test(v))) return { value: v };
    return URL_RE.test(v) ? { value: v } : { drop: 'illegal-chars' };
  }
  const v = s.trim();
  return v ? { value: v } : null;
}

/**
 * 参数 → { flags, parts, dropped, viaBody, prompt }。
 * carrier 'mj'(apimart)时比例/版本/速度改由 body 结构化字段承载 → 记进 viaBody 而不是 flags;
 * carrier 'mj-proxy' 时只有速度走 body(accountFilter.modes),比例进 flags。
 * 版本 flag(--v/--niji)不在本函数产出 —— 它由 mj-proxy 方言层按需拼在提示词末尾。
 */
export function compileMjFlags(params, opts) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : null;
  const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : null;
  const empty = { flags: '', parts: [], dropped: [], viaBody: [], prompt: '' };
  if (!p || !o) return { ...empty, prompt: !p ? '' : String(o?.prompt || '') };

  const prompt = String(o.prompt || '');
  const carrier = o.carrier === 'mj' ? 'mj' : 'mj-proxy';
  const version = typeof o.version === 'string' ? o.version.trim() : '';
  const speed = typeof o.speed === 'string' ? o.speed.trim().toLowerCase() : '';
  const caps = mjCapsFor(version);
  const ctx = { prompt, speed };
  const parts = [];
  const dropped = [];
  const viaBody = [];

  for (const spec of SPEC) {
    // apimart 的比例走 body.size,不编译成 flag;但"提示词里已手写 --ar"仍要拦下
    // (手写优先:再发一个 body.size 就是两个比例打架)。
    if (spec.field === 'ar' && carrier === 'mj') {
      if (isBlank(p.ar)) continue;
      if (inPrompt(prompt, '--ar')) { dropped.push({ field: 'ar', reason: 'already-in-prompt' }); continue; }
      if (!RATIO_RE.test(String(p.ar).trim())) { dropped.push({ field: 'ar', reason: 'out-of-range' }); continue; }
      viaBody.push({ field: 'ar', bodyKey: 'size' });
      continue;
    }
    const out = compileOne(spec, p[spec.field], caps, ctx);
    if (!out) continue;
    if (out.drop) { dropped.push({ field: spec.field, reason: out.drop }); continue; }
    parts.push([spec.flag, out.value]);
  }

  if (carrier === 'mj' && version) {
    viaBody.push({ field: 'version', bodyKey: 'version' });
    if (caps.niji) viaBody.push({ field: 'niji', bodyKey: 'niji' });
  }
  if (speed) viaBody.push({ field: 'speed', bodyKey: carrier === 'mj' ? 'speed' : 'accountFilter.modes' });

  // 长度闸只管 flags 段:提示词本体再长也不该挤掉一个 `--s 250`(上游对正文另有自己的限制)。
  // 末尾统一规范化(去首尾空白 + 连续空白压成一个空格):extraFlags 那一段没有 flag 名
  // (parts 里是 ['', 原文]),按上面的公式拼出来会带一个前导空格 —— 拼进提示词就是
  // `cat  --sv 4` 这种双空格,违反 §1.1 的"不以空白开头、无连续空白"两条不变式。
  const render = (list) => list.map(([f, v]) => (v ? `${f} ${v}` : f)).join(' ').replace(/\s+/g, ' ').trim();
  while (parts.length && render(parts).length > MAX_FLAGS_LEN) {
    const [flag] = parts.pop();
    const spec = SPEC.find((s) => s.flag === flag) || SPEC[SPEC.length - 1];
    dropped.push({ field: spec.field, reason: 'too-long' });
  }
  const flags = render(parts);
  return { flags, parts, dropped, viaBody, prompt: flags ? `${prompt} ${flags}` : prompt };
}
