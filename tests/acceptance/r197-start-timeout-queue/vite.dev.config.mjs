// 页面来源 = dev server(源码直出),不是 client/dist。/api、/ws 全部代理到本套件的隔离实例。
// cacheDir 指到本套件 .artifacts:不写 client/node_modules/.vite,不碰别人的缓存。
import { fileURLToPath } from 'node:url';
import base from '../../../client/vite.config.js';

const apiPort = Number(process.env.R197_API_PORT || 0);
const uiPort = Number(process.env.R197_UI_PORT || 0);
if (apiPort !== 6961 || uiPort !== 6962) throw new Error('本套件只允许 API 端口 6961、页面端口 6962(run.sh 负责设置)');

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
