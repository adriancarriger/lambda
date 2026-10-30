/**
 * `lambda verdict visual record <id> --round <file>`: record one round of the
 * build's visual check and decide, for the whole set of the ticket's
 * pictures, whether the loop goes on.
 *
 * `/visual-check` photographs and grades; this decides. The round number
 * comes from `rounds.json` (1 + the rounds already there), never from the
 * caller, and the result comes from the stop rule (`shouldStopDesignLoop`)
 * applied to every picture's issues at once: the worst issue across the set
 * decides, so the set stops together.
 *
 * The round file is model output, so everything in it is checked before any
 * path is built from it, and every refusal throws before anything is written.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  type DesignIssue,
  MAX_DESIGN_ROUNDS,
  RANK,
  parseJudgeVerdict,
  shouldStopDesignLoop,
} from '../design/loop';
import { SCENARIO_ID } from '../shot/scenario';
import { ensureVerdictsDir, headShaOf } from './store';
import {
  type VisualIssue,
  type VisualPicture,
  type VisualResult,
  type VisualRoundRecord,
  type VisualVerdict,
  assertVisualTicketId,
  isMiss,
  readVisualVerdict,
  visualDir,
  visualRoundsPath,
  visualVerdictPath,
  writeVisualVerdict,
} from './visualStore';

export interface VisualRecordDeps {
  /** The build checkout: every picture path is relative to it, and stays in it. */
  projectRoot: string;
  now?: () => Date;
  headSha?: () => string | undefined;
  /** Posts the SHIPPED_WITH_MISSES comment; called only for that result. */
  postMisses?: (verdict: VisualVerdict) => Promise<void>;
  /** Copies a recorded round's pictures for the Workflow rail. */
  copyRound?: (ticketId: string, record: VisualRoundRecord) => void;
  /** Where a failed post or copy is reported. */
  warn?: (line: string) => void;
}

export interface RecordedVisualRound {
  round: number;
  /** What the command prints: the `VISUAL:` line, then any detail lines. */
  lines: string[];
  /** The final record, once the set stopped. */
  verdict: VisualVerdict | null;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Relative to the checkout, inside it, and on disk — its real path too, so a
 * symlink can't lead out of it.
 */
export const assertRepoFile = (
  root: string,
  file: string,
  label: string
): void => {
  const escapes =
    path.isAbsolute(file) ||
    path.relative(root, path.join(root, file)).startsWith('..');

  if (escapes) {
    throw new Error(`${label} must be a checkout-relative path, not ${file}.`);
  }

  const full = path.join(root, file);

  if (!fs.existsSync(full)) {
    throw new Error(`${label} ${file} does not exist.`);
  }

  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(full);

  if (
    !real.startsWith(`${realRoot}${path.sep}`) ||
    !fs.statSync(real).isFile()
  ) {
    throw new Error(`${label} ${file} is not a file inside the checkout.`);
  }
};

const stringField = (value: object, field: string, label: string): string => {
  const raw: unknown = field in value ? Reflect.get(value, field) : undefined;

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${label} needs a non-empty "${field}".`);
  }

  return raw;
};

const parsePicture = (
  root: string,
  entry: unknown,
  index: number
): VisualPicture => {
  const label = `Picture ${index + 1}`;

  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`${label} is not an object.`);
  }

  const scenarioId = stringField(entry, 'scenarioId', label);

  // Before the id is part of any path (`round-<n>/<id>.png`, `composite-<id>.png`).
  if (!SCENARIO_ID.test(scenarioId)) {
    throw new Error(
      `${label} has scenarioId ${JSON.stringify(
        scenarioId
      )}: it must match ${SCENARIO_ID}.`
    );
  }

  const expected = stringField(entry, 'expected', label);
  const actual = stringField(entry, 'actual', label);
  assertRepoFile(root, expected, `${label} (${scenarioId}) expected`);
  assertRepoFile(root, actual, `${label} (${scenarioId}) actual`);

  const issues = 'issues' in entry ? entry.issues : undefined;

  if (!Array.isArray(issues)) {
    throw new Error(`${label} (${scenarioId}) needs an "issues" list.`);
  }

  return {
    scenarioId,
    situation: stringField(entry, 'situation', label),
    expected,
    actual,
    issues: (() => {
      try {
        return parseJudgeVerdict(JSON.stringify({ issues }));
      } catch (error) {
        throw new Error(`${label} (${scenarioId}): ${reasonOf(error)}`);
      }
    })(),
  };
};

/** The round file: `{ pictures: [{ scenarioId, situation, expected, actual, issues }] }`. */
export const parseRoundFile = (root: string, raw: string): VisualPicture[] => {
  const parsed: unknown = JSON.parse(raw);
  const pictures =
    typeof parsed === 'object' && parsed !== null && 'pictures' in parsed
      ? parsed.pictures
      : undefined;

  if (!Array.isArray(pictures) || pictures.length === 0) {
    throw new Error('The round file needs a non-empty "pictures" list.');
  }

  const parsedPictures = pictures.map((entry, index) =>
    parsePicture(root, entry, index)
  );
  const ids = parsedPictures.map(({ scenarioId }) => scenarioId);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);

  if (repeated.length > 0) {
    throw new Error(`The round file names ${repeated.join(', ')} twice.`);
  }

  return parsedPictures;
};

/** What a recorded round says that the next one is checked against. */
interface PriorRound {
  ids: string[];
  stop: boolean;
}

/**
 * The rounds already recorded, in order, plus the file's entries as they are
 * (appended to unchanged). Throws on a file it cannot read, or an entry that
 * isn't a round record.
 */
export const readRounds = (
  file: string
): { entries: unknown[]; rounds: PriorRound[] } => {
  if (!fs.existsSync(file)) {
    return { entries: [], rounds: [] };
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!Array.isArray(parsed)) {
    throw new Error(`${file} is not a list of rounds; fix or move it aside.`);
  }

  const entries: unknown[] = parsed;

  return {
    entries,
    rounds: entries.map((entry, index) => {
      const pictures =
        typeof entry === 'object' && entry !== null && 'pictures' in entry
          ? entry.pictures
          : undefined;
      const decision =
        typeof entry === 'object' && entry !== null && 'decision' in entry
          ? entry.decision
          : undefined;

      if (
        !Array.isArray(pictures) ||
        typeof decision !== 'object' ||
        decision === null ||
        !('stop' in decision) ||
        typeof decision.stop !== 'boolean'
      ) {
        throw new Error(
          `${file} round ${
            index + 1
          } is not a round record; fix or move it aside.`
        );
      }

      // Only the ids and the decision are read back; the rest is history.
      return {
        ids: pictures.map((picture: unknown) =>
          typeof picture === 'object' &&
          picture !== null &&
          'scenarioId' in picture
            ? String(picture.scenarioId)
            : ''
        ),
        stop: decision.stop,
      };
    }),
  };
};

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length &&
  [...a].sort().join('\n') === [...b].sort().join('\n');

/** Leftover high → BLOCKED; medium or medium-low → SHIPPED_WITH_MISSES; else MATCH. */
export const visualResultOf = (issues: DesignIssue[]): VisualResult => {
  const worst = Math.max(
    RANK.low,
    ...issues.map(({ severity }) => RANK[severity])
  );

  if (worst === RANK.high) {
    return 'BLOCKED';
  }

  return worst > RANK.low ? 'SHIPPED_WITH_MISSES' : 'MATCH';
};

const withPicture = (picture: VisualPicture): VisualIssue[] =>
  [...picture.issues]
    .sort((a, b) => RANK[b.severity] - RANK[a.severity])
    .map((issue) => ({
      ...issue,
      scenarioId: picture.scenarioId,
      situation: picture.situation,
      expected: picture.expected,
      actual: picture.actual,
    }));

/** ISO with `:` and `.` made `-`, safe in a file name. */
export const fileStamp = (iso: string): string => iso.replace(/[:.]/g, '-');

const finalLine = (verdict: VisualVerdict): string => {
  const rounds = `(round ${verdict.rounds})`;

  if (verdict.result === 'MATCH') {
    return `VISUAL: MATCH ${rounds}`;
  }

  const misses = verdict.issues.filter(isMiss);
  const ids = Array.from(new Set(misses.map(({ scenarioId }) => scenarioId)));

  if (verdict.result === 'BLOCKED') {
    return `VISUAL: BLOCKED ${rounds} — high issue left: ${Array.from(
      new Set(
        misses
          .filter(({ severity }) => severity === 'high')
          .map(({ scenarioId }) => scenarioId)
      )
    ).join(', ')}`;
  }

  return `VISUAL: SHIPPED_WITH_MISSES ${rounds} — ${misses.length} issue${
    misses.length === 1 ? '' : 's'
  } left: ${ids.join(', ')}`;
};

/**
 * Record one round. Refuses (throws, writing nothing) an invalid ticket id or
 * round file, a set of pictures that differs from round 1's, a round 8, and a
 * round after one that stopped but left no final record. A finished loop (a
 * `.visual.json` exists, readable or not) is archived first — its rounds to
 * `rounds.<recordedAt>.json`, its record removed — and this becomes round 1.
 */
export const recordVisualRound = async (
  ticketIdArg: string,
  roundFile: string,
  {
    projectRoot,
    now = () => new Date(),
    headSha = () => headShaOf(projectRoot),
    postMisses = async () => undefined,
    copyRound = () => undefined,
    warn = (line) => console.warn(line),
  }: VisualRecordDeps
): Promise<RecordedVisualRound> => {
  const ticketId = assertVisualTicketId(ticketIdArg);

  if (!fs.existsSync(roundFile)) {
    throw new Error(`Round file ${roundFile} does not exist.`);
  }

  const pictures = parseRoundFile(
    projectRoot,
    fs.readFileSync(roundFile, 'utf8')
  );
  const roundsPath = visualRoundsPath(projectRoot, ticketId);
  const previous = readVisualVerdict(projectRoot, ticketId);
  // A finished loop is history: this round starts a new one. An unreadable
  // record has no recordedAt, so its archive is stamped with the time now.
  const archive =
    previous.state === 'missing'
      ? null
      : {
          stamp: fileStamp(
            previous.state === 'found'
              ? previous.verdict.recordedAt
              : now().toISOString()
          ),
        };
  const { entries, rounds: prior } =
    archive === null ? readRounds(roundsPath) : { entries: [], rounds: [] };
  const round = prior.length + 1;

  if (round > MAX_DESIGN_ROUNDS) {
    throw new Error(
      `Refusing round ${round}: a ticket's pictures get at most ${MAX_DESIGN_ROUNDS} rounds.`
    );
  }

  const last = prior.at(-1);

  if (last?.stop === true) {
    throw new Error(
      `Round ${
        prior.length
      } already stopped the loop, but no final record exists at ${visualVerdictPath(
        projectRoot,
        ticketId
      )}; move ${roundsPath} aside to start again.`
    );
  }

  const firstIds = prior[0]?.ids;
  const ids = pictures.map(({ scenarioId }) => scenarioId);

  if (firstIds !== undefined && !sameSet(firstIds, ids)) {
    throw new Error(
      `Every round grades the same set: round 1 graded ${firstIds.join(
        ', '
      )}, this round names ${ids.join(', ')}.`
    );
  }

  const issues = pictures.flatMap((picture) => picture.issues);
  const decision = shouldStopDesignLoop(round, issues);
  const at = now().toISOString();
  const archived =
    archive === null
      ? null
      : path.join(
          visualDir(projectRoot, ticketId),
          `rounds.${archive.stamp}.json`
        );

  if (
    archived !== null &&
    fs.existsSync(roundsPath) &&
    fs.existsSync(archived)
  ) {
    throw new Error(`${archived} already exists; try again.`);
  }

  // Every check is behind us: from here on, writes. The verdicts folder gets
  // its `*` .gitignore before anything else lands in it.
  ensureVerdictsDir(projectRoot);

  if (archived !== null) {
    if (fs.existsSync(roundsPath)) {
      fs.renameSync(roundsPath, archived);
    }

    fs.rmSync(visualVerdictPath(projectRoot, ticketId), { force: true });
  }

  fs.mkdirSync(visualDir(projectRoot, ticketId), { recursive: true });
  const record: VisualRoundRecord = {
    round,
    at,
    pictures,
    decision: { stop: decision.stop, reason: decision.reason },
  };
  fs.writeFileSync(
    roundsPath,
    `${JSON.stringify([...entries, record], null, 2)}\n`
  );

  try {
    copyRound(ticketId, record);
  } catch (error) {
    warn(
      `Could not copy round ${round}'s pictures for the Workflow rail (${reasonOf(
        error
      )}) — the round stands.`
    );
  }

  if (!decision.stop) {
    const withIssues = pictures.filter((picture) => picture.issues.length > 0);

    return {
      round,
      verdict: null,
      lines: [
        `VISUAL: CONTINUE (round ${round}) — fix: ${withIssues
          .map(({ scenarioId }) => scenarioId)
          .join(', ')}`,
        ...withIssues.map(
          ({ expected, actual }) => `Expected: ${expected}, actual: ${actual}`
        ),
      ],
    };
  }

  const sha = headSha();
  const verdict: VisualVerdict = {
    ticketId,
    result: visualResultOf(issues),
    rounds: round,
    issues: pictures.flatMap(withPicture),
    recordedAt: at,
    ...(sha === undefined ? {} : { headSha: sha }),
  };
  const file = writeVisualVerdict(projectRoot, verdict);

  if (verdict.result === 'SHIPPED_WITH_MISSES') {
    try {
      await postMisses(verdict);
    } catch (error) {
      warn(
        `Could not post the visual misses to ${ticketId} (${reasonOf(
          error
        )}) — the record stands.`
      );
    }
  }

  return { round, verdict, lines: [finalLine(verdict), `   ${file}`] };
};
