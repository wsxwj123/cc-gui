// U1-U3 的页面来源:dev server(源码直出),/api 与 /ws 代理到本套件的隔离实例;cacheDir 指到本套件 .artifacts。
import { fileURLToPath } from 'node:url';
import base from '../../../client/vite.config.js';

const apiPort = Number(process.env.R154_API_PORT || 0);
const uiPort = Number(process.env.R154_UI_PORT || 0);
if (!apiPort || !uiPort) throw new Error('R154_API_PORT / R154_UI_PORT 必须由 r154-ui.spec.mjs 设置');
if ([6677, 6689, 6710].includes(apiPort) || [6677, 6689, 6710].includes(uiPort)) throw new Error('拒绝使用保留端口');

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
