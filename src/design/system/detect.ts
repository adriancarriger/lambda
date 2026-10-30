import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  type ProjectConfig,
  resolvePodsRoot,
} from '../../config/projectConfig';
import { defaultBranchRef, gitPaths } from './git';
import { expandGlobs } from './glob';
import { readManifestOnBranch } from './manifest';

/**
 * `lambda design system detect`: what a project's code says its look and
 * components are. Read from the project's own files only, nothing installed
 * or run. The setup ticket starts here, and Settings → Design system shows
 * its look and components lines.
 */

export type Stack =
  | 'mui'
  | 'chakra'
  | 'tailwind'
  | 'styled-components'
  | 'css-variables'
  | 'vue'
  | 'svelte'
  | 'angular'
  | 'solid'
  | 'unknown';

export interface Detected {
  stack: Stack;
  /** Tailwind with shadcn/ui (a `components.json` at the package). */
  shadcn: boolean;
  react: boolean;
  /** Theme files, relative to the project root. */
  theme: string[];
  /** Component names, most imported first. */
  components: string[];
  /** Why there are no components, when that is the stack's fault. */
  reason?: string;
  system: { dir: string; version?: number; builtFrom?: string } | null;
}

/** At most this many components are listed. */
export const MAX_COMPONENTS = 40;

/** MUI and Chakra: the library's own themed primitives come first. */
export const LIBRARY_PRIMITIVES = [
  'Button',
  'IconButton',
  'Card',
  'Input',
  'Textarea',
  'Select',
  'Checkbox',
  'Chip',
  'Badge',
  'Divider',
  'Typography',
  'Modal',
  'Tooltip',
  'List',
];

const NON_REACT: { dep: string; stack: Stack; label: string }[] = [
  { dep: 'vue', stack: 'vue', label: 'Vue' },
  { dep: 'svelte', stack: 'svelte', label: 'Svelte' },
  { dep: '@angular/core', stack: 'angular', label: 'Angular' },
  { dep: 'solid-js', stack: 'solid', label: 'Solid' },
];

export const nonReactReason = (label: string): string =>
  `${label} components can't run in Claude Design, which uses React.`;

const SKIPPED_DIRS = [
  'node_modules',
  'dist',
  'build',
  '.next',
  '.lambda',
  '.turbo',
  'coverage',
  'playwright-report',
  'out',
];
const SOURCE = /\.(tsx?|jsx?|mjs|cjs)$/;
const TEST = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const COMPONENT_DIRS = [
  'components/',
  'src/components/',
  'app/components/',
  'src/ui/',
  'components/ui/',
];
const PACKAGE_SRC = /^packages\/[^/]+\/src\//;

const parseObject = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null;
  } catch {
    return null;
  }
};

const depsOf = (pkg: Record<string, unknown> | null): string[] =>
  ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) => {
    const value = pkg?.[field];

    return typeof value === 'object' && value !== null
      ? Object.keys(value)
      : [];
  });

/** Whether a skipped folder holds `rel` (a `/`-separated file path). */
const isSkipped = (rel: string, skip: string[]): boolean =>
  rel
    .split('/')
    .slice(0, -1)
    .some((name) => SKIPPED_DIRS.includes(name) || name === '.git') ||
  skip.some((one) => rel.startsWith(`${one}/`));

/** Every file under `root` (relative, `/`-separated), skipped folders left out. */
export const projectFiles = (root: string, skip: string[]): string[] => {
  const walk = (rel: string): string[] => {
    const dir = path.join(root, rel);
    const entries = (() => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    })();

    return entries.flatMap((entry) => {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;

      if (entry.isDirectory()) {
        const skipped =
          SKIPPED_DIRS.includes(entry.name) ||
          entry.name === '.git' ||
          skip.some((one) => child === one || child.startsWith(`${one}/`));

        return skipped ? [] : walk(child);
      }

      return entry.isFile() ? [child] : [];
    });
  };

  return walk('').sort();
};

/** Reads a project file (or `''`), each file at most once per reader. */
type Read = (rel: string) => string;

/**
 * The project as detect reads it: the files on disk, or the tree committed
 * at a ref. Paths are relative and `/`-separated.
 */
interface Tree {
  read: Read;
  exists: (rel: string) => boolean;
  /** The folders directly inside `rel`. */
  folders: (rel: string) => string[];
  /** Every file, skipped folders left out. */
  files: (skip: string[]) => string[];
}

const cached = (load: (rel: string) => string): Read => {
  const cache = new Map<string, string>();

  return (rel) => {
    const kept = cache.get(rel);

    if (kept !== undefined) {
      return kept;
    }

    const text = load(rel);
    cache.set(rel, text);

    return text;
  };
};

const diskTree = (root: string): Tree => ({
  read: cached((rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return '';
    }
  }),
  exists: (rel) => fs.existsSync(path.join(root, rel)),
  folders: (rel) => {
    try {
      return fs
        .readdirSync(path.join(root, rel), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  files: (skip) => projectFiles(root, skip),
});

/** What detect reads the text of: sources, stylesheets and package files. */
const READ_AT_REF = /\.(tsx?|jsx?|mjs|cjs|css|json|ya?ml)$/;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;

/**
 * Blobs at `ref` by path, through one `git cat-file --batch`: each answer is
 * `<sha> blob <size>` and the content, or `<name> missing`.
 */
const blobsAt = (
  root: string,
  ref: string,
  paths: string[]
): Map<string, string> => {
  const asked = paths.filter((rel) => !rel.includes('\n'));
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: asked.map((rel) => `${ref}:${rel}\n`).join(''),
    maxBuffer: MAX_BATCH_BYTES,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return asked.reduce(
    ({ blobs, at }, rel) => {
      const newline = out.indexOf(10, at);

      if (newline === -1) {
        throw new Error(`git cat-file stopped before ${ref}:${rel}.`);
      }

      const header = out.subarray(at, newline).toString('utf8');
      const blob = /^[0-9a-f]+ blob (\d+)$/.exec(header);

      if (blob === null) {
        return { blobs, at: newline + 1 };
      }

      const size = Number(blob[1]);
      const body = out.subarray(newline + 1, newline + 1 + size);

      return {
        blobs: blobs.set(rel, body.toString('utf8')),
        at: newline + 1 + size + 1,
      };
    },
    { blobs: new Map<string, string>(), at: 0 }
  ).blobs;
};

/** The tree committed at `ref`, read through git: the working tree is never read. */
const refTree = (root: string, ref: string): Tree => {
  const all = gitPaths(root, ['ls-tree', '-r', '-z', '--name-only', ref]);
  const listed = new Set(all);
  const folderSet = new Set(
    all.flatMap((rel) =>
      rel
        .split('/')
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join('/'))
    )
  );
  const prefetched = (() => {
    const kept: { blobs?: Map<string, string> } = {};

    return (): Map<string, string> => {
      if (kept.blobs === undefined) {
        kept.blobs = blobsAt(
          root,
          ref,
          all.filter((rel) => READ_AT_REF.test(rel) && !isSkipped(rel, []))
        );
      }

      return kept.blobs;
    };
  })();

  return {
    read: cached((rel) => {
      const blob = prefetched().get(rel);

      if (blob !== undefined || !listed.has(rel)) {
        return blob ?? '';
      }

      try {
        return execFileSync('git', ['cat-file', 'blob', `${ref}:${rel}`], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: MAX_BATCH_BYTES,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        return '';
      }
    }),
    exists: (rel) => listed.has(rel) || folderSet.has(rel),
    folders: (rel) =>
      Array.from(folderSet).flatMap((folder) => {
        const name = rel === '' ? folder : folder.slice(rel.length + 1);

        return (rel === '' || folder.startsWith(`${rel}/`)) &&
          name !== '' &&
          !name.includes('/')
          ? [name]
          : [];
      }),
    files: (skip) => all.filter((rel) => !isSkipped(rel, skip)).sort(),
  };
};

const readJsonIn = (tree: Tree, rel: string): Record<string, unknown> | null =>
  parseObject(tree.read(rel));

const workspaceDirsIn = (tree: Tree): string[] => {
  const pkg = readJsonIn(tree, 'package.json');
  const fromPackage = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces.filter((one): one is string => typeof one === 'string')
    : [];
  const fromPnpm = Array.from(
    tree.read('pnpm-workspace.yaml').matchAll(/^\s*-\s*['"]?([^'"\n#]+)/gm),
    (match) => (match[1] ?? '').trim()
  );

  return [...fromPackage, ...fromPnpm].flatMap((glob) => {
    if (!glob.endsWith('/*')) {
      return tree.exists(`${glob}/package.json`) ? [glob] : [];
    }

    const parent = glob.slice(0, -2);

    return tree
      .folders(parent)
      .filter((name) => tree.exists(`${parent}/${name}/package.json`))
      .map((name) => `${parent}/${name}`);
  });
};

/** The workspace packages' folders, from package.json or pnpm-workspace.yaml. */
export const workspaceDirs = (root: string): string[] =>
  workspaceDirsIn(diskTree(root));

/**
 * The package the app is in: in a workspace, the one `app.start` or the
 * photo hook names (by folder or package name), else the root.
 */
const appPackageDir = (tree: Tree, config: ProjectConfig): string => {
  const commands = [config.app?.start, config.commands?.shot]
    .filter((one): one is string => one !== undefined)
    .join('\n');

  if (commands === '') {
    return '';
  }

  // Whole words only: `web` is not in a command naming `webapp`.
  const mentions = (word: string, after: string): boolean =>
    new RegExp(
      `(^|[\\s=/'"])${word.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      )}($|[\\s'"${after}])`
    ).test(commands);
  const found = workspaceDirsIn(tree).find((dir) => {
    const name = readJsonIn(tree, `${dir}/package.json`)?.name;

    return (
      mentions(dir, '/') || (typeof name === 'string' && mentions(name, ''))
    );
  });

  return found ?? '';
};

const inPackage = (pkgDir: string, rel: string): boolean =>
  pkgDir === '' || rel.startsWith(`${pkgDir}/`);

const sourceFiles = (files: string[]): string[] =>
  files.filter((file) => SOURCE.test(file) && !TEST.test(file));

/** A `:root {` block declaring at least 5 custom properties. */
const hasRootVariables = (css: string): boolean =>
  Array.from(css.matchAll(/:root\s*\{([^}]*)\}/g)).some(
    (match) =>
      ((match[1] ?? '').match(/--[A-Za-z0-9_-]+\s*:/g) ?? []).length >= 5
  );

/** The file defining `name` (`const name`, `function name`, `export default`). */
const definingFile = (
  read: Read,
  files: string[],
  name: string
): string | undefined =>
  files.find((file) =>
    new RegExp(
      `(const|let|var|function)\\s+${name}\\b|export\\s+default\\s+${name}\\b`
    ).test(read(file))
  );

const themeFilesByStack = (
  tree: Tree,
  pkgDir: string,
  files: string[],
  deps: string[]
): { stack: Stack; theme: string[]; shadcn: boolean }[] => {
  const { read } = tree;
  const sources = sourceFiles(files).filter((file) => inPackage(pkgDir, file));
  const css = files.filter(
    (file) => file.endsWith('.css') && inPackage(pkgDir, file)
  );
  const callsFrom = (calls: RegExp, from: RegExp): string[] =>
    sources.filter((file) => {
      const text = read(file);

      return calls.test(text) && from.test(text);
    });
  type Found = { stack: Stack; theme: string[]; shadcn: boolean };
  const mui = (): Found[] => {
    if (!deps.some((dep) => dep.startsWith('@mui/'))) {
      return [];
    }

    const theme = callsFrom(
      /\b(extendTheme|createTheme)\(/,
      /from\s+['"]@mui\//
    );

    return theme.length > 0 ? [{ stack: 'mui', theme, shadcn: false }] : [];
  };
  const chakra = (): Found[] => {
    if (!deps.includes('@chakra-ui/react')) {
      return [];
    }

    const theme = callsFrom(/\b(extendTheme|createSystem)\(/, /@chakra-ui\//);

    return theme.length > 0 ? [{ stack: 'chakra', theme, shadcn: false }] : [];
  };
  const tailwind = (): Found[] => {
    if (!deps.includes('tailwindcss') && !deps.includes('@tailwindcss/cli')) {
      return [];
    }

    const configs = files.filter(
      (file) =>
        inPackage(pkgDir, file) &&
        /(^|\/)tailwind\.config\.(js|cjs|mjs|ts)$/.test(file)
    );
    const sheets = css.filter((file) =>
      /@theme\b|@tailwind\b/.test(read(file))
    );

    return [
      {
        stack: 'tailwind',
        theme: [...configs, ...sheets],
        shadcn: tree.exists(path.posix.join(pkgDir, 'components.json')),
      },
    ];
  };
  const styled = (): Found[] => {
    if (
      !deps.includes('styled-components') &&
      !deps.includes('@emotion/react')
    ) {
      return [];
    }

    const names = sources.flatMap((file) =>
      Array.from(
        read(file).matchAll(
          /<ThemeProvider\s+theme=\{\s*([A-Za-z_$][\w$]*)\s*\}/g
        ),
        (match) => match[1] ?? ''
      )
    );
    const theme = Array.from(
      new Set(
        names.flatMap((name) => {
          const file = definingFile(read, sources, name);

          return file === undefined ? [] : [file];
        })
      )
    );

    return theme.length > 0
      ? [{ stack: 'styled-components', theme, shadcn: false }]
      : [];
  };
  const cssVariables = (): Found[] => {
    const variables = css.filter((file) => hasRootVariables(read(file)));

    return variables.length > 0
      ? [{ stack: 'css-variables', theme: variables, shadcn: false }]
      : [];
  };

  return [mui, chakra, tailwind, styled, cssVariables].flatMap((find) =>
    find()
  );
};

/** `export const ParkCard =`, `export function ParkCard(`, and `: FC` or `<T>` after. */
const PASCAL_EXPORT =
  /export\s+(?:default\s+)?(?:const|function)\s+([A-Z][A-Za-z0-9]*)(?=\s*[=(:<])/g;

/** PascalCase, not a constant (`MAX_BENCHES`, `ID`) or a schema (`ParkSchema`). */
const isComponentName = (name: string): boolean =>
  /[a-z]/.test(name) && !name.endsWith('Schema');

/** Component files: where components live, under the app's package. */
const isComponentFile = (pkgDir: string, file: string): boolean => {
  const rel = pkgDir === '' ? file : file.slice(pkgDir.length + 1);

  return (
    /\.(tsx|jsx|ts|js)$/.test(file) &&
    !TEST.test(file) &&
    ((inPackage(pkgDir, file) &&
      COMPONENT_DIRS.some((dir) => rel.startsWith(dir))) ||
      PACKAGE_SRC.test(file))
  );
};

const withoutExt = (file: string): string =>
  file.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '').replace(/\/index$/, '');

/**
 * Who imports what, each source file parsed once: relative imports by the
 * file they resolve to, aliases (`@/components/ParkCard`) by the path they
 * name, which matches any file whose path ends with it at a folder boundary.
 */
const importIndex = (
  read: Read,
  sources: string[]
): ((file: string) => number) => {
  const relative = new Map<string, Set<string>>();
  const alias = new Map<string, Set<string>>();
  const add = (index: Map<string, Set<string>>, key: string, by: string) => {
    index.set(key, (index.get(key) ?? new Set<string>()).add(by));
  };

  sources.forEach((other) => {
    Array.from(
      read(other).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
      (match) => match[1] ?? ''
    ).forEach((spec) => {
      if (spec.startsWith('.')) {
        add(
          relative,
          withoutExt(path.posix.join(path.posix.dirname(other), spec)),
          other
        );

        return;
      }

      add(alias, spec.replace(/^[@~]\//, ''), other);
    });
  });

  /** How many other source files import `file`. */
  return (file) => {
    const target = withoutExt(file);
    const parts = target.split('/');
    const tails = parts.map((_, index) => parts.slice(index).join('/'));
    const importers = new Set([
      ...(relative.get(target) ?? []),
      ...tails.flatMap((tail) => [...(alias.get(tail) ?? [])]),
    ]);
    importers.delete(file);

    return importers.size;
  };
};

const exportedComponents = (read: Read, file: string): string[] =>
  Array.from(
    new Set(Array.from(read(file).matchAll(PASCAL_EXPORT), (m) => m[1] ?? ''))
  ).filter(isComponentName);

/** Component names, most imported first, then by name; at most 40. */
const rankComponents = (
  read: Read,
  pkgDir: string,
  files: string[],
  chosen: string[] | undefined
): string[] => {
  const importCount = importIndex(read, sourceFiles(files));
  const candidates =
    chosen ?? files.filter((file) => isComponentFile(pkgDir, file));

  return candidates
    .flatMap((file) => {
      const count = importCount(file);

      return exportedComponents(read, file).map((name) => ({ name, count }));
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map(({ name }) => name)
    .filter((name, index, all) => all.indexOf(name) === index);
};

/** Read the code: stack, theme files and components. */
export const detectStack = (
  root: string,
  config: ProjectConfig,
  {
    ref,
    // The pods' own folders (their worktrees hold copies of the app).
    podsRoot = resolvePodsRoot({ root, file: undefined, config }),
  }: { ref?: string; podsRoot?: string } = {}
): Detected => {
  const { dir, manifest } = config.design.system;
  const skip = [dir, path.relative(root, podsRoot)].filter(
    (one) => one !== '' && !one.startsWith('..')
  );
  // A ref is read as committed there, so another branch's working tree (or
  // uncommitted edits) never shows. `HEAD` is this checkout, read from disk:
  // the build reads what it builds, edits included.
  const tree =
    ref === undefined || ref === 'HEAD' ? diskTree(root) : refTree(root, ref);
  const files = tree.files(skip);
  const pkgDir = appPackageDir(tree, config);
  const deps = Array.from(
    new Set([
      ...depsOf(readJsonIn(tree, 'package.json')),
      ...depsOf(readJsonIn(tree, path.posix.join(pkgDir, 'package.json'))),
    ])
  );
  const nonReact = NON_REACT.find(({ dep }) => deps.includes(dep));
  const react = deps.includes('react') && nonReact === undefined;
  const { read } = tree;
  const matches = themeFilesByStack(tree, pkgDir, files, deps);
  const build = config.design.systemBuild;
  const theme =
    build?.theme === undefined
      ? Array.from(new Set(matches.flatMap((match) => match.theme)))
      : expandGlobs(build.theme, files);
  const [first] = matches;
  const ranked = react
    ? rankComponents(
        read,
        pkgDir,
        files,
        build?.components === undefined
          ? undefined
          : expandGlobs(build.components, files)
      )
    : [];
  const primitives =
    react &&
    build?.components === undefined &&
    (first?.stack === 'mui' || first?.stack === 'chakra')
      ? LIBRARY_PRIMITIVES
      : [];
  const components = [
    ...primitives,
    ...ranked.filter((name) => !primitives.includes(name)),
  ].slice(0, MAX_COMPONENTS);
  const onRef = readManifestOnBranch(
    root,
    ref ?? defaultBranchRef(root),
    manifest
  );
  const system =
    onRef === null
      ? null
      : {
          dir,
          ...(onRef.manifest.version === undefined
            ? {}
            : { version: onRef.manifest.version }),
          ...(onRef.builtFrom === undefined
            ? {}
            : { builtFrom: onRef.builtFrom }),
        };

  if (nonReact !== undefined) {
    return {
      stack: theme.length === 0 ? 'unknown' : nonReact.stack,
      shadcn: false,
      react: false,
      theme,
      components: [],
      reason: nonReactReason(nonReact.label),
      system,
    };
  }

  if (theme.length === 0 && components.length === 0) {
    return {
      stack: 'unknown',
      shadcn: false,
      react,
      theme,
      components,
      system,
    };
  }

  return {
    stack: first?.stack ?? 'unknown',
    shadcn: first?.shadcn ?? false,
    react,
    theme,
    components,
    system,
  };
};

const STACK_LABEL: Record<Stack, string> = {
  mui: 'MUI',
  chakra: 'Chakra',
  tailwind: 'Tailwind',
  'styled-components': 'styled-components',
  'css-variables': 'CSS variables',
  vue: 'Vue',
  svelte: 'Svelte',
  angular: 'Angular',
  solid: 'Solid',
  unknown: 'Unknown',
};

/** The Stack line: "React · Tailwind (shadcn/ui)", "Vue". */
export const stackLine = (detected: Detected): string => {
  const label = `${STACK_LABEL[detected.stack]}${
    detected.shadcn ? ' (shadcn/ui)' : ''
  }`;

  return detected.react ? `React · ${label}` : label;
};

const shortList = (names: string[], max = 5): string =>
  names.length > max
    ? `${names.slice(0, max).join(', ')}, …`
    : names.join(', ');

/** The Look line, or `none`. */
export const lookLine = (detected: Detected): string =>
  detected.theme.length === 0 ? 'none' : detected.theme.join(', ');

/** The Components line: "12 — Button, Card, …", or none with the reason. */
export const componentsLine = (detected: Detected): string =>
  detected.components.length === 0
    ? `none${detected.reason === undefined ? '' : ` — ${detected.reason}`}`
    : `${detected.components.length} — ${shortList(detected.components)}`;
