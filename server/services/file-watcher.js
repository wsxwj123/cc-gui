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
    // chokidar v4 dropped fsevents and watches via fs.watch, which opens one fd
    // per directory. A large ~/.claude (thousands of session jsonls) blows past
    // the OS file-descriptor limit → EMFILE, which kills live updates. Polling
    // is stat-based and opens NO fds, so it's immune to EMFILE; a longer
    // interval keeps CPU modest on big trees.
    usePolling: true,
    interval: 2500,
    binaryInterval: 5000,
    ignored: [
      '**/telemetry/**',
      '**/debug/**',
      '**/paste-cache/**',
      '**/shell-snapshots/**',
      '**/media/**',
      '**/todos/**',
      '**/statsig/**',
      '**/.git/**',
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

  // Without an 'error' handler chokidar emits an unhandled 'error' event, which
  // on EMFILE (too many open files) / ENOSPC (inotify limit) crashes the process
  // or silently kills live updates. Log loudly and keep the server alive.
  watcher.on('error', (err) => {
    console.warn('[file-watcher] error:', err?.message || err);
  });

  return watcher;
}
