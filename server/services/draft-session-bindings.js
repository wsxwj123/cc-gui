import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DRAFT_SESSION_BINDINGS_MAX = 256;
export const DRAFT_SESSION_BINDINGS_FILE = join(homedir(), '.claude-gui', 'draft-session-bindings.json');

export function createDraftSessionBindingsStore({
  file = DRAFT_SESSION_BINDINGS_FILE,
  fs = { mkdir, readFile, rename, unlink, writeFile },
  now = () => Date.now(),
  makeTempId = () => randomUUID(),
} = {}) {
  let writeTail = Promise.resolve();

  const quarantineMalformed = async (error) => {
    const quarantined = `${file}.corrupt-${now()}`;
    try {
      await fs.rename(file, quarantined);
      console.warn(`[draft-session-bindings] malformed index quarantined: ${quarantined}`);
    } catch (renameError) {
      console.warn('[draft-session-bindings] malformed index could not be quarantined:', renameError?.message || renameError);
    }
    void error;
    return {};
  };

  const read = async () => {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) { return quarantineMalformed(error); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return quarantineMalformed(new Error('binding index root must be an object'));
    }
    return parsed;
  };

  const record = ({ draftId, sessionId, projectHash }) => {
    if (!draftId || !sessionId || !projectHash) return Promise.reject(new Error('draftId/sessionId/projectHash required'));
    const run = writeTail.catch(() => {}).then(async () => {
      const current = await read();
      const next = {
        ...current,
        [draftId]: { sessionId, projectHash, at: now() },
      };
      const bounded = Object.fromEntries(Object.entries(next)
        .sort(([, a], [, b]) => Number(b?.at || 0) - Number(a?.at || 0))
        .slice(0, DRAFT_SESSION_BINDINGS_MAX));
      await fs.mkdir(dirname(file), { recursive: true });
      const temp = `${file}.tmp-${makeTempId()}`;
      try {
        // 内容含会话/项目标识:按用户私有落盘,不跟随 umask 放宽。
        await fs.writeFile(temp, JSON.stringify(bounded), { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, file);
      } catch (error) {
        try { await fs.unlink(temp); } catch {}
        throw error;
      }
      return bounded[draftId];
    });
    writeTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const mergeIntoSessions = async (sessions, projectHash) => {
    const list = Array.isArray(sessions) ? sessions : [];
    const bindings = await read();
    const bySession = new Map();
    for (const [draftId, binding] of Object.entries(bindings)) {
      if (binding?.projectHash === projectHash && binding?.sessionId) {
        bySession.set(binding.sessionId, draftId);
      }
    }
    return list.map((session) => {
      const draftId = bySession.get(session?.sessionId);
      return draftId ? { ...session, draftId } : session;
    });
  };

  return { read, record, mergeIntoSessions };
}

const draftSessionBindingsStore = createDraftSessionBindingsStore();

export const recordDraftSessionBinding = (binding) => draftSessionBindingsStore.record(binding);
export const mergeDraftBindingsIntoSessions = (sessions, projectHash) => (
  draftSessionBindingsStore.mergeIntoSessions(sessions, projectHash)
);

// 恢复索引是可选旁路，绝不能把核心 listSessions 的成功改写成项目 403/500。
// 权限错误只记录索引自身路径，不冒充 ~/.claude/projects 的访问错误。
export async function mergeDraftBindingsBestEffort(
  sessions,
  projectHash,
  { mergeImpl = mergeDraftBindingsIntoSessions, diagnose = console.warn } = {},
) {
  try {
    return await mergeImpl(sessions, projectHash);
  } catch (error) {
    diagnose?.(`[draft-session-bindings] optional merge skipped (${error?.code || 'error'}): ${error?.message || error}`);
    return sessions;
  }
}
