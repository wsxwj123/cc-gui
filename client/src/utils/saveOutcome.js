// 保存类接口的结果判定(r151a 复审建议 3,口径同 App.jsx 里 provider 模型选择的保存):HTTP 2xx 且应答没写 ok:false
// 才算成功;失败时给应答里的 error,没有就给"保存失败(<状态码>)"。旧应答没有 ok 键时按状态码判。
export function saveOutcome(status, body) {
  const ok = status >= 200 && status < 300 && body?.ok !== false;
  if (ok) return { ok: true };
  return { ok: false, error: typeof body?.error === 'string' && body.error ? body.error : `保存失败（${status}）` };
}
