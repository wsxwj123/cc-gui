// 页面来源 = dev server(源码直出),不是 client/dist:worktree 里没有 dist,
// 且修复后重跑不必重建,浏览器验的永远是当前源码。/api、/ws 全部代理到本套件的隔离实例。
// cacheDir 指到本套件 .artifacts:不写 client/node_modules/.vite,不碰别人的缓存。
import { fileURLToPath } from 'node:url';
import base from '../../../client/vite.config.js';

const apiPort = Number(process.env.R116_API_PORT || 0);
const uiPort = Number(process.env.R116_UI_PORT || 0);
if (!apiPort || !uiPort) throw new Error('R116_API_PORT / R116_UI_PORT 必须先设置(run.sh 负责)');
for (const p of [apiPort, uiPort]) {
  if (p < 6700 || p > 6999 || [6677, 6689, 6710].includes(p)) throw new Error(`端口 ${p} 不在允许范围(6700–6999,且不碰 6710)`);
}

export default {
  ...base,
  root: fileURLToPath(new URL('../../../client', import.meta.url)),
  cacheDir: fileURLToPath(new URL('.artifacts/vite-cache', import.meta.url)),
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
