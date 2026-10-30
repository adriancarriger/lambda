import * as fs from 'fs';
import * as path from 'path';

import { git, gitOk, gitPaths } from './git';

/**
 * The source map, `<dir>/sources.json`: which app files each part of the
 * design system comes from. `lambda design system changed` reads a ticket's
 * changes against it, so the building pod knows when a pattern copy must be
 * updated in the same ticket. It never guesses: a file the map does not name
 * is not a design change.
 *
 * - `system`: the design system's own source (its folder, a build script) —
 *   a rebuild picks it up.
 * - `tokens`: the theme files the look is derived from — rebuild only.
 * - `components`: app components the bundle re-exports; imported, not
 *   copied — rebuild only.
 * - `patterns`: `patterns/<file>` are hand-made copies of app pieces that
 *   cannot run on a canvas. A change to a file one copies means the copy must
 *   be updated to match — the case that drifts silently.
 */

export const SOURCE_MAP_FILE = 'sources.json';

export interface SourceMap {
  system: string[];
  tokens: string[];
  components: Record<string, string>;
  patterns: Record<string, string[]>;
}

export interface DesignChanges {
  system: string[];
  tokens: string[];
  components: { name: string; file: string }[];
  patterns: { pattern: string; files: string[] }[];
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isRecordOf = <T>(
  value: unknown,
  check: (item: unknown) => item is T
): value is Record<string, T> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(check);

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * The path rule: relative, inside the project, and spelled as git names it
 * (no `..`, `.` or empty segment; a folder's trailing `/` is kept).
 */
const isInsidePath = (value: string): boolean =>
  value !== '' &&
  !path.isAbsolute(value) &&
  value
    .replace(/\/$/, '')
    .split('/')
    .every((segment) => !['', '.', '..'].includes(segment));

export const shapeMessage = (dir: string): string =>
  `${dir}/${SOURCE_MAP_FILE} must hold system and tokens (path lists), components ({name: path}) and patterns ({file: path list}).`;

export const parseSourceMap = (raw: unknown, dir: string): SourceMap => {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('system' in raw) ||
    !isStringList(raw.system) ||
    !('tokens' in raw) ||
    !isStringList(raw.tokens) ||
    !('components' in raw) ||
    !isRecordOf(raw.components, isString) ||
    !('patterns' in raw) ||
    !isRecordOf(raw.patterns, isStringList)
  ) {
    throw new Error(shapeMessage(dir));
  }

  const paths = [
    ...raw.system,
    ...raw.tokens,
    ...Object.values(raw.components),
    ...Object.values(raw.patterns).flat(),
  ];
  const outside = paths.find((one) => !isInsidePath(one));

  if (outside !== undefined) {
    throw new Error(
      `${dir}/${SOURCE_MAP_FILE}: ${outside} must be a path inside the project.`
    );
  }

  return {
    system: raw.system,
    tokens: raw.tokens,
    components: raw.components,
    patterns: raw.patterns,
  };
};

/** The map in the working tree under `root/<dir>`; throws when missing or bad. */
export const readSourceMap = (root: string, dir: string): SourceMap => {
  const file = path.join(root, dir, SOURCE_MAP_FILE);

  if (!fs.existsSync(file)) {
    throw new Error(`${dir}/${SOURCE_MAP_FILE} does not exist.`);
  }

  return parseSourceMap(JSON.parse(fs.readFileSync(file, 'utf8')), dir);
};

/** A map path ending in `/` names a folder: anything under it matches. */
const matches = (entry: string, file: string): boolean =>
  entry.endsWith('/') ? file.startsWith(entry) : file === entry;

const matching = (entries: string[], files: string[]): string[] =>
  files.filter((file) => entries.some((entry) => matches(entry, file)));

/** Tests never change what is drawn, wherever they live. */
const isTest = (file: string): boolean =>
  /(^|\/)__tests__\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);

export const designChanges = (
  map: SourceMap,
  changedFiles: string[]
): DesignChanges => {
  const files = Array.from(new Set(changedFiles))
    .filter((file) => !isTest(file))
    .sort();

  return {
    system: matching(map.system, files),
    tokens: matching(map.tokens, files),
    components: Object.entries(map.components).flatMap(([name, entry]) =>
      matching([entry], files).map((file) => ({ name, file }))
    ),
    patterns: Object.entries(map.patterns).flatMap(([pattern, sources]) => {
      const changed = matching(sources, files);

      return changed.length === 0 ? [] : [{ pattern, files: changed }];
    }),
  };
};

export const hasDesignChanges = (changes: DesignChanges): boolean =>
  changes.system.length +
    changes.tokens.length +
    changes.components.length +
    changes.patterns.length >
  0;

export const NO_DESIGN_CHANGES = 'NO DESIGN CHANGES';

/** One line per change, each labelled with what it asks for. */
export const formatDesignChanges = (changes: DesignChanges): string[] =>
  hasDesignChanges(changes)
    ? [
        ...changes.tokens.map((file) => `rebuild only     theme   ${file}`),
        ...changes.components.map(
          ({ name, file }) => `rebuild only     component ${name}  ← ${file}`
        ),
        ...changes.system.map((file) => `rebuild only     system  ${file}`),
        ...changes.patterns.map(
          ({ pattern, files }) =>
            `update the copy  pattern ${pattern}  ← ${files.join(', ')}`
        ),
      ]
    : [NO_DESIGN_CHANGES];

/**
 * What the ticket changes: committed since its merge base with `base`, plus
 * the working tree (staged, unstaged and untracked files). Paths are relative
 * to `root` (a project may sit in a subfolder of its repo), and a rename
 * counts as both of its paths.
 */
const DIFF = ['diff', '--name-only', '-z', '--no-renames', '--relative'];

export const ticketChanges = (root: string, base: string): string[] => {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']);

  return Array.from(
    new Set([
      ...gitPaths(root, [...DIFF, `${mergeBase}..HEAD`]),
      ...gitPaths(root, [...DIFF, 'HEAD']),
      ...gitPaths(root, ['ls-files', '-z', '--others', '--exclude-standard']),
    ])
  ).sort();
};

/** The merge base of HEAD with `base`, or undefined when there is none. */
export const mergeBaseOf = (root: string, base: string): string | undefined =>
  gitOk(root, ['merge-base', base, 'HEAD']);

/** The names a module exports as values, not counting `export *`. */
const ownExportedNames = (text: string): string[] => [
  ...Array.from(
    text.matchAll(
      /export\s+(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/g
    ),
    (match) => match[1] ?? ''
  ),
  ...Array.from(
    text.matchAll(/export\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g),
    (match) => match[1] ?? ''
  ),
  ...Array.from(text.matchAll(/export\s*\{([^}]*)\}/g)).flatMap((match) =>
    (match[1] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '' && !/^type\s/.test(part))
      .map((part) => {
        const names = part.split(/\s+as\s+/);

        return (names[1] ?? names[0] ?? '').trim();
      })
  ),
];

const MODULE_FILES = [
  '',
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '/index.tsx',
  '/index.ts',
  '/index.jsx',
  '/index.js',
];

/** A relative specifier's file from `fromDir`, or undefined. */
const resolveModule = (fromDir: string, spec: string): string | undefined =>
  MODULE_FILES.map((suffix) => path.resolve(fromDir, `${spec}${suffix}`)).find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
  );

/**
 * The names `index.tsx` exports as values, plus those of each relative
 * module it re-exports with `export * from` (one level, never followed
 * further). A package's `export *` is not looked into.
 */
const exportedNames = (indexFile: string): string[] => {
  const text = fs.readFileSync(indexFile, 'utf8');
  const starred = Array.from(
    text.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g),
    (match) => match[1] ?? ''
  )
    .filter((spec) => spec.startsWith('.'))
    .flatMap((spec) => {
      const file = resolveModule(path.dirname(indexFile), spec);

      return file === undefined
        ? []
        : ownExportedNames(fs.readFileSync(file, 'utf8'));
    });

  return Array.from(new Set([...ownExportedNames(text), ...starred]));
};

/**
 * The map test: every file in `patterns/` has an entry; every entry copies
 * at least one file; every path in the map exists (a `/` entry as a folder,
 * any other as a file); every `components` name is exported from
 * `index.tsx`. Returns one line per failure, naming the entry.
 */
export const checkSourceMap = (root: string, dir: string): string[] => {
  const map = readSourceMap(root, dir);
  const patternsDir = path.join(root, dir, 'patterns');
  const patternFiles = fs.existsSync(patternsDir)
    ? fs
        .readdirSync(patternsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];
  const exists = (entry: string): boolean => {
    const full = path.join(root, entry);

    if (!fs.existsSync(full)) {
      return false;
    }

    return entry.endsWith('/')
      ? fs.statSync(full).isDirectory()
      : fs.statSync(full).isFile();
  };
  const index = path.join(root, dir, 'index.tsx');
  const exported = fs.existsSync(index) ? exportedNames(index) : [];
  const allPaths: { label: string; entry: string }[] = [
    ...map.system.map((entry) => ({ label: 'system', entry })),
    ...map.tokens.map((entry) => ({ label: 'tokens', entry })),
    ...Object.entries(map.components).map(([name, entry]) => ({
      label: `components.${name}`,
      entry,
    })),
    ...Object.entries(map.patterns).flatMap(([pattern, entries]) =>
      entries.map((entry) => ({ label: `patterns.${pattern}`, entry }))
    ),
  ];

  return [
    ...patternFiles
      .filter((file) => !(file in map.patterns))
      .map((file) => `patterns/${file} has no entry in sources.json patterns.`),
    ...Object.entries(map.patterns)
      .filter(([, entries]) => entries.length === 0)
      .map(([pattern]) => `patterns.${pattern} copies no file.`),
    ...allPaths
      .filter(({ entry }) => !exists(entry))
      .map(({ label, entry }) =>
        entry.endsWith('/')
          ? `${label}: ${entry} is not a folder.`
          : `${label}: ${entry} is not a file.`
      ),
    ...Object.keys(map.components)
      .filter((name) => !exported.includes(name))
      .map((name) => `components.${name} is not exported from index.tsx.`),
  ];
};
