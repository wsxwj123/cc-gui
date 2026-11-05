// 取电脑操控「面板凭证」(r154 起的授权写入约定,本套件只照着用):
//   · POST /api/computer-use/grants 的"新增/开启类"写入(带 bundleId 且 granted 不是 false,或 screenScope:true)
//     必须带请求头 X-CGUI-Grant-Token;纯撤销(granted:false / screenScope:false)不需要。缺凭证或凭证错 →
//     HTTP 403,body.code = CU_GRANT_FORBIDDEN。
//   · 凭证每次服务启动随机生成、只放内存。拿法与面板一样:连 ws://<host>/ws(Origin 设成同源),握手成功后
//     服务端会对该连接单发一帧文本 JSON {"type":"cu:grant-token","token":"…"},取 token,然后关连接。
// 本文件自成一体:只依赖上面这条公开约定,不 import r154 套件的 helpers,不读产品内部实现。
import WebSocket from 'ws';
import { EnvironmentBlocked } from './harness.mjs';

export const GRANT_TOKEN_HEADER = 'X-CGUI-Grant-Token';

/** 连一次 /ws,收到 cu:grant-token 帧就返回 token;任何拿不到的情形都抛带原因的 EnvironmentBlocked。 */
function fetchGrantToken(base, timeoutMs) {
  const u = new URL(base);
  const where = `ws://${u.host}/ws`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws = null;
    const finish = (reason, token) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.terminate(); } catch { /* 已关 */ }
      if (reason) reject(new EnvironmentBlocked(`取不到面板凭证(${where}):${reason}`));
      else resolve(token);
    };
    const timer = setTimeout(() => finish(`${timeoutMs}ms 内没收到 cu:grant-token 帧`), timeoutMs);
    ws = new WebSocket(where, { origin: `http://${u.host}` });
    ws.on('message', (data) => {
      let json = null;
      try { json = JSON.parse(data.toString()); } catch { return; } // 非 JSON 帧不是我们要的
      if (json?.type !== 'cu:grant-token') return;
      if (typeof json.token === 'string' && json.token.length > 0) finish(null, json.token);
      else finish('cu:grant-token 帧里没有非空的 token 字符串');
    });
    ws.on('unexpected-response', (_req, res) => finish(`握手被拒(HTTP ${res.statusCode})`));
    ws.on('error', (e) => finish(`连接出错:${e?.message || e}`));
    ws.on('close', (code) => finish(`连接在收到凭证帧之前就关了(close code ${code})`));
  });
}

// origin → Promise<token>。同一次运行里服务不重启,取一次就够;取失败的不缓存(下次调用重试)。
const tokens = new Map();

/** 取某个实例(base 形如 http://127.0.0.1:6701)当前的面板凭证,按实例缓存。 */
export function getGrantToken(base, { timeoutMs = 5_000 } = {}) {
  const key = new URL(base).origin;
  if (!tokens.has(key)) {
    tokens.set(key, fetchGrantToken(base, timeoutMs).catch((e) => { tokens.delete(key); throw e; }));
  }
  return tokens.get(key);
}
