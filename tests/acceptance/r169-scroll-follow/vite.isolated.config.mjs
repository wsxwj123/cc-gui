// 源码直出用的 Vite 配置：复用产品自己的 client/vite.config.js（只 import 不写），
// 只覆盖三样 —— 代理目标（指向本套件自己的隔离后端，绝不是 6677）、监听地址、缓存目录（放进本套件 .artifacts）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../../client/vite.config.js';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(suiteDir, '../../../client');
const backendPort = Number(process.env.R169_BACKEND_PORT);
const DENY = [6677, 6689, 6710, 8798, 8799];
if (!Number.isInteger(backendPort) || backendPort < 6880 || backendPort > 6889 || DENY.includes(backendPort)) {
  throw new Error(`R169_BACKEND_PORT=${process.env.R169_BACKEND_PORT} 不合规：只许 6880–6889 且不得是 ${DENY.join('/')}`);
}
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const cacheDir = path.join(suiteDir, '.artifacts', 'vite-cache');

export default {
  ...base,
  cacheDir,
  server: {
    ...(base.server || {}),
    host: '127.0.0.1',
    fs: {
      allow: [
        ...((base.server && base.server.fs && base.server.fs.allow) || []),
        cacheDir,
        real(path.join(clientDir, 'node_modules')),
        real(path.resolve(clientDir, '..', 'node_modules')),
      ].filter(Boolean),
    },
    proxy: {
      '/api': `http://127.0.0.1:${backendPort}`,
      '/ws': { target: `ws://127.0.0.1:${backendPort}`, ws: true },
    },
  },
};
