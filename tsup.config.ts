import { defineConfig } from 'tsup';

// The library (index) and the command line (cli). bin/lambda requires
// dist/cli.js. The mothership and the runner are their own processes,
// started by `lambda start`. The app's client is built by Vite into dist/app.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    mothership: 'src/mothership/main.ts',
    runner: 'src/runner/main.ts',
    // Kokoro's model runs in its own process (src/app/server/tts/kokoro.ts).
    kokoroWorker: 'src/app/server/tts/kokoroWorker.ts',
  },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  dts: { entry: { index: 'src/index.ts', cli: 'src/cli.ts' } },
  // Vite writes dist/app after this (`tsup && vite build`).
  clean: true,
  // Native modules, loaded from node_modules at run time; Kokoro's only in
  // the Mac app, which carries it beside app.asar.
  external: [
    'better-sqlite3',
    '@lydell/node-pty',
    'kokoro-js',
    '@huggingface/transformers',
  ],
});
