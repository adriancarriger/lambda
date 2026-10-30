import * as fs from 'fs';
import * as path from 'path';

import { MANIFEST } from '../app/server/podFile';
import type {
  VisualPictureView,
  VisualRoundView,
} from '../app/shared/building';
import type { PodStore } from '../pod-store';
import type { VisualRoundRecord } from '../verdict/visualStore';

/**
 * The visual check's pictures, for the building pod's Workflow rail: each
 * recorded round's expected and actual pictures, copied into the pod as
 * `<pods root>/<pod>/visual/<ticket>/<round>/` with a `manifest.json`
 * (`[{ scenarioId, situation, expected, actual, issues }]`, the pictures by
 * their file names there). The runner serves that folder and nothing else of
 * the check: the copies in the project's verdicts folder are out of the
 * app's reach.
 */

export const VISUAL_FOLDER = 'visual';

const ticketVisualDir = (
  store: PodStore,
  podId: string,
  ticketId: string
): string => store.file(podId, VISUAL_FOLDER, ticketId);

export const roundVisualDir = (
  store: PodStore,
  podId: string,
  ticketId: string,
  round: number
): string => path.join(ticketVisualDir(store, podId, ticketId), String(round));

/**
 * Copy one recorded round. Round 1 starts a loop, so an earlier loop's rounds
 * of the ticket are cleared first: none of them is left to pass as this one's.
 */
export const copyRoundToPod = (input: {
  store: PodStore;
  podId: string;
  projectRoot: string;
  ticketId: string;
  record: VisualRoundRecord;
}): string => {
  const { store, podId, ticketId, record } = input;

  if (record.round === 1) {
    fs.rmSync(ticketVisualDir(store, podId, ticketId), {
      recursive: true,
      force: true,
    });
  }

  const dir = roundVisualDir(store, podId, ticketId, record.round);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: VisualPictureView[] = record.pictures.map((picture) => {
    const expected = `expected-${picture.scenarioId}.png`;
    const actual = `actual-${picture.scenarioId}.png`;
    fs.copyFileSync(
      path.join(input.projectRoot, picture.expected),
      path.join(dir, expected)
    );
    fs.copyFileSync(
      path.join(input.projectRoot, picture.actual),
      path.join(dir, actual)
    );

    return {
      scenarioId: picture.scenarioId,
      situation: picture.situation,
      expected,
      actual,
      issues: picture.issues,
    };
  });
  fs.writeFileSync(
    path.join(dir, MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  return dir;
};

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isPictureList = (value: unknown): value is VisualPictureView[] =>
  Array.isArray(value) &&
  value.every(
    (entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'scenarioId' in entry &&
      typeof entry.scenarioId === 'string' &&
      'situation' in entry &&
      typeof entry.situation === 'string' &&
      'expected' in entry &&
      typeof entry.expected === 'string' &&
      'actual' in entry &&
      typeof entry.actual === 'string' &&
      'issues' in entry &&
      Array.isArray(entry.issues)
  );

/** One round's manifest, or null when it is missing or not one. */
const readRound = (dir: string, round: number): VisualRoundView | null => {
  const file = path.join(dir, MANIFEST);

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));

    return isPictureList(parsed)
      ? {
          round,
          at: fs.statSync(file).mtime.toISOString(),
          pictures: parsed,
        }
      : null;
  } catch {
    return null;
  }
};

/** Every ticket's recorded rounds in the pod, oldest first. */
export const readVisualRounds = (
  store: PodStore,
  podId: string
): Record<string, VisualRoundView[]> => {
  const dir = store.file(podId, VISUAL_FOLDER);

  if (!fs.existsSync(dir)) {
    return {};
  }

  // Real folders only: a link isn't a round Lambda wrote.
  return Object.fromEntries(
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SEGMENT.test(entry.name))
      .map((entry) => {
        const ticketDir = path.join(dir, entry.name);
        const rounds = fs
          .readdirSync(ticketDir, { withFileTypes: true })
          .filter(
            (round) => round.isDirectory() && /^[1-9]\d*$/.test(round.name)
          )
          .map((round) =>
            readRound(path.join(ticketDir, round.name), Number(round.name))
          )
          .filter((round): round is VisualRoundView => round !== null)
          .sort((a, b) => a.round - b.round);

        return [entry.name, rounds] as const;
      })
  );
};
