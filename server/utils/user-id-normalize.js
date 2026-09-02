// r89-A5:把请求体 metadata.user_id 里的 session_id 归一,让跨会话共享同一份前缀缓存。
//
// 依据(V3 真机实测,DeepSeek /anthropic,2026-09-02):DeepSeek 按 metadata.user_id
// **整串**隔离 KVCache(官方限速文档:"KVCache Isolation: user_id is used to isolate
// KVCache")。claude CLI 传的是 `{"device_id":..,"account_uuid":"","session_id":"<每会话变>"}`
// 这个 JSON 字符串 → 每开一个新会话就是一个新的缓存桶,系统提示 + 工具定义(占空会话 prompt
// 的 80%+)每个会话都要从零缓存一遍。实测:同一 system 下 session A 第二次 read 512;
// 只把 user_id 里的 session_id 换掉(其余不变)→ read 归 0。
//
// 做法:只清空 session_id,保留 device_id / account_uuid 及任何其它字段(仍是同一台设备、
// 同一账号的隔离粒度,不跨用户混用缓存)。metadata 不计入 token 前缀,改它不影响模型输入。
// 官方 Anthropic 上游一字不动:官方按账号做缓存、不用 user_id 隔离,没必要动。

import { isOfficialAnthropic } from '../services/model-resolver.js';

// 返回归一后的 user_id 字符串;不该改(非 JSON 对象 / 没有 session_id 字段)时返回 null。
export function normalizeUserId(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!('session_id' in obj)) return null;
  return JSON.stringify({ ...obj, session_id: '' });
}

// 请求体级改写。不需要改(官方上游 / 解析失败 / 没有 metadata.user_id / user_id 不是那种
// JSON 串)时**原样返回传入的同一个 Buffer**,调用方据此零成本透传。
export function normalizeUserIdInBody(body, baseURL) {
  if (!body || isOfficialAnthropic(baseURL)) return body;
  let parsed;
  try { parsed = JSON.parse(body.toString('utf-8')); } catch { return body; }
  if (!parsed || typeof parsed !== 'object') return body;
  const next = normalizeUserId(parsed.metadata?.user_id);
  if (next == null || next === parsed.metadata.user_id) return body;
  parsed.metadata = { ...parsed.metadata, user_id: next };
  return Buffer.from(JSON.stringify(parsed));
}
