import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createMetaProxyMiddleware } from './src/server/meta-proxy';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'traceforge-meta-proxy',
      configureServer(server) {
        // Local Meta API proxy: attaches META_API_KEY server-side so the
        // browser bundle never sees it. Returns 503 in zero-cost mode.
        server.middlewares.use(createMetaProxyMiddleware());
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
