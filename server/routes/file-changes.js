import { Router } from 'express';
import { parseJsonl } from '../utils/jsonl-parser.js';
import { join } from 'path';
import { homedir } from 'os';

const router = Router();
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Extract file changes from a session's tool calls.
 * Looks for Edit, Write, and Bash commands that modify files.
 */
function extractFileChanges(records) {
  const changes = [];
  const seen = new Set();

  for (const record of records) {
    if (record.type !== 'assistant') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const { name, input } = block;

      if (name === 'Edit' && input?.file_path) {
        const key = `edit:${input.file_path}:${record.timestamp}`;
        if (!seen.has(key)) {
          seen.add(key);
          changes.push({
            type: 'edit',
            file: input.file_path,
            timestamp: record.timestamp,
            model: record.message?.model,
            uuid: record.uuid,
            preview: input.new_string?.slice(0, 200) || '',
            oldPreview: input.old_string?.slice(0, 200) || '',
          });
        }
      } else if (name === 'Write' && input?.file_path) {
        const key = `write:${input.file_path}:${record.timestamp}`;
        if (!seen.has(key)) {
          seen.add(key);
          changes.push({
            type: 'write',
            file: input.file_path,
            timestamp: record.timestamp,
            model: record.message?.model,
            uuid: record.uuid,
            preview: input.content?.slice(0, 200) || '',
          });
        }
      } else if (name === 'Bash' && input?.command) {
        // Detect file-modifying bash commands
        const cmd = input.command;
        if (/\b(mv|cp|rm|mkdir|touch|chmod|chown|tee|sed -i)\b/.test(cmd)) {
          const key = `bash:${cmd.slice(0, 100)}:${record.timestamp}`;
          if (!seen.has(key)) {
            seen.add(key);
            changes.push({
              type: 'bash',
              command: cmd,
              timestamp: record.timestamp,
              model: record.message?.model,
              uuid: record.uuid,
            });
          }
        }
      }
    }
  }

  return changes;
}

// GET /api/sessions/:sessionId/file-changes — file changes in a session
router.get('/sessions/:sessionId/file-changes', async (req, res) => {
  try {
    const { projectHash } = req.query;
    if (!projectHash) {
      return res.status(400).json({ error: 'projectHash required' });
    }
    const filePath = join(PROJECTS_DIR, projectHash, `${req.params.sessionId}.jsonl`);
    const records = await parseJsonl(filePath);
    const changes = extractFileChanges(records);
    res.json(changes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
