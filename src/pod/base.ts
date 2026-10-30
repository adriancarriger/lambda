import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { type Pod } from '../pod-store';
import { fillInstructions } from '../process/instructions';
import {
  isLockedInstruction,
  lambdaPackageDir,
  loadProcess,
  resolveInstructions,
  withAddendum,
} from '../process/workflow-file';
import { podsRoot } from './context';

/**
 * Where pod worktrees come from, set in `<pods root>/_base.json`:
 *
 *   { "ref": "pod-base", "planner": "/…/planner-checkout" }
 *
 * - `ref`: the commit pods check out. Without it, the project's default
 *   branch, fetched fresh (`origin/<default>`), or the main checkout's HEAD
 *   when there is no `origin`. A local branch works: worktrees share the
 *   repo's refs.
 * - `planner`: a checkout whose WORKING TREE is "the project" for the pod's
 *   instructions, so an edit there reaches pods without a commit.
 */
export interface PodBase {
  ref?: string;
  planner?: string;
}

const BaseFileSchema = z.object({
  ref: z.string().optional().catch(undefined),
  planner: z.string().optional().catch(undefined),
});

export const podBase = (root: string = podsRoot()): PodBase => {
  const file = path.join(root, '_base.json');

  if (!fs.existsSync(file)) {
    return {};
  }

  const { ref, planner } = BaseFileSchema.parse(
    JSON.parse(fs.readFileSync(file, 'utf8'))
  );

  return {
    ...(ref === undefined ? {} : { ref }),
    ...(planner === undefined ? {} : { planner }),
  };
};

/** "The project" the pod's instructions are read from: the planner, else its folder. */
export const instructionsProject = (
  pod: Pod,
  root: string = podsRoot()
): string => podBase(root).planner ?? pod.devCwd;

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const gitOk = (cwd: string, args: string[]): string | undefined => {
  try {
    return git(cwd, args).trim();
  } catch {
    return undefined;
  }
};

/** Is this folder inside a git checkout? */
export const isGitRepo = (cwd: string): boolean =>
  gitOk(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';

/**
 * What git said went wrong: its last `fatal:` line (the advice git prints
 * after it, "…and the repository exists.", says nothing), else its last
 * line. Without a closing full stop, as the caller adds its own.
 */
const lastStderrLine = (error: unknown): string => {
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr)
      : '';
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const line =
    lines.filter((candidate) => candidate.startsWith('fatal:')).at(-1) ??
    lines.at(-1) ??
    (error instanceof Error ? error.message : String(error));

  return line.replace(/\.+$/, '');
};

/**
 * The commit a pod's worktree is made at (and moved to by `sync`), brought
 * up to date first. `repo` is the main checkout. Throws, before anything is
 * created, when origin's default branch can't be told or can't be fetched.
 */
export const refreshBase = (
  repo: string,
  base: PodBase,
  root: string = podsRoot()
): string => {
  if (base.ref !== undefined) {
    return base.ref;
  }

  const remotes = (gitOk(repo, ['remote']) ?? '').split('\n');

  if (!remotes.includes('origin')) {
    const commit = gitOk(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']);

    if (commit === undefined) {
      throw new Error(
        'this codebase has no commits yet. Make a first commit, then try again. Nothing was created.'
      );
    }

    return commit.trim();
  }

  const head = gitOk(repo, [
    'symbolic-ref',
    '--quiet',
    'refs/remotes/origin/HEAD',
  ]);

  if (head === undefined || !head.startsWith('refs/remotes/origin/')) {
    throw new Error(
      `can't tell origin's default branch. Run "git remote set-head origin --auto", or set "ref" in ${path.join(
        root,
        '_base.json'
      )}. Nothing was created.`
    );
  }

  const branch = head.slice('refs/remotes/origin/'.length);

  try {
    git(repo, ['fetch', 'origin', branch, '--quiet']);
  } catch (error) {
    throw new Error(
      `git fetch origin ${branch} failed: ${lastStderrLine(
        error
      )}. Nothing was created.`
    );
  }

  return `origin/${branch}`;
};

// ── the pod's instructions ──────────────────────────────────────────────────

/** The conversation commands, Lambda's own copies in `commands/pod/`. */
export const CONVERSATION_COMMANDS = [
  'human-chat',
  'human-standby',
  'human',
  'human-async',
  'human-close',
  'human-resolved',
  'pod-request',
  'pod-request-queued',
  'pod-request-done',
  'pod-restarted',
  'checkpoint-complete',
  'pod-skip',
  'pod-structured',
  'freeform',
];

/** Lambda's planning instructions a pod runs as slash commands. */
export const PLANNING_COMMANDS = [
  'pod-phase',
  'red-flags',
  'review-ticket',
  'split-ticket',
  'ux-sketch',
  'reconcile-tickets',
  // Run by the ux phase once per screen in full render mode.
  'design-screen',
];

const lambdaCommandFile = (name: string): string =>
  path.join(lambdaPackageDir(), 'commands', 'pod', `${name}.md`);

export const COMMANDS_DIR = path.join('.claude', 'commands');
const COMMANDS_IGNORE = path.join(COMMANDS_DIR, '.gitignore');
/**
 * Each pod lists what it wrote under its own header, so pods sharing a folder
 * (a building pod and a --workdir planning pod) never drop each other's
 * files. The header with no pod id is an older Lambda's, kept as it is.
 */
const OURS_HEADER =
  /^# Written by lambda pod (?:(\S+) )?for this worktree only\.$/;

const oursHeader = (podId: string): string =>
  `# Written by lambda pod ${podId} for this worktree only.`;

interface CommandsIgnore {
  /** The lines above Lambda's sections: the project's own. */
  lead: string;
  /** Each pod's files, by pod id ('' for the older, unnamed list). */
  sections: Map<string, string[]>;
}

const readCommandsIgnore = (worktree: string): CommandsIgnore => {
  const file = path.join(worktree, COMMANDS_IGNORE);
  const lines = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n')
    : [];
  const start = lines.findIndex((line) => OURS_HEADER.test(line));
  const sections = new Map<string, string[]>();
  // Each line goes to the section of the header above it.
  (start === -1 ? [] : lines.slice(start)).reduce((current, line) => {
    const header = OURS_HEADER.exec(line);

    if (header !== null) {
      const podId = header[1] ?? '';
      sections.set(podId, sections.get(podId) ?? []);

      return podId;
    }

    if (line.trim().endsWith('.md')) {
      sections.set(current, [...(sections.get(current) ?? []), line.trim()]);
    }

    return current;
  }, '');

  return {
    lead: (start === -1 ? lines : lines.slice(0, start)).join('\n'),
    sections,
  };
};

/**
 * The command files Lambda wrote here before: every pod's, or with `podId`
 * only that pod's.
 */
export const ourCommandFiles = (worktree: string, podId?: string): string[] => {
  const { sections } = readCommandsIgnore(worktree);

  if (podId !== undefined) {
    return sections.get(podId) ?? [];
  }

  return Array.from(new Set([...sections.values()].flat()));
};

/**
 * The file holding one of the pod's instructions in this project: the
 * project's `.lambda/planning/<name>.md`, then its own
 * `.claude/commands/<name>.md`, then Lambda's default. The planning ones go
 * through the process's lookup, which keeps Lambda's quality steps its own.
 * A `.claude/commands/` file Lambda wrote there itself isn't the project's,
 * so it's passed over: a `--workdir` pod writes into the folder it reads.
 */
export const resolvePodInstructions = (
  projectDir: string,
  name: string
): string => {
  const ours = ourCommandFiles(projectDir).map((file) =>
    path.join(projectDir, COMMANDS_DIR, file)
  );

  if (!CONVERSATION_COMMANDS.includes(name)) {
    return resolveInstructions(projectDir, 'planning', name, ours);
  }

  const candidates = [
    path.join(projectDir, '.lambda', 'planning', `${name}.md`),
    path.join(projectDir, '.claude', 'commands', `${name}.md`),
    lambdaCommandFile(name),
  ].filter((file) => !ours.includes(file));
  const found = candidates.find((file) => fs.existsSync(file));

  if (found === undefined) {
    throw new Error(`${name}.md isn't in any of: ${candidates.join(', ')}.`);
  }

  return found;
};

/** Commands the project's workflow.json adds, with their own `.lambda/planning/` file. */
const addedCommands = (projectDir: string): string[] =>
  Object.values(loadProcess(projectDir, 'planning').tracks)
    .flat()
    .flatMap((stage) => stage.steps)
    .filter((step) => step.added === true && step.command !== undefined)
    .map((step) => step.command ?? '')
    .filter((command) =>
      fs.existsSync(
        path.join(projectDir, '.lambda', 'planning', `${command}.md`)
      )
    );

/** Every slash command a pod's agents receive, each once. */
export const podCommandNames = (projectDir: string): string[] =>
  Array.from(
    new Set([
      ...PLANNING_COMMANDS,
      ...CONVERSATION_COMMANDS,
      ...addedCommands(projectDir),
    ])
  );

export const isTracked = (worktree: string, file: string): boolean =>
  gitOk(worktree, ['ls-files', '--error-unmatch', file]) !== undefined;

/** Put a tracked file Lambda replaced back as the checkout has it. */
const restoreTracked = (worktree: string, file: string): void => {
  git(worktree, ['update-index', '--no-skip-worktree', file]);
  git(worktree, ['checkout', '--', file]);
};

/**
 * Put the worktree's `.claude/commands/` back as the checkout has it: the
 * files Lambda wrote go (a tracked one it replaced is checked out again), and
 * a tracked `.gitignore` it appended to is restored. Run before the worktree
 * is moved, so `checkout` is never refused over them.
 */
export const resetInstructions = (worktree: string): void => {
  ourCommandFiles(worktree).forEach((name) => {
    const file = path.join(COMMANDS_DIR, name);

    if (isTracked(worktree, file)) {
      restoreTracked(worktree, file);

      return;
    }

    fs.rmSync(path.join(worktree, file), { force: true });
  });

  const ignore = path.join(worktree, COMMANDS_IGNORE);

  if (isTracked(worktree, COMMANDS_IGNORE)) {
    restoreTracked(worktree, COMMANDS_IGNORE);

    return;
  }

  fs.rmSync(ignore, { force: true });
};

/**
 * Write the ignore back with these sections; with none left it goes (a
 * tracked one is checked out again).
 */
const saveCommandsIgnore = (
  worktree: string,
  { lead, sections }: CommandsIgnore
): void => {
  const file = path.join(worktree, COMMANDS_IGNORE);
  const tracked = isTracked(worktree, COMMANDS_IGNORE);

  if (sections.size === 0) {
    if (tracked) {
      restoreTracked(worktree, COMMANDS_IGNORE);

      return;
    }

    if (lead.trim() === '') {
      fs.rmSync(file, { force: true });

      return;
    }

    fs.writeFileSync(file, lead.endsWith('\n') ? lead : `${lead}\n`);

    return;
  }

  const kept = lead === '' || lead.endsWith('\n') ? lead : `${lead}\n`;
  const ours = [...sections].flatMap(([podId, files]) => [
    podId === ''
      ? '# Written by lambda pod for this worktree only.'
      : oursHeader(podId),
    ...(tracked ? [] : ['.gitignore']),
    ...files,
  ]);

  fs.writeFileSync(file, `${kept}${ours.join('\n')}\n`);

  if (tracked) {
    git(worktree, ['update-index', '--skip-worktree', COMMANDS_IGNORE]);
  }
};

/**
 * List the files a pod wrote in the worktree's `.claude/commands/.gitignore`
 * (which lists itself), under that pod's own header, so they never show up
 * as changes to commit. Another pod's section is left as it is. Not
 * `info/exclude`: in a linked worktree that is the main repo's shared file,
 * and the main checkout would stop seeing a command the person adds there.
 * A tracked `.gitignore` gets the lines appended and is marked skip-worktree
 * in this worktree's own index.
 */
export const writeCommandsIgnore = (
  worktree: string,
  podId: string,
  written: string[]
): void => {
  const ignore = readCommandsIgnore(worktree);
  ignore.sections.set(podId, written);
  saveCommandsIgnore(worktree, ignore);
};

/**
 * A pod leaving a folder it shares: the command files only it wrote go (a
 * tracked one it replaced is checked out again), and so does its section. A
 * file another pod's section also lists stays, for that pod.
 */
export const removePodInstructions = (
  worktree: string,
  podId: string
): void => {
  const ignore = readCommandsIgnore(worktree);
  const mine = ignore.sections.get(podId);

  // Nothing listed for it: the pod wrote no commands here.
  if (mine === undefined) {
    return;
  }

  ignore.sections.delete(podId);
  const others = new Set([...ignore.sections.values()].flat());
  mine
    .filter((name) => !others.has(name))
    .forEach((name) => {
      const file = path.join(COMMANDS_DIR, name);

      if (isTracked(worktree, file)) {
        restoreTracked(worktree, file);

        return;
      }

      fs.rmSync(path.join(worktree, file), { force: true });
    });
  saveCommandsIgnore(worktree, ignore);
};

/** A placeholder that opens a sentence, a heading, a list item or bold text. */
const SENTENCE_START =
  /(^|[.!?:]\s+|^#+\s+|^\s*(?:[-*]|\d+\.)\s+|\*\*|\|\s+)\{owner\}/gm;

/**
 * `{owner}` → the owner's name, else "the owner" — capitalised where it
 * opens a sentence.
 */
export const fillOwner = (text: string, owner: string): string =>
  fillInstructions(
    text.replace(
      SENTENCE_START,
      (_match, lead: string) =>
        `${lead}${owner.charAt(0).toUpperCase()}${owner.slice(1)}`
    ),
    { owner }
  );

export interface PodInstructions {
  /** Whose section of the commands ignore the written files go under. */
  podId: string;
  /** Where the dev works: the worktree, or the --workdir / non-git folder. */
  devCwd: string;
  /** The manager's own folder (`<devCwd>/.lambda/managers/<id>`). */
  managerCwd: string;
  /** "The project" the lookup reads: the planner, else devCwd. */
  projectDir: string;
  /** Fills `{owner}` in what is written. */
  owner: string;
}

/**
 * Write the pod's instructions: the manager's CLAUDE.md and every slash
 * command into the manager folder (Claude Code finds commands only under the
 * agent's own folder), and into the dev's `.claude/commands/` every command
 * the project doesn't already have there. A locked one (`pod-phase`, the
 * quality steps) is always Lambda's, in both: a tracked project copy is
 * replaced in this worktree only (skip-worktree, restored by
 * `resetInstructions`). Returns the worktree files written.
 */
export const writePodInstructions = (args: PodInstructions): string[] => {
  const { podId, devCwd, managerCwd, projectDir, owner } = args;
  const filled = (name: string): string =>
    fillOwner(
      withAddendum(
        projectDir,
        'planning',
        name,
        fs.readFileSync(resolvePodInstructions(projectDir, name), 'utf8')
      ),
      owner
    );

  fs.mkdirSync(path.join(managerCwd, COMMANDS_DIR), { recursive: true });
  fs.writeFileSync(path.join(managerCwd, 'CLAUDE.md'), filled('manager'));

  const commandsDir = path.join(devCwd, COMMANDS_DIR);
  const ours = new Set(ourCommandFiles(devCwd));
  fs.mkdirSync(commandsDir, { recursive: true });

  const written = podCommandNames(projectDir).flatMap((name) => {
    const text = filled(name);
    const file = `${name}.md`;
    fs.writeFileSync(path.join(managerCwd, COMMANDS_DIR, file), text);

    const projects =
      fs.existsSync(path.join(commandsDir, file)) && !ours.has(file);

    // The project's own command (tracked or not) is never overwritten…
    if (projects && !isLockedInstruction('planning', name)) {
      return [];
    }

    // …except one whose instructions are always Lambda's own: the manager
    // just got Lambda's, so the dev's `/<name>` has to run the same text.
    const tracked =
      projects && isTracked(devCwd, path.join(COMMANDS_DIR, file));

    if (projects && !tracked) {
      throw new Error(
        `${path.join(
          commandsDir,
          file
        )} would hide Lambda's own /${name} from the pod's dev. Move it out of .claude/commands/ and start the pod again.`
      );
    }

    fs.writeFileSync(path.join(commandsDir, file), text);

    if (tracked) {
      git(devCwd, [
        'update-index',
        '--skip-worktree',
        path.join(COMMANDS_DIR, file),
      ]);
    }

    return [file];
  });

  writeCommandsIgnore(devCwd, podId, written);

  return written;
};

/** The manager's folder, kept out of git by its own `*` ignore. */
export const prepareManagerFolder = (devCwd: string, podId: string): string => {
  const managers = path.join(devCwd, '.lambda', 'managers');
  const managerCwd = path.join(managers, podId);
  fs.mkdirSync(managerCwd, { recursive: true });
  fs.writeFileSync(path.join(managers, '.gitignore'), '*\n');

  return managerCwd;
};

// ── the agents' PATH ────────────────────────────────────────────────────────

/** `<pods root>/_bin`, when it holds a `lambda` launcher. */
export const plannerBin = (root: string = podsRoot()): string | undefined => {
  const dir = path.join(root, '_bin');

  return fs.existsSync(path.join(dir, 'lambda')) ? dir : undefined;
};

/**
 * The PATH pod agents get: `<pods root>/_bin` first when it holds a `lambda`
 * launcher, else the folder of the `lambda` that is running. Hooks and the
 * agents' `lambda pod …` then run the same copy, installed globally or not.
 */
export const agentPath = (
  root: string = podsRoot(),
  runningBinary: string | undefined = process.argv[1]
): string => {
  const first =
    plannerBin(root) ??
    (runningBinary === undefined ? undefined : path.dirname(runningBinary));
  const rest = process.env.PATH ?? '';

  return first === undefined ? rest : `${first}:${rest}`;
};
