// UI 用例的页面来源:**dev server(源码直出)**,不是 client/dist。
// 本批明令不许跑统一 `vite build`(另有代理在并行动前端,构建会打架),所以浏览器验的是
// 当前源码经 dev 转换后的产物 —— 页面里的 /api、/ws 全部代理到本套件的隔离实例,
// 绝不落到操作者正在用的 6677。
// cacheDir 指到本套件 .artifacts:不写 client/node_modules/.vite,不碰别人的缓存。
import { fileURLToPath } from 'node:url';
import base from '../../../client/vite.config.js';

const apiPort = Number(process.env.CGUI_TEST_API_PORT || 0);
const uiPort = Number(process.env.CGUI_TEST_UI_PORT || 0);
if (!apiPort || !uiPort) throw new Error('CGUI_TEST_API_PORT / CGUI_TEST_UI_PORT 必须先设置(run-isolated.sh 负责)');
if (apiPort === 6677 || apiPort === 6689 || uiPort === 6677 || uiPort === 6689) {
  throw new Error('拒绝使用用户实例端口 6677 / 6689');
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
