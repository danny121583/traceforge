import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createMetaProxyMiddleware } from './src/server/meta-proxy';
import { createMaasMcpMiddleware } from './src/server/maas-mcp-server';

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
    {
      name: 'traceforge-maas-mcp',
      configureServer(server) {
        // Independent TraceForge MaaS/MCP surface: MCP 2025-06-18 JSON-RPC
        // plus public MaaS REST endpoints and the scoped audit endpoint.
        server.middlewares.use(createMaasMcpMiddleware());
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
