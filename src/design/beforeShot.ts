/**
 * A screen's "before" pictures, taken with the project's photo hook before
 * anything is designed (design-screen runs `lambda shot before`).
 *
 * - With `commands.shot`, every situation is photographed to
 *   `<screen-dir>/<situation>.before.png`. One that fails (the hook exits 1,
 *   times out, or writes no PNG) ends the screen with
 *   `DESIGN FAILED <slug>: before shot — <scenario id>: <the hook's last line>`:
 *   a screen is never designed without its befores.
 * - With no photo hook at all, the screen is designed from the written
 *   change: no before pictures, and its ux screen says `noPhotoHook: true`.
 */
import * as path from 'path';

import { type ShotOutcome, lastWordsOf } from '../shot';
import { DESIGN_SLUG } from './loop';
import { assertScreenDir } from './screenDir';

export interface BeforeSituation {
  /** The situation's slug: its picture is `<situation>.before.png`. */
  situation: string;
  scenarioId: string;
}

export type Shoot = (scenarioId: string, out: string) => Promise<ShotOutcome>;

export type BeforeShots =
  | {
      kind: 'taken';
      befores: Array<BeforeSituation & { file: string }>;
    }
  | { kind: 'no-hook'; noPhotoHook: true }
  | { kind: 'failed'; line: string };

export interface BeforeInput {
  slug: string;
  screenDir: string;
  situations: BeforeSituation[];
  shoot: Shoot;
}

export const beforeFile = (screenDir: string, situation: string): string =>
  path.join(screenDir, `${situation}.before.png`);

const assertSlug = (value: string, what: string): string => {
  if (!DESIGN_SLUG.test(value)) {
    throw new Error(
      `"${value}" isn't a ${what}: it must match ${DESIGN_SLUG}.`
    );
  }

  return value;
};

export const failedLine = (
  slug: string,
  scenarioId: string,
  outcome: Extract<ShotOutcome, { kind: 'failed' }>
): string =>
  `DESIGN FAILED ${slug}: before shot — ${scenarioId}: ${
    lastWordsOf(outcome.tail) ?? outcome.reason
  }`;

/** Every situation's before picture, stopping at the first that fails. */
export const takeBeforeShots = async (
  input: BeforeInput
): Promise<BeforeShots> => {
  const slug = assertSlug(input.slug, 'screen slug');

  if (input.situations.length === 0) {
    throw new Error(
      `No situations for ${slug}: give one --situation <situation>=<scenario id> per situation.`
    );
  }

  input.situations.forEach((one) =>
    assertSlug(one.situation, 'situation name')
  );
  // Like every command that writes into a screen folder.
  const screenDir = assertScreenDir(input.screenDir);

  return input.situations.reduce<Promise<BeforeShots>>(async (sofar, one) => {
    const done = await sofar;

    if (done.kind !== 'taken') {
      return done;
    }

    const file = beforeFile(screenDir, one.situation);
    const outcome = await input.shoot(one.scenarioId, file);

    if (outcome.kind === 'no-hook') {
      return { kind: 'no-hook', noPhotoHook: true };
    }

    if (outcome.kind === 'failed') {
      return {
        kind: 'failed',
        line: failedLine(slug, one.scenarioId, outcome),
      };
    }

    return { kind: 'taken', befores: [...done.befores, { ...one, file }] };
  }, Promise.resolve({ kind: 'taken', befores: [] }));
};
