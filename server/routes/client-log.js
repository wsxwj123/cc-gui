import { Router } from 'express';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// r29 取证:Windows 公开版"用一段时间整个窗口消失"拿不到证据,因为三条链路
// 全部零记录。本文件承载其中的前端上报链 + 三个日志文件的公共原语(白名单只
// 放行这一个新文件):
//   ① POST /api/client-log —— 前端 window error/unhandledrejection 上报落 client.log
//   ② writeCrashLog —— server/index.js 全局崩溃 handler 落 crash.log
//   ③ rotateLogIfBig —— 启动时日志滚动(server.log 在 Rust 侧 spawn 前同口径滚动,
//      因为 stderr 句柄由它持有,JS 侧改名打开中的文件在 Windows 上会失败)

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB,超了启动时滚动成 .old(只留一代)
const MAX_FIELD_CHARS = 2048; // message/stack 单字段截断 2KB
const RATE_LIMIT_MS = 5000; // 同消息 5s 限流(崩溃刷屏防打爆磁盘)

export function guiLogDir() {
  return join(homedir(), '.claude-gui');
}

// 日志滚动:超过 5MB 改名 <file>.old,下次写入自然开新文件。返回是否发生了滚动。
// 任何失败都静默(滚动失败不该影响启动),测试可直接传 /tmp 样本路径。
export function rotateLogIfBig(filePath, maxBytes = MAX_LOG_BYTES) {
  try {
    if (!existsSync(filePath)) return false;
    if (statSync(filePath).size <= maxBytes) return false;
    renameSync(filePath, filePath + '.old');
    return true;
  } catch { return false; }
}

// 单行 JSON 追加。同步写:崩溃路径上进程随时可能死,不能等异步 flush。
export function appendJsonLine(filePath, obj) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(obj) + '\n');
    return true;
  } catch { return false; }
}

// server 全局崩溃落盘:uncaughtException / unhandledRejection 各一行 JSON
// (时间戳/类型/stack 截 2KB)。dir 参数仅测试用,默认 ~/.claude-gui。
export function writeCrashLog(type, err, dir = guiLogDir()) {
  return appendJsonLine(join(dir, 'crash.log'), {
    ts: Date.now(),
    iso: new Date().toISOString(),
    type: String(type),
    stack: String((err && err.stack) || err).slice(0, MAX_FIELD_CHARS),
  });
}

// logDir 参数化是为了测试(/tmp 样本,绝不碰真实 ~/.claude-gui);
// 生产默认绑 guiLogDir()。
export function createClientLogRouter(logDir = guiLogDir()) {
  const router = Router();
  const lastSeen = new Map(); // message -> ts(同消息 5s 限流)

  // POST /api/client-log { kind, message, stack, url }
  // 挂载在 /api(authMiddleware 之后)自动带鉴权。限流命中也回 ok ——
  // 上报方是 fire-and-forget,不需要区分。
  router.post('/client-log', (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const message = String(body.message || '').slice(0, MAX_FIELD_CHARS);
    if (!message) return res.status(400).json({ error: 'message 必填' });

    const now = Date.now();
    const last = lastSeen.get(message);
    if (last !== undefined && now - last < RATE_LIMIT_MS) {
      return res.json({ ok: true, throttled: true });
    }
    lastSeen.set(message, now);
    // 防 Map 无限涨:超 500 条先清过期项,清不动就整体清空(限流状态丢了
    // 只是多写几行,不至于泄漏内存)。
    if (lastSeen.size > 500) {
      for (const [k, t] of lastSeen) { if (now - t >= RATE_LIMIT_MS) lastSeen.delete(k); }
      if (lastSeen.size > 500) lastSeen.clear();
    }

    appendJsonLine(join(logDir, 'client.log'), {
      ts: now,
      iso: new Date(now).toISOString(),
      kind: String(body.kind || 'error').slice(0, 32),
      message,
      stack: String(body.stack || '').slice(0, MAX_FIELD_CHARS),
      url: String(body.url || '').slice(0, 512),
    });
    res.json({ ok: true });
  });

  return router;
}

const router = createClientLogRouter();
export default router;
