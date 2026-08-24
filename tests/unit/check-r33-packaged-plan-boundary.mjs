import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readerUrl = new URL('../../server/services/session-reader.js', import.meta.url);
const tauriUrl = new URL('../../src-tauri/tauri.conf.json', import.meta.url);
const readerSource = await readFile(readerUrl, 'utf8');
const tauri = JSON.parse(await readFile(tauriUrl, 'utf8'));
const resources = tauri?.bundle?.resources || [];

assert.ok(resources.includes('../server'), 'Tauri bundle must include the server source tree');
assert.ok(!resources.includes('../client/src'), 'Tauri bundle intentionally ships client/dist, not client/src');
assert.doesNotMatch(
  readerSource,
  /from\s+['"][^'"]*client\/src\//,
  'packaged server modules must not import client/src files that are absent from the app bundle',
);

console.log('check-r33-packaged-plan-boundary: all passed');
