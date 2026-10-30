import * as fs from 'fs';
import * as path from 'path';

import { type Project } from '../../config/projectConfig';
import { RANK } from '../loop';
import { PHOTO_TOKENS } from './build';
import { git, gitPaths } from './git';
import { loadProjectModule } from './loadModule';
import {
  type Manifest,
  type ManifestCheck,
  type ManifestSource,
  manifestText,
  mergeManifest,
  readManifestAt,
  readManifestFile,
} from './manifest';
import { systemNamespace } from './namespace';
import { lastSystemRound } from './round';
import { SOURCE_MAP_FILE, readSourceMap } from './sources';

/**
 * `lambda design system manifest write`: the setup ticket's last step. It
 * records what was made — the version, the commit it was made from, the
 * ticket, how it was checked — and nothing else changes in the manifest.
 *
 * Two refusals, both the setup ticket's rules: a ticket that changed any file
 * outside the design system (making it only pulls from the app into the
 * design system), and a loop that didn't end in MATCH or CLOSE. The build's
 * design check never runs this.
 */

export const outsideMessage = (paths: string[]): string =>
  `This ticket changed files outside the design system: ${paths.join(
    ', '
  )}. Making the design system only pulls from the app into the design system.`;

/**
 * Every path the repo changes over `base`, untracked files included, from the
 * repo's root (a project may sit in a subfolder; nothing outside it may
 * change either). A rename counts as both of its paths.
 */
const changedSince = (checkout: string, base: string): string[] =>
  Array.from(
    new Set([
      ...gitPaths(checkout, [
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        base,
      ]),
      ...gitPaths(checkout, [
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
        '--full-name',
        ':/',
      ]),
    ])
  ).sort();

const inside = (dir: string, file: string): boolean =>
  file === dir || file.startsWith(`${dir.replace(/\/$/, '')}/`);

const screenTitles = async (
  checkout: string,
  dir: string
): Promise<string[]> => {
  const index = path.join(dir, 'screens', 'index.ts');

  if (!fs.existsSync(path.join(checkout, index))) {
    return [];
  }

  const exported = await loadProjectModule(checkout, index);
  const screens = exported.SCREENS ?? exported.screens ?? exported.default;

  return Array.isArray(screens)
    ? screens.flatMap((screen: unknown) =>
        typeof screen === 'object' &&
        screen !== null &&
        'title' in screen &&
        typeof screen.title === 'string'
          ? [screen.title]
          : []
      )
    : [];
};

export interface ManifestWriteOptions {
  project: Project;
  projectName: string;
  /** The setup ticket's checkout. */
  checkout: string;
  /** The setup's base commit (a ref is resolved to its sha). */
  base: string;
  ticketId: string;
  /** The pod's `design-system/rounds.json`; absent when not checked. */
  roundsFile?: string;
  /** Why the design system wasn't checked against the app. */
  notChecked?: string;
  leftOut?: { name: string; why: string }[];
}

export const writeSetupManifest = async (
  options: ManifestWriteOptions
): Promise<{ file: string; manifest: Record<string, unknown> }> => {
  const { project, projectName, checkout, ticketId } = options;

  if (options.roundsFile !== undefined && options.notChecked !== undefined) {
    throw new Error(
      'manifest write takes either --rounds or --not-checked, never both: a design system checked against the app has no not-checked reason.'
    );
  }

  const { dir, manifest: manifestPath } = project.config.design.system;
  const base = git(checkout, ['rev-parse', `${options.base}^{commit}`]);
  const prefix = git(checkout, ['rev-parse', '--show-prefix']);
  const outside = changedSince(checkout, base).filter(
    (file) =>
      !inside(`${prefix}${dir}`, file) && file !== `${prefix}${manifestPath}`
  );

  if (outside.length > 0) {
    throw new Error(outsideMessage(outside));
  }

  const check = ((): ManifestCheck => {
    if (options.roundsFile === undefined) {
      if (options.notChecked === undefined) {
        throw new Error(
          'manifest write needs --rounds <rounds.json>, or --not-checked <reason> when the design system could not be checked against the app.'
        );
      }

      return {
        result: 'not-checked',
        rounds: 0,
        photos: 0,
        issues: [],
        reason: options.notChecked,
      };
    }

    const last = lastSystemRound(options.roundsFile);

    if (
      last === undefined ||
      (last.result !== 'MATCH' && last.result !== 'CLOSE')
    ) {
      throw new Error(
        `${
          options.roundsFile
        } doesn't end in MATCH or CLOSE (its last round is ${
          last?.result ?? 'missing'
        }), so there is no design system to record.`
      );
    }

    return {
      result: last.result === 'MATCH' ? 'match' : 'close',
      rounds: last.round,
      photos: last.pictures.length,
      issues: last.pictures
        .flatMap(({ issues }) => issues)
        .sort((a, b) => RANK[b.severity] - RANK[a.severity]),
    };
  })();

  const file = path.join(checkout, manifestPath);
  // The working tree's manifest only keeps its field order and other fields:
  // what it says is read at the base, so writing twice is still one version.
  const existing = readManifestFile(file);
  const atBase = readManifestAt(checkout, base, manifestPath);
  const map = fs.existsSync(path.join(checkout, dir, SOURCE_MAP_FILE))
    ? readSourceMap(checkout, dir)
    : { components: {}, patterns: {} };
  const source: ManifestSource = fs.existsSync(
    path.join(checkout, dir, PHOTO_TOKENS)
  )
    ? 'photos'
    : check.result === 'not-checked'
    ? 'code'
    : 'code+photos';
  const fields: Partial<Manifest> = {
    // A new design system keeps the namespace its rounds were built with.
    namespace: systemNamespace(
      projectName,
      atBase?.manifest.namespace ?? existing?.manifest.namespace
    ),
    version: (atBase?.manifest.version ?? 0) + 1,
    builtFrom: base,
    syncedBy: ticketId,
    source,
    check,
    components: Object.keys(map.components),
    patterns: Object.keys(map.patterns).map((pattern) =>
      pattern.replace(/\.[jt]sx?$/, '')
    ),
    screens: await screenTitles(checkout, dir),
    leftOut: options.leftOut ?? atBase?.manifest.leftOut ?? [],
  };
  const raw = mergeManifest(existing?.raw ?? {}, fields);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, manifestText(raw));

  return { file, manifest: raw };
};
