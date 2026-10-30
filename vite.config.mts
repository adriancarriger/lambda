import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { type ProxyOptions, defineConfig } from 'vite';

import { proxiedOrigin } from './src/app/devProxy';

const MOTHERSHIP = 'http://127.0.0.1:4580';

/**
 * In development the page is on Vite's port: the proxy presents it to the
 * mothership as its own origin, or its Origin/Host check refuses every POST.
 * Only its own: any other origin passes through and is refused.
 */
const toMothership: ProxyOptions = {
  target: MOTHERSHIP,
  changeOrigin: true,
  ws: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (request) => {
      const origin = request.getHeader('origin');
      const sent = proxiedOrigin(
        typeof origin === 'string' ? origin : undefined,
        MOTHERSHIP
      );

      if (sent !== undefined) {
        request.setHeader('origin', sent);
      }
    });
  },
};

/**
 * The Lambda app's client, served by the mothership from dist/app. The
 * manifest lets a test check each screen is its own chunk.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/app/client'),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/app'),
    emptyOutDir: true,
    manifest: true,
  },
  server: {
    port: 4581,
    proxy: {
      '/api': toMothership,
      '/auth': toMothership,
      '/proto': toMothership,
    },
  },
});
