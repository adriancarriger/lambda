/**
 * What the build's visual check tells the ticket: one comment when a loop
 * ships with medium or medium-low issues left (SHIPPED_WITH_MISSES), and the
 * picture section of a Blocked comment (BLOCKED). Each picture with an issue
 * worse than low is shown as one expected | actual composite, followed by its
 * issues, worst first.
 *
 * Posted through the project's own ticket source, with the pictures attached
 * (`lambda tickets comment --image`): on a markdown project each is saved next
 * to the ticket file as `<tickets dir>/<id>/visual-<scenarioId>.png`.
 */
import * as fs from 'fs';
import * as path from 'path';

import { composeExpectedActual } from '../design/composite';
import type { TicketSource } from '../tickets/source';
import {
  type VisualIssue,
  type VisualVerdict,
  isMiss,
  visualDir,
} from './visualStore';

/** Draws one composite; Playwright by default, a fake in tests. */
export type Compose = (input: {
  expected: string;
  actual: string;
  out: string;
}) => Promise<void>;

/** A comment body with `{{image:<i>}}` tokens, and the images they name. */
export interface VisualSection {
  body: string;
  images: Array<{ path: string; alt: string }>;
  /** Each picture's composite, as drawn into `<verdicts.dir>/<id>.visual/`. */
  composites: Array<{ scenarioId: string; file: string }>;
}

/** The composite of one picture: `<verdicts.dir>/<id>.visual/composite-<scenarioId>.png`. */
export const compositePath = (
  projectRoot: string,
  ticketId: string,
  scenarioId: string
): string =>
  path.join(visualDir(projectRoot, ticketId), `composite-${scenarioId}.png`);

/** Every issue worse than low, grouped by picture, in the record's order. */
export const missesByPicture = (verdict: VisualVerdict): VisualIssue[][] =>
  Array.from(
    verdict.issues
      .filter(isMiss)
      .reduce<Map<string, VisualIssue[]>>(
        (byPicture, issue) =>
          new Map(byPicture).set(issue.scenarioId, [
            ...(byPicture.get(issue.scenarioId) ?? []),
            issue,
          ]),
        new Map()
      )
      .values()
  );

/**
 * The pictures a visual record left differing from their design (every issue
 * worse than low), each as an expected | actual composite followed by its
 * issues. Throws when a composite can't be drawn: each caller decides what
 * that costs.
 */
export const buildVisualSection = async (
  projectRoot: string,
  verdict: VisualVerdict,
  compose: Compose = composeExpectedActual
): Promise<VisualSection> => {
  const block = async (issues: VisualIssue[], index: number) => {
    const [first] = issues;

    if (first === undefined) {
      throw new Error('A picture with no issues has no composite.');
    }

    const { scenarioId, situation, expected, actual } = first;
    const composite = compositePath(projectRoot, verdict.ticketId, scenarioId);
    fs.mkdirSync(path.dirname(composite), { recursive: true });
    await compose({
      expected: path.join(projectRoot, expected),
      actual: path.join(projectRoot, actual),
      out: composite,
    });
    // Attached under its own name, so a markdown project keeps it as
    // `<tickets dir>/<id>/visual-<scenarioId>.png`.
    const attached = path.join(
      visualDir(projectRoot, verdict.ticketId),
      'attach',
      `visual-${scenarioId}.png`
    );
    fs.mkdirSync(path.dirname(attached), { recursive: true });
    fs.copyFileSync(composite, attached);

    return {
      composite: { scenarioId, file: composite },
      image: { path: attached, alt: situation },
      text: [
        `### ${situation}`,
        '',
        `{{image:${index}}}`,
        '',
        ...issues.map(
          ({ severity, where, what }) => `- **${severity}** — ${where}: ${what}`
        ),
      ].join('\n'),
    };
  };
  // One after another: each composite is a headless browser, and a runner
  // drawing every picture at once can run out of memory.
  const blocks = await missesByPicture(verdict).reduce<
    Promise<Array<Awaited<ReturnType<typeof block>>>>
  >(
    async (done, issues, index) => [
      ...(await done),
      await block(issues, index),
    ],
    Promise.resolve([])
  );

  return {
    body: blocks.map(({ text }) => text).join('\n\n'),
    images: blocks.map(({ image }) => image),
    composites: blocks.map(({ composite }) => composite),
  };
};

/**
 * Keyed on `recordedAt`, never `headSha`: the dev's fixes stay uncommitted
 * between loops, so two loops share a HEAD and only the record time tells
 * them apart.
 */
export const visualMissesMarker = (
  ticketId: string,
  recordedAt: string
): string => `<!-- visual-check:${ticketId}:${recordedAt} -->`;

export interface PostMissesDeps {
  projectRoot: string;
  source: TicketSource;
  compose?: Compose;
  info?: (line: string) => void;
  warn?: (line: string) => void;
}

/** Whether a comment carries the marker, or null when the tracker didn't say. */
const alreadyPosted = async (
  deps: PostMissesDeps,
  ticketId: string,
  marker: string
): Promise<boolean | null> => {
  try {
    const comments = await deps.source.comments(ticketId);

    return comments.some((comment) => comment.includes(marker));
  } catch (error) {
    deps.warn?.(
      `Could not check ${ticketId} for an earlier post of its visual misses (${
        error instanceof Error ? error.message : String(error)
      }) — posting them anyway.`
    );

    return null;
  }
};

/**
 * Post a SHIPPED_WITH_MISSES record's leftovers to its ticket: one comment per
 * record (deduped by its marker; a failed read still posts — a duplicate
 * comment beats a lost one), expected | actual per picture. Never throws: a
 * failed post is a warning, and the record stands either way.
 */
export const postVisualMisses = async (
  verdict: VisualVerdict,
  deps: PostMissesDeps
): Promise<void> => {
  const marker = visualMissesMarker(verdict.ticketId, verdict.recordedAt);

  if ((await alreadyPosted(deps, verdict.ticketId, marker)) === true) {
    deps.info?.(`Visual misses already posted to ${verdict.ticketId}.`);

    return;
  }

  try {
    const section = await buildVisualSection(
      deps.projectRoot,
      verdict,
      deps.compose
    );
    await deps.source.comment(
      verdict.ticketId,
      [
        marker,
        '### 🎨 Visual check: shipped with misses',
        '',
        `After ${verdict.rounds} round${
          verdict.rounds === 1 ? '' : 's'
        }, the build still differs from its design here. Each picture is the design (Expected) beside the build (Actual).`,
        '',
        section.body,
      ].join('\n'),
      { images: section.images }
    );
    deps.info?.(`Posted the visual misses to ${verdict.ticketId}.`);
  } catch (error) {
    deps.warn?.(
      `Failed to post the visual misses to ${verdict.ticketId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};
