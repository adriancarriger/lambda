import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { type Project } from '../../config/projectConfig';
import { ensureDesignGitignore } from '../canvasDir';
import {
  BUNDLE_JS,
  type CatalogEntry,
  INDEX,
  type PatternCopy,
  type ReferenceScreen,
  assembleSystem,
  checkBundle,
} from './assemble';
import {
  bundleEntry,
  compileTailwind,
  installedFrom,
  tailwindCli,
} from './bundle';
import { appRuntimeProblems, drawCheckProblems } from './checks';
import { detectStack } from './detect';
import { git, gitOk } from './git';
import { loadProjectModule } from './loadModule';
import { ManifestSchema, readManifestFile } from './manifest';
import { systemNamespace } from './namespace';
import { checkScreens } from './screenCheck';
import { SOURCE_MAP_FILE, checkSourceMap, readSourceMap } from './sources';
import { type TokensJson, checkTokens, deriveTokens } from './tokens';

/**
 * `lambda design system build`: the design system as committed in a
 * checkout, built into a gitignored folder. Local and deterministic: two
 * builds of one commit on any computer with the same installed packages give
 * the same files (the Screens page's pictures aside). It never writes inside
 * `design.system.dir`.
 */

export const DEFAULT_BUILD_OUT = path.join('.lambda', 'design', 'system');

export const PHOTO_TOKENS = 'tokens.photos.json';

export class NoDesignSystemError extends Error {}

export const noDesignSystemMessage = (manifest: string): string =>
  `This project has no design system yet (${manifest}).`;

export const uncommittedMessage = (dir: string): string =>
  `The design system in ${dir} has uncommitted changes. Designs use it as committed; commit or drop them first.`;

/** Names the project, never its path: the output holds no path on this computer. */
export const notInstalledMessage = (projectName: string): string =>
  `${projectName}'s packages aren't installed, so Lambda can't bundle its components. The design system has the look only.`;

export const noComponentsMessage = (dir: string): string =>
  `${dir}/catalog.ts lists no components, so the design system has the look only.`;

export const outOverlapsMessage = (out: string, dir: string): string =>
  `Refusing to build into ${out}: replacing it would delete ${dir}, the design system's own source. Build into another folder (the default is ${DEFAULT_BUILD_OUT}).`;

export const TAILWIND_NO_ENTRY =
  'Tailwind is installed, but none of the theme files is its CSS entry (a stylesheet with @tailwind, or @import "tailwindcss"), so bundle.css can\'t be compiled. Name it in sources.json tokens.';

export const TAILWIND_NO_CLI =
  "Tailwind is in the app, but no Tailwind CLI is installed here, so bundle.css is esbuild's CSS, without Tailwind's classes.";

export const RUNTIME_NOT_CHECKED =
  "App runtime not checked: the project's own build (design.system.build) made the bundle.";

export interface BuildOptions {
  project: Project;
  /** The project's name as Lambda shows it: the system's title. */
  projectName: string;
  /** The checkout the source is read from and built in. */
  checkout: string;
  out: string;
  /** Build what is on disk, uncommitted edits included. */
  workingTree?: boolean;
  /** Also the app-runtime, draw and map checks (implies a working-tree build). */
  check?: boolean;
  log?: (line: string) => void;
}

export interface BuildResult {
  out: string;
  warnings: string[];
  /** What `--check` found; empty when it passed or didn't run. */
  problems: string[];
  /** Lines worth printing (a look-only reason, a check that didn't run). */
  notes: string[];
}

const posix = (file: string): string => file.split(path.sep).join('/');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Committer date of `ref` (`%cI`). */
const commitDate = (checkout: string, ref: string): string =>
  git(checkout, ['show', '-s', '--format=%cI', ref]);

/** When the manifest was first committed, else `fallback`. */
const createdAt = (
  checkout: string,
  manifest: string,
  fallback: string
): string => {
  const added = gitOk(checkout, [
    'log',
    '--diff-filter=A',
    '--format=%cI',
    '--',
    manifest,
  ]);
  const last = added
    ?.split('\n')
    .filter((line) => line !== '')
    .at(-1);

  return last ?? fallback;
};

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

/** `sampleData.ts` exports one plain data object; throws naming the bad key. */
export const assertPlainData = (value: unknown, at = ''): void => {
  const fail = (type: string): never => {
    throw new Error(
      `sampleData.ts must export one plain data object: ${
        at || 'it'
      } is a ${type}.`
    );
  };

  if (
    value === null ||
    ['string', 'number', 'boolean'].includes(typeof value)
  ) {
    return;
  }

  if (typeof value === 'function') {
    fail('function');
  }

  if (
    value instanceof Date ||
    Object.prototype.toString.call(value) === '[object Date]'
  ) {
    fail('Date');
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainData(item, `${at}[${index}]`));

    return;
  }

  if (!isRecord(value)) {
    fail(typeof value);

    return;
  }

  const proto: unknown = Object.getPrototypeOf(value);

  if (proto !== Object.prototype && proto !== null) {
    fail(
      isRecord(proto) && typeof proto.constructor === 'function'
        ? proto.constructor.name
        : 'class instance'
    );
  }

  Object.entries(value).forEach(([key, child]) =>
    assertPlainData(child, at === '' ? key : `${at}.${key}`)
  );
};

/** The one exported value of a module: `default`, else `named`, else the only one. */
const exportOf = (
  exported: Record<string, unknown>,
  named: string[]
): unknown => {
  const [byName] = named.flatMap((name) =>
    name in exported ? [exported[name]] : []
  );

  if (byName !== undefined) {
    return byName;
  }

  if ('default' in exported) {
    return exported.default;
  }

  const values = Object.values(exported);

  return values.length === 1 ? values[0] : undefined;
};

const readCatalog = async (
  checkout: string,
  dir: string
): Promise<CatalogEntry[]> => {
  const file = path.join(dir, 'catalog.ts');

  if (!fs.existsSync(path.join(checkout, file))) {
    return [];
  }

  const catalog = exportOf(await loadProjectModule(checkout, file), [
    'catalog',
    'CATALOG',
  ]);

  if (
    !Array.isArray(catalog) ||
    !catalog.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        typeof entry.summary === 'string' &&
        isRecord(entry.props) &&
        'example' in entry
    )
  ) {
    throw new Error(
      `${dir}/catalog.ts must export a list of { name, summary, props, example }.`
    );
  }

  return catalog.map(
    (entry): CatalogEntry => ({
      ...entry,
      name: String(entry.name),
      summary: String(entry.summary),
      props: Object.fromEntries(
        Object.entries(isRecord(entry.props) ? entry.props : {}).map(
          ([k, v]) => [k, String(v)]
        )
      ),
      example: entry.example,
    })
  );
};

const readSampleData = async (
  checkout: string,
  dir: string
): Promise<unknown> => {
  const file = path.join(dir, 'sampleData.ts');

  if (!fs.existsSync(path.join(checkout, file))) {
    return undefined;
  }

  const exported = await loadProjectModule(checkout, file);
  const values = Object.values(exported);

  if (values.length !== 1) {
    throw new Error(
      `sampleData.ts must export one plain data object, not ${values.length} exports.`
    );
  }

  const [data] = values;
  assertPlainData(data);

  return data;
};

const isScreen = (value: unknown): value is ReferenceScreen =>
  isRecord(value) &&
  typeof value.file === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.dc\.html$/.test(value.file) &&
  typeof value.title === 'string' &&
  typeof value.route === 'string' &&
  typeof value.summary === 'string' &&
  typeof value.scenario === 'string' &&
  Array.isArray(value.situations) &&
  Array.isArray(value.path);

const readScreens = async (
  checkout: string,
  dir: string
): Promise<{ screens: ReferenceScreen[]; files: Record<string, string> }> => {
  const index = path.join(dir, 'screens', 'index.ts');

  if (!fs.existsSync(path.join(checkout, index))) {
    return { screens: [], files: {} };
  }

  const screens = exportOf(await loadProjectModule(checkout, index), [
    'SCREENS',
    'screens',
  ]);

  if (!Array.isArray(screens) || !screens.every(isScreen)) {
    throw new Error(
      `${dir}/screens/index.ts must export SCREENS: [{ file, title, route, summary, situations, path, scenario }].`
    );
  }

  return {
    screens,
    files: Object.fromEntries(
      screens.flatMap(({ file }) => {
        const full = path.join(checkout, dir, 'screens', file);

        return fs.existsSync(full)
          ? [[file, fs.readFileSync(full, 'utf8')]]
          : [];
      })
    ),
  };
};

/** Write a built folder: into a temporary sibling, renamed into place. */
const writeBuilt = (out: string, files: Record<string, string>): void => {
  const temp = `${out}.building-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });

  try {
    Object.entries(files).forEach(([rel, body]) => {
      const file = path.join(temp, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    });
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.renameSync(temp, out);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });

    throw error;
  }
};

/**
 * The project's own build, `design.system.build`, into `out`, its bundle
 * held to the manifest's namespace. Returns the bundle rules' warnings.
 */
const runProjectBuild = (
  command: string,
  checkout: string,
  out: string,
  namespace: string
): string[] => {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const result = spawnSync(
    'sh',
    ['-c', command.split('{out}').join(shellQuote(out))],
    // A chatty build must not overflow the pipe: 64 MB of output.
    { cwd: checkout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  // When spawning itself failed (ENOENT, ENOBUFS), that is the cause.
  const lastLine =
    result.error?.message ??
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .at(-1) ??
    `exit ${result.status ?? 'unknown'}`;

  if (result.status !== 0) {
    fs.rmSync(out, { recursive: true, force: true });

    throw new Error(
      `The project's design system build (design.system.build) failed: ${lastLine.replace(
        /\.+$/,
        ''
      )}.`
    );
  }

  const bundle = path.join(out, BUNDLE_JS);

  if (!fs.existsSync(path.join(out, INDEX))) {
    throw new Error(
      `The project's design system build (design.system.build) wrote no ${INDEX} into {out}.`
    );
  }

  return fs.existsSync(bundle)
    ? checkBundle(fs.readFileSync(bundle, 'utf8'), namespace)
    : [];
};

/** The source map's patterns, as the README lists them. */
const patternsOf = (
  checkout: string,
  dir: string
): { patterns: PatternCopy[]; components: Record<string, string> } => {
  if (!fs.existsSync(path.join(checkout, dir, SOURCE_MAP_FILE))) {
    return { patterns: [], components: {} };
  }

  const map = readSourceMap(checkout, dir);

  return {
    patterns: Object.entries(map.patterns).map(([file, copies]) => ({
      file,
      copies,
    })),
    components: map.components,
  };
};

/** The map test, when the design system has a source map. */
const mapProblems = (checkout: string, dir: string): string[] =>
  fs.existsSync(path.join(checkout, dir, SOURCE_MAP_FILE))
    ? checkSourceMap(checkout, dir)
    : [];

/** Tailwind's CSS entry among the theme files; throws when none is one. */
const tailwindEntry = (checkout: string, theme: string[]): string => {
  const entry = theme.find(
    (file) =>
      file.endsWith('.css') &&
      /@tailwind\b|@import\s+["']tailwindcss["']/.test(
        fs.readFileSync(path.join(checkout, file), 'utf8')
      )
  );

  if (entry === undefined) {
    throw new Error(TAILWIND_NO_ENTRY);
  }

  return entry;
};

/** Why the build makes no bundle, or undefined when it makes one. */
const noBundleReasonOf = ({
  react,
  reason,
  installed,
  components,
  dir,
  projectName,
}: {
  react: boolean;
  reason: string | undefined;
  installed: boolean;
  /** How many components and patterns the catalog lists. */
  components: number;
  dir: string;
  projectName: string;
}): string | undefined => {
  if (!react) {
    return (
      reason ??
      'This app has no React components, so the design system has the look only.'
    );
  }

  if (!installed) {
    return notInstalledMessage(projectName);
  }

  return components === 0 ? noComponentsMessage(dir) : undefined;
};

/**
 * Build the design system in `checkout` into `out`. Throws (nothing left in
 * `out`) on a refusal or a broken build; `--check` problems come back in
 * `problems` with the built folder kept, so they can be read.
 */
export const buildSystem = async (
  options: BuildOptions
): Promise<BuildResult> => {
  const { project, projectName, checkout } = options;
  const workingTree = options.workingTree === true || options.check === true;
  const log = options.log ?? (() => {});
  const { dir, manifest: manifestPath, build } = project.config.design.system;
  const out = path.resolve(options.out);
  // A build replaces its out folder: never one holding the source.
  const overlaps = (target: string): boolean => {
    const from = path.relative(out, target);
    const to = path.relative(target, out);

    return (
      from === '' ||
      !(from.startsWith('..') || path.isAbsolute(from)) ||
      !(to.startsWith('..') || path.isAbsolute(to))
    );
  };

  if (
    overlaps(path.resolve(checkout, dir)) ||
    overlaps(path.resolve(checkout, manifestPath))
  ) {
    throw new Error(outOverlapsMessage(out, dir));
  }

  const read = readManifestFile(path.join(checkout, manifestPath));

  // A working-tree build may come before the manifest: the setup ticket
  // builds and checks the design system before its last step writes it.
  if (read === null && !workingTree) {
    throw new NoDesignSystemError(noDesignSystemMessage(manifestPath));
  }

  if (!workingTree) {
    const dirty = git(checkout, [
      'status',
      '--porcelain',
      '--',
      dir,
      manifestPath,
    ]);

    if (dirty !== '') {
      throw new Error(uncommittedMessage(dir));
    }
  }

  ensureDesignGitignore(out);
  const manifest =
    read?.manifest ??
    ManifestSchema.parse({ namespace: systemNamespace(projectName) });
  const { namespace } = manifest;
  const exclude = project.config.design.systemBuild?.exclude ?? [];

  if (build !== undefined) {
    const temp = `${out}.building-${process.pid}`;
    const warnings = ((): string[] => {
      try {
        return runProjectBuild(build, checkout, temp, namespace);
      } catch (error) {
        // Its output broke a bundle rule, or never came: nothing is kept.
        fs.rmSync(temp, { recursive: true, force: true });

        throw error;
      }
    })();

    fs.rmSync(out, { recursive: true, force: true });
    fs.renameSync(temp, out);

    if (options.check !== true) {
      return { out, warnings, problems: [], notes: [] };
    }

    const metafileFile = path.join(out, 'metafile.json');
    const entry = posix(path.join(dir, 'index.tsx'));
    const runtime = fs.existsSync(metafileFile)
      ? appRuntimeProblems({
          metafile: JSON.parse(fs.readFileSync(metafileFile, 'utf8')),
          entry,
          entryText: fs.existsSync(path.join(checkout, entry))
            ? fs.readFileSync(path.join(checkout, entry), 'utf8')
            : '',
          exclude,
        })
      : [];
    const notes = fs.existsSync(metafileFile) ? [] : [RUNTIME_NOT_CHECKED];

    const catalog = await readCatalog(checkout, dir);
    const drawn = fs.existsSync(path.join(out, BUNDLE_JS))
      ? await drawCheckProblems({
          builtDir: out,
          checkout,
          catalog,
          namespace,
          log,
        })
      : [];

    return {
      out,
      warnings,
      problems: [...runtime, ...drawn, ...mapProblems(checkout, dir)],
      notes,
    };
  }

  const sha = git(checkout, ['rev-parse', 'HEAD']);
  const short = sha.slice(0, 7);
  const at = commitDate(checkout, 'HEAD');
  const created = createdAt(checkout, manifestPath, at);
  const { patterns, components: mapped } = patternsOf(checkout, dir);
  const leftOut = manifest.leftOut ?? [];
  const common = {
    namespace,
    title: projectName,
    leftOut,
    patterns,
    version: manifest.version,
    sha: short,
    at,
    createdAt: created,
  };

  if (manifest.source === 'photos') {
    const photoTokens = path.join(checkout, dir, PHOTO_TOKENS);

    if (!fs.existsSync(photoTokens)) {
      throw new Error(
        `${dir}/${PHOTO_TOKENS} is missing: a design system made from photos keeps its look there.`
      );
    }

    const committed: TokensJson = JSON.parse(
      fs.readFileSync(photoTokens, 'utf8')
    );
    // The look as the photos gave it; meta says where it came from.
    const tokens: TokensJson = {
      ...committed,
      meta: { source: 'photos', ref: short, components: {} },
    };

    try {
      checkTokens(tokens);
    } catch (error) {
      // The file at fault is the committed one: name it.
      throw new Error(
        String(error instanceof Error ? error.message : error).replace(
          /^tokens\.json:/,
          `${dir}/${PHOTO_TOKENS}:`
        )
      );
    }
    const { files, warnings } = assembleSystem({
      ...common,
      tokens,
      skipped: [],
      catalog: [],
      patterns: [],
      screens: [],
      screenFiles: {},
      source: 'photos',
      noBundleReason:
        'Made from photos only: there are no components to mount.',
    });
    writeBuilt(out, files);

    return { out, warnings, problems: [], notes: [] };
  }

  const detected = detectStack(checkout, project.config, { ref: 'HEAD' });
  const mapTheme = fs.existsSync(path.join(checkout, dir, SOURCE_MAP_FILE))
    ? readSourceMap(checkout, dir).tokens
    : [];
  const theme = mapTheme.length > 0 ? mapTheme : detected.theme;
  // As Node finds it from the design system: a workspace package's install counts.
  const installed =
    installedFrom(checkout, path.join(checkout, dir), 'react') !== undefined;
  const entry = posix(path.join(dir, 'index.tsx'));
  // The catalog is the design system's list of what the bundle exports.
  const listed =
    detected.react && installed ? await readCatalog(checkout, dir) : [];
  const noBundleReason = noBundleReasonOf({
    react: detected.react,
    reason: detected.reason,
    installed,
    components: listed.length,
    dir,
    projectName,
  });

  if (
    noBundleReason === undefined &&
    !fs.existsSync(path.join(checkout, entry))
  ) {
    throw new Error(
      `${entry} doesn't exist, but ${dir}/catalog.ts lists ${
        listed.length
      } component${listed.length === 1 ? '' : 's'}: the bundle has no entry.`
    );
  }

  const catalog = noBundleReason === undefined ? listed : [];
  const bundled =
    noBundleReason === undefined
      ? await bundleEntry({
          checkout,
          entry,
          namespace,
          components: catalog.map(({ name }) => name),
          exclude,
        })
      : undefined;
  const tailwind = bundled !== undefined && detected.stack === 'tailwind';
  const tailwindInstalled =
    tailwind &&
    [checkout, ...theme.map((file) => path.dirname(path.join(checkout, file)))]
      .map((from) => tailwindCli(checkout, from))
      .some((cli) => cli !== undefined);
  const css =
    bundled !== undefined && tailwindInstalled
      ? compileTailwind({
          checkout,
          cssEntry: tailwindEntry(checkout, theme),
          inputs: Object.keys(bundled.metafile.inputs).filter(
            (input) =>
              !input.includes('node_modules/') &&
              !input.includes(':') &&
              !input.endsWith('.css')
          ),
        })
      : undefined;
  // Without the project's Tailwind CLI, bundle.css is esbuild's: said, so it's never mistaken for the whole look.
  const notes = [
    ...(noBundleReason === undefined ? [] : [noBundleReason]),
    ...(tailwind && css === undefined ? [TAILWIND_NO_CLI] : []),
  ];
  const sampleData =
    bundled === undefined ? undefined : await readSampleData(checkout, dir);
  const { screens, files: screenFiles } =
    bundled === undefined
      ? { screens: [], files: {} }
      : await readScreens(checkout, dir);
  const { tokens, skipped } = await deriveTokens({
    checkout,
    stack: detected.stack,
    theme,
    title: projectName,
    ref: short,
    components: mapped,
  });
  const { files, warnings } = assembleSystem({
    ...common,
    ...(bundled === undefined
      ? { noBundleReason }
      : {
          bundle: {
            js: bundled.js,
            css: css ?? bundled.css,
            components: catalog.map(({ name }) => name),
          },
        }),
    tokens,
    skipped,
    catalog,
    sampleData,
    screens,
    screenFiles,
    source: manifest.source ?? 'code',
  });
  writeBuilt(out, files);

  if (screens.length > 0) {
    // A screen that fails fails the build: nothing is left in `out`.
    await checkScreens({
      out,
      title: projectName,
      namespace,
      screens,
      log,
    }).catch((error: unknown) => {
      fs.rmSync(out, { recursive: true, force: true });

      throw error;
    });
  }

  if (options.check !== true || bundled === undefined) {
    return {
      out,
      warnings,
      problems: options.check === true ? mapProblems(checkout, dir) : [],
      notes,
    };
  }

  const runtime = appRuntimeProblems({
    metafile: bundled.metafile,
    entry,
    entryText: fs.readFileSync(path.join(checkout, entry), 'utf8'),
    exclude,
  });
  const drawn = await drawCheckProblems({
    builtDir: out,
    checkout,
    catalog,
    namespace,
    log,
  });

  return {
    out,
    warnings,
    problems: [...runtime, ...drawn, ...mapProblems(checkout, dir)],
    notes,
  };
};
