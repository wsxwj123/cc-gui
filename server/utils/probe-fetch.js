// r181:带 Key 的探测请求不跨主机跟随重定向。
// 规则:同源(协议 + 主机 + 端口都相同)最多跟 1 跳,跨源一律拒绝。
//   GET / HEAD 遇到任何 3xx 可以跟;其它方法只在 307 / 308 时跟(这两种保持方法与请求体)。
//   其余一律当失败,不向跳转目标发任何请求。
// 调用点:文本拉模型、测试连接(settings.js)、生图 gemini 拉模型(image.js)。
// 不在这里重跑内网地址守卫:同源跳转目标与第一跳是同一主机名,第一跳前已由调用方守卫过。

// 发请求,遇 3xx 按上面的规则处理。
// init.body 只能是字符串 / Buffer(同源 307 / 308 时要原样重发;流式正文重发会是空体)。
// init.signal 由调用方给,两次请求共用,总超时不变。
// 返回 { response }(非 3xx,可能是跟了一跳之后的)或 { refused: { status, reason, targetHost, requestUrl } }。
// 网络异常、超时原样抛出,调用方现有的 catch 不用改。
export async function fetchFollowSameOriginOnce(url, init = {}, { fetchImpl = fetch } = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  let current = url;
  for (let hop = 0; ; hop++) {
    const r = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (r.status < 300 || r.status >= 400) return { response: r };
    const location = r.headers.get('location');
    await r.body?.cancel?.().catch(() => {});
    const refuse = (reason, target) => ({
      refused: { status: r.status, reason, targetHost: target ? target.host : '', requestUrl: url },
    });
    let target = null;
    // location 不是非空字符串时不解析(new URL(null, base) 会被解析成 base/null)。
    try { if (typeof location === 'string' && location) target = new URL(location, current); } catch { target = null; }
    // 非 http(s)、带账号密码的 Location 一律当无效。
    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) {
      return refuse('bad-location');
    }
    const from = new URL(current);
    if (target.origin !== from.origin) {
      // 只有「同一主机、端口相同、http 改 https」才算改用 https;连端口也换了的按另一个主机处理。
      const upgrade = from.protocol === 'http:' && target.protocol === 'https:'
        && target.hostname === from.hostname && target.port === from.port;
      return refuse(upgrade ? 'https-upgrade' : 'cross-host', target);
    }
    const replayable = method === 'GET' || method === 'HEAD' || r.status === 307 || r.status === 308;
    if (hop >= 1 || !replayable) return refuse('same-origin-stop', target);
    current = target.href;
  }
}

// 报错里显示的请求地址:origin + pathname,不带查询串 / 片段 / userinfo;
// 长于 24 个字符的路径段换成「…」(有的中转站把令牌放在路径里)。
function shownRequestUrl(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname.split('/').map((seg) => (seg.length > 24 ? '…' : seg)).join('/');
  } catch { return ''; }
}

// 跳转被拒时的报错文字。跳转目标由上游决定,不替它背书:
// 只在换到另一个主机时给出主机名(URL.host,不带协议前缀),不出现 Location 的路径、查询串、片段。
export function redirectRefusedMessage({ status, reason, targetHost, requestUrl }) {
  const head = `上游返回了重定向（HTTP ${status}），已拒绝跟随（防止密钥被带到未校验的地址）。`;
  const detail = {
    'https-upgrade': '上游要求改用 https 访问同一主机，可以把接口地址开头的 http 改成 https 后再试。',
    'cross-host': `上游要求跳转到另一个主机「${String(targetHost).slice(0, 80)}」（这个主机名取自上游的响应，未经核实），密钥没有发往该主机。只有向服务商核实它是官方地址之后才改用，不要直接照抄。`,
    'same-origin-stop': '上游在同一主机内要求跳转，已停止（同一主机内只跟随一次，POST 请求遇到 301 / 302 / 303 不跟随）。',
    'bad-location': '上游要求跳转，但没有给出有效的跳转地址，已停止。',
  }[reason] || '';
  const shown = shownRequestUrl(requestUrl);
  return head + detail + (shown ? `请求的地址：${shown}` : '');
}
