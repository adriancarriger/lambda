/**
 * Lambda's scenario format: one file, `<id>.scenario.<ext>`, describing one
 * exact situation of the project's app (who is signed in, what data, the
 * clock, what just happened, which screen), so the photo hook can put the
 * app in it and a later plan can find it again.
 *
 * With `.json` the file is an object holding `id`, `title`, `description`,
 * `tags` and an optional `viewport` at the top level, plus whatever the
 * hook needs. With any other extension Lambda reads those keys from one line
 * in the first 20 holding `lambda-scenario:` and a JSON object, inside the
 * comment the project's language uses:
 *
 *   // lambda-scenario: {"id": "trail-map-closed", "title": "…", …}
 */
import * as fs from 'fs';
import * as path from 'path';

/** A scenario id: lower-case words joined by single dashes. */
export const SCENARIO_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A scenario file's name, whatever its extension. */
export const SCENARIO_FILE_NAME =
  /^[a-z0-9]+(-[a-z0-9]+)*\.scenario\.[a-z0-9]+$/;

const FILE_PARTS = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.scenario\.([a-z0-9]+)$/;

export const MIN_DESCRIPTION = 120;
export const MARKER = 'lambda-scenario:';
export const MARKER_LINES = 20;

export const VIEWPORTS = ['desktop', 'phone'] as const;
export type Viewport = (typeof VIEWPORTS)[number];

export type ScenarioSource = 'tracked' | 'pending';

export interface Scenario {
  id: string;
  title: string;
  description: string;
  tags: string[];
  viewport: Viewport;
}

export interface ScenarioEntry extends Scenario {
  source: ScenarioSource;
  file: string;
}

/** Refuse an id before it is ever used to build a path. */
export const assertScenarioId = (id: string): string => {
  if (!SCENARIO_ID.test(id)) {
    throw new Error(
      `"${id}" isn't a scenario id: use lower-case words joined by single dashes (${SCENARIO_ID.source}).`
    );
  }

  return id;
};

/** `trail-map-closed.scenario.json` → its id and extension. */
export const scenarioFileParts = (
  name: string
): { id: string; ext: string } | null => {
  const match = FILE_PARTS.exec(name);

  return match?.[1] === undefined || match[2] === undefined
    ? null
    : { id: match[1], ext: match[2] };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The object a file declares, or why there is none. */
const declared = (
  text: string,
  ext: string
): { fields: Record<string, unknown> } | { problem: string } => {
  const parse = (json: string, where: string) => {
    try {
      const value: unknown = JSON.parse(json);

      return isRecord(value)
        ? { fields: value }
        : { problem: `${where} isn't a JSON object.` };
    } catch (error) {
      return {
        problem: `${where} isn't valid JSON (${
          error instanceof Error ? error.message : String(error)
        }).`,
      };
    }
  };

  if (ext === 'json') {
    return parse(text, 'The file');
  }

  const line = text
    .split('\n')
    .slice(0, MARKER_LINES)
    .find((candidate) => candidate.includes(MARKER));

  if (line === undefined) {
    return {
      problem: `It has no line containing ${MARKER} in its first ${MARKER_LINES} lines.`,
    };
  }

  const after = line.slice(line.indexOf(MARKER) + MARKER.length);
  const start = after.indexOf('{');
  const end = after.lastIndexOf('}');

  if (start === -1 || end < start) {
    return { problem: `Its ${MARKER} line holds no JSON object.` };
  }

  return parse(after.slice(start, end + 1), `Its ${MARKER} line`);
};

/** Every problem with the declared fields, in field order. */
const fieldProblems = (
  fields: Record<string, unknown>,
  fileId: string
): string[] => {
  const { id, title, description, tags, viewport } = fields;
  const idProblem =
    typeof id !== 'string'
      ? 'id is required.'
      : !SCENARIO_ID.test(id)
      ? `id "${id}" isn't a scenario id (${SCENARIO_ID.source}).`
      : id !== fileId
      ? `id "${id}" isn't the file name's ("${fileId}").`
      : null;
  const titleProblem =
    typeof title === 'string' && title.trim() !== ''
      ? null
      : 'title is required.';
  const descriptionProblem =
    typeof description !== 'string'
      ? `description is required (at least ${MIN_DESCRIPTION} characters).`
      : description.length < MIN_DESCRIPTION
      ? `description is ${description.length} characters; it needs at least ${MIN_DESCRIPTION}: who is signed in, what data, the clock, what just happened and which screen.`
      : null;
  const tagsProblem =
    Array.isArray(tags) && tags.every((tag) => typeof tag === 'string')
      ? null
      : 'tags must be a list of strings.';
  const viewportProblem =
    viewport === undefined || VIEWPORTS.some((allowed) => allowed === viewport)
      ? null
      : `viewport must be ${VIEWPORTS.join(' or ')}.`;

  return [
    idProblem,
    titleProblem,
    descriptionProblem,
    tagsProblem,
    viewportProblem,
  ].filter((problem): problem is string => problem !== null);
};

const viewportOf = (value: unknown): Viewport =>
  VIEWPORTS.find((allowed) => allowed === value) ?? 'desktop';

/** A scenario file read and checked: the scenario, or each problem. */
export const checkScenarioFile = (
  file: string
): { scenario: Scenario | null; problems: string[] } => {
  const parts = scenarioFileParts(path.basename(file));

  if (parts === null) {
    return {
      scenario: null,
      problems: [
        `${path.basename(file)} isn't named <id>.scenario.<ext> (${
          SCENARIO_FILE_NAME.source
        }).`,
      ],
    };
  }

  const text = (() => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();

  if (text instanceof Error) {
    return { scenario: null, problems: [`Can't read it: ${text.message}`] };
  }

  const found = declared(text, parts.ext);

  if ('problem' in found) {
    return { scenario: null, problems: [found.problem] };
  }

  const problems = fieldProblems(found.fields, parts.id);

  if (problems.length > 0) {
    return { scenario: null, problems };
  }

  const { fields } = found;

  return {
    scenario: {
      id: parts.id,
      title: String(fields.title),
      description: String(fields.description),
      tags: Array.isArray(fields.tags) ? fields.tags.map(String) : [],
      viewport: viewportOf(fields.viewport),
    },
    problems: [],
  };
};

// ── search and suggestions ──────────────────────────────────────────────────

/**
 * Every word must match the id, title, description or tags (any case). Title
 * and tag hits rank first.
 */
export const searchScenarios = (
  entries: ScenarioEntry[],
  words: string[]
): ScenarioEntry[] => {
  const needles = words.map((word) => word.toLowerCase()).filter(Boolean);

  return entries
    .map((entry) => {
      const strong = [entry.title, ...entry.tags].join('\n').toLowerCase();
      const all = [entry.id, strong, entry.description.toLowerCase()].join(
        '\n'
      );

      return {
        entry,
        matches: needles.every((needle) => all.includes(needle)),
        score: needles.filter((needle) => strong.includes(needle)).length,
      };
    })
    .filter(({ matches }) => matches)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .map(({ entry }) => entry);
};

/** Levenshtein distance, one row of the table at a time. */
export const editDistance = (a: string, b: string): number => {
  const first = Array.from({ length: b.length + 1 }, (_, index) => index);
  const last = Array.from(a).reduce(
    (previous, charA, i) =>
      Array.from(b).reduce<number[]>(
        (row, charB, j) => [
          ...row,
          Math.min(
            (previous[j + 1] ?? 0) + 1,
            (row[j] ?? 0) + 1,
            (previous[j] ?? 0) + (charA === charB ? 0 : 1)
          ),
        ],
        [i + 1]
      ),
    first
  );

  return last[b.length] ?? 0;
};

/** Up to `max` known ids, closest first. */
export const closestIds = (id: string, known: string[], max = 3): string[] =>
  Array.from(new Set(known))
    .map((candidate) => ({ candidate, distance: editDistance(id, candidate) }))
    .sort(
      (a, b) =>
        a.distance - b.distance || a.candidate.localeCompare(b.candidate)
    )
    .slice(0, max)
    .map(({ candidate }) => candidate);
