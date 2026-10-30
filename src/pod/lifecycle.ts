import { execFileSync } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { currentRun } from '../app/shared/building';
import { setAsideText, setAsideWork } from '../building/blocked';
import { leaveRelease, leaveShip } from '../building/driver';
import {
  briefRoles,
  buildingAgentsHealthy,
  clearBuildingRecord,
  closeBuildingWindows,
  interruptBusyAgents,
  resumeNote,
  startBuildingAgents,
} from '../building/lifecycle';
import { POD_WINDOW_FORMAT } from '../building/windows';
import { writeLambdaGitignore } from '../commands/init';
import {
  PROJECT_CONFIG_FILE,
  type Project,
  ProjectConfigSchema,
} from '../config/projectConfig';
import { readConfigFile } from '../config/readConfigFile';
import {
  BUILDING_ROLES,
  type Pod,
  type PodStore,
  RENDER_MODES,
  nowIso,
  pendingAsk,
  pendingResends,
  podKindOf,
  podRenderMode,
  sessionOf,
  trackOf,
} from '../pod-store';
import { addendumFile } from '../process/workflow-file';
import { machineDesign } from '../runner/machineDesign';
import { type TicketSource } from '../tickets/source';
import {
  instructionsProject,
  isGitRepo,
  podBase,
  prepareManagerFolder,
  refreshBase,
  removePodInstructions,
  resetInstructions,
  resolvePodInstructions,
  writePodInstructions,
} from './base';
import { startKind } from './claudeSessions';
import {
  agentWindow,
  callerAgent,
  callerPodId,
  currentProject,
  openStore,
  openTickets,
  paneTarget,
  podSessionOf,
  podsRoot,
  sessionName,
  worktreeRoot,
} from './context';
import {
  configuredTicketKeys,
  lookUpTicket,
  openingMessage,
  readIntake,
} from './intake';
import {
  DEV_BOOTSTRAP,
  MANAGER_BOOTSTRAP,
  launchAgent,
  writePodSettings,
} from './launch';
import { deliverEntry, sendMessage } from './messaging';
import {
  ownerForAgent,
  ownerForPerson,
  ownerName,
  ownerStartForAgent,
  ownersForAgent,
} from './owner';
import { podTicketIds, startPlanning } from './planningStatus';
import { runNewFromPod } from './pullout';
import {
  hasSession,
  killSession,
  killWindow,
  listWindows,
  sendToPane,
  windowCount,
} from './tmux';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'pod';

/** (Re)write the pod's instructions: the manager's folder and the dev's commands. */
export const writeInstructionsFor = (pod: Pod): void => {
  writePodInstructions({
    podId: pod.id,
    devCwd: pod.devCwd,
    managerCwd: pod.managerCwd,
    projectDir: instructionsProject(pod),
    owner: ownerForAgent(),
  });
};

/** Start (fresh) or bring back (resume) a pod's manager and dev. */
export const startPodAgents = async (
  store: PodStore,
  pod: Pod,
  mode: 'fresh' | 'resume'
): Promise<void> => {
  // The project's own first message (lambda.json `pods.firstMessage`), read
  // before either agent starts: a lambda.json that does not parse refuses
  // here, never after two agents are running with nothing typed to them.
  const configFile = path.join(instructionsProject(pod), PROJECT_CONFIG_FILE);
  const firstMessage = fs.existsSync(configFile)
    ? readConfigFile(configFile, ProjectConfigSchema).pods?.firstMessage
    : undefined;

  // A resume brings back only a conversation that exists; an agent whose
  // first start never got going starts fresh, and gets its opening message.
  const kinds = {
    manager: startKind(mode, sessionOf(pod, 'manager')),
    dev: startKind(mode, sessionOf(pod, 'dev')),
  };
  const managerReady = await launchAgent({
    pod,
    store,
    agent: 'manager',
    cwd: pod.managerCwd,
    mode: { kind: kinds.manager, sessionId: sessionOf(pod, 'manager') },
  });
  const devReady = await launchAgent({
    pod,
    store,
    agent: 'dev',
    cwd: pod.devCwd,
    mode: { kind: kinds.dev, sessionId: sessionOf(pod, 'dev') },
  });

  if (!managerReady || !devReady) {
    console.warn(
      `⚠ Pod ${pod.id}: ${managerReady ? '' : 'manager '}${
        devReady ? '' : 'dev '
      }did not show an input prompt in time; sending anyway.`
    );
  }

  // Typed to both before anything else they read.
  if (firstMessage !== undefined) {
    await sendToPane(paneTarget(pod.id, 'manager', store), firstMessage);
    await sendToPane(paneTarget(pod.id, 'dev', store), firstMessage);
  }

  const devAddendum = addendumFile(instructionsProject(pod), 'planning', 'dev');
  const opening = {
    dev: () =>
      DEV_BOOTSTRAP(
        pod.id,
        resolvePodInstructions(instructionsProject(pod), 'dev'),
        undefined,
        fs.existsSync(devAddendum) ? devAddendum : undefined
      ),
    manager: () => MANAGER_BOOTSTRAP(pod.id),
  };

  // Fresh ones get their opening message, the dev's first; resumed ones
  // are told they were restarted.
  await (['dev', 'manager'] as const)
    .filter((agent) => kinds[agent] === 'fresh')
    .reduce(async (previous, agent) => {
      await previous;
      await sendMessage(store, {
        podId: pod.id,
        target: agent,
        command: '',
        text: opening[agent](),
        mode: 'note',
        from: 'system',
      });
    }, Promise.resolve());

  await Promise.all(
    (['manager', 'dev'] as const)
      .filter((agent) => kinds[agent] === 'resume')
      .map((agent) =>
        sendMessage(store, {
          podId: pod.id,
          target: agent,
          command: '/pod-restarted',
          text: '',
          mode: 'note',
          from: 'system',
        })
      )
  );
};

/**
 * Bringing a stopped pod back, safely, from any of the paths that do it:
 * `resume-all` after a restart, `lambda pod resume`, and the nudge of a
 * stopped pod (`lambda pod nudge`). Two of them racing could leave a pod with
 * two managers and two devs; with two windows of one name tmux refuses every
 * target into either, so nothing sent to the pod would arrive.
 *
 * So: one start at a time per pod (a lock file), a session that is not
 * exactly one manager and one dev is replaced rather than added to, a failed
 * start is retried once and logged to the pod's workflow, and every start
 * re-sends what the agents never took in.
 */

const START_LOCK_STALE_MS = 10 * 60_000;
const AGENT_WINDOWS = ['manager', 'dev'] as const;

/** Exactly one manager and one dev window. */
export const agentsHealthy = (podId: string): boolean =>
  AGENT_WINDOWS.every((agent) => windowCount(sessionName(podId), agent) === 1);

const takeStartLock = (
  store: PodStore,
  podId: string
): (() => void) | undefined => {
  const lock = store.file(podId, 'start.lock');

  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > START_LOCK_STALE_MS) {
      fs.rmSync(lock, { force: true });
    }
  } catch {
    // No lock yet.
  }

  try {
    fs.writeFileSync(lock, `${process.pid} ${nowIso()}\n`, { flag: 'wx' });
  } catch {
    return undefined;
  }

  return () => fs.rmSync(lock, { force: true });
};

const restartNote = (store: PodStore, podId: string, note: string): void => {
  store.appendStep(podId, {
    at: nowIso(),
    step: 'restart',
    event: 'note',
    by: 'system',
    note,
  });
};

const startClean = async (
  store: PodStore,
  pod: Pod,
  retries: number
): Promise<void> => {
  // A partial or doubled session can't be sent to: replace it, never add to it.
  killSession(sessionName(pod.id));

  const failure = await startPodAgents(store, pod, 'resume').then(
    () => undefined,
    (error: unknown) => String(error)
  );

  if (failure === undefined && agentsHealthy(pod.id)) {
    return;
  }

  const windows = listWindows(sessionName(pod.id));
  const why =
    failure ??
    `after starting, its windows were: ${
      windows.length === 0 ? 'none' : windows.join(', ')
    }`;
  restartNote(
    store,
    pod.id,
    `Restart failed (${why.slice(0, 300)})${
      retries > 0 ? '; trying once more.' : '.'
    }`
  );

  if (retries > 0) {
    await startClean(store, pod, retries - 1);

    return;
  }

  throw new Error(`Pod ${pod.id} did not start: ${why}`);
};

export interface StartOutcome {
  result: 'running' | 'starting' | 'started';
  resent: string[];
  errors: string[];
}

/**
 * Close every window of a building role that is open more than once (by
 * window id: tmux refuses a name two windows share), so it can be started
 * again as one. In a project's shared session only the pod's own are closed.
 * The healthy roles, and anything else in the session, keep running.
 */
const closeDoubledRoles = (pod: Pod): void => {
  const session = podSessionOf(pod);
  const doubled: string[] = BUILDING_ROLES.map((role) =>
    agentWindow(pod, role)
  ).filter((window) => windowCount(session, window) > 1);

  if (doubled.length === 0) {
    return;
  }

  execFileSync(
    'tmux',
    [
      'list-windows',
      '-t',
      `=${session}`,
      '-F',
      `#{window_id}\t${POD_WINDOW_FORMAT}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t'))
    .filter(
      ([, name = '', tag = '']) =>
        doubled.includes(name) &&
        (pod.tmuxSession === undefined || tag === pod.id)
    )
    .forEach(([id = '']) => killWindow(id));
};

/** Messages the agents never took in, sent again (same id, so a repeat is visible). */
export const resendPending = async (
  store: PodStore,
  podId: string
): Promise<{ resent: string[]; errors: string[] }> =>
  pendingResends(store.readThread(podId), Date.now()).reduce<
    Promise<{ resent: string[]; errors: string[] }>
  >(async (previousPromise, message) => {
    const previous = await previousPromise;

    try {
      await deliverEntry(store, message);

      return { ...previous, resent: [...previous.resent, message.id] };
    } catch (error) {
      return {
        ...previous,
        errors: [...previous.errors, `${message.id}: ${String(error)}`],
      };
    }
  }, Promise.resolve({ resent: [], errors: [] }));

/** Pending messages re-sent after a start, and a note saying so. */
const resendAndNote = async (
  store: PodStore,
  podId: string
): Promise<{ resent: string[]; errors: string[] }> => {
  const { resent, errors } = await resendPending(store, podId);

  if (resent.length > 0 || errors.length > 0) {
    restartNote(
      store,
      podId,
      `Re-sent ${resent.length} message(s) the agents never took in${
        errors.length > 0 ? `; ${errors.length} could not be sent` : ''
      }.`
    );
  }

  return { resent, errors };
};

/** Start a stopped (or broken) pod's agents; a no-op while it is healthy or already starting. */
export const ensurePodRunning = async (
  store: PodStore,
  pod: Pod
): Promise<StartOutcome> => {
  const release = takeStartLock(store, pod.id);

  if (release === undefined) {
    return { result: 'starting', resent: [], errors: [] };
  }

  try {
    // A one-shot Product manager wakes on its next message, never here.
    if (pod.talk !== undefined) {
      return { result: 'running', resent: [], errors: [] };
    }

    if (podKindOf(pod) === 'building') {
      if (buildingAgentsHealthy(pod)) {
        return { result: 'running', resent: [], errors: [] };
      }

      // Only a doubled role is closed; a missing one is just started, and
      // the healthy agents are never killed mid-turn.
      closeDoubledRoles(pod);
      await startBuildingAgents(store, pod, 'resume');

      return { result: 'started', ...(await resendAndNote(store, pod.id)) };
    }

    if (agentsHealthy(pod.id)) {
      return { result: 'running', resent: [], errors: [] };
    }

    await startClean(store, pod, 1);

    return { result: 'started', ...(await resendAndNote(store, pod.id)) };
  } finally {
    release();
  }
};

export interface NewPodOptions {
  workdir?: string;
  agent?: string;
  launch: boolean;
  idea?: string;
  /** Plan an EXISTING epic (and adopt its children) instead of writing a new one. */
  epic?: string;
  /** Plan a lone EXISTING ticket (no epic): reviewed and brought up to the template. */
  ticket?: string;
  /**
   * The one text box: an idea, a ticket, an epic or several tickets (see
   * intake.ts). Replaces --idea/--epic/--ticket.
   */
  text?: string;
  /** Several ticket ids in --text, but one pod about the first (not a batch). */
  single?: boolean;
  /** A conversation with the dev, no pipeline, until the owner switches it. */
  freeform?: boolean;
  /** (pod agents) The closed checkpoint that approved pulling this ticket out. */
  fromCheckpoint?: string;
  /** (pod agents) The owner's chat message agreeing to a new Lambda: `[m:…]`'s id. */
  spinoff?: string;
  /** Set by the re-run in pullout.ts: the pod (and checkpoint or message) this came from. */
  fromPod?: string;
  fromQid?: string;
  fromMessage?: string;
}

/** What `runNew` reads from outside; tests hand in their own. */
export interface NewPodDeps {
  project: Project;
  tickets: () => TicketSource;
  print: (line: string) => void;
}

const defaultNewPodDeps = (): NewPodDeps => {
  const project = currentProject();

  return {
    project,
    tickets: () => openTickets(project),
    print: (line) => console.log(line),
  };
};

/**
 * Where the pod works, decided before anything is created: `--workdir` as
 * is, the project folder when it isn't a git repo (neither is owned), or a
 * new detached worktree at the base ref (owned; made by `createWorkdir`).
 */
type Workdir =
  | { kind: 'folder'; path: string }
  | { kind: 'worktree'; path: string; repo: string; ref: string };

const planWorkdir = (
  project: Project,
  id: string,
  workdir: string | undefined
): Workdir => {
  if (workdir !== undefined) {
    const resolved = path.resolve(workdir);

    if (!fs.existsSync(resolved)) {
      throw new Error(
        `--workdir ${workdir} does not exist. Nothing was created.`
      );
    }

    return { kind: 'folder', path: resolved };
  }

  if (!isGitRepo(project.root)) {
    return { kind: 'folder', path: project.root };
  }

  return {
    kind: 'worktree',
    path: path.join(worktreeRoot(project), id),
    repo: project.root,
    ref: refreshBase(project.root, podBase()),
  };
};

const createWorkdir = (workdir: Workdir): void => {
  if (workdir.kind === 'folder') {
    return;
  }

  fs.mkdirSync(path.dirname(workdir.path), { recursive: true });
  git(workdir.repo, ['worktree', 'add', '--detach', workdir.path, workdir.ref]);
};

export const runNew = async (
  slug: string,
  options: NewPodOptions,
  deps: NewPodDeps = defaultNewPodDeps()
): Promise<void> => {
  // A pod starting a pod: checked, then re-run as a person would run it.
  if (callerPodId() !== undefined) {
    runNewFromPod(slug, options);

    return;
  }

  if (options.epic !== undefined && options.ticket !== undefined) {
    throw new Error('Pass --epic OR --ticket, not both.');
  }

  if (
    options.text !== undefined &&
    [options.idea, options.epic, options.ticket].some(
      (value) => value !== undefined
    )
  ) {
    throw new Error('--text replaces --idea, --epic and --ticket.');
  }

  const { project, print } = deps;

  // Read before anything is created: a ticket id that isn't real fails here.
  const intake =
    options.text === undefined
      ? undefined
      : await readIntake(
          options.text,
          options.single === true,
          deps.tickets(),
          configuredTicketKeys(project.config.tickets)
        );
  const named = options.epic ?? options.ticket;
  const existing =
    named === undefined ? undefined : await lookUpTicket(deps.tickets(), named);
  const store = openStore();
  const id = `${slugify(intake?.slug ?? slug)}-${randomBytes(2).toString(
    'hex'
  )}`;
  const workdir = planWorkdir(project, id, options.workdir);

  createWorkdir(workdir);
  writeLambdaGitignore(project.root);

  const devCwd = workdir.path;
  const managerCwd = prepareManagerFolder(devCwd, id);

  const pod: Pod = {
    id,
    slug,
    createdAt: nowIso(),
    status: 'active',
    phase: 1,
    completedCheckpoints: [],
    worktreePath: workdir.path,
    ownsWorktree: workdir.kind === 'worktree',
    managerCwd,
    devCwd,
    agentCommand: options.agent ?? 'claude',
    sessions: { manager: randomUUID(), dev: randomUUID() },
    epicId: intake?.epicId ?? existing?.id,
    pipeline: 2,
    source:
      intake?.source ??
      (options.epic !== undefined
        ? 'epic'
        : options.ticket !== undefined
        ? 'ticket'
        : 'idea'),
    ...(intake?.tickets === undefined ? {} : { tickets: intake.tickets }),
    ...(intake === undefined ? {} : { title: intake.title, titleBy: 'agent' }),
    ...(options.freeform === true ? { mode: 'freeform' } : {}),
    ...(options.fromPod === undefined
      ? {}
      : {
          from: {
            podId: options.fromPod,
            ...(options.fromQid === undefined ? {} : { qid: options.fromQid }),
            ...(options.fromMessage === undefined
              ? {}
              : { messageId: options.fromMessage }),
          },
        }),
  };

  store.writePod(pod);
  writeInstructionsFor(pod);
  writePodSettings(store, id, {
    projectRoot: project.root,
    cli: project.config.cli,
    deny: project.config.pods?.deny,
    forkDeny: project.config.pods?.forkDeny,
  });
  print(`Created Lambda ${id}`);
  print(`  state:    ${store.podDir(id)}`);
  print(
    `  worktree: ${pod.worktreePath}${pod.ownsWorktree ? '' : ' (not owned)'}`
  );

  if (!options.launch) {
    return;
  }

  // A freeform chat isn't planning yet; it moves them when it's structured.
  if (pod.mode !== 'freeform') {
    await startPlanning(deps.tickets, podTicketIds(pod));
  }

  // The same lock a resume takes: two starts at once each made windows in
  // one session, and a pod came up with two `dev` windows and no manager.
  const release = takeStartLock(store, id);

  if (release === undefined) {
    print(`  ${id} is already being started.`);

    return;
  }

  try {
    await startPodAgents(store, pod, 'fresh');
  } finally {
    release();
  }

  print(`  tmux:     ${sessionName(id)} (windows: manager, dev)`);

  if (options.text !== undefined) {
    const text = openingMessage(pod, options.text);

    if (text !== '') {
      await sendMessage(store, {
        podId: id,
        target: 'dev',
        command: pod.mode === 'freeform' ? '/freeform' : '/human-chat',
        text,
        mode: 'sync',
        from: 'human',
      });
    }

    return;
  }

  const idea = options.idea?.trim() ?? '';

  // An existing epic is planned in place: phase 1 adopts it (see /pod-phase).
  const opening =
    pod.source === 'ticket'
      ? `Please plan the existing ticket ${
          pod.epicId ?? ''
        } — a lone ticket: don't create a new epic. Propose a split anyway (the split proposal, CP3); I'll choose between keeping one ticket and the split.${
          idea === '' ? '' : ` ${idea}`
        }`
      : pod.epicId !== undefined
      ? `Please plan the existing epic ${pod.epicId} — don't create a new one.${
          idea === '' ? '' : ` ${idea}`
        }`
      : idea === ''
      ? ''
      : `Here is my idea for this pod: ${idea}`;

  if (opening !== '') {
    await sendMessage(store, {
      podId: id,
      target: 'dev',
      command: '/human-chat',
      text: opening,
      mode: 'sync',
      from: 'human',
    });
  }
};

export const runList = (): void => {
  const store = openStore();
  const pods = store.listPodIds().map((podId) => store.requirePod(podId));

  if (pods.length === 0) {
    console.log('No pods.');

    return;
  }

  pods.forEach((pod) => {
    const open = store
      .listQuestions(pod.id)
      .filter((question) => question.status === 'open').length;
    const running = hasSession(sessionName(pod.id)) ? 'running' : 'stopped';
    console.log(
      `${pod.id.padEnd(30)} ${pod.status.padEnd(7)} phase ${
        pod.phase
      }  CP done [${pod.completedCheckpoints.join(',')}]  ${
        pod.epicId ?? '-'
      }  ${open} open  ${running}`
    );
  });
};

/** Phase 3 is research, the split proposal, the tickets and the UX review. */
const PHASE_NAMES = [
  '',
  'Shape',
  'Review',
  'Research, tickets and UX review',
  'Fill',
  'Reconcile',
];

/** What the manager reads to decide its next step. */
/** `lambda pod status` for a building pod: the ticket it's on and its runs. */
const printBuildingStatus = (store: PodStore, pod: Pod): void => {
  const state = store.readBuilding(pod.id);
  const run = currentRun(state);
  const done = state.runs.filter((one) => one.shippedAt !== undefined);

  console.log('  kind:         building');
  console.log(
    `  ticket:       ${
      run === null
        ? 'none (waiting for a Ready ticket)'
        : `${run.id} ${run.title} — step ${run.step}, attempt ${run.attempt}`
    }`
  );
  console.log(
    `  shipped:      ${
      done.length === 0 ? 'nothing yet' : done.map((one) => one.id).join(', ')
    }`
  );
  console.log(
    `  blocked:      ${
      state.runs.filter((one) => one.blocked !== undefined).length
    }`
  );
  console.log(
    `  up next:      ${
      state.upNext.length === 0
        ? 'nothing'
        : state.upNext.map((next) => next.id).join(', ')
    }`
  );
  BUILDING_ROLES.forEach((role) =>
    console.log(
      `  ${`${role} turn:`.padEnd(14)}${JSON.stringify(
        store.readTurn(pod.id, role)
      )}`
    )
  );
};

export const runStatus = (podId: string): void => {
  const store = openStore();
  const pod = store.requirePod(podId);
  const questions = store.listQuestions(podId);
  const count = (status: string) =>
    questions.filter((question) => question.status === status).length;
  const owner = ownerStartForAgent();
  const owners = ownersForAgent();

  console.log(`Pod ${pod.id} (${pod.status})`);

  // A building pod has no phases, track or checkpoints: its tickets.
  if (podKindOf(pod) === 'building') {
    printBuildingStatus(store, pod);

    return;
  }

  const track = trackOf(pod);
  console.log(
    `  phase:        ${pod.phase} — ${PHASE_NAMES[pod.phase] ?? '?'}`
  );
  console.log(
    `  track:        ${track}${
      track === 'idea'
        ? ' (new idea: CP1, CP2, split proposal at CP3, CP4 UX review, CP5)'
        : track === 'batch'
        ? ' (batch of existing tickets: no CP1; triage at CP2; no split proposal; CP4 UX review, CP5 — one of each for the whole batch)'
        : ` (existing ${
            pod.source ?? 'epic'
          }: no CP1/CP2; split proposal at CP3 only when an epic has no children; CP4 UX review, CP5)`
    }`
  );
  console.log(
    `  mode:         ${
      pod.mode === 'freeform'
        ? `FREEFORM — a conversation with ${ownerForAgent()}, no pipeline: run no phase until /pod-structured`
        : pod.mode === 'structured'
        ? 'structured (started as a freeform conversation: Shape starts from it)'
        : 'structured'
    }`
  );
  console.log(
    `  checkpoints:  completed [${pod.completedCheckpoints.join(', ')}]`
  );

  if (pod.from !== undefined) {
    console.log(
      pod.from.qid === undefined
        ? `  from:         spun off from pod ${
            pod.from.podId
          } (${owners} message ${pod.from.messageId ?? '?'})`
        : `  from:         pulled out of pod ${pod.from.podId} (checkpoint ${pod.from.qid})`
    );
  }
  console.log(
    `  skipped:      ${
      (pod.skipped ?? []).length === 0
        ? 'nothing'
        : `${(pod.skipped ?? []).join(
            ', '
          )} — ${owner} skipped these: don't run them; a skipped checkpoint counts as closed`
    }`
  );
  console.log(
    pod.source === 'batch'
      ? `  tickets:      ${(pod.tickets ?? []).join(', ')}`
      : `  ${pod.source === 'ticket' ? 'ticket:      ' : 'epic:        '} ${
          pod.epicId ?? '(not created yet)'
        }`
  );

  if (pod.split !== undefined) {
    console.log(
      pod.split === 'one-ticket'
        ? `  split:        ${owner} kept it one ticket at CP3 — bring it up to the template; drop the proposal`
        : `  split:        ${owner} accepted the split at CP3 — the ticket is now the epic; write the proposal as its children`
    );
  }
  console.log(
    `  questions:    ${count('open')} open, ${count('draft')} draft, ${count(
      'answered'
    )} answered, ${count('withdrawn')} withdrawn`
  );
  const ask = pendingAsk(store.readThread(podId));
  console.log(
    `  owner:        ${
      ask === null
        ? `nothing waiting on ${owners} reply`
        : `WAITING ON ${owners.toUpperCase()} REPLY to the ${
            ask.from
          }'s question of ${ask.createdAt}: "${ask.text
            .replace(/\s+/g, ' ')
            .slice(0, 100)}"`
    }`
  );
  console.log(
    `  dev turn:     ${JSON.stringify(store.readTurn(podId, 'dev'))}`
  );
};

export const runSetPhase = (podId: string, phase: number): void => {
  openStore().updatePod(podId, (pod) => ({ ...pod, phase }));
  console.log(
    `Pod ${podId} is now in phase ${phase} — ${PHASE_NAMES[phase] ?? '?'}.`
  );
};

/**
 * How the pod's UX review is drawn: with no mode, prints it (an unset mode
 * follows this computer's Claude Design check in `~/.lambda/config.json`);
 * with one, sets it. Takes effect at the next UX review.
 */
export const runRenderMode = (podId: string, mode?: string): void => {
  const store = openStore();

  if (mode === undefined) {
    console.log(podRenderMode(store.requirePod(podId), machineDesign()));

    return;
  }

  const next = RENDER_MODES.find((known) => known === mode);

  if (next === undefined) {
    throw new Error(`Render mode must be full or ascii, not "${mode}".`);
  }

  store.updatePod(podId, (pod) => ({ ...pod, renderMode: next }));
  console.log(`Pod ${podId} now renders its UX review as ${next}.`);
};

/** The pod's display name. The id and slug never change. */
export const runRename = (podId: string, title: string): void => {
  const trimmed = title.trim();

  if (trimmed === '') {
    throw new Error('A pod title cannot be empty.');
  }

  const store = openStore();
  const byAgent = callerAgent() !== undefined;

  // A name the owner chose is theirs: the dev names a pod once, never over it.
  if (byAgent && store.requirePod(podId).titleBy === 'owner') {
    console.log(RENAME_REFUSED());

    return;
  }

  store.updatePod(podId, (pod) => ({
    ...pod,
    title: trimmed,
    titleBy: byAgent ? 'agent' : 'owner',
  }));
  console.log(`Pod ${podId} is now "${trimmed}".`);
};

/** Printed to the person: `You named this pod — keeping your name.` */
export const RENAME_REFUSED = (
  name: string | undefined = ownerName()
): string => {
  const who = ownerForPerson(name);

  return `${who.charAt(0).toUpperCase()}${who.slice(
    1
  )} named this pod — keeping ${name === undefined ? 'your' : 'that'} name.`;
};

export const runSetEpic = (podId: string, epicId: string): void => {
  openStore().updatePod(podId, (pod) => ({ ...pod, epicId }));
  console.log(`Pod ${podId} epic = ${epicId}.`);
};

/**
 * Check the pod's worktree out at the latest base (start of every phase):
 * origin's default branch, or the ref `_base.json` names — then write the
 * pod's instructions again.
 */
export const runSync = (podId: string): void => {
  const pod = openStore().requirePod(podId);

  if (!pod.ownsWorktree) {
    writeInstructionsFor(pod);
    console.log(
      `Pod ${podId} uses ${pod.worktreePath} (--workdir); not syncing a checkout it does not own. Its instructions were rewritten.`
    );

    return;
  }

  const ref = refreshBase(currentProject().root, podBase());
  resetInstructions(pod.worktreePath);
  git(pod.worktreePath, ['checkout', '--detach', '--quiet', ref]);
  writeInstructionsFor(pod);
  console.log(
    `Pod ${podId} worktree now at ${ref} ${git(pod.worktreePath, [
      'rev-parse',
      '--short',
      'HEAD',
    ]).trim()}.`
  );
};

export const runPause = (podId: string): void => {
  const store = openStore();
  const pod = store.updatePod(podId, (current) => ({
    ...current,
    status: 'paused',
  }));

  // The claim and the ticket's run are kept: Resume carries on at its step.
  // The three agents' windows stay open, their busy turns stopped.
  if (podKindOf(pod) === 'building') {
    const interrupted = interruptBusyAgents(store, pod);
    closeBuildingWindows(pod, { keepAgents: true });
    store.updateBuilding(podId, (state) => {
      const run = currentRun(state);

      return {
        ...state,
        productManager:
          state.productManager === undefined
            ? undefined
            : { ...state.productManager, awake: false },
        pause: {
          at: nowIso(),
          interrupted,
          ...(run === null ? {} : { ticket: run.id }),
        },
      };
    });
    console.log(
      `Paused ${podId} (its windows stay open${
        interrupted.length === 0
          ? ''
          : `; stopped mid-turn: ${interrupted.join(', ')}`
      }; its ticket is kept).`
    );

    return;
  }

  killSession(sessionName(podId));
  console.log(`Paused ${podId} (session stopped; state kept).`);
};

export const runResume = async (podId: string): Promise<void> => {
  const store = openStore();
  const pod = store.updatePod(podId, (current) => ({
    ...current,
    status: 'active',
  }));

  const pause =
    podKindOf(pod) === 'building' ? store.readBuilding(podId).pause : undefined;
  const outcome = await ensurePodRunning(store, pod);

  // A building pod's agents kept running through the pause: the
  // Engineering manager is told who it stopped, and what to carry on with.
  if (podKindOf(pod) === 'building') {
    const { unbriefed = [] } = store.readBuilding(podId);
    const state = store.updateBuilding(
      podId,
      ({ pause: _done, unbriefed: _briefed, ...rest }) => ({
        ...rest,
        // Blocks before now no longer count toward the breaker's pause.
        resumedAt: nowIso(),
      })
    );
    // Agents started while paused were told nothing: their opening first.
    await briefRoles(store, podId, unbriefed);
    const note = outcome.result === 'running' ? resumeNote(state, pause) : null;

    if (note !== null) {
      await sendMessage(store, {
        podId,
        target: 'engineering-manager',
        command: '',
        text: note,
        mode: 'note',
        from: 'system',
      });
      console.log(`Resumed ${podId}; told the Engineering manager.`);

      return;
    }

    if (outcome.result === 'running') {
      console.log(`Resumed ${podId}.`);

      return;
    }
  }

  if (outcome.result === 'running') {
    console.log(`Pod ${podId} is already running.`);

    return;
  }

  if (outcome.result === 'starting') {
    console.log(`Pod ${podId} is already being started.`);

    return;
  }

  console.log(
    `Resumed ${podId}${
      outcome.resent.length > 0
        ? `; re-sent ${outcome.resent.length} message(s)`
        : ''
    }.`
  );
  outcome.errors.forEach((error) => console.warn(`⚠ ${error}`));
};

/**
 * Take a pod's working copy away: an owned worktree goes as a whole; a
 * folder it doesn't own stays, with only this pod's manager folder and the
 * commands only it wrote there removed.
 */
const removeWorkdir = (pod: Pod, repo: string): void => {
  if (pod.ownsWorktree && fs.existsSync(pod.worktreePath)) {
    git(repo, ['worktree', 'remove', '--force', pod.worktreePath]);

    return;
  }

  if (!pod.ownsWorktree) {
    removePodInstructions(pod.devCwd, pod.id);
    fs.rmSync(pod.managerCwd, { recursive: true, force: true });
  }
};

/**
 * A building pod ending: its claims left for the runner to release (the
 * current ticket goes back to Ready; a blocked one stays blocked), its
 * unreported ships left for the runner to report, and the
 * computer's record cleared, before anything that can fail; then its
 * windows closed, and the current ticket's uncommitted work set aside so
 * the next ticket's ship doesn't commit it.
 */
const endBuilding = (store: PodStore, pod: Pod): void => {
  // Under the building lock: a pick-up checks the pod is active and appends
  // its run under the same lock, so it either lands before this read (and
  // its claim is left here) or sees the pod done and takes nothing.
  const state = store.updateBuilding(pod.id, (latest) => {
    const current = currentRun(latest);
    // The current run's claim, and any blocked run's the runner hadn't
    // released yet: it only ticks pods that aren't done.
    latest.runs
      .filter(
        (one) =>
          one.claim === 'claimed' &&
          (one === current || one.blocked !== undefined)
      )
      .forEach((one) => leaveRelease(store.root, one.id, pod.projectId));
    // A ship the runner hadn't reported: its claim stays, marked shipped.
    latest.runs
      .filter((one) => one.shippedAt !== undefined && one.shipReported !== true)
      .forEach((one) => leaveShip(store.root, one.id, pod.projectId));

    return latest;
  });
  const run = currentRun(state);
  clearBuildingRecord(pod.id);
  // In the project's session the agents' windows stay where they are (the
  // next building pod starts its agents in them); in its own, it all goes.
  const shared = pod.tmuxSession !== undefined;

  if (shared) {
    interruptBusyAgents(store, pod);
  }

  closeBuildingWindows(pod, { keepAgents: shared });

  if (run === null) {
    return;
  }

  try {
    const stashed = setAsideWork(pod.devCwd, run.id, 'ended');

    if (stashed !== null) {
      console.log(`${run.id} was being built. ${setAsideText(stashed)}`);
    }
  } catch (error) {
    console.warn(
      `⚠ ${run.id}'s uncommitted work couldn't be set aside (${
        error instanceof Error ? error.message.trim() : String(error)
      }). Commit or stash it before the next ticket.`
    );
  }
};

const stopAgents = (store: PodStore, pod: Pod): void => {
  if (podKindOf(pod) === 'building') {
    endBuilding(store, pod);

    return;
  }

  killSession(sessionName(pod.id));
};

export const runDone = (podId: string, repo?: string): void => {
  const store = openStore();
  const pod = store.updatePod(podId, (current) => ({
    ...current,
    status: 'done',
  }));

  stopAgents(store, pod);

  removeWorkdir(pod, repo ?? (pod.ownsWorktree ? currentProject().root : ''));

  console.log(`Pod ${podId} is done. State kept at ${store.podDir(podId)}.`);
};

/** Printed to the person when an agent tries it. */
export const DELETE_REFUSED = (name?: string): string =>
  `Pod agents cannot delete pods — only ${ownerForPerson(name)} can.`;

/**
 * Remove a pod: stop its agents, drop its working copy, and move its state to
 * `<pods root>/.trash/` — recoverable by moving the folder back. Its tickets
 * are untouched. The person's action only: refused inside a pod.
 */
export const runDelete = (podId: string, repo?: string): void => {
  if (process.env.POD_ID !== undefined) {
    throw new Error(DELETE_REFUSED());
  }

  const store = openStore();
  // Done before its agents stop, as runDone: a building pod's pick-up then
  // takes nothing, so no claim is made after its claims are left.
  const pod = store.updatePod(podId, (current) => ({
    ...current,
    status: 'done',
  }));

  stopAgents(store, pod);

  removeWorkdir(pod, repo ?? (pod.ownsWorktree ? currentProject().root : ''));

  const source = store.podDir(podId);
  const trash = path.join(path.dirname(source), '.trash');
  const target = path.join(
    trash,
    `${podId}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(source, target);
  console.log(
    `Deleted pod ${podId}. Its state is in ${target} (move it back to restore). Its tickets were not touched.`
  );
};
