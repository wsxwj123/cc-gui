// r142-wincu 的 UI 页面来源:dev server(源码直出),/api、/ws 代理到本套件的隔离实例。
// cacheDir 指到本套件 .artifacts:不写 client/node_modules/.vite,不碰别的套件的缓存。
import { fileURLToPath } from 'node:url';
import base from '../../../client/vite.config.js';

const apiPort = Number(process.env.CGUI_TEST_API_PORT || 0);
const uiPort = Number(process.env.CGUI_TEST_UI_PORT || 0);
if (!apiPort || !uiPort) throw new Error('CGUI_TEST_API_PORT / CGUI_TEST_UI_PORT 必须先设置(run-isolated.sh 负责)');
for (const port of [apiPort, uiPort]) {
  if (port === 6677 || port === 6689) throw new Error(`拒绝使用用户实例端口 ${port}`);
  if (port < 7200 || port > 7299) throw new Error(`端口 ${port} 不在本套件保留段 7200-7299(6700-6999 归 r140 的套件)`);
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
