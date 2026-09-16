import { join, resolve as resolvePath, sep } from 'path';
import { homedir } from 'os';
import { rm } from 'fs/promises';

// 影子快照库的根。注意是 `.claude/gui`(不是 `.claude-gui`)——排查时别找错路径。
// 独立放这里是为了让 sessions.js 的"删会话连带清理"不用 import checkpoints 路由
// (那会和 checkpoints.js → sessions.js 的 broadcastSessionFileChange 形成环)。
export const CHECKPOINTS_ROOT = join(homedir(), '.claude', 'gui', 'checkpoints');

export const CHECKPOINT_SESSION_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 删会话时连带清掉该会话的快照目录(空间只涨不跌的根治)。best-effort:
 * 任何失败都吞掉并只回布尔——清理失败绝不许阻断会话删除。
 * sessionId 白名单 + 拼好后校验仍在 CHECKPOINTS_ROOT 之下,rm -rf 不许越界。
 */
export async function dropSessionCheckpoints(sessionId) {
  try {
    const id = String(sessionId || '');
    if (!CHECKPOINT_SESSION_RE.test(id)) return false;
    const dir = join(CHECKPOINTS_ROOT, id);
    const abs = resolvePath(dir);
    if (!abs.startsWith(resolvePath(CHECKPOINTS_ROOT) + sep)) return false;
    await rm(abs, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.warn('[checkpoints] drop session checkpoints failed:', sessionId, e?.message || e);
    return false;
  }
}
