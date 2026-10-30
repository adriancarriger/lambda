import { execFileSync } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { lambdaPackageDir } from '../../process/workflow-file';
import { bundleHeader } from './assemble';
import { matchesAny } from './glob';

/**
 * Bundle a design system's entry (`<dir>/index.tsx`) into one classic IIFE
 * script and its stylesheet, the way a canvas loads them:
 *
 *   - React is not bundled: `react`, `react-dom`, `react-dom/client` and
 *     `react/jsx-runtime` read `window.React` / `window.ReactDOM`.
 *   - `next/link`, `next/image`, `next/navigation` and `next/router` become
 *     Lambda's shims; any other `next/*` import fails the build.
 *   - `design.systemBuild.exclude` files become empty modules.
 *   - The project's packages resolve from the checkout (`nodePaths` = its
 *     `node_modules`); each file's `tsconfig.json` paths are its nearest
 *     tsconfig's, so a workspace package's own `@/*` works.
 */

export interface Metafile {
  inputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
}

export interface Bundled {
  js: string;
  css: string;
  metafile: Metafile;
}

const REACT_GLOBALS: Record<string, string> = {
  react: 'window.React',
  'react-dom': 'window.ReactDOM',
  'react-dom/client': 'window.ReactDOM',
};

// The automatic JSX runtime, over the page's createElement.
const JSX_RUNTIME = `
  var R = window.React;
  exports.Fragment = R.Fragment;
  exports.jsx = exports.jsxs = exports.jsxDEV = function (type, props, key) {
    return R.createElement(type, key === undefined ? props : Object.assign({}, props, { key: key }));
  };
`;

const SHIMS: Record<string, string> = {
  'next/link': 'link.ts',
  'next/image': 'image.ts',
  'next/navigation': 'navigation.ts',
  'next/router': 'router.ts',
};

/** Where the shims are: beside this file in the package's source. */
export const shimsDir = (): string =>
  path.join(lambdaPackageDir(), 'src', 'design', 'system', 'shims');

const reactGlobals: esbuild.Plugin = {
  name: 'react-globals',
  setup(build) {
    build.onResolve(
      {
        filter:
          /^(react|react-dom|react-dom\/client|react\/jsx-(dev-)?runtime)$/,
      },
      (args) => ({ path: args.path, namespace: 'react-global' })
    );
    build.onLoad({ filter: /.*/, namespace: 'react-global' }, (args) => ({
      loader: 'js',
      contents: args.path.startsWith('react/jsx')
        ? JSX_RUNTIME
        : `module.exports = ${REACT_GLOBALS[args.path] ?? 'window.React'};`,
    }));
  },
};

export const noStandInMessage = (file: string, specifier: string): string =>
  `${file} imports ${specifier}, which the design system has no stand-in for. Copy the piece as a pattern, or leave it out with design.systemBuild.exclude.`;

const nextShims = (checkout: string): esbuild.Plugin => ({
  name: 'next-shims',
  setup(build) {
    build.onResolve({ filter: /^next(\/|$)/ }, (args) => {
      const shim = SHIMS[args.path];

      if (shim === undefined) {
        return {
          errors: [
            {
              text: noStandInMessage(
                path.relative(checkout, args.importer),
                args.path
              ),
            },
          ],
        };
      }

      return { path: path.join(shimsDir(), shim) };
    });
  },
});

const excluded = (checkout: string, exclude: string[]): esbuild.Plugin => ({
  name: 'design-system-exclude',
  setup(build) {
    if (exclude.length === 0) {
      return;
    }

    build.onLoad({ filter: /.*/ }, (args) => {
      const rel = path.relative(checkout, args.path).split(path.sep).join('/');

      return matchesAny(exclude, rel)
        ? { contents: 'module.exports = {};', loader: 'js' }
        : undefined;
    });
  },
});

/** Messages of a failed esbuild run, one per line. */
const buildErrors = (error: unknown): string => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'errors' in error &&
    Array.isArray(error.errors)
  ) {
    return error.errors
      .map((one: unknown) =>
        typeof one === 'object' && one !== null && 'text' in one
          ? String(one.text)
          : String(one)
      )
      .join('\n');
  }

  return error instanceof Error ? error.message : String(error);
};

export const bundleEntry = async ({
  checkout,
  entry,
  namespace,
  components,
  exclude,
}: {
  checkout: string;
  /** Relative to the checkout: `<dir>/index.tsx`. */
  entry: string;
  namespace: string;
  /** The names the header lists. */
  components: string[];
  exclude: string[];
}): Promise<Bundled> => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-bundle-'));
  const outfile = path.join(scratch, 'bundle.js');

  try {
    const result = await esbuild
      .build({
        absWorkingDir: checkout,
        entryPoints: [path.join(checkout, entry)],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2019',
        minify: true,
        legalComments: 'none',
        charset: 'utf8',
        jsx: 'automatic',
        nodePaths: [path.join(checkout, 'node_modules')],
        define: { 'process.env.NODE_ENV': '"production"' },
        banner: { js: bundleHeader(namespace, components) },
        outfile,
        metafile: true,
        write: true,
        plugins: [
          reactGlobals,
          nextShims(checkout),
          excluded(checkout, exclude),
        ],
        logLevel: 'silent',
      })
      .catch((error: unknown) => {
        throw new Error(buildErrors(error));
      });
    const cssFile = path.join(scratch, 'bundle.css');

    return {
      js: fs.readFileSync(outfile, 'utf8'),
      css: fs.existsSync(cssFile) ? fs.readFileSync(cssFile, 'utf8') : '',
      // esbuild names inputs relative to absWorkingDir: the checkout.
      metafile: result.metafile,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

/** `from` and each folder above it, up to and including the checkout. */
const foldersUp = (checkout: string, from: string): string[] => {
  const rel = path.relative(checkout, from);

  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel)
    ? [checkout]
    : [from, ...foldersUp(checkout, path.dirname(from))];
};

/**
 * `node_modules/<rel>` as Node finds it from `from` (absolute): the nearest
 * one, walking up to the checkout, so a workspace package's own install
 * counts as much as the root's.
 */
export const installedFrom = (
  checkout: string,
  from: string,
  rel: string
): string | undefined =>
  foldersUp(checkout, from)
    .map((dir) => path.join(dir, 'node_modules', rel))
    .find((file) => fs.existsSync(file));

/** The Tailwind CLI (v3's or v4's) installed for `from`, if any. */
export const tailwindCli = (
  checkout: string,
  from: string = checkout
): string | undefined =>
  foldersUp(checkout, from)
    .flatMap((dir) =>
      ['tailwindcss', 'tailwind'].map((bin) =>
        path.join(dir, 'node_modules', '.bin', bin)
      )
    )
    .find((bin) => fs.existsSync(bin));

/** The installed `tailwindcss` major version; v4 when only `@tailwindcss/cli` is there. */
const tailwindMajor = (checkout: string, from: string): number => {
  const pkg = installedFrom(checkout, from, 'tailwindcss/package.json');
  const version: unknown =
    pkg === undefined
      ? undefined
      : JSON.parse(fs.readFileSync(pkg, 'utf8')).version;

  return typeof version === 'string' ? Number(version.split('.')[0]) : 4;
};

/**
 * Tailwind: `bundle.css` compiled by the project's own installed CLI over its
 * CSS entry, with the bundle's inputs as content. v3 takes them as one
 * comma-separated `--content` (it keeps only the last of a repeated flag);
 * v4 has no `--content`, so a scratch entry imports the project's and names
 * each input with `@source`. Without a CLI installed, the stylesheet esbuild
 * made stands.
 */
export const compileTailwind = ({
  checkout,
  cssEntry,
  inputs,
}: {
  checkout: string;
  /** Relative to the checkout. */
  cssEntry: string;
  /** Relative to the checkout. */
  inputs: string[];
}): string | undefined => {
  // The CLI and its version as the CSS entry's own package has them.
  const from = path.dirname(path.join(checkout, cssEntry));
  const cli = tailwindCli(checkout, from);

  if (cli === undefined) {
    return undefined;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-tailwind-'));
  const out = path.join(scratch, 'bundle.css');
  const absolute = inputs.map((input) => path.join(checkout, input));

  try {
    if (tailwindMajor(checkout, from) >= 4) {
      const entry = path.join(scratch, 'entry.css');
      fs.writeFileSync(
        entry,
        [
          `@import "${path.join(checkout, cssEntry)}";`,
          ...absolute.map((file) => `@source "${file}";`),
          '',
        ].join('\n')
      );
      execFileSync(cli, ['--input', entry, '--output', out, '--minify'], {
        cwd: checkout,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      return fs.readFileSync(out, 'utf8');
    }

    execFileSync(
      cli,
      [
        '--input',
        path.join(checkout, cssEntry),
        '--output',
        out,
        '--minify',
        '--content',
        absolute.join(','),
      ],
      { cwd: checkout, stdio: ['ignore', 'ignore', 'pipe'] }
    );

    return fs.readFileSync(out, 'utf8');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};
