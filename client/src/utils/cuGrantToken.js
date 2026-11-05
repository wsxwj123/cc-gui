// r154:电脑操控「面板凭证」。服务端在 WS 握手通过后对该连接单发 {type:'cu:grant-token', token},
// 面板发授权类写入(正向意图)时放进请求头回传。
// 只放内存(模块级变量):不写 localStorage / sessionStorage —— 凭证落到持久存储,
// 任何能读浏览器存储的东西都能拿去盲打授权接口。服务重启后 WS 重连会收到新值并直接覆盖。

let grantToken = '';

export function setCuGrantToken(token) {
  if (typeof token !== 'string' || !token) return; // 非字符串 / 空串忽略,不清掉已有值
  grantToken = token;
}

export function getCuGrantToken() {
  return grantToken;
}
