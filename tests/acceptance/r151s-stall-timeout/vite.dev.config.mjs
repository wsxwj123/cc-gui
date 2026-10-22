// 页面来源 = dev server(源码直出);/api、/ws 代理到本套件的隔离实例(照 r151n-ui-fixes 的同名文件)。
// cacheDir 放在本次 run 的临时目录(run.sh 注入),避免跨基线复用旧预构建。
import { fileURLToPath } from 'node:url';
import base from '../../../client/vite.config.js';

const apiPort = Number(process.env.R151S_API_PORT || 0);
const uiPort = Number(process.env.R151S_UI_PORT || 0);
if (!apiPort || !uiPort) throw new Error('R151S_API_PORT / R151S_UI_PORT 必须先设置(run.sh 负责)');
for (const p of [apiPort, uiPort]) {
  if (p < 6700 || p > 6999 || [6677, 6689, 6710, 8788, 8789, 8798, 8799, 8000].includes(p)) {
    throw new Error(`端口 ${p} 不在允许范围(6700–6999,且不碰保留端口)`);
  }
}

export default {
  ...base,
  root: fileURLToPath(new URL('../../../client', import.meta.url)),
  cacheDir: process.env.R151S_VITE_CACHE || fileURLToPath(new URL('.artifacts/vite-cache', import.meta.url)),
  server: {
    ...base.server,
    host: '127.0.0.1',
    port: uiPort,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
};
