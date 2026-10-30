import * as fs from 'fs';
import * as path from 'path';

import { ID_PATTERN } from '../../pod-store/schemas';
import { podsRoot } from '../../pod/context';
import { SCENARIO_ID } from '../../shot/scenario';
import { composeExpectedActual } from '../composite';
import {
  type DesignIssue,
  MAX_DESIGN_ROUNDS,
  RANK,
  parseJudgeVerdict,
  shouldStopDesignLoop,
} from '../loop';

/**
 * `lambda design system round record --round <file>`: one round of the setup
 * ticket's loop, every photographed screen graded against its reference
 * screen. The stop rule is applied once to the whole set — the worst issue
 * across all the pictures decides — and the round number comes from
 * `rounds.json`, never from the caller.
 *
 * The round file is model output: every path in it must be a PNG under the
 * pod's `design-system/` folder, and every refusal throws before anything
 * is written.
 */

export const SYSTEM_ROUNDS_FILE = 'rounds.json';

/**
 * A round file `round record` refuses outright: round 8, a missing or
 * out-of-folder picture, a different set of screens, a file that isn't a
 * round. The caller fixes the file and records again; it is not a
 * `SYSTEM: ERROR` (those are the judge's answer failing its format, or a
 * failed render) and never counts toward BLOCKED.
 */
export class SystemRoundRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemRoundRefusal';
  }
}

/** `JSON.parse`, refusing with the file's name on a parse failure. */
const parseJson = (raw: string, file: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SystemRoundRefusal(
      `${file} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

export type SystemResult = 'CONTINUE' | 'MATCH' | 'CLOSE' | 'BLOCKED';

export interface SystemPicture {
  scenarioId: string;
  photo: string;
  drawn: string;
  issues: DesignIssue[];
}

export interface SystemRoundRecord {
  round: number;
  pictures: SystemPicture[];
  result: SystemResult;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isPng = (file: string): boolean => {
  const bytes = Buffer.alloc(PNG.length);
  const fd = fs.openSync(file, 'r');

  try {
    fs.readSync(fd, bytes, 0, PNG.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  return bytes.equals(PNG);
};

/** `<pods root>/<pod>/design-system/` holding `file`, by realpath; throws otherwise. */
const designSystemDirOf = (file: string, label: string): string => {
  if (!fs.existsSync(file)) {
    throw new SystemRoundRefusal(`${label} ${file} does not exist.`);
  }

  const real = fs.realpathSync(file);
  const root = fs.realpathSync(podsRoot());
  const [pod, folder, ...rest] = path.relative(root, real).split(path.sep);

  if (
    pod === undefined ||
    !ID_PATTERN.test(pod) ||
    folder !== 'design-system' ||
    rest.length === 0 ||
    !fs.statSync(real).isFile() ||
    !isPng(real)
  ) {
    throw new SystemRoundRefusal(
      `${label} ${file} must be a PNG under <pods root>/<pod>/design-system/ (${root}).`
    );
  }

  return path.join(root, pod, folder);
};

const field = (value: object, key: string, label: string): string => {
  const raw: unknown = key in value ? Reflect.get(value, key) : undefined;

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SystemRoundRefusal(`${label} needs a non-empty "${key}".`);
  }

  return raw;
};

/** Parse and check a round file; returns its pictures and the pod's folder. */
export const parseSystemRound = (
  raw: string,
  file = 'The round file'
): { pictures: SystemPicture[]; dir: string } => {
  const parsed = parseJson(raw, file);
  const list =
    typeof parsed === 'object' && parsed !== null && 'pictures' in parsed
      ? parsed.pictures
      : undefined;

  if (!Array.isArray(list) || list.length === 0) {
    throw new SystemRoundRefusal(
      'The round file needs a non-empty "pictures" list.'
    );
  }

  const pictures = list.map(
    (
      entry: unknown,
      index
    ): SystemPicture & {
      dir: string;
    } => {
      const label = `Picture ${index + 1}`;

      if (typeof entry !== 'object' || entry === null) {
        throw new SystemRoundRefusal(`${label} is not an object.`);
      }

      const scenarioId = field(entry, 'scenarioId', label);

      if (!SCENARIO_ID.test(scenarioId)) {
        throw new SystemRoundRefusal(
          `${label} has scenarioId ${JSON.stringify(
            scenarioId
          )}: it must match ${SCENARIO_ID}.`
        );
      }

      const photo = field(entry, 'photo', label);
      const drawn = field(entry, 'drawn', label);
      const dir = designSystemDirOf(photo, `${label} (${scenarioId}) photo`);

      if (designSystemDirOf(drawn, `${label} (${scenarioId}) drawn`) !== dir) {
        throw new SystemRoundRefusal(
          `${label} (${scenarioId}): its photo and drawn picture are in different pods.`
        );
      }

      const issues = 'issues' in entry ? entry.issues : undefined;

      if (!Array.isArray(issues)) {
        throw new SystemRoundRefusal(
          `${label} (${scenarioId}) needs an "issues" list.`
        );
      }

      try {
        return {
          scenarioId,
          photo,
          drawn,
          dir,
          issues: parseJudgeVerdict(JSON.stringify({ issues })),
        };
      } catch (error) {
        throw new Error(
          `${label} (${scenarioId}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  );
  const [first] = pictures;
  const ids = pictures.map(({ scenarioId }) => scenarioId);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);

  if (repeated.length > 0) {
    throw new SystemRoundRefusal(
      `The round file names ${repeated.join(', ')} twice.`
    );
  }

  if (first === undefined || pictures.some(({ dir }) => dir !== first.dir)) {
    throw new SystemRoundRefusal(
      "Every picture of a round is in the same pod's design-system/."
    );
  }

  return {
    dir: first.dir,
    pictures: pictures.map(({ dir: _dir, ...picture }) => picture),
  };
};

const readRecords = (file: string): SystemRoundRecord[] => {
  if (!fs.existsSync(file)) {
    return [];
  }

  const parsed = parseJson(fs.readFileSync(file, 'utf8'), file);

  if (!Array.isArray(parsed)) {
    throw new SystemRoundRefusal(
      `${file} is not a list of rounds; fix or move it aside.`
    );
  }

  return parsed.map((entry: unknown, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('pictures' in entry) ||
      !Array.isArray(entry.pictures) ||
      !('result' in entry) ||
      typeof entry.result !== 'string'
    ) {
      throw new SystemRoundRefusal(
        `${file} round ${
          index + 1
        } is not a round record; fix or move it aside.`
      );
    }

    const { result } = entry;

    return {
      round: index + 1,
      pictures: entry.pictures,
      result:
        result === 'MATCH' || result === 'CLOSE' || result === 'BLOCKED'
          ? result
          : 'CONTINUE',
    };
  });
};

const sameSet = (a: string[], b: string[]): boolean =>
  [...a].sort().join('\n') === [...b].sort().join('\n');

/** The set's result from the stop rule. */
const resultOf = (round: number, issues: DesignIssue[]): SystemResult => {
  const decision = shouldStopDesignLoop(round, issues);

  if (!decision.stop) {
    return 'CONTINUE';
  }

  if (decision.reason === 'only-low') {
    return 'MATCH';
  }

  const worst = Math.max(
    RANK.low,
    ...issues.map(({ severity }) => RANK[severity])
  );

  return worst === RANK.high ? 'BLOCKED' : 'CLOSE';
};

export const resultLine = (record: SystemRoundRecord): string => {
  if (record.result !== 'CONTINUE') {
    return `SYSTEM: ${record.result}`;
  }

  const fix = record.pictures
    .filter(({ issues }) => issues.some(({ severity }) => severity !== 'low'))
    .map(({ scenarioId }) => scenarioId);

  return `SYSTEM: CONTINUE (round ${record.round}) — fix: ${fix.join(', ')}`;
};

export interface PreparedSystemRound {
  record: SystemRoundRecord;
  line: string;
  /** The pod's rounds.json, which `saveSystemRound` appends the record to. */
  file: string;
}

/**
 * Check one round and work out its record, writing nothing: the CLI draws
 * its composites before saving it, so a round that can't be drawn is never
 * recorded.
 */
export const prepareSystemRound = (roundFile: string): PreparedSystemRound => {
  if (!fs.existsSync(roundFile)) {
    throw new SystemRoundRefusal(`Round file ${roundFile} does not exist.`);
  }

  const { pictures, dir } = parseSystemRound(
    fs.readFileSync(roundFile, 'utf8'),
    roundFile
  );
  const file = path.join(dir, SYSTEM_ROUNDS_FILE);
  const prior = readRecords(file);
  const round = prior.length + 1;

  if (round > MAX_DESIGN_ROUNDS) {
    throw new SystemRoundRefusal(
      `Refusing round ${round}: making a design system gets at most ${MAX_DESIGN_ROUNDS} rounds.`
    );
  }

  const last = prior.at(-1);

  if (last !== undefined && last.result !== 'CONTINUE') {
    throw new SystemRoundRefusal(
      `Round ${last.round} already ended the loop (${last.result}); there is no round ${round}.`
    );
  }

  const firstIds = prior[0]?.pictures.map(({ scenarioId }) => scenarioId);
  const ids = pictures.map(({ scenarioId }) => scenarioId);

  if (firstIds !== undefined && !sameSet(firstIds, ids)) {
    throw new SystemRoundRefusal(
      `Every round grades the same screens: round 1 graded ${firstIds.join(
        ', '
      )}, this round names ${ids.join(', ')}.`
    );
  }

  const record: SystemRoundRecord = {
    round,
    pictures,
    result: resultOf(
      round,
      pictures.flatMap(({ issues }) => issues)
    ),
  };

  return { record, line: resultLine(record), file };
};

/** Append a prepared round to its pod's rounds.json. */
export const saveSystemRound = ({
  record,
  file,
}: PreparedSystemRound): void => {
  const existing: unknown[] = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : [];
  fs.writeFileSync(file, `${JSON.stringify([...existing, record], null, 2)}\n`);
};

/** Record one round; returns the record and the line to print. */
export const recordSystemRound = (roundFile: string): PreparedSystemRound => {
  const prepared = prepareSystemRound(roundFile);
  saveSystemRound(prepared);

  return prepared;
};

/**
 * The last round recorded in a rounds file, or undefined. Its result is
 * worked out again from its issues, never taken as written.
 */
export const lastSystemRound = (
  file: string
): SystemRoundRecord | undefined => {
  const last = readRecords(file).at(-1);

  if (last === undefined) {
    return undefined;
  }

  const issues = last.pictures.flatMap(({ issues: written }) =>
    parseJudgeVerdict(JSON.stringify({ issues: written }))
  );

  return { ...last, result: resultOf(last.round, issues) };
};

/** Where a round's composite for one screen goes: beside its drawn picture. */
export const roundCompositePath = (
  dir: string,
  round: number,
  scenarioId: string
): string => path.join(dir, `round-${round}`, `composite-${scenarioId}.png`);

/**
 * One photo | drawn composite per screen of a recorded round, in
 * `<dir>/round-<n>/composite-<scenario id>.png`: what the setup posts on its
 * ticket, one picture per screen. Returns the paths in the round's order.
 */
export const writeRoundComposites = async (
  record: SystemRoundRecord,
  dir: string
): Promise<string[]> =>
  record.pictures.reduce<Promise<string[]>>(async (done, picture) => {
    const written = await done;
    const out = roundCompositePath(dir, record.round, picture.scenarioId);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await composeExpectedActual({
      expected: picture.photo,
      actual: picture.drawn,
      out,
      labels: { left: 'Photo', right: 'Drawn' },
    });

    return [...written, out];
  }, Promise.resolve([]));
