/// <reference types="vitest" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

export const devFaviconPlugin = (): Plugin => ({
  name: 'dev-favicon-transform',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace('/favicon.svg', '/favicon-dev.svg');
  },
});

export default defineConfig(({ mode }) => {
  const isAnalyze = mode === 'analyze' || process.env.ANALYZE === 'true';

  // Third argument '' loads every var (not only VITE_*), matching the previous
  // process.env reads; defaults preserve the historical dev setup exactly.
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://127.0.0.1:3000';
  const devOrigin = env.VITE_DEV_ORIGIN || 'http://localhost:5173';

  const apiProxyConfig = {
    '/api': {
      target: backendUrl,
      changeOrigin: true,
      headers: {
        origin: devOrigin,
      },
    },
  };

  return {
    plugins: [
      react(),
      devFaviconPlugin(),
      ...(isAnalyze
        ? [
            visualizer({
              filename: 'dist/stats.html',
              open: false,
              gzipSize: true,
              brotliSize: true,
              template: 'treemap',
            }),
            visualizer({
              filename: 'dist/stats.json',
              template: 'raw-data',
              open: false,
              gzipSize: true,
              brotliSize: true,
            }),
          ]
        : []),
    ],
  server: {
    port: 5173,
    allowedHosts: ['.trycloudflare.com'],
    proxy: apiProxyConfig,
  },
  preview: {
    port: 5173,
    allowedHosts: ['.trycloudflare.com'],
    proxy: apiProxyConfig,
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;

          // Resolve the owning package name (handles scoped names and pnpm's
          // nested node_modules layout, where the *last* node_modules wins).
          const normalizedId = id.replace(/\\/g, '/');
          const [first = '', second = ''] = (
            normalizedId.split('/node_modules/').pop() ?? ''
          ).split('/');
          const pkgName = first.startsWith('@') ? `${first}/${second}` : first;

          const isPkg = (name: string) => pkgName === name || pkgName.startsWith(`${name}/`);
          const hasPrefix = (prefix: string) => pkgName.startsWith(prefix);

          // Pure leaf foundation runtimes without cross-chunk cycles
          if (isPkg('@tanstack/react-query') || isPkg('@tanstack/query-core')) {
            return 'vendor-query';
          }
          if (
            isPkg('react') ||
            isPkg('react-dom') ||
            isPkg('scheduler') ||
            isPkg('react-router') ||
            isPkg('react-router-dom')
          ) {
            return 'vendor-react';
          }
          // Heavy UI kit (antd + its icon set) — larger than every other vendor.
          // rc-* / @rc-component/* are antd's transitive headless primitives and
          // must ride the same chunk: leaving them unmapped dumped them into the
          // app entry bundle.
          if (isPkg('antd') || hasPrefix('@ant-design/')) {
            return 'vendor-antd';
          }
          // antd's headless primitives (rc-*, @rc-component/*) — mapped explicitly
          // so they never leak into the app entry, but kept in their own chunk so
          // the antd runtime itself stays well under the vendor ceiling.
          if (hasPrefix('rc-') || hasPrefix('@rc-component/')) {
            return 'vendor-antd-rc';
          }
          // Drag-and-drop runtime
          if (isPkg('@dnd-kit')) {
            return 'vendor-dnd';
          }
          // Date library
          if (isPkg('dayjs')) {
            return 'vendor-date';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    testTimeout: 15000,
    include: ['src/**/*.test.{ts,tsx}', 'tests/unit/**/*.test.{ts,tsx}'],
  },
};
});
