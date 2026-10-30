import * as esbuild from 'esbuild';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

import { installedFrom } from './bundle';

/**
 * Run one of a project's own modules (a theme file, a Tailwind config, the
 * catalog, the sample data) and return its exports. It is bundled for node
 * with esbuild — TypeScript and each file's nearest `tsconfig.json` paths work —
 * while its packages stay external. The bundle is written under the
 * `node_modules/.cache/` nearest the module (a workspace package's own, else
 * the checkout's), so those packages resolve as Node finds them from the
 * module (in the build checkout, through the symlinks to the project's), and
 * removed once read.
 */
export const loadProjectModule = async (
  checkout: string,
  file: string
): Promise<Record<string, unknown>> => {
  const modules =
    installedFrom(checkout, path.dirname(path.resolve(checkout, file)), '') ??
    path.join(checkout, 'node_modules');
  const cache = path.join(modules, '.cache', 'lambda-design');
  fs.mkdirSync(cache, { recursive: true });
  const outfile = path.join(
    cache,
    `${path.basename(file).replace(/\W/g, '-')}-${
      process.pid
    }-${Date.now()}.cjs`
  );

  try {
    await esbuild.build({
      absWorkingDir: checkout,
      entryPoints: [path.resolve(checkout, file)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      jsx: 'automatic',
      outfile,
      logLevel: 'silent',
    });

    // Node's own require, so the project's packages load as they are.
    const load = createRequire(outfile);
    const exported: unknown = load(outfile);
    delete load.cache[outfile];

    return typeof exported === 'object' && exported !== null
      ? Object.fromEntries(Object.entries(exported))
      : { default: exported };
  } finally {
    fs.rmSync(outfile, { force: true });
  }
};
