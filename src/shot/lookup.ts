/**
 * Where scenarios live, in the order `lambda shot` looks:
 *
 * 1. the tracked library, lambda.json `design.scenarios`
 * 2. `<design.pendingDir>/<ticket>/`: the scenarios a ticket brought
 * 3. `<pods root>/_scenarios/`: the scenarios a plan wrote, untracked
 *
 * The first two are read from the checkout the command runs in (a pod's
 * worktree, or the project's own checkout); the pods store is the project's.
 */
import * as fs from 'fs';
import * as path from 'path';

import { type Project, resolvePodsRoot } from '../config/projectConfig';
import {
  type ScenarioEntry,
  type ScenarioSource,
  assertScenarioId,
  checkScenarioFile,
  closestIds,
  scenarioFileParts,
} from './scenario';

type Env = Record<string, string | undefined>;

export const PODS_SCENARIOS = '_scenarios';

export interface ScenarioRoots {
  tracked: string;
  /** One folder per ticket below it. */
  pendingRoot: string;
  podsStore: string;
  /** lambda.json `design.scenarioExt`. */
  ext: string;
}

export const scenarioRootsFor = (
  project: Project,
  checkout: string,
  env: Env = process.env
): ScenarioRoots => ({
  tracked: path.resolve(checkout, project.config.design.scenarios),
  pendingRoot: path.resolve(checkout, project.config.design.pendingDir),
  podsStore: path.join(resolvePodsRoot(project, env), PODS_SCENARIOS),
  ext: project.config.design.scenarioExt,
});

const subfolders = (root: string): string[] => {
  if (!fs.existsSync(root)) {
    return [];
  }

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
};

/** Every folder to look in, in lookup order. */
const searchDirs = (
  roots: ScenarioRoots
): Array<{ source: ScenarioSource; dir: string }> => [
  { source: 'tracked', dir: roots.tracked },
  ...subfolders(roots.pendingRoot).map((dir) => ({
    source: 'pending' as const,
    dir,
  })),
  { source: 'pending', dir: roots.podsStore },
];

/** Ids of the `<id>.scenario.<ext>` files in `dir`, sorted. */
export const scenarioIdsIn = (dir: string, ext: string): string[] => {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .flatMap((name) => {
      const parts = scenarioFileParts(name);

      return parts !== null && parts.ext === ext ? [parts.id] : [];
    })
    .sort();
};

export interface FoundScenario {
  id: string;
  source: ScenarioSource;
  file: string;
}

/**
 * The scenario with this id, from the first place that has it. A bad id is
 * refused before any path is built; an unknown one names the closest ids.
 */
export const findScenario = (
  rawId: string,
  roots: ScenarioRoots
): FoundScenario => {
  const id = assertScenarioId(rawId);
  const dirs = searchDirs(roots);
  const found = dirs
    .map(({ source, dir }) => ({
      id,
      source,
      file: path.join(dir, `${id}.scenario.${roots.ext}`),
    }))
    .find(({ file }) => fs.existsSync(file));

  if (found !== undefined) {
    return found;
  }

  const suggestions = closestIds(
    id,
    dirs.flatMap(({ dir }) => scenarioIdsIn(dir, roots.ext))
  );

  throw new Error(
    `No scenario "${id}".${
      suggestions.length > 0 ? ` Closest: ${suggestions.join(', ')}` : ''
    }`
  );
};

export interface BrokenScenario {
  file: string;
  problems: string[];
}

/** Every scenario once (the first place's copy wins), and the broken ones. */
export const listScenarioEntries = (
  roots: ScenarioRoots
): { entries: ScenarioEntry[]; broken: BrokenScenario[] } =>
  searchDirs(roots).reduce<{
    entries: ScenarioEntry[];
    broken: BrokenScenario[];
  }>(
    (sofar, { source, dir }) =>
      scenarioIdsIn(dir, roots.ext)
        // A broken copy wins too: `lambda shot` would take it, and fail.
        .filter(
          (id) =>
            !sofar.entries.some((entry) => entry.id === id) &&
            !sofar.broken.some(
              ({ file }) => scenarioFileParts(path.basename(file))?.id === id
            )
        )
        .reduce((next, id) => {
          const file = path.join(dir, `${id}.scenario.${roots.ext}`);
          const { scenario, problems } = checkScenarioFile(file);

          return scenario === null
            ? { ...next, broken: [...next.broken, { file, problems }] }
            : {
                ...next,
                entries: [...next.entries, { ...scenario, source, file }],
              };
        }, sofar),
    { entries: [], broken: [] }
  );
