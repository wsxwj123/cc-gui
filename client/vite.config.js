import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Q1: 把根 package.json 版本烤进 bundle。前端由此获得自己的版本身份,
// 启动时与 /api/health 的 server 版本握手——任何一层(WebView 缓存/代理/
// 打包塞进旧 dist)端出旧 bundle 都会被当场发现,不再"显示最新实为旧版"。
const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_VERSION__: JSON.stringify(rootPkg.version || 'unknown'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:6677',
      '/ws': {
        target: 'ws://localhost:6677',
        ws: true,
      },
    },
  },
});
