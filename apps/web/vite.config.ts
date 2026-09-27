/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

export const devFaviconPlugin = (): Plugin => ({
  name: 'dev-favicon-transform',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace('/favicon.svg', '/favicon-dev.svg');
  },
});

const apiProxyConfig = {
  '/api': {
    target: process.env.VITE_BACKEND_URL || 'http://127.0.0.1:3000',
    changeOrigin: true,
    headers: {
      origin: 'http://localhost:5173',
    },
  },
};

export default defineConfig(({ mode }) => {
  const isAnalyze = mode === 'analyze' || process.env.ANALYZE === 'true';

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

          const isPkg = (name: string) =>
            id.includes(`/node_modules/${name}/`) || id.includes(`\\node_modules\\${name}\\`);

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
