// 电脑操控授权的「面板凭证」(r154)。
//
// 进程启动时生成一次,**只放内存**:不进日志、环境变量、文件、任何 HTTP 响应。只经 WebSocket
// 在连接建立后对该连接单发给面板;面板发授权类请求时放进请求头 X-CGUI-Grant-Token 回传。
//
// 威胁模型(与 routes/permissions.js 的 r26-H1 nonce 同口径):防**盲打**——不知道凭证的本机脚本、
// 模型照旧文档敲出的 curl、网页 CSRF。**不防**主动连 WS 的本机进程(WS 本就能开内置终端)和
// 直接改 grants.json 的进程;后者由 forbidden-apps.js 的底线缓解。
// 与 H1 nonce 不同:nonce 绑定单个待决请求、随请求生灭;凭证要在面板整个生命周期可用,按进程常驻。
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const GRANT_TOKEN = randomBytes(32).toString('hex');
const GRANT_TOKEN_DIGEST = createHash('sha256').update(GRANT_TOKEN).digest();

export function getGrantToken() {
  return GRANT_TOKEN;
}

/** 定长比较:两边各取 SHA-256 再 timingSafeEqual,长度不同也不会提前返回。 */
export function grantTokenMatches(presented) {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const digest = createHash('sha256').update(presented).digest();
  return timingSafeEqual(digest, GRANT_TOKEN_DIGEST);
}
