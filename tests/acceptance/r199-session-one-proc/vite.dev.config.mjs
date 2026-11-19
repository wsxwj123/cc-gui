// 页面来源 = dev server(源码直出);/api、/ws 代理到本套件的共享实例(6971);页面端口 6972。
import { fileURLToPath } from 'node:url';
import base from '../../../client/vite.config.js';

const apiPort = Number(process.env.R199_API_PORT || 0);
const uiPort = Number(process.env.R199_UI_PORT || 0);
if (apiPort !== 6971 || uiPort !== 6972) throw new Error('r199 只允许后端 6971 / 页面 6972(run.sh 负责设置)');

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
