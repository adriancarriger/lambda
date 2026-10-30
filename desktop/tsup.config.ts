import { defineConfig } from 'tsup';

// The Mac app's main process and its preload bridge, into desktop/dist.
// Run from the package folder (`build:mac`), after the package's own build.
export default defineConfig({
  entry: {
    main: 'desktop/main.ts',
    preload: 'desktop/preload.ts',
  },
  outDir: 'desktop/dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  clean: true,
  // Electron's own, and native modules loaded from node_modules.
  external: [
    'electron',
    'electron-updater',
    'better-sqlite3',
    '@lydell/node-pty',
  ],
});
