import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * dev 直接把 /api 代理到容器里的 server（7788），前端不需要关心跨域；
 * 产物只落在 web/dist（rule.md C1：产物不出仓库目录）。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7788',
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
