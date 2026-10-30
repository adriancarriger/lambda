import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { readConfigFile } from './readConfigFile';

export const PROJECT_CONFIG_FILE = 'lambda.json';

/** What `lambda init` writes into `.lambda/`, relative to the project. */
export const LAMBDA_GITIGNORE = path.join('.lambda', '.gitignore');

/**
 * The project session's shell: what `lambda tmux scratchPad …` and
 * `lambda agent compact` drive, and the one project window the Agents panel
 * lets you type into.
 */
export const SCRATCH_WINDOW = 'scratchPad';

/** The open-source layout: a project with no lambda.json but a TASKS.md. */
export const TASKS_FILE = 'TASKS.md';

export const DEFAULT_TMUX_SESSION = 'lambda';
export const DEFAULT_AGENT_WINDOWS = ['manager', 'dev', 'qa'];
export const DEFAULT_VERDICTS_DIR = '.lambda/verdicts';
export const DEFAULT_DESIGN_SYSTEM_DIR = '.lambda/design-system';
/** The tracked scenario library: one `<id>.scenario.<ext>` per situation. */
export const DEFAULT_SCENARIOS_DIR = '.lambda/scenarios';
export const DEFAULT_SCENARIO_EXT = 'json';
/** Scenarios a ticket brought, one folder per ticket; never committed. */
export const DEFAULT_PENDING_DIR = '.lambda/scenarios-pending';

/**
 * Locked building commands whose result the ship gate reads from a recorded
 * verdict: the only ones `building.ownCommands` may name.
 */
export const VERDICT_GATED_COMMANDS: readonly string[] = ['check-ticket'];

/** A path relative to the project that stays inside it. */
const insideProject = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !path.normalize(value).split(path.sep).includes('..'),
    { message: 'must be a path inside the codebase' }
  );

/**
 * The same, stored as git names it (`./ds/` is `ds`), since it is compared
 * with git's paths. The project itself is refused.
 */
const plainProjectPath = insideProject
  .transform((value) => path.posix.normalize(value).replace(/\/+$/, ''))
  .refine((value) => value !== '.', {
    message: 'must be a path inside the codebase',
  });

export const TICKET_SOURCES = ['markdown', 'linear', 'jira'] as const;

/**
 * Lambda's ticket states, whatever a project calls them. `inbox` is where a
 * new ticket lands until a planning pod picks it up; a tracker that names no
 * Inbox reads and writes it as `planning`.
 */
export const TICKET_STATES = [
  'inbox',
  'planning',
  'ready',
  'building',
  'blocked',
  'done',
  'canceled',
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

/**
 * The tracker's name for a state: its own, or for an Inbox the project
 * hasn't named, Planning's (so a new ticket still lands somewhere real).
 */
export const statusNameOf = (
  statuses: Partial<Record<TicketState, string>>,
  state: TicketState
): string | undefined =>
  statuses[state] ?? (state === 'inbox' ? statuses.planning : undefined);

/** A field that would hold a credential: never allowed in lambda.json. */
const CREDENTIAL_FIELD = /key|token|secret|password/i;

const credentialHome = (source: unknown): string =>
  source === 'jira'
    ? 'LAMBDA_JIRA_EMAIL + LAMBDA_JIRA_TOKEN'
    : source === 'linear'
    ? 'LAMBDA_LINEAR_KEY'
    : 'LAMBDA_LINEAR_KEY, or LAMBDA_JIRA_EMAIL + LAMBDA_JIRA_TOKEN';

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const statusName = z.string().min(1).optional();

const TicketsFields = z.object({
  source: z.enum(TICKET_SOURCES, {
    errorMap: (_issue, ctx) => ({
      message: `${JSON.stringify(ctx.data)} isn't one of ${TICKET_SOURCES.join(
        ', '
      )}.`,
    }),
  }),
  /**
   * Lambda's state → the tracker's status name (linear and jira: all but
   * `inbox`, which falls back to `planning`'s).
   */
  statuses: z
    .object({
      inbox: statusName,
      planning: statusName,
      ready: statusName,
      building: statusName,
      blocked: statusName,
      done: statusName,
      canceled: statusName,
    } satisfies Record<TicketState, z.ZodTypeAny>)
    .strict()
    .optional(),
  /** Lambda's label key → the tracker's label name. */
  labels: z.record(z.string()).optional(),
  /**
   * linear and jira: the tracker label that makes a ticket Lambda's. Only
   * tickets with it (or under an epic with it) are read; every ticket Lambda
   * makes gets it; Lambda never shows it. Left out: every ticket is Lambda's.
   */
  lambdaLabel: z.string().trim().min(1).optional(),
  /**
   * linear and jira: a computer's name → the tracker's user it's assigned
   * as (an email or a name; jira: an email or an account id). Only these
   * users read as a computer: an issue assigned to anyone else reads as
   * unassigned.
   */
  assignees: z.record(z.string().min(1)).optional(),
  /**
   * Read the tracker, never write it: a mirror of another Lambda's tickets
   * (a rehearsal, a second computer's view). Every change is refused, and
   * nothing is claimed or built.
   */
  readOnly: z.boolean().optional(),
  /** The ticket-id prefix, e.g. `PAWNEE`. */
  prefix: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, 'must be letters, digits or _')
    .optional(),
  /** markdown: the queue file (default TASKS.md). */
  queue: insideProject.optional(),
  /** markdown: the ticket files' folder (default tickets/). */
  dir: insideProject.optional(),
  /** linear: the team key. */
  team: z.string().min(1).optional(),
  /** jira: the site, an https:// URL. */
  site: z
    .string()
    .refine(isHttpsUrl, { message: 'must be an https:// URL' })
    .optional(),
  /** jira: the project key. */
  project: z.string().min(1).optional(),
});

const AnyRecord = z.record(z.unknown());

/**
 * Maps whose keys a project names itself (`labels: { hotkey: … }`): their
 * keys are names, not fields, so they are never read as credentials. The
 * values are still strings the schema checks.
 */
const NAMED_KEYS = ['labels', 'assignees'];

/** Every key path under `value` whose key looks like a credential. */
const credentialPaths = (value: unknown, at: string[] = []): string[][] => {
  const record = AnyRecord.safeParse(value);

  if (!record.success || Array.isArray(value)) {
    return [];
  }

  return Object.entries(record.data).flatMap(([key, inner]) => {
    if (CREDENTIAL_FIELD.test(key)) {
      return [[...at, key]];
    }

    if (at.length === 0 && NAMED_KEYS.includes(key)) {
      return [];
    }

    return credentialPaths(inner, [...at, key]);
  });
};

const credentialMessage = (source: unknown): string =>
  `— keys never go in lambda.json. Put it in ~/.lambda/config.json or ${credentialHome(
    source
  )}.`;

/**
 * Two of Lambda's states under one tracker name: reading it back can only
 * give the first, so the second would never be seen. Names compare as Jira
 * does, ignoring case and outer spaces.
 */
const sharedStatusNames = (
  raw: Record<string, unknown>
): Array<[TicketState, TicketState, string]> => {
  const statuses = AnyRecord.safeParse(raw.statuses);
  const mapped = statuses.success ? statuses.data : {};
  const named = TICKET_STATES.flatMap((state) => {
    const name = mapped[state];

    return typeof name === 'string' ? [{ state, name }] : [];
  });
  const same = (a: string, b: string): boolean =>
    a.trim().toLowerCase() === b.trim().toLowerCase();

  return named.flatMap((second, index) => {
    const first = named
      .slice(0, index)
      .find((earlier) => same(earlier.name, second.name));

    return first === undefined ? [] : [[first.state, second.state, first.name]];
  });
};

/** For linear and jira: every state Lambda has but the map leaves out. */
const unmappedStates = (raw: Record<string, unknown>): TicketState[] => {
  if (raw.source !== 'linear' && raw.source !== 'jira') {
    return [];
  }

  const statuses = AnyRecord.safeParse(raw.statuses);
  const mapped = statuses.success ? statuses.data : {};

  return TICKET_STATES.filter(
    (state) => state !== 'inbox' && typeof mapped[state] !== 'string'
  );
};

/**
 * The `tickets` block. Unknown keys are dropped like the rest of lambda.json,
 * except one that looks like a credential: that is refused, naming it. Every
 * problem is reported at once, so a project owner fixes the file in one go.
 */
const TicketsSchema = AnyRecord.superRefine((raw, ctx) => {
  credentialPaths(raw).forEach((keyPath) =>
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: keyPath,
      message: credentialMessage(raw.source),
    })
  );

  const fields = TicketsFields.safeParse(raw);

  if (!fields.success) {
    fields.error.issues.forEach((issue) => ctx.addIssue(issue));
  }

  unmappedStates(raw).forEach((state) =>
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['statuses', state],
      message: `has no name for "${state}".`,
    })
  );

  sharedStatusNames(raw).forEach(([first, second, name]) =>
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['statuses', first],
      message: `and tickets.statuses.${second} are both ${JSON.stringify(
        name
      )}.`,
    })
  );
}).transform((raw, ctx) => {
  // Reached only when the checks above found nothing.
  const fields = TicketsFields.safeParse(raw);

  if (!fields.success) {
    fields.error.issues.forEach((issue) => ctx.addIssue(issue));

    return z.NEVER;
  }

  return fields.data;
});

export type TicketsConfig = z.infer<typeof TicketsFields>;

const CommandsSchema = z.object({
  /** Replaces the built-in `lambda e2e`; `{spec}` takes the quoted args. */
  e2e: z.string().optional(),
  /** Runs as `lambda test`; `{spec}` takes the quoted args. */
  test: z.string().optional(),
  /** Run by `lambda ship` after its verdict gate. Never replaces it. */
  ship: z.string().optional(),
  /**
   * Run by a building pod's pick-up once it has claimed a ticket, before
   * anything is built (`{spec}`: the ticket id): sets the checkout up so the
   * project's `ship` can ship it. A failure puts the ticket back and pauses
   * the pod (building/breaker.ts).
   */
  pickUp: z.string().optional(),
  /** Run by `lambda stop`. Data, not an overridable command. */
  stop: z.string().optional(),
  /**
   * The photo hook (`lambda shot`): writes a PNG of the app in one scenario.
   * `{scenario}`, `{id}`, `{viewport}` and `{out}` take shell-quoted values.
   */
  shot: z.string().optional(),
  /** The project's long-running services, by name. Data, not commands. */
  services: z.record(z.string()).optional(),
});

const isRegExp = (source: string, flags: string): boolean => {
  try {
    return new RegExp(source, flags) instanceof RegExp;
  } catch {
    return false;
  }
};

/**
 * One of the project's own `lambda trace diagnose` patterns. Each piece of
 * text gets the first pattern that matches it, so `before` names the built-in
 * category this one is checked ahead of; without it, it comes after them all.
 */
const TracePatternSchema = z
  .object({
    pattern: z.string().min(1),
    flags: z
      .string()
      .regex(/^[imsu]*$/, 'must be some of i, m, s and u')
      .default(''),
    category: z.string().min(1),
    explanation: z.string().min(1),
    solution: z.string().min(1),
    before: z.string().min(1).optional(),
  })
  .refine((entry) => isRegExp(entry.pattern, entry.flags), {
    message: 'pattern must be a valid regular expression',
    path: ['pattern'],
  });

export type TracePatternConfig = z.infer<typeof TracePatternSchema>;

export const DESIGN_SYSTEM_MANIFEST = 'design-system.json';

const DesignSystemSchema = z
  .object({
    dir: plainProjectPath.default(DEFAULT_DESIGN_SYSTEM_DIR),
    /** Defaults to `<dir>/design-system.json`. */
    manifest: plainProjectPath.optional(),
    /** For a project that builds its own: a command containing `{out}`. */
    build: z
      .string()
      .refine((value) => value.includes('{out}'), {
        message: 'must contain {out}',
      })
      .optional(),
  })
  .transform((system) => ({
    ...system,
    manifest:
      system.manifest ?? path.posix.join(system.dir, DESIGN_SYSTEM_MANIFEST),
  }));

/**
 * `lambda.json`, one per project. Unknown keys are dropped rather than
 * refused, so an older lambda can read a file written for a newer one.
 */
export const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  /**
   * Who uses the product, for planning's plain-words checks: a decision's
   * "means" is what this person will see ("a resident"). Optional.
   */
  audience: z.string().min(1).optional(),
  /** The project's own CLI: a command on PATH, or a path from the project. */
  cli: z.string().min(1).optional(),
  tickets: TicketsSchema.default({ source: 'markdown' }),
  commands: CommandsSchema.optional(),
  app: z
    .object({
      start: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  tmux: z
    .object({
      session: z.string().min(1).default(DEFAULT_TMUX_SESSION),
      agentWindows: z.array(z.string().min(1)).default(DEFAULT_AGENT_WINDOWS),
    })
    .default({}),
  pods: z
    .object({
      root: z.string().min(1).optional(),
      // Tighten only: each rule is denied in every pod agent's settings and
      // taken out of its allow list, so a project can narrow what pods may
      // run (its own CLI's ship or deploy) but never widen it.
      deny: z.array(z.string().min(1)).optional(),
      // The same, for a planning pod's read-only forks only.
      forkDeny: z.array(z.string().min(1)).optional(),
      // Typed to a planning pod's manager and dev before their instructions,
      // on every start, e.g. a slash command the project's own setup needs.
      firstMessage: z.string().min(1).optional(),
    })
    .optional(),
  building: z
    .object({
      // Lambda's locked building commands the project runs its own copy of
      // (`.claude/commands/<name>.md`), e.g. a check-ticket with extra audits.
      // Its ship gate still reads the verdict that copy records, so only a
      // command gated by a recorded verdict may be the project's own.
      ownCommands: z
        .array(
          z.string().refine((name) => VERDICT_GATED_COMMANDS.includes(name), {
            message: `must be one of: ${VERDICT_GATED_COMMANDS.join(', ')}`,
          })
        )
        .optional(),
    })
    .optional(),
  knowledge: z
    .object({
      local: z.string().min(1).optional(),
      shared: z.string().min(1).optional(),
    })
    .optional(),
  verdicts: z
    .object({ dir: insideProject.default(DEFAULT_VERDICTS_DIR) })
    .default({}),
  design: z
    .object({
      scenarios: insideProject.default(DEFAULT_SCENARIOS_DIR),
      scenarioExt: z
        .string()
        .regex(/^[a-z0-9]+$/, 'must be lower-case letters and digits, no dot')
        .default(DEFAULT_SCENARIO_EXT),
      pendingDir: insideProject.default(DEFAULT_PENDING_DIR),
      system: DesignSystemSchema.default({}),
      /**
       * What the design system's build reads, by relative glob: `theme` and
       * `components` replace what detection finds, `exclude` keeps matching
       * files out of the bundle.
       */
      systemBuild: z
        .object({
          theme: z.array(insideProject).optional(),
          components: z.array(insideProject).optional(),
          exclude: z.array(insideProject).optional(),
        })
        .optional(),
    })
    // The pending folder gets a `.gitignore` of `*`: it must not be the
    // project, nor hold or sit inside the scenarios that ship.
    .superRefine((design, ctx) => {
      const pending = path.normalize(design.pendingDir);
      const toScenarios = path.relative(pending, design.scenarios);
      const fromScenarios = path.relative(design.scenarios, pending);
      const holds = (relative: string): boolean =>
        relative === '' || !relative.startsWith('..');

      if (pending === '.' || pending === `.${path.sep}`) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pendingDir'],
          message:
            'must be a folder inside the codebase, not the codebase itself',
        });

        return;
      }

      if (holds(toScenarios) || holds(fromScenarios)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pendingDir'],
          message: `must not hold, or sit inside, design.scenarios (${design.scenarios})`,
        });
      }
    })
    .default({}),
  trace: z
    .object({
      /** False: only the project's own patterns, in the order given. */
      builtIn: z.boolean().default(true),
      patterns: z.array(TracePatternSchema).default([]),
    })
    .optional(),
  /** Agent instruction files, e.g. CLAUDE.md. */
  instructions: z.array(z.string()).optional(),
  /** Never here: ~/.lambda/config.json's `tokens`, copied by mistake. */
  tokens: z
    .unknown()
    .refine((value) => value === undefined, {
      message: credentialMessage(undefined),
    })
    .optional()
    .transform(() => undefined),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface Project {
  /** The folder holding lambda.json (or TASKS.md, for the open-source layout). */
  root: string;
  /** The lambda.json read, when there is one. */
  file: string | undefined;
  config: ProjectConfig;
}

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

const ancestors = (start: string): string[] => {
  const parent = path.dirname(start);

  return parent === start ? [start] : [start, ...ancestors(parent)];
};

const git = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
};

const realpath = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

/**
 * Inside a linked git worktree, the folder to search from is the same folder
 * in the main checkout: a pod worktree is deleted when the pod is done, so
 * anything read or written there would vanish.
 */
export const mainCheckoutFolder = (cwd: string): string => {
  const output = git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
    '--git-dir',
    '--show-toplevel',
  ]);

  if (output === undefined) {
    return cwd;
  }

  const [commonDir, gitDir, topLevel] = output.split('\n');

  if (
    commonDir === undefined ||
    gitDir === undefined ||
    topLevel === undefined ||
    realpath(commonDir) === realpath(gitDir)
  ) {
    return cwd;
  }

  const below = path.relative(realpath(topLevel), realpath(cwd));

  return path.join(path.dirname(realpath(commonDir)), below);
};

/**
 * The nearest folder going up that holds lambda.json. Only when none does,
 * the nearest one with a TASKS.md. Neither: no project.
 */
export const findProjectRoot = (
  cwd: string = process.cwd()
): { root: string; file: string | undefined } | null => {
  const folders = ancestors(path.resolve(mainCheckoutFolder(cwd)));
  const withConfig = folders.find((folder) =>
    isFile(path.join(folder, PROJECT_CONFIG_FILE))
  );

  if (withConfig !== undefined) {
    return {
      root: withConfig,
      file: path.join(withConfig, PROJECT_CONFIG_FILE),
    };
  }

  const withTasks = folders.find((folder) =>
    isFile(path.join(folder, TASKS_FILE))
  );

  return withTasks === undefined ? null : { root: withTasks, file: undefined };
};

/**
 * The project the current folder belongs to, with its settings validated and
 * defaults filled in. `null` when there is no project. Throws
 * `<path>: <field> <problem>` (one line per problem) on a bad lambda.json.
 */
export const loadProjectConfig = (
  cwd: string = process.cwd()
): Project | null => {
  const found = findProjectRoot(cwd);

  if (found === null) {
    return null;
  }

  return {
    ...found,
    config:
      found.file === undefined
        ? ProjectConfigSchema.parse({})
        : readConfigFile(found.file, ProjectConfigSchema),
  };
};

type Env = Record<string, string | undefined>;

/** `LAMBDA_PODS_ROOT`, else lambda.json `pods.root`, else `.lambda/pods`. */
export const resolvePodsRoot = (
  project: Project,
  env: Env = process.env
): string => {
  const fromEnv = env.LAMBDA_PODS_ROOT;

  if (fromEnv !== undefined && fromEnv !== '') {
    return path.resolve(fromEnv);
  }

  const configured = project.config.pods?.root;

  return configured === undefined
    ? path.join(project.root, '.lambda', 'pods')
    : path.resolve(project.root, configured);
};

/**
 * The knowledge store's two folders: this machine's (under the pods root) and
 * the checked-in one shared by every machine. `lambda knowledge` and the
 * pods' checkpoints read them through here (pod/knowledge.ts).
 */
export const resolveKnowledgeDirs = (
  project: Project,
  env: Env = process.env
): { local: string; shared: string } => {
  const { local, shared } = project.config.knowledge ?? {};

  return {
    local:
      local === undefined
        ? path.join(resolvePodsRoot(project, env), '_knowledge')
        : path.resolve(project.root, local),
    shared:
      shared === undefined
        ? path.join(project.root, '.lambda', 'knowledge')
        : path.resolve(project.root, shared),
  };
};
