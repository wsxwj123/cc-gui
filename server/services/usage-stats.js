import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { parseJsonl } from '../utils/jsonl-parser.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Aggregate usage stats across all sessions.
 * Returns per-model, per-project, and per-day breakdowns.
 */
export async function getUsageStats() {
  const projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  const byModel = {};
  const byProject = {};
  const byDay = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let sessionCount = 0;

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const projectPath = join(PROJECTS_DIR, dir.name);
    let files;
    try {
      files = (await readdir(projectPath)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const records = await parseJsonl(join(projectPath, file), { limit: 5000 });
        sessionCount++;

        for (const record of records) {
          if (record.type !== 'assistant') continue;
          const usage = record.message?.usage;
          if (!usage) continue;

          const model = record.message?.model || 'unknown';
          const input = usage.input_tokens || 0;
          const output = usage.output_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const day = record.timestamp ? record.timestamp.slice(0, 10) : 'unknown';

          totalInput += input;
          totalOutput += output;
          totalCacheRead += cacheRead;

          // By model
          if (!byModel[model]) byModel[model] = { input: 0, output: 0, cacheRead: 0, calls: 0 };
          byModel[model].input += input;
          byModel[model].output += output;
          byModel[model].cacheRead += cacheRead;
          byModel[model].calls++;

          // By project
          if (!byProject[dir.name]) byProject[dir.name] = { input: 0, output: 0, cacheRead: 0, calls: 0 };
          byProject[dir.name].input += input;
          byProject[dir.name].output += output;
          byProject[dir.name].cacheRead += cacheRead;
          byProject[dir.name].calls++;

          // By day
          if (!byDay[day]) byDay[day] = { input: 0, output: 0, cacheRead: 0, calls: 0 };
          byDay[day].input += input;
          byDay[day].output += output;
          byDay[day].cacheRead += cacheRead;
          byDay[day].calls++;
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return {
    total: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, sessionCount },
    byModel: Object.entries(byModel)
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    byProject: Object.entries(byProject)
      .map(([hash, stats]) => ({ hash, ...stats }))
      .sort((a, b) => (b.input + b.output) - (a.input + a.output))
      .slice(0, 20),
    byDay: Object.entries(byDay)
      .map(([day, stats]) => ({ day, ...stats }))
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, 30),
  };
}
