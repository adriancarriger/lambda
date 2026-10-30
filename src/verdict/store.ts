/**
 * Check-ticket verdicts: the one durable fact `lambda ship` gates on. It says
 * a ticket's acceptance criteria were checked and found met.
 *
 * Stored at `<project>/<verdicts.dir>/<id>.json` (lambda.json's
 * `verdicts.dir`, `.lambda/verdicts` by default). `recordVerdict`, `lambda
 * verdict show` and the ship gate all read that one folder.
 *
 * **It is a latch, not a freshness check.** `recordedAt` and `headSha` are
 * provenance for a person reading the file and are never compared: once
 * COMPLETE is recorded it keeps opening the gate until a later check records
 * something else, because the latest verdict wins.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_VERDICTS_DIR,
  PROJECT_CONFIG_FILE,
  ProjectConfigSchema,
} from '../config/projectConfig';
import { readConfigFile } from '../config/readConfigFile';
import { type Verdict, VerdictSchema } from '../pod-store/schemas';
import { assertTicketId } from '../tickets/source';

/**
 * The project's verdicts folder. A `verdicts.dir` outside the project is
 * refused (by lambda.json's own check, which names the field).
 */
export const verdictsDir = (projectRoot: string): string => {
  const file = path.join(projectRoot, PROJECT_CONFIG_FILE);
  const dir = fs.existsSync(file)
    ? readConfigFile(file, ProjectConfigSchema).verdicts.dir
    : DEFAULT_VERDICTS_DIR;

  return path.join(projectRoot, dir);
};

const LAMBDA_GITIGNORE = '*\n';

/**
 * What in an existing folder Lambda didn't write: anything but verdict JSONs,
 * a visual check's `<id>.visual/` folders (its photos land there before its
 * first round is recorded) and its own `*` .gitignore.
 */
const foreignEntries = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => {
      if (entry.name === '.gitignore') {
        return (
          !entry.isFile() ||
          fs.readFileSync(path.join(dir, entry.name), 'utf8') !==
            LAMBDA_GITIGNORE
        );
      }

      if (entry.isDirectory()) {
        return !entry.name.endsWith('.visual');
      }

      return !entry.isFile() || !entry.name.endsWith('.json');
    })
    .map((entry) => entry.name)
    .sort();

/**
 * The one way into the verdicts folder: it gets a `*` .gitignore before
 * anything else is written there, so a default ship's `git add -A` never
 * commits what's in it. Answers the folder.
 *
 * Refused: the project root, and a folder of the project's own (`src`) —
 * the `*` would hide its new files from that `git add -A`, or its own
 * .gitignore would let the verdicts be committed.
 */
export const ensureVerdictsDir = (projectRoot: string): string => {
  const dir = verdictsDir(projectRoot);
  const setting = path.relative(projectRoot, dir) || '.';

  if (path.resolve(dir) === path.resolve(projectRoot)) {
    throw new Error(
      `lambda.json verdicts.dir "${setting}" is the project root. Give verdicts a folder of their own, like ${DEFAULT_VERDICTS_DIR}.`
    );
  }

  const ignore = path.join(dir, '.gitignore');
  // A folder whose .gitignore ignores everything is Lambda's, whatever else
  // it holds (visual records and their pictures, for one).
  const ownIgnore =
    fs.existsSync(ignore) &&
    fs.readFileSync(ignore, 'utf8').split('\n')[0]?.trim() === '*';
  const foreign = fs.existsSync(dir) && !ownIgnore ? foreignEntries(dir) : [];

  if (foreign.length > 0) {
    throw new Error(
      `lambda.json verdicts.dir "${setting}" already holds files Lambda didn't write (${foreign.join(
        ', '
      )}). Give verdicts a folder of their own, like ${DEFAULT_VERDICTS_DIR}.`
    );
  }

  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, LAMBDA_GITIGNORE);
  }

  return dir;
};

export const verdictPath = (projectRoot: string, ticketId: string): string =>
  path.join(verdictsDir(projectRoot), `${assertTicketId(ticketId)}.json`);

/**
 * Missing and unreadable are kept apart: both refuse, but they have
 * different remedies, and naming the wrong cause sends someone to fix the
 * wrong thing.
 */
export type VerdictRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'found'; verdict: Verdict };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A verdict file that can't be parsed is `unreadable`, never `missing`.
 * Throws on a ticket id that isn't one (`assertTicketId`) and on a
 * lambda.json that can't be read (its `verdicts.dir`), since neither is
 * about the verdict.
 */
export const readVerdict = (
  projectRoot: string,
  ticketId: string
): VerdictRead => {
  const file = verdictPath(projectRoot, ticketId);

  if (!fs.existsSync(file)) {
    return { kind: 'missing' };
  }

  try {
    // Extra fields another tool wrote are dropped, not refused.
    const parsed = VerdictSchema.safeParse(
      JSON.parse(fs.readFileSync(file, 'utf8'))
    );

    if (!parsed.success) {
      return {
        kind: 'unreadable',
        reason: parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || 'verdict'}: ${issue.message}`
          )
          .join('; '),
      };
    }

    // A file copied or edited from another ticket's must not open this gate.
    if (parsed.data.ticketId !== ticketId) {
      return {
        kind: 'unreadable',
        reason: `the verdict is for ${parsed.data.ticketId}, not ${ticketId}`,
      };
    }

    return { kind: 'found', verdict: parsed.data };
  } catch (error) {
    return { kind: 'unreadable', reason: reasonOf(error) };
  }
};

/** Write a verdict, replacing any earlier one; answers the file. */
export const recordVerdict = (
  projectRoot: string,
  verdict: Verdict
): string => {
  ensureVerdictsDir(projectRoot);
  const file = verdictPath(projectRoot, verdict.ticketId);
  fs.writeFileSync(
    file,
    `${JSON.stringify(VerdictSchema.parse(verdict), null, 2)}\n`
  );

  return file;
};

/** HEAD, for provenance; absent in a folder that isn't a git repository. */
export const headShaOf = (projectRoot: string): string | undefined => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
};
