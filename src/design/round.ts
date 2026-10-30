import * as fs from 'fs';
import * as path from 'path';

import {
  type DesignIssue,
  type DesignStopDecision,
  MAX_DESIGN_ROUNDS,
  parseJudgeVerdict,
  shouldStopDesignLoop,
} from './loop';
import { assertScreenDir } from './screenDir';

/**
 * `lambda design round` — record one judged round of a screen's prototype in
 * `<screen dir>/rounds.jsonl`, one line per round:
 * `{round, at, issues, decision: {stop, reason}}`.
 *
 * The round number comes from the file itself (1 + the lines already there),
 * never from the caller. Round 8 is refused here, separately from the stop
 * helper, so the cap holds even if the helper were wrong. Every refusal
 * throws before anything is written.
 */

export const ROUNDS_FILE = 'rounds.jsonl';

export interface RoundRecord {
  round: number;
  at: string;
  issues: DesignIssue[];
  decision: DesignStopDecision;
}

export interface RecordedRound {
  round: number;
  decision: DesignStopDecision;
  /** What the command prints: `STOP <reason>` or `CONTINUE`. */
  line: string;
}

/** The decisions already recorded, in order. Throws naming a bad line. */
const readDecisions = (file: string): DesignStopDecision[] => {
  if (!fs.existsSync(file)) {
    return [];
  }

  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((text, index) => ({ text, n: index + 1 }))
    .filter(({ text }) => text.trim() !== '')
    .map(({ text, n }) => {
      const parsed: unknown = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })();
      const decision =
        typeof parsed === 'object' && parsed !== null && 'decision' in parsed
          ? parsed.decision
          : undefined;

      if (
        typeof decision !== 'object' ||
        decision === null ||
        !('stop' in decision) ||
        typeof decision.stop !== 'boolean'
      ) {
        throw new Error(
          `${file} line ${n} is not a round record ({round, at, issues, decision: {stop, reason}}); fix or move the file aside.`
        );
      }

      const reason =
        'reason' in decision && typeof decision.reason === 'string'
          ? decision.reason
          : null;

      return {
        stop: decision.stop,
        reason:
          reason === 'only-low' ||
          reason === 'round-4-medium-low' ||
          reason === 'round-7'
            ? reason
            : null,
      };
    });
};

/**
 * Start a re-design (the owner changed the screen at its checkpoint): move `rounds.jsonl`
 * to `rounds.<time>.jsonl` and `walk/` to `walk.<time>/`, so the new design
 * gets its own rounds and its own cap. Returns the new names (none when there
 * was nothing to move). The time is ISO with `:` and `.` made `-`, safe in a
 * file name.
 */
export const archiveDesignRounds = ({
  screenDir,
  now = () => new Date(),
}: {
  screenDir: string;
  now?: () => Date;
}): string[] => {
  const dir = assertScreenDir(screenDir);
  const stamp = now().toISOString().replace(/[:.]/g, '-');

  return [
    { from: ROUNDS_FILE, to: `rounds.${stamp}.jsonl` },
    { from: 'walk', to: `walk.${stamp}` },
  ]
    .filter(({ from }) => fs.existsSync(path.join(dir, from)))
    .map(({ from, to }) => {
      if (fs.existsSync(path.join(dir, to))) {
        throw new Error(`${to} already exists in ${dir}; try again.`);
      }

      fs.renameSync(path.join(dir, from), path.join(dir, to));

      return to;
    });
};

export const recordDesignRound = ({
  screenDir,
  judgeFile,
  now = () => new Date(),
}: {
  screenDir: string;
  judgeFile: string;
  now?: () => Date;
}): RecordedRound => {
  const dir = assertScreenDir(screenDir);
  const file = path.join(dir, ROUNDS_FILE);
  const decisions = readDecisions(file);
  const last = decisions[decisions.length - 1];

  if (last?.stop === true) {
    throw new Error(
      `Round ${decisions.length} already said STOP${
        last.reason === null ? '' : ` ${last.reason}`
      }: this design is finished. A re-design moves ${ROUNDS_FILE} aside first.`
    );
  }

  const round = decisions.length + 1;

  if (round > MAX_DESIGN_ROUNDS) {
    throw new Error(
      `Refusing round ${round}: a screen's prototype gets at most ${MAX_DESIGN_ROUNDS} rounds.`
    );
  }

  const issues = parseJudgeVerdict(fs.readFileSync(judgeFile, 'utf8'));
  const decision = shouldStopDesignLoop(round, issues);
  const record: RoundRecord = {
    round,
    at: now().toISOString(),
    issues,
    decision: { stop: decision.stop, reason: decision.reason },
  };

  const unterminated =
    fs.existsSync(file) &&
    fs.statSync(file).size > 0 &&
    !fs.readFileSync(file, 'utf8').endsWith('\n');
  fs.appendFileSync(
    file,
    `${unterminated ? '\n' : ''}${JSON.stringify(record)}\n`
  );

  return {
    round,
    decision,
    line:
      decision.stop && decision.reason !== null
        ? `STOP ${decision.reason}`
        : 'CONTINUE',
  };
};
