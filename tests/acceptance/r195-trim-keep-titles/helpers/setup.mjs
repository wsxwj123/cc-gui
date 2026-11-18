// 运行脚本调用:在 .artifacts 下建假家目录与 PATH 上的假 claude 薄壳。只写本套件 .artifacts。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const art = path.join(suiteDir, '.artifacts');
fs.mkdirSync(path.join(art, 'runtime-data', 'home', '.claude', 'projects'), { recursive: true });
fs.mkdirSync(path.join(art, 'runtime-data', 'home', '.claude-gui'), { recursive: true });
fs.mkdirSync(path.join(art, 'fakebin'), { recursive: true });
const shim = path.join(art, 'fakebin', 'claude');
fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
fs.chmodSync(shim, 0o755);
