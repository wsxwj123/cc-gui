// r151b:跨会话消息的 HTTP 接口(接口 X.3.1)。挂在 /api 下,在 index.js 的 authMiddleware 之后(同既有鉴权)。
// 错误体一律 { ok:false, code, error }。【二期】接口一期不存在(总开关开着时落到 404)。
import { Router } from 'express';
import { broadcast } from '../broadcast.js';
import { isAuthorized } from '../services/auth.js';
import { readXsEnabledSync, updatePrefs } from './prefs.js';
import { XS_LIMITS } from '../services/xsession-store.js';

const router = Router();

const DISABLED_TEXT = '跨会话消息未开启';
const STORAGE_FAILED_TEXT = '保存失败，请重试';

export function xsError(res, status, code, error, extra) {
  return res.status(status).json({ ok: false, code, error, ...extra });
}

// config 两个接口不受总开关约束。判法与 Express 的路由匹配同口径(不分大小写、容忍结尾斜杠)。
const CONFIG_PATH_RE = /^\/config\/?$/i;

// 总开关闸门:关着时 /api/xsession/ 下除 config 以外的请求一律 409(含【二期】路径)。
// 按整个前缀判,而不是逐个接口挂:逐个挂时路径写法(大小写、结尾斜杠)与路由匹配稍有出入就会漏过闸门。
router.use('/xsession', (req, res, next) => {
  if (CONFIG_PATH_RE.test(req.path) || readXsEnabledSync()) return next();
  return xsError(res, 409, 'XS_DISABLED', DISABLED_TEXT);
});

// nativeGuard.lastFailureAt:原生 SendMessage 引导最近一次检查失效的时刻(ISO 字符串),由引导守卫(T-X6)调用记下。
let nativeGuardLastFailureAt = null;
export function noteNativeGuardFailure(at = new Date()) {
  nativeGuardLastFailureAt = at.toISOString();
}

// GET /api/xsession/config → 一期字段(autoPaused、autoBudget、limits 的另三项是【二期】,不出现)。
// 偏好文件损坏或读不出 → readXsEnabledSync 给 false,照常 200。
router.get('/xsession/config', (_req, res) => {
  res.json({
    enabled: readXsEnabledSync(),
    limits: { bodyBytes: XS_LIMITS.bodyBytes, pendingPerSession: XS_LIMITS.pendingPerSession },
    nativeGuard: { lastFailureAt: nativeGuardLastFailureAt },
  });
});

// PUT /api/xsession/config { enabled } —— 一期只认 enabled;其它键(含二期的 autoPaused、chainLimit)一律 400,不写文件。
router.put('/xsession/config', async (req, res) => {
  const body = req.body;
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
  if (!keys || keys.length === 0 || keys.some((k) => k !== 'enabled') || typeof body.enabled !== 'boolean') {
    return xsError(res, 400, 'XS_INVALID_INPUT', '请求体须为 { enabled: 布尔值 }，不能带其它键');
  }
  const { enabled } = body;
  try {
    await updatePrefs((prefs) => { prefs.xsEnabled = enabled; });
  } catch {
    return xsError(res, 500, 'STORAGE_WRITE_FAILED', STORAGE_FAILED_TEXT);
  }
  broadcast({ type: 'xs:config', enabled });
  res.json({ ok: true, enabled });
});

// index.js 的全局 JSON 解析器在路由之前跑:请求体不是 JSON、或是 "on" / null 这类非对象时直接进错误链,到不了上面的
// 闸门与校验。这个错误处理器(index.js 挂在通用错误处理之前)把 /api/xsession/* 的请求体错误改回本节的错误体:
// 总开关关着(config 除外)先回 409,否则解析失败回 400 XS_INVALID_INPUT。未通过鉴权的请求、其它路径、其它错误
// 原样交给下一个错误处理器(未鉴权时不透露开关状态)。
const XS_URL_RE = /^\/api\/xsession(\/[^?]*)?(?:\?|$)/i;
export function xsessionBodyErrorHandler(err, req, res, next) {
  const m = XS_URL_RE.exec(req.originalUrl || '');
  const isBodyError = typeof err?.type === 'string' && err.status >= 400 && err.status < 500;
  if (!m || !isBodyError || res.headersSent || !isAuthorized(req)) return next(err);
  if (!CONFIG_PATH_RE.test(m[1] || '/') && !readXsEnabledSync()) return xsError(res, 409, 'XS_DISABLED', DISABLED_TEXT);
  if (err.type === 'entity.parse.failed') return xsError(res, 400, 'XS_INVALID_INPUT', '请求体不是合法的 JSON 对象');
  return next(err);
}

export default router;
