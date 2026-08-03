// MCP elicitation 的 requestedSchema → 表单控件描述(纯函数,便于单测;渲染在
// PermissionPrompt 的 ElicitCard 里)。
//
// MCP 规定 elicitation 只用扁平的 object schema,每个字段是 string / 带 enum 的 string /
// boolean / integer|number 之一。认不出的类型(嵌套对象、数组、未来扩展、恶意 schema)
// 一律退化成文本框:卡片必须渲染得出来 —— 渲染不出等于用户永远填不了表,而回合正挂着
// 等这张表,结果是整轮卡死。
export function elicitFields(schema) {
  const props = schema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.keys(props).map((key) => {
    const p = (props[key] && typeof props[key] === 'object') ? props[key] : {};
    const base = {
      key,
      label: (typeof p.title === 'string' && p.title) ? p.title : key,
      description: typeof p.description === 'string' ? p.description : '',
      required: required.has(key),
      ...(p.default !== undefined ? { defaultValue: p.default } : {}),
    };
    if (Array.isArray(p.enum) && p.enum.length) {
      // enumNames 是 MCP 对 JSON Schema 的扩展:显示名,按下标与 enum 对齐。缺失或缺项
      // 时回落到值本身(不能因为没写显示名就让选项变空按钮)。
      const names = Array.isArray(p.enumNames) ? p.enumNames : [];
      return {
        ...base,
        type: 'enum',
        options: p.enum.map((v, i) => ({ value: String(v), label: String(names[i] ?? v) })),
      };
    }
    if (p.type === 'boolean') return { ...base, type: 'boolean' };
    if (p.type === 'integer' || p.type === 'number') {
      return {
        ...base,
        type: 'number',
        integer: p.type === 'integer',
        min: Number.isFinite(p.minimum) ? p.minimum : null,
        max: Number.isFinite(p.maximum) ? p.maximum : null,
      };
    }
    return { ...base, type: 'text' };
  });
}

// 未填的必填项(按 key 返回)。boolean 不算未填:false 是一个合法答案,不是空。
export function elicitMissing(fields, values) {
  return (fields || [])
    .filter((f) => f.required && f.type !== 'boolean'
      && (values?.[f.key] === undefined || values[f.key] === null || String(values[f.key]).trim() === ''))
    .map((f) => f.key);
}

// 表单值 → 回给 MCP 服务器的 content。按 schema 类型转真值(数字框回数字不回字符串);
// 空着的可选字段整个不带 —— 服务器多按 schema 校验,空串会被判成类型错误。
// ponytail: 不做 min/max 校验,输入框的 min/max 属性挡住手输,越界值由服务器判并重新 elicit。
export function buildElicitContent(fields, values) {
  const out = {};
  for (const f of (fields || [])) {
    const v = values?.[f.key];
    if (f.type === 'boolean') { out[f.key] = !!v; continue; }
    if (v === undefined || v === null || String(v).trim() === '') continue;
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[f.key] = f.integer ? Math.trunc(n) : n;
      continue;
    }
    out[f.key] = String(v);
  }
  return out;
}

// 表单初值:有 default 的字段用 default,其余留空(boolean 无 default 时为 false)。
export function initialElicitValues(fields) {
  const out = {};
  for (const f of (fields || [])) {
    if (f.defaultValue !== undefined) out[f.key] = f.type === 'boolean' ? !!f.defaultValue : f.defaultValue;
    else if (f.type === 'boolean') out[f.key] = false;
  }
  return out;
}
