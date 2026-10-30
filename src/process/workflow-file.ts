/**
 * A project's own process: Lambda's standard planning and building steps,
 * patched by `.lambda/{planning,building}/workflow.json`.
 *
 *   {
 *     "extends": "standard",
 *     "add": [{ "id": "a11y-check", "label": "Accessibility", "run": "/a11y {tickets}", "after": "ux-review" }],
 *     "drop": ["duplicate-check"],
 *     "move": [{ "id": "research", "after": "verify-premise" }],
 *     "rename": { "proposal-cold-read": "Fresh read" },
 *     "off": ["ux-sketch"]
 *   }
 *
 * A patch, not a copy, so a project picks up Lambda's later changes to the
 * standard steps. Each step is an ordinary slash command, and a file
 * `.lambda/<process>/<step id or command>.md` replaces its instructions for
 * this project only. Lambda's quality steps (`locked`) can't be dropped,
 * moved, switched off or replaced. Its `required` steps can't be dropped,
 * moved or switched off, nor have a step put between them and the step after
 * them, but their instructions can be replaced. Only `optional` steps can be
 * switched off. The flags are data on the steps, never listed here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import {
  STANDARD_PLANNING,
  STEP_IDS,
  type WorkflowStage,
  type WorkflowStep,
} from '../pod-store/workflow';
import { BUILDING_STAGES, BUILDING_STEPS, BUILDING_TRACK } from './building';

export type ProcessName = 'planning' | 'building';

export const PROCESS_NAMES: ProcessName[] = ['planning', 'building'];

export interface ResolvedStep extends WorkflowStep {
  /** Added by the project's workflow.json. */
  added?: boolean;
  /** An added step's slash command line, before `{tickets}`/`{epic}`. */
  run?: string;
  /** An added step that must be done before this checkpoint is posted. */
  checkpoint?: number;
  /** The project gave it its own label. */
  renamed?: boolean;
  /** The project file replacing its instructions, from the project root. */
  replacedBy?: string;
}

export interface ResolvedStage extends WorkflowStage {
  steps: ResolvedStep[];
  renamed?: boolean;
}

export interface ResolvedProcess {
  name: ProcessName;
  /** Each track's stages in order (building has one track, `standard`). */
  tracks: Record<string, ResolvedStage[]>;
}

const ID = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lower-case letters, digits and -');

const AddSchema = z
  .object({
    id: ID,
    label: z.string().min(1),
    /** A slash command, e.g. `/a11y-check {tickets}`. */
    run: z
      .string()
      .regex(
        /^\/[a-z0-9][a-z0-9-]*(\s|$)/i,
        'must start with a slash command, e.g. "/a11y-check {tickets}".'
      ),
    after: z.string().min(1),
    /** It can be switched off. */
    switch: z.boolean().optional(),
    /** It must be done before checkpoint n is posted. */
    checkpoint: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export const WorkflowFileSchema = z
  .object({
    extends: z.string(),
    add: z.array(AddSchema).optional(),
    drop: z.array(z.string()).optional(),
    move: z
      .array(z.object({ id: z.string(), after: z.string() }).strict())
      .optional(),
    rename: z.record(z.string().min(1)).optional(),
    off: z.array(z.string()).optional(),
    /** Optional steps that start off (`offByDefault`), switched on. */
    on: z.array(z.string()).optional(),
  })
  .strict();

export type WorkflowFile = z.infer<typeof WorkflowFileSchema>;

/** `.lambda/<process>/workflow.json`, as the project sees it. */
export const workflowFileName = (name: ProcessName): string =>
  `.lambda/${name}/workflow.json`;

const fileIn = (root: string, relative: string): string =>
  path.join(root, ...relative.split('/'));

// ── the standard processes ──────────────────────────────────────────────────

const copyStages = (stages: WorkflowStage[]): ResolvedStage[] =>
  stages.map((stage) => ({
    ...stage,
    // A step that starts off is off until the project switches it on.
    steps: stage.steps.map((step) =>
      step.offByDefault === true ? { ...step, off: true } : { ...step }
    ),
  }));

export const standardProcess = (name: ProcessName): ResolvedProcess =>
  name === 'planning'
    ? {
        name,
        tracks: Object.fromEntries(
          Object.entries(STANDARD_PLANNING).map(([track, stages]) => [
            track,
            copyStages(stages),
          ])
        ),
      }
    : { name, tracks: { [BUILDING_TRACK]: copyStages(BUILDING_STAGES) } };

// ── instructions ────────────────────────────────────────────────────────────

const PACKAGE_NAME = '@adriancarriger/lambda';

/** Lambda's own folder, from src (tests) or dist (the built CLI). */
export const lambdaPackageDir = (start: string = __dirname): string => {
  const manifest = path.join(start, 'package.json');
  const parent = path.dirname(start);

  if (fs.existsSync(manifest)) {
    const { name }: { name?: unknown } = JSON.parse(
      fs.readFileSync(manifest, 'utf8')
    );

    if (name === PACKAGE_NAME) {
      return start;
    }
  }

  if (parent === start) {
    throw new Error(`Can't find ${PACKAGE_NAME}'s own folder.`);
  }

  return lambdaPackageDir(parent);
};

const INSTRUCTION_NAME = /^[a-z0-9][a-z0-9-]*$/i;

/** Where a step's instructions can come from, in lookup order. */
const instructionCandidates = (
  root: string,
  name: ProcessName,
  instructions: string
): string[] => [
  path.join(root, '.lambda', name, `${instructions}.md`),
  path.join(root, '.claude', 'commands', `${instructions}.md`),
  path.join(lambdaPackageDir(), 'instructions', name, `${instructions}.md`),
];

/** Every place looked in, as full paths, for an error that names them. */
const placesText = (
  root: string,
  name: ProcessName,
  instructions: string
): string => instructionCandidates(root, name, instructions).join(', ');

/**
 * The step ids and commands of Lambda's quality steps. Their instructions are
 * always Lambda's own (and so are its role instructions, below): a `.lambda/<process>/` file that would replace one is
 * refused when the process loads, and a same-named `.claude/commands/` file is
 * passed over (it stays an ordinary slash command of the project's).
 */
const lockedStepInstructionNames = (name: ProcessName): string[] =>
  allSteps(standardProcess(name).tracks)
    .filter((step) => step.locked === true)
    .flatMap((step) => [step.id, step.command])
    .filter((value): value is string => value !== undefined);

/** Lambda's own instruction names for a process: `pod-phase`, `manager`, … */
const ownInstructionNames = (name: ProcessName): string[] =>
  fs
    .readdirSync(path.join(lambdaPackageDir(), 'instructions', name))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length));

/**
 * A planning pod's conversation commands (`/human-chat`, `/pod-skip`, …),
 * Lambda's defaults in `commands/pod/`. A project replaces one with
 * `.lambda/planning/<name>.md`, like a step's instructions.
 */
const podConversationCommands = (name: ProcessName): string[] => {
  const dir = path.join(lambdaPackageDir(), 'commands', 'pod');

  return name === 'planning' && fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.md'))
        .map((file) => file.slice(0, -'.md'.length))
    : [];
};

/**
 * Commands a step's own instructions run, with no step of their own: the ux
 * phase runs `/design-screen` once per screen, and a building pod's dev runs
 * `/design-system-setup` in place of `/start` for the ticket that makes the
 * design system. A project replaces one with `.lambda/<process>/<name>.md`,
 * like a step's command.
 */
export const INNER_COMMANDS: Record<ProcessName, string[]> = {
  planning: ['design-screen'],
  building: ['design-system-setup'],
};

/**
 * Lambda's role instructions (`pod-phase`, `dev`, `manager`): its own files
 * no step runs. They hold the instructions of the quality steps that run no
 * command (the cold reads, the checkpoint posts, check-ticket's loop), so they
 * are locked like those steps.
 */
export const roleInstructionNames = (name: ProcessName): string[] => {
  const stepNames = new Set([
    ...allSteps(standardProcess(name).tracks).flatMap((step) =>
      step.command === undefined ? [step.id] : [step.id, step.command]
    ),
    ...INNER_COMMANDS[name],
  ]);

  return ownInstructionNames(name).filter(
    (instructions) => !stepNames.has(instructions)
  );
};

const lockedInstructionNames = (name: ProcessName): string[] => [
  ...lockedStepInstructionNames(name),
  ...roleInstructionNames(name),
];

/** Are these instructions always Lambda's own (a quality step or a role)? */
export const isLockedInstruction = (
  name: ProcessName,
  instructions: string
): boolean => lockedInstructionNames(name).includes(instructions);

/**
 * The file holding a step's instructions: `.lambda/<process>/<name>.md`, then
 * the project's own `.claude/commands/<name>.md`, then Lambda's default.
 * `name` is a step id or a command name. A quality step's instructions are
 * always Lambda's own. `passOver` names files that aren't the project's
 * (copies Lambda wrote there itself), so the lookup goes past them.
 */
export const resolveInstructions = (
  projectRoot: string,
  name: ProcessName,
  instructions: string,
  passOver: string[] = []
): string => {
  if (!INSTRUCTION_NAME.test(instructions)) {
    throw new Error(`"${instructions}" isn't a step or command name.`);
  }

  const candidates = instructionCandidates(
    projectRoot,
    name,
    instructions
  ).filter((file) => !passOver.includes(file));
  const places = isLockedInstruction(name, instructions)
    ? candidates.slice(-1)
    : candidates;
  const found = places.find((file) => fs.existsSync(file));

  if (found === undefined) {
    throw new Error(
      `${instructions}.md isn't in any of: ${places.join(', ')}.`
    );
  }

  return found;
};

/**
 * A project's addition to an instruction file: `.lambda/<process>/<name>.add.md`.
 * It never replaces Lambda's text, so it may add to a locked one too (a role,
 * a quality step): the project's own rules ride after Lambda's.
 */
export const ADDENDUM_EXT = '.add.md';

export const addendumFile = (
  projectRoot: string,
  name: ProcessName,
  instructions: string
): string =>
  path.join(projectRoot, '.lambda', name, `${instructions}${ADDENDUM_EXT}`);

/** `text` with the project's addendum for these instructions after it, if any. */
export const withAddendum = (
  projectRoot: string,
  name: ProcessName,
  instructions: string,
  text: string
): string => {
  const file = addendumFile(projectRoot, name, instructions);

  return fs.existsSync(file)
    ? `${text.trimEnd()}\n\n${fs.readFileSync(file, 'utf8')}`
    : text;
};

/** `{tickets}` → `PAWNEE-1, PAWNEE-2`; `{epic}` → the epic id or ''. */
export const fillRun = (
  run: string,
  pod: { tickets: string[]; epic?: string }
): string =>
  run
    .split('{tickets}')
    .join(pod.tickets.join(', '))
    .split('{epic}')
    .join(pod.epic ?? '');

/** An added step's command: the first word of `run`, without its `/`. */
const commandOf = (run: string): string =>
  (run.trim().split(/\s+/)[0] ?? '').replace(/^\//, '');

// ── reading and writing workflow.json ───────────────────────────────────────

const parseWorkflowFile = (name: ProcessName, text: string): WorkflowFile => {
  const label = workflowFileName(name);
  const json = ((): unknown => {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${label}: not valid JSON (${
          error instanceof Error ? error.message : String(error)
        }).`
      );
    }
  })();
  const result = WorkflowFileSchema.safeParse(json);

  if (result.success) {
    return result.data;
  }

  throw new Error(
    result.error.issues
      .map(
        (issue) =>
          `${label}: ${fieldOf(json, issue.path)} ${describeIssue(issue)}`
      )
      .join('\n')
  );
};

/** The step id an `add`/`move`/`drop`/`off` entry names, if it names one. */
const entryId = (
  json: unknown,
  key: string | number,
  index: number
): string | undefined => {
  const list = z.record(z.unknown()).safeParse(json);
  const entries = list.success
    ? z.array(z.unknown()).safeParse(list.data[key])
    : undefined;
  const entry = entries?.success === true ? entries.data[index] : undefined;
  const named = z
    .union([z.string(), z.object({ id: z.string() })])
    .safeParse(entry);

  if (!named.success) {
    return undefined;
  }

  return typeof named.data === 'string' ? named.data : named.data.id;
};

/**
 * The field at fault, as the settings files name it (`tickets.source`), but
 * an entry by its step id where it has one: `add "a11y-check" after`,
 * `rename "research"`.
 */
const fieldOf = (json: unknown, at: (string | number)[]): string => {
  const [key, entry, ...rest] = at;

  if (key === undefined) {
    return '(root)';
  }

  const id =
    typeof entry === 'number'
      ? entryId(json, key, entry)
      : typeof entry === 'string' && key === 'rename'
      ? entry
      : undefined;

  if (id === undefined) {
    return at.join('.');
  }

  return [
    `${key} "${id}"`,
    ...(rest.length === 0 ? [] : [rest.join('.')]),
  ].join(' ');
};

/** Zod's message, lower-cased to read on from the field, as readConfigFile does. */
const describeIssue = (issue: z.ZodIssue): string => {
  if (issue.code === 'invalid_type' && issue.received === 'undefined') {
    return 'is required.';
  }

  return issue.message.charAt(0).toLowerCase() + issue.message.slice(1);
};

/** The project's workflow.json for this process, or null when it has none. */
export const readWorkflowFile = (
  root: string,
  name: ProcessName
): WorkflowFile | null => {
  const file = fileIn(root, workflowFileName(name));

  return fs.existsSync(file)
    ? parseWorkflowFile(name, fs.readFileSync(file, 'utf8'))
    : null;
};

/**
 * Switch an optional step off (or back on) for this project: writes only
 * `off` in the project's workflow.json, after checking the result loads.
 */
export const setStepOff = (
  root: string,
  name: ProcessName,
  id: string,
  off: boolean
): void => {
  const file = fileIn(root, workflowFileName(name));
  const exists = fs.existsSync(file);

  // A step that starts off is switched with `on`; every other with `off`.
  const startsOff = standardSteps(name).some(
    (step) => step.id === id && step.offByDefault === true
  );

  // Already as asked with no workflow.json: an ordinary step on, or a step
  // that starts off switched off.
  if (!exists && off === startsOff) {
    return;
  }

  const text = exists ? fs.readFileSync(file, 'utf8') : '';
  const current = exists
    ? parseWorkflowFile(name, text)
    : { extends: 'standard' as const };
  const key = startsOff ? 'on' : 'off';
  const listed = startsOff ? !off : off;
  const rest = (current[key] ?? []).filter((other) => other !== id);
  const next = listed ? [...rest, id] : rest;

  resolveWorkflow(root, name, { ...current, [key]: next });

  // Only that list changes: every other key stays as the project wrote it,
  // in its place.
  const raw = exists
    ? z.record(z.unknown()).parse(JSON.parse(text))
    : { extends: 'standard' };
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    temp,
    `${JSON.stringify({ ...raw, [key]: next }, null, 2)}\n`
  );
  fs.renameSync(temp, file);
};

/** Every step of a standard process, for whether one starts off. */
const standardSteps = (name: ProcessName): WorkflowStep[] =>
  Object.values(standardProcess(name).tracks)
    .flat()
    .flatMap((stage) => stage.steps);

// ── resolving ───────────────────────────────────────────────────────────────

type Tracks = Record<string, ResolvedStage[]>;

interface State {
  tracks: Tracks;
  errors: string[];
}

const QUALITY = "it's one of Lambda's quality steps.";
const REQUIRED =
  "it's one of Lambda's required steps: it stays where it is, though its instructions can be replaced.";
const ROLE = "it holds the instructions of Lambda's quality steps.";

/** Each checkpoint's post step (CP2's in a batch: cp2-post-triage). */
const CHECKPOINT_POSTS: Record<number, string[]> = {
  1: ['cp1-post'],
  2: ['cp2-post', 'cp2-post-triage'],
  3: ['proposal-post'],
  4: ['cp4-post'],
  5: ['cp5-post'],
};

const stepsOf = (stages: ResolvedStage[]): ResolvedStep[] =>
  stages.flatMap((stage) => stage.steps);

const allSteps = (tracks: Tracks): ResolvedStep[] =>
  Object.values(tracks).flatMap(stepsOf);

const allStages = (tracks: Tracks): ResolvedStage[] =>
  Object.values(tracks).flat();

const findAnyStep = (tracks: Tracks, id: string): ResolvedStep | undefined =>
  allSteps(tracks).find((step) => step.id === id);

const findAnyStage = (tracks: Tracks, id: string): ResolvedStage | undefined =>
  allStages(tracks).find((stage) => stage.id === id);

const mapTracks = (
  tracks: Tracks,
  change: (stages: ResolvedStage[], track: string) => ResolvedStage[]
): Tracks =>
  Object.fromEntries(
    Object.entries(tracks).map(([track, stages]) => [
      track,
      change(stages, track),
    ])
  );

const mapSteps = (
  stages: ResolvedStage[],
  change: (step: ResolvedStep) => ResolvedStep
): ResolvedStage[] =>
  stages.map((stage) => ({ ...stage, steps: stage.steps.map(change) }));

const withoutStep = (stages: ResolvedStage[], id: string): ResolvedStage[] =>
  stages.map((stage) => ({
    ...stage,
    steps: stage.steps.filter((step) => step.id !== id),
  }));

/**
 * `step` placed after `after` in one track, or null when the track has no
 * such step or stage. After a step: right after it. After a phase stage: its
 * last step. After a checkpoint stage: the first step of the next stage. An id
 * that is both a step and a stage means the step.
 */
const insertAfter = (
  stages: ResolvedStage[],
  after: string,
  step: ResolvedStep
): ResolvedStage[] | null => {
  if (stepsOf(stages).some((candidate) => candidate.id === after)) {
    return stages.map((stage) => {
      const at = stage.steps.findIndex((candidate) => candidate.id === after);

      return at === -1
        ? stage
        : {
            ...stage,
            steps: [
              ...stage.steps.slice(0, at + 1),
              step,
              ...stage.steps.slice(at + 1),
            ],
          };
    });
  }

  const at = stages.findIndex((stage) => stage.id === after);
  const stage = stages[at];

  if (stage === undefined) {
    return null;
  }

  const target = stage.kind === 'checkpoint' ? at + 1 : at;
  const into = stages[target];

  if (into === undefined) {
    return null;
  }

  return stages.map((candidate, index) =>
    index !== target
      ? candidate
      : {
          ...candidate,
          steps:
            stage.kind === 'checkpoint'
              ? [step, ...candidate.steps]
              : [...candidate.steps, step],
        }
  );
};

/** Edit distance, for "Did you mean". */
const distance = (a: string, b: string): number => {
  const first = Array.from({ length: b.length + 1 }, (_, j) => j);
  const last = Array.from(a).reduce<number[]>(
    (previous, charA, i) =>
      Array.from(b).reduce<number[]>(
        (row, charB, j) => [
          ...row,
          Math.min(
            (row[j] ?? 0) + 1,
            (previous[j + 1] ?? 0) + 1,
            (previous[j] ?? 0) + (charA === charB ? 0 : 1)
          ),
        ],
        [i + 1]
      ),
    first
  );

  return last[b.length] ?? 0;
};

const suggestion = (tracks: Tracks, id: string): string => {
  const ids = Array.from(
    new Set([
      ...allSteps(tracks).map((step) => step.id),
      ...allStages(tracks).map((stage) => stage.id),
    ])
  );
  const [best] = ids
    .map((candidate) => ({ candidate, score: distance(id, candidate) }))
    .filter(({ score }) => score > 0 && score <= 2)
    .sort((a, b) => a.score - b.score);

  return best === undefined ? '' : ` Did you mean "${best.candidate}"?`;
};

const fail = (state: State, message: string): State => ({
  ...state,
  errors: [...state.errors, message],
});

const commandExists = (
  root: string,
  name: ProcessName,
  command: string
): boolean =>
  INSTRUCTION_NAME.test(command) &&
  instructionCandidates(root, name, command).some((file) =>
    fs.existsSync(file)
  );

type Add = NonNullable<WorkflowFile['add']>[number];

/** Every standard step id, including planning's steps on no track. */
const standardStepIds = (name: ProcessName): string[] =>
  name === 'planning' ? STEP_IDS : BUILDING_STEPS.map((step) => step.id);

const applyAdd = (
  root: string,
  name: ProcessName,
  label: string,
  state: State,
  add: Add
): State => {
  if (
    findAnyStep(state.tracks, add.id) !== undefined ||
    standardStepIds(name).includes(add.id)
  ) {
    return fail(
      state,
      `${label}: add "${add.id}" repeats the id of an existing step. Give it its own id.`
    );
  }

  if (findAnyStage(state.tracks, add.id) !== undefined) {
    return fail(
      state,
      `${label}: add "${add.id}" repeats the id of an existing stage. Give it its own id.`
    );
  }

  const command = commandOf(add.run);
  const checked = commandExists(root, name, command)
    ? state
    : fail(
        state,
        `${label}: add "${
          add.id
        }" runs /${command}, but ${command}.md isn't in any of: ${placesText(
          root,
          name,
          command
        )}.`
      );
  const step: ResolvedStep = {
    id: add.id,
    label: add.label,
    who: 'dev',
    tip: `Runs ${add.run}.`,
    doneWhen: `${add.label} is reported done.`,
    command,
    optional: add.switch === true,
    added: true,
    run: add.run,
    checkpoint: add.checkpoint,
  };
  const placed = Object.entries(checked.tracks).map(
    ([track, stages]): [string, ResolvedStage[] | null] => [
      track,
      insertAfter(stages, add.after, step),
    ]
  );

  if (placed.every(([, stages]) => stages === null)) {
    return fail(
      checked,
      `${label}: add "${add.id}" after "${
        add.after
      }" — no such step.${suggestion(checked.tracks, add.after)}`
    );
  }

  return {
    ...checked,
    tracks: Object.fromEntries(
      placed.map(([track, stages]) => [
        track,
        stages ?? checked.tracks[track] ?? [],
      ])
    ),
  };
};

const lockedStepIn = (stage: ResolvedStage): ResolvedStep | undefined =>
  stage.steps.find((step) => step.locked === true);

const applyDrop = (label: string, state: State, id: string): State => {
  const step = findAnyStep(state.tracks, id);

  if (step?.required === true) {
    return fail(state, `${label}: drop "${id}" refused — ${REQUIRED}`);
  }

  if (step !== undefined) {
    return step.locked === true
      ? fail(state, `${label}: drop "${id}" refused — ${QUALITY}`)
      : {
          ...state,
          tracks: mapTracks(state.tracks, (stages) => withoutStep(stages, id)),
        };
  }

  const stage = findAnyStage(state.tracks, id);

  if (stage === undefined) {
    return fail(
      state,
      `${label}: drop "${id}" — no such step.${suggestion(state.tracks, id)}`
    );
  }

  const locked = allStages(state.tracks)
    .filter((candidate) => candidate.id === id)
    .map(lockedStepIn)
    .find((candidate) => candidate !== undefined);

  if (stage.locked === true) {
    return fail(state, `${label}: drop "${id}" refused — ${QUALITY}`);
  }

  if (locked !== undefined) {
    return fail(
      state,
      `${label}: drop "${id}" refused — it holds "${locked.id}", and ${QUALITY}`
    );
  }

  return {
    ...state,
    tracks: mapTracks(state.tracks, (stages) =>
      stages.filter((candidate) => candidate.id !== id)
    ),
  };
};

/**
 * `move` and `off` take steps only. A stage id there is refused: a checkpoint
 * as a quality step, any other stage because only `drop` and `rename` take one.
 */
const notAStep = (
  label: string,
  state: State,
  verb: 'move' | 'off' | 'on',
  id: string
): State => {
  const stage = findAnyStage(state.tracks, id);

  if (stage === undefined) {
    return fail(
      state,
      `${label}: ${verb} "${id}" — no such step.${suggestion(state.tracks, id)}`
    );
  }

  return stage.locked === true
    ? fail(state, `${label}: ${verb} "${id}" refused — ${QUALITY}`)
    : fail(
        state,
        `${label}: ${verb} "${id}" — "${id}" is a stage, and only drop and rename take a stage.`
      );
};

/**
 * The checkpoint post a standard step moved across, if any, and which way: a
 * checkpoint is the owner's approval of the work before it, so moving that
 * work past the post would have the owner approve without it, and moving the
 * work after it ahead of the post would run it before the owner approves.
 */
const crossedPost = (
  before: ResolvedStage[],
  after: ResolvedStage[],
  id: string
): { cp: number; post: string; way: 'after' | 'before' } | undefined => {
  const was = stepsOf(before).map((candidate) => candidate.id);
  const now = stepsOf(after).map((candidate) => candidate.id);
  const side = (order: string[], post: string): 'after' | 'before' =>
    order.indexOf(id) > order.indexOf(post) ? 'after' : 'before';

  return Object.entries(CHECKPOINT_POSTS)
    .flatMap(([cp, posts]) => posts.map((post) => ({ cp: Number(cp), post })))
    .filter(({ post }) => was.includes(post))
    .map(({ cp, post }) => ({ cp, post, way: side(now, post) }))
    .find(({ post, way }) => side(was, post) !== way);
};

const applyMove = (
  label: string,
  state: State,
  move: { id: string; after: string }
): State => {
  const step = findAnyStep(state.tracks, move.id);

  if (step === undefined) {
    return notAStep(label, state, 'move', move.id);
  }

  if (step.locked === true) {
    return fail(state, `${label}: move "${move.id}" refused — ${QUALITY}`);
  }

  if (step.required === true) {
    return fail(state, `${label}: move "${move.id}" refused — ${REQUIRED}`);
  }

  if (move.after === move.id) {
    return fail(state, `${label}: move "${move.id}" after itself.`);
  }

  const placed = Object.entries(state.tracks).map(
    ([track, stages]): [string, ResolvedStage[] | null] => {
      const own = stepsOf(stages).find((candidate) => candidate.id === move.id);

      return [
        track,
        own === undefined
          ? null
          : insertAfter(withoutStep(stages, move.id), move.after, own),
      ];
    }
  );

  const crossed = placed
    .map(([track, stages]) =>
      stages === null || step.added === true
        ? undefined
        : crossedPost(state.tracks[track] ?? [], stages, move.id)
    )
    .find((found) => found !== undefined);

  if (crossed !== undefined) {
    return fail(
      state,
      `${label}: move "${move.id}" after "${
        move.after
      }" refused — it would run ${crossed.way} "${crossed.post}", and ${
        crossed.way === 'after'
          ? `checkpoint ${crossed.cp} is where the owner approves the work before it.`
          : `the work after checkpoint ${crossed.cp} waits for the owner to approve it.`
      }`
    );
  }

  if (placed.every(([, stages]) => stages === null)) {
    const exists =
      findAnyStep(state.tracks, move.after) !== undefined ||
      findAnyStage(state.tracks, move.after) !== undefined;

    return fail(
      state,
      exists
        ? `${label}: move "${move.id}" after "${move.after}" — no track has both.`
        : `${label}: move "${move.id}" after "${
            move.after
          }" — no such step.${suggestion(state.tracks, move.after)}`
    );
  }

  return {
    ...state,
    tracks: Object.fromEntries(
      placed.map(([track, stages]) => [
        track,
        stages ?? state.tracks[track] ?? [],
      ])
    ),
  };
};

const applyRename = (
  label: string,
  state: State,
  [id, newLabel]: [string, string]
): State => {
  if (findAnyStep(state.tracks, id) !== undefined) {
    return {
      ...state,
      tracks: mapTracks(state.tracks, (stages) =>
        mapSteps(stages, (step) =>
          step.id === id ? { ...step, label: newLabel, renamed: true } : step
        )
      ),
    };
  }

  if (findAnyStage(state.tracks, id) !== undefined) {
    return {
      ...state,
      tracks: mapTracks(state.tracks, (stages) =>
        stages.map((stage) =>
          stage.id === id ? { ...stage, label: newLabel, renamed: true } : stage
        )
      ),
    };
  }

  return fail(
    state,
    `${label}: rename "${id}" — no such step.${suggestion(state.tracks, id)}`
  );
};

/** A step that starts off, switched on by the project. */
const applyOn = (label: string, state: State, id: string): State => {
  const step = findAnyStep(state.tracks, id);

  if (step === undefined) {
    return notAStep(label, state, 'on', id);
  }

  if (step.offByDefault !== true) {
    return fail(
      state,
      `${label}: on "${id}" refused — only a step that starts off can be switched on; the others are on unless listed in off.`
    );
  }

  return {
    ...state,
    tracks: mapTracks(state.tracks, (stages) =>
      mapSteps(stages, (candidate) =>
        candidate.id === id ? { ...candidate, off: false } : candidate
      )
    ),
  };
};

const applyOff = (label: string, state: State, id: string): State => {
  const step = findAnyStep(state.tracks, id);

  if (step === undefined) {
    return notAStep(label, state, 'off', id);
  }

  if (step.locked === true) {
    return fail(state, `${label}: off "${id}" refused — ${QUALITY}`);
  }

  if (step.required === true) {
    return fail(state, `${label}: off "${id}" refused — ${REQUIRED}`);
  }

  if (step.optional !== true) {
    return fail(
      state,
      `${label}: off "${id}" refused — it isn't an optional step, so it can't be switched off.`
    );
  }

  return {
    ...state,
    tracks: mapTracks(state.tracks, (stages) =>
      mapSteps(stages, (candidate) =>
        candidate.id === id ? { ...candidate, off: true } : candidate
      )
    ),
  };
};

/** An added step with `checkpoint: n` must come before that checkpoint's post. */
const checkCheckpoints = (label: string, state: State): State =>
  Object.entries(state.tracks).reduce((current, [track, stages]) => {
    const order = stepsOf(stages).map((step) => step.id);

    return stepsOf(stages)
      .filter((step) => step.added === true && step.checkpoint !== undefined)
      .reduce((inner, step) => {
        const cp = step.checkpoint ?? 0;
        const hasCheckpoint = stages.some(
          (stage) => stage.kind === 'checkpoint' && stage.checkpoint === cp
        );
        const post = (CHECKPOINT_POSTS[cp] ?? []).find((id) =>
          order.includes(id)
        );

        if (!hasCheckpoint || post === undefined) {
          return fail(
            inner,
            `${label}: add "${step.id}" checkpoint ${cp} — the ${track} track has no checkpoint ${cp}.`
          );
        }

        return order.indexOf(step.id) > order.indexOf(post)
          ? fail(
              inner,
              `${label}: add "${step.id}" checkpoint ${cp} — it comes after "${post}", so it can't be done before checkpoint ${cp} is posted.`
            )
          : inner;
      }, current);
  }, state);

/**
 * A required step keeps the step after it: a step an add or a move put
 * between them is refused, by its id.
 */
const checkRequired = (
  label: string,
  name: ProcessName,
  state: State
): State => {
  const nextIn = (stages: ResolvedStage[], id: string): string | undefined => {
    const order = stepsOf(stages).map((step) => step.id);
    const at = order.indexOf(id);

    return at === -1 ? undefined : order[at + 1];
  };

  return Object.entries(state.tracks).reduce((current, [track, stages]) => {
    const standard = standardProcess(name).tracks[track] ?? [];

    return stepsOf(stages)
      .filter((step) => step.required === true)
      .reduce((inner, step) => {
        const expected = nextIn(standard, step.id);
        const actual = nextIn(stages, step.id);

        return expected === undefined || actual === expected
          ? inner
          : fail(
              inner,
              `${label}: "${actual ?? ''}" can't run between "${
                step.id
              }" and "${expected}" — "${
                step.id
              }" is one of Lambda's required steps and runs right before "${expected}".`
            );
      }, current);
  }, state);
};

/**
 * `.lambda/<process>/<step id>.md`, else `.lambda/<process>/<command>.md`,
 * else the project's `.claude/commands/<command>.md` (as `resolveInstructions`
 * looks), replaces a standard step's instructions — never a quality step's.
 */
const applyReplacements = (
  root: string,
  name: ProcessName,
  state: State
): State => {
  const exists = (relative: string): boolean =>
    fs.existsSync(fileIn(root, relative));
  const lambdaReplacementOf = (step: ResolvedStep): string | undefined =>
    [step.id, step.command]
      .filter((candidate): candidate is string => candidate !== undefined)
      .map((candidate) => `.lambda/${name}/${candidate}.md`)
      .find(exists);
  const replacementOf = (step: ResolvedStep): string | undefined =>
    lambdaReplacementOf(step) ??
    [step.command]
      .filter((candidate): candidate is string => candidate !== undefined)
      .map((candidate) => `.claude/commands/${candidate}.md`)
      .find(exists);
  // A same-named `.claude/commands/` file is passed over for a quality step,
  // never refused: it stays an ordinary slash command of the project's.
  const refused = Array.from(
    new Set(
      allSteps(state.tracks)
        .filter((step) => step.added !== true && step.locked === true)
        .flatMap((step) => {
          const relative = lambdaReplacementOf(step);

          return relative === undefined
            ? []
            : [`${relative} replaces "${step.id}" refused — ${QUALITY}`];
        })
    )
  );

  return {
    errors: [...state.errors, ...refused],
    tracks: mapTracks(state.tracks, (stages) =>
      mapSteps(stages, (step) => {
        const relative =
          step.added === true || step.locked === true
            ? undefined
            : replacementOf(step);

        return relative === undefined
          ? step
          : { ...step, replacedBy: relative };
      })
    ),
  };
};

/**
 * A `.lambda/<process>/<name>.md` that no step, command or Lambda
 * instruction is named after would replace nothing, silently. An added step's
 * command counts even when the step itself was refused, so the refusal isn't
 * buried under a second one.
 */
const checkOverrideFiles = (
  root: string,
  name: ProcessName,
  file: WorkflowFile | null,
  state: State
): State => {
  const dir = path.join(root, '.lambda', name);

  if (!fs.existsSync(dir)) {
    return state;
  }

  const known = new Set([
    ...standardStepIds(name),
    ...allSteps(state.tracks).flatMap((step) =>
      step.command === undefined ? [step.id] : [step.id, step.command]
    ),
    ...(file?.add ?? []).map((add) => commandOf(add.run)),
    ...ownInstructionNames(name),
    ...podConversationCommands(name),
  ]);
  const roles = roleInstructionNames(name);
  const files = fs.readdirSync(dir).sort();
  const overrides = files
    .filter((file) => file.endsWith('.md') && !file.endsWith(ADDENDUM_EXT))
    .map((file) => file.slice(0, -'.md'.length));
  const addenda = files
    .filter((file) => file.endsWith(ADDENDUM_EXT))
    .map((file) => file.slice(0, -ADDENDUM_EXT.length));
  const withAddenda = addenda
    .filter((instructions) => !known.has(instructions))
    .reduce(
      (current, instructions) =>
        fail(
          current,
          `.lambda/${name}/${instructions}${ADDENDUM_EXT} adds to nothing — no step, command or Lambda instruction is named "${instructions}".`
        ),
      state
    );
  const withRoles = overrides
    .filter((instructions) => roles.includes(instructions))
    .reduce(
      (current, instructions) =>
        fail(
          current,
          `.lambda/${name}/${instructions}.md replaces Lambda's "${instructions}" instructions refused — ${ROLE} Add to them with .lambda/${name}/${instructions}${ADDENDUM_EXT} instead.`
        ),
      withAddenda
    );

  return overrides
    .filter((instructions) => !known.has(instructions))
    .reduce(
      (current, instructions) =>
        fail(
          current,
          `.lambda/${name}/${instructions}.md replaces nothing — no step, command or Lambda instruction is named "${instructions}".`
        ),
      withRoles
    );
};

/** Resolve a workflow file (or none) against the standard process. */
export const resolveWorkflow = (
  root: string,
  name: ProcessName,
  file: WorkflowFile | null
): ResolvedProcess => {
  const label = workflowFileName(name);

  if (file !== null && file.extends !== 'standard') {
    throw new Error(
      `${label}: extends "${file.extends}" — only "standard" can be extended.`
    );
  }

  const start: State = { tracks: standardProcess(name).tracks, errors: [] };
  const patched =
    file === null
      ? start
      : [
          (state: State) =>
            (file.add ?? []).reduce(
              (current, add) => applyAdd(root, name, label, current, add),
              state
            ),
          (state: State) =>
            (file.drop ?? []).reduce(
              (current, id) => applyDrop(label, current, id),
              state
            ),
          (state: State) =>
            (file.move ?? []).reduce(
              (current, move) => applyMove(label, current, move),
              state
            ),
          (state: State) =>
            Object.entries(file.rename ?? {}).reduce(
              (current, entry) => applyRename(label, current, entry),
              state
            ),
          (state: State) =>
            (file.off ?? []).reduce(
              (current, id) => applyOff(label, current, id),
              state
            ),
          (state: State) =>
            (file.on ?? []).reduce(
              (current, id) => applyOn(label, current, id),
              state
            ),
          (state: State) => checkCheckpoints(label, state),
          (state: State) => checkRequired(label, name, state),
        ].reduce((state, apply) => apply(state), start);
  const resolved = checkOverrideFiles(
    root,
    name,
    file,
    applyReplacements(root, name, patched)
  );
  const errors = Array.from(new Set(resolved.errors));

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return { name, tracks: resolved.tracks };
};

/** The project's process: the standard one, patched by its workflow.json. */
export const loadProcess = (root: string, name: ProcessName): ResolvedProcess =>
  resolveWorkflow(root, name, readWorkflowFile(root, name));

/**
 * The file holding one step's instructions in this project:
 * `.lambda/<process>/<step id>.md`, then its command's lookup
 * (`resolveInstructions`). A quality step's are always Lambda's own.
 */
export const resolveStepInstructions = (
  projectRoot: string,
  name: ProcessName,
  stepId: string
): string => {
  const step = findAnyStep(loadProcess(projectRoot, name).tracks, stepId);

  if (step === undefined) {
    throw new Error(`"${stepId}" isn't a ${name} step.`);
  }

  const own = path.join(projectRoot, '.lambda', name, `${step.id}.md`);

  if (step.locked !== true && fs.existsSync(own)) {
    return own;
  }

  if (step.command === undefined) {
    throw new Error(
      `"${step.id}" runs no command, so it has no instructions of its own.`
    );
  }

  return resolveInstructions(projectRoot, name, step.command);
};

// ── showing it ──────────────────────────────────────────────────────────────

const MARK_COLUMN = 28;

const stepMarks = (
  step: ResolvedStep,
  own: { commands: string[]; title: string }
): string[] =>
  [
    step.added === true ? 'added' : undefined,
    step.renamed === true ? `renamed "${step.label}"` : undefined,
    step.replacedBy === undefined ? undefined : `replaced (${step.replacedBy})`,
    step.optional === true
      ? step.off === true
        ? 'optional · off'
        : 'optional'
      : step.off === true
      ? 'off'
      : undefined,
    step.locked === true ? 'locked' : undefined,
    step.required === true ? 'required' : undefined,
    // lambda.json `building.ownCommands`: the step stays, its text is the project's.
    step.command !== undefined && own.commands.includes(step.command)
      ? `${own.title}'s own instructions`
      : undefined,
  ].filter((mark): mark is string => mark !== undefined);

const withMarks = (left: string, marks: string[]): string =>
  marks.length === 0
    ? left
    : `${left.padEnd(MARK_COLUMN - 1)} ${marks.join(' · ')}`;

/**
 * The resolved process in order, grouped by stage, each step numbered and
 * marked: added, renamed, replaced, optional (· off), locked, required and
 * run with the project's own instructions (`ownCommands`).
 */
export const formatProcess = (
  process: ResolvedProcess,
  options: {
    title: string;
    track?: string;
    pod?: { tickets: string[]; epic?: string };
    /** lambda.json `building.ownCommands`. */
    ownCommands?: string[];
  }
): string => {
  const track =
    options.track ?? (process.name === 'planning' ? 'idea' : BUILDING_TRACK);
  const stages = process.tracks[track];

  if (stages === undefined) {
    throw new Error(
      `"${track}" isn't a track. Use one of: ${Object.keys(process.tracks).join(
        ', '
      )}.`
    );
  }

  const header =
    process.name === 'planning'
      ? `${options.title} · planning · track: ${track}`
      : `${options.title} · building`;
  const { lines } = stages.reduce<{ lines: string[]; count: number }>(
    (acc, stage) => {
      const stageLine = withMarks(` ${stage.id}`, [
        ...(stage.renamed === true ? [`renamed "${stage.label}"`] : []),
        ...(stage.locked === true ? ['locked'] : []),
      ]);
      const stepLines = stage.steps.flatMap((step, index) => {
        const number = String(acc.count + index + 1).padStart(3);
        const line = withMarks(
          `${number}  ${step.id}`,
          stepMarks(step, {
            commands: options.ownCommands ?? [],
            title: options.title,
          })
        );

        return step.run === undefined
          ? [line]
          : [
              line,
              `     run: ${
                options.pod === undefined
                  ? step.run
                  : fillRun(step.run, options.pod)
              }`,
            ];
      });

      return {
        lines: [...acc.lines, stageLine, ...stepLines],
        count: acc.count + stage.steps.length,
      };
    },
    { lines: [], count: 0 }
  );

  return [header, ...lines].join('\n');
};

/** Every step and stage id, for `lambda planning steps` / `building steps`. */
export const formatIds = (process: ResolvedProcess): string => {
  const tracksOf = (has: (stages: ResolvedStage[]) => boolean): string =>
    process.name === 'planning'
      ? ` (${Object.entries(process.tracks)
          .filter(([, stages]) => has(stages))
          .map(([track]) => track)
          .join(', ')})`
      : '';
  const steps = Array.from(
    new Map(
      allSteps(process.tracks).map((step) => [step.id, step] as const)
    ).values()
  );
  const unplaced =
    process.name === 'planning'
      ? STEP_IDS.filter((id) => !steps.some((step) => step.id === id))
      : [];
  const stages = Array.from(
    new Map(
      allStages(process.tracks).map((stage) => [stage.id, stage] as const)
    ).values()
  );

  return [
    'Steps',
    ...steps.map(
      (step) =>
        `  ${step.id.padEnd(22)} ${step.label}${tracksOf((track) =>
          stepsOf(track).some((candidate) => candidate.id === step.id)
        )}`
    ),
    ...unplaced.map((id) => `  ${id.padEnd(22)} (on no track)`),
    '',
    'Stages',
    ...stages.map(
      (stage) =>
        `  ${stage.id.padEnd(22)} ${stage.label}${tracksOf((track) =>
          track.some((candidate) => candidate.id === stage.id)
        )}`
    ),
  ].join('\n');
};
