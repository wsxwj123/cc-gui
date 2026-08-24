import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createAttachmentSidecarStore({
  directory,
  hashText,
  fs = { mkdir, readFile, rename, unlink, writeFile },
  makeTempId = () => randomUUID(),
} = {}) {
  if (!directory || typeof hashText !== 'function') throw new Error('directory and hashText are required');
  const sessionTails = new Map();

  const write = (sessionId, { text, attachments, displayText = '' }) => {
    const previous = sessionTails.get(sessionId) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      await fs.mkdir(directory, { recursive: true });
      const file = join(directory, `${sessionId}.json`);
      let current;
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('attachment sidecar root must be an object');
        }
        current = parsed;
      } catch (error) {
        if (error?.code === 'ENOENT') current = {};
        else throw error;
      }
      const next = {
        ...current,
        [hashText(text)]: {
          attachments: attachments.map((attachment) => ({
            kind: attachment.kind,
            name: attachment.name,
            path: attachment.path,
            preview: attachment.preview,
            bytes: attachment.bytes,
          })),
          displayText: typeof displayText === 'string' ? displayText : '',
        },
      };
      const temp = `${file}.tmp-${makeTempId()}`;
      try {
        await fs.writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
        await fs.rename(temp, file);
      } catch (error) {
        try { await fs.unlink(temp); } catch {}
        throw error;
      }
      return next;
    });
    sessionTails.set(sessionId, run);
    const cleanup = () => {
      if (sessionTails.get(sessionId) === run) sessionTails.delete(sessionId);
    };
    run.then(cleanup, cleanup);
    return run;
  };

  return { write, pendingSessionCount: () => sessionTails.size };
}
