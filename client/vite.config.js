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
    // client/src/utils/plan.js 复用仓库根 server/utils/plan.js —— 共享纯规则必须住在
    // Tauri 会打包的 server 资源树里(反过来 server 导 client/src 在安装包里会 ENOENT)。
    // 该 import 跨出 vite root(client/),dev 走 /@fs/,默认 fs.allow 只含 root → 403
    // 断模块图 = 白屏。只放行被 import 的那个目录,不放整个仓库根(否则 dev 下
    // /@fs 可读 CLAUDE.local.md / LEARNINGS.md / .devflow 等)。生产 build 不经这道门。
    fs: { allow: ['../server/utils'] },
    proxy: {
      '/api': 'http://localhost:6677',
      '/ws': {
        target: 'ws://localhost:6677',
        ws: true,
      },
    },
  },
});
