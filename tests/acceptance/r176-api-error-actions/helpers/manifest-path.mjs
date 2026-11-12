// 夹具清单的落点（单独一个小模块，免得 runtime.mjs 与 fixtures.mjs 互相 import）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function fixtureManifestPath() {
  const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.join(suiteDir, '.artifacts', 'fixture-manifest.json');
}
