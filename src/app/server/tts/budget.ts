import * as fs from 'fs';
import * as path from 'path';

/**
 * The monthly ElevenLabs cap. Every render and every stream asks first; past
 * the cap there is no audio until the 1st. Usage is
 * an ESTIMATE (characters × configured price) kept in `~/.lambda/tts-usage.json`, one per computer.
 */
export interface Usage {
  month: string;
  characters: number;
  usd: number;
}

export interface BudgetStatus extends Usage {
  capUsd: number;
  overBudget: boolean;
  /** Why nothing can be spent besides the cap (the file can't be read). */
  problem?: string;
}

/** The usage file exists but can't be read: spending stops (fails closed). */
class UnreadableBudget extends Error {}

const monthOf = (now: Date): string => now.toISOString().slice(0, 7);

export const createBudget = (args: {
  file: string;
  usdPer1kChars: number;
  capUsd: number;
  now?: () => Date;
}) => {
  const now = args.now ?? (() => new Date());

  const text = (): string | null => {
    try {
      return fs.readFileSync(args.file, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null;
      }

      throw error;
    }
  };

  /**
   * This month's spend. No file is a fresh start; one that can't be read
   * stops all spending (read as $0, it would lift the cap).
   */
  const read = (): Usage => {
    const month = monthOf(now());
    const raw = text();

    if (raw === null) {
      return { month, characters: 0, usd: 0 };
    }

    const parsed: unknown = (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('month' in parsed) ||
      typeof parsed.month !== 'string' ||
      !('characters' in parsed) ||
      typeof parsed.characters !== 'number' ||
      !('usd' in parsed) ||
      typeof parsed.usd !== 'number'
    ) {
      throw new UnreadableBudget(
        `The audio budget in ${args.file} can't be read, so nothing is spent until it's fixed or deleted.`
      );
    }

    return parsed.month === month
      ? { month, characters: parsed.characters, usd: parsed.usd }
      : { month, characters: 0, usd: 0 };
  };

  const costOf = (characters: number): number =>
    (characters / 1000) * args.usdPer1kChars;

  /** This month's spend, or the reason there's none to go on. */
  const usage = (): Usage | UnreadableBudget => {
    try {
      return read();
    } catch (error) {
      if (error instanceof UnreadableBudget) {
        return error;
      }

      throw error;
    }
  };

  /** Would spending this many characters stay within the cap? */
  const allows = (characters: number): boolean => {
    const spent = usage();

    return (
      !(spent instanceof UnreadableBudget) &&
      spent.usd + costOf(characters) <= args.capUsd
    );
  };

  const record = (characters: number): Usage => {
    const current = read();
    const next = {
      month: current.month,
      characters: current.characters + characters,
      usd: current.usd + costOf(characters),
    };
    // Whole or not at all: a half-written file would stop all audio.
    fs.mkdirSync(path.dirname(args.file), { recursive: true });
    const tmp = `${args.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, args.file);

    return next;
  };

  const status = (): BudgetStatus => {
    const spent = usage();

    if (spent instanceof UnreadableBudget) {
      return {
        month: monthOf(now()),
        characters: 0,
        usd: 0,
        capUsd: args.capUsd,
        overBudget: true,
        problem: spent.message,
      };
    }

    return {
      ...spent,
      capUsd: args.capUsd,
      overBudget: spent.usd >= args.capUsd,
    };
  };

  return { allows, record, status };
};

export type Budget = ReturnType<typeof createBudget>;
