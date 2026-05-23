import { watch } from 'chokidar';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_DIR = join(homedir(), '.claude');

/**
 * Set up file watchers for ~/.claude/ changes.
 * Calls the callback with event type and path when files change.
 */
export function setupFileWatcher(onChange) {
  const watcher = watch(CLAUDE_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 3,
    ignored: [
      '**/telemetry/**',
      '**/debug/**',
      '**/paste-cache/**',
      '**/shell-snapshots/**',
      '**/media/**',
    ],
  });

  watcher.on('change', (path) => {
    if (path.endsWith('.jsonl') || path.endsWith('.json')) {
      onChange('change', path);
    }
  });

  watcher.on('add', (path) => {
    if (path.endsWith('.jsonl') || path.endsWith('.json')) {
      onChange('add', path);
    }
  });

  watcher.on('unlink', (path) => {
    onChange('unlink', path);
  });

  return watcher;
}
