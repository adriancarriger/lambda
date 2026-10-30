import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { currentRun } from '../app/shared/building';
import { writeLambdaGitignore } from '../commands/init';
import { BUILDING_AGENT_WINDOWS } from '../commands/tmux';
import { lambdaHome, loadMachineConfig } from '../config/machineConfig';
import {
  PROJECT_CONFIG_FILE,
  ProjectConfigSchema,
  loadProjectConfig,
  resolvePodsRoot,
} from '../config/projectConfig';
import { readConfigFile } from '../config/readConfigFile';
import {
  BUILDING_ROLES,
  type BuildingState,
  type Pod,
  type PodStore,
  createPodStore,
  isIdle,
  nowIso,
} from '../pod-store';
import {
  COMMANDS_DIR,
  fillOwner,
  ourCommandFiles,
  prepareManagerFolder,
  writeCommandsIgnore,
} from '../pod/base';
import { startKind } from '../pod/claudeSessions';
import { agentWindow, podSessionOf } from '../pod/context';
import { launchAgent, writePodSettings } from '../pod/launch';
import { sendMessage } from '../pod/messaging';
import { ownerForAgent } from '../pod/owner';
import {
  hasWindow,
  killSession,
  killWindow,
  listWindows,
  sendKey,
  windowAtShell,
  windowCount,
} from '../pod/tmux';
import {
  INNER_COMMANDS,
  isLockedInstruction,
  resolveInstructions,
  withAddendum,
} from '../process/workflow-file';
import { computerName } from '../runner/hostRunner';
import { readRunnerInfo } from '../runner/localFiles';
import { listPodWindows, windowTag } from './windows';
import { buildingSteps } from './workflow';

/**
 * `lambda pod build`: a building pod on this computer, for the project here.
 * One per computer: an Engineering manager, a dev and a qa, each running
 * Claude with Lambda's building instructions, in the project's own checkout
 * (no worktree), so a shipped commit lands on the branch the project has
 * checked out. The windows go in lambda.json's `tmux.session` when the
 * project set one, beside its own windows; otherwise in the pod's own
 * session. They are always there, first and in this order: `manager` (the
 * Engineering manager), `qa`, `dev`. Pause stops a busy agent's turn but
 * keeps its window, and a window already open is started in place, never
 * doubled.
 */

/** `~/.lambda/building.json`: the building pod this computer runs. */
export const BUILDING_FILE = 'building.json';

interface BuildingRecord {
  podId: string;
  podsRoot: string;
  project: string;
}

const recordFile = (): string => path.join(lambdaHome(), BUILDING_FILE);

const readRecord = (): BuildingRecord | null => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));

    return typeof parsed === 'object' &&
      parsed !== null &&
      'podId' in parsed &&
      typeof parsed.podId === 'string' &&
      'podsRoot' in parsed &&
      typeof parsed.podsRoot === 'string' &&
      'project' in parsed &&
      typeof parsed.project === 'string'
      ? {
          podId: parsed.podId,
          podsRoot: parsed.podsRoot,
          project: parsed.project,
        }
      : null;
  } catch {
    return null;
  }
};

/** The computer's building pod, when it still has one that isn't done. */
export const buildingOnThisComputer = (): BuildingRecord | null => {
  const record = readRecord();

  if (record === null) {
    return null;
  }

  const pod = (() => {
    try {
      return createPodStore(record.podsRoot).readPod(record.podId);
    } catch {
      return null;
    }
  })();

  return pod === null || pod.status === 'done' ? null : record;
};

/** Writes the file only if it isn't there: false when it already was. */
const createdExclusively = (file: string, content: string): boolean => {
  try {
    fs.writeFileSync(file, content, { flag: 'wx' });

    return true;
  } catch (error) {
    // Not `instanceof Error`: fs errors can come from another realm.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      return false;
    }

    throw error;
  }
};

/** Forget it once it's done or deleted (another may then start). */
export const clearBuildingRecord = (podId: string): void => {
  if (readRecord()?.podId === podId) {
    fs.rmSync(recordFile(), { force: true });
  }
};

/** lambda.json's `tmux.session`, only when the project wrote it itself. */
export const explicitSession = (projectRoot: string): string | undefined => {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(projectRoot, PROJECT_CONFIG_FILE), 'utf8')
    );
    const session =
      typeof raw === 'object' &&
      raw !== null &&
      'tmux' in raw &&
      typeof raw.tmux === 'object' &&
      raw.tmux !== null &&
      'session' in raw.tmux
        ? raw.tmux.session
        : undefined;

    return typeof session === 'string' && session !== '' ? session : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Close the pod's windows: only its own in a shared `tmux.session` (the
 * project's other windows and the session stay), else its whole session.
 * `keepAgents`: the three agent windows stay (pause), only the rest go —
 * the Product manager's, ask forks'.
 */
export const closeBuildingWindows = (
  pod: Pod,
  options: { keepAgents?: boolean } = {}
): void => {
  const session = podSessionOf(pod);
  const agents = BUILDING_ROLES.map((role) => agentWindow(pod, role));

  if (pod.tmuxSession === undefined && options.keepAgents !== true) {
    killSession(session);

    return;
  }

  const open =
    pod.tmuxSession === undefined
      ? listWindows(session)
      : listPodWindows(session, pod.id);

  open
    .filter((name) => options.keepAgents !== true || !agents.includes(name))
    .forEach((name) => killWindow(`=${session}:=${name}`));
};

/**
 * What a role's window holds: nothing (`missing`); this pod's agent
 * (`ours`); a shell, or an agent of a pod that has ended (`free`: this pod
 * starts its agent there); or something of the project's own, never
 * touched (`theirs`). In the pod's own session everything open is its own.
 */
export type RoleWindow = 'missing' | 'ours' | 'free' | 'theirs';

export const roleWindowState = (pod: Pod, role: string): RoleWindow => {
  const session = podSessionOf(pod);
  const window = agentWindow(pod, role);

  if (!hasWindow(session, window)) {
    return 'missing';
  }

  if (windowAtShell(session, window)) {
    return 'free';
  }

  if (pod.tmuxSession === undefined) {
    return 'ours';
  }

  const tag = windowTag(session, window);

  return tag === pod.id ? 'ours' : tag === '' ? 'theirs' : 'free';
};

/** Exactly one window for each of the pod's three roles, each running its agent. */
export const buildingAgentsHealthy = (pod: Pod): boolean =>
  BUILDING_ROLES.every(
    (role) =>
      windowCount(podSessionOf(pod), agentWindow(pod, role)) === 1 &&
      ['ours', 'theirs'].includes(roleWindowState(pod, role))
  );

/**
 * Stop each of the pod's agents that's mid-turn — Escape, as at the
 * keyboard — and leave the idle ones alone (an Escape there could clear
 * something typed and not yet sent). Answers the roles it stopped.
 */
export const interruptBusyAgents = (store: PodStore, pod: Pod): string[] =>
  BUILDING_ROLES.filter(
    (role) =>
      roleWindowState(pod, role) === 'ours' &&
      !isIdle(store.readTurn(pod.id, role))
  ).map((role) => {
    sendKey(`=${podSessionOf(pod)}:=${agentWindow(pod, role)}`, 'Escape');

    return role;
  });

const ROLE_NAMES: Record<string, string> = {
  'engineering-manager': 'you',
  dev: 'the dev',
  qa: 'qa',
};

/** "you, the dev and qa" */
const roleList = (roles: string[]): string => {
  const names = roles.map((role) => ROLE_NAMES[role] ?? role);

  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

/**
 * What Resume tells the Engineering manager when its agents kept running
 * through the pause: who the pause stopped, and what to carry on with.
 * Null when no ticket was being built: the runner's next pick-up says it all.
 */
export const resumeNote = (
  state: BuildingState,
  pause: BuildingState['pause']
): string | null => {
  const run = currentRun(state);

  if (run === null) {
    return null;
  }

  const stopped =
    pause === undefined || pause.interrupted.length === 0
      ? 'Nobody was stopped mid-turn.'
      : `The pause stopped ${roleList(
          pause.interrupted
        )} mid-turn (Escape, at ${pause.at}).`;

  return `Resumed after a pause. ${stopped} Carry on with ${run.id} ${run.title} at ${run.step}, attempt ${run.attempt}: check the dev and qa first.`;
};

/** Each role's opening message: who it is, and what to wait for. */
export const briefRoles = async (
  store: PodStore,
  podId: string,
  roles: string[]
): Promise<void> =>
  roles.reduce(async (previous, role) => {
    await previous;
    const bootstrap = ROLE_BOOTSTRAP[role];

    if (bootstrap !== undefined) {
      await sendMessage(store, {
        podId,
        target: role,
        command: '',
        text: bootstrap(podId),
        mode: 'note',
        from: 'system',
      });
    }
  }, Promise.resolve());

const cwdOf = (pod: Pod, role: string): string =>
  role === 'engineering-manager' ? pod.managerCwd : pod.devCwd;

export const EM_BOOTSTRAP = (podId: string): string =>
  `You are the ENGINEERING MANAGER of building pod ${podId}. Your instructions are CLAUDE.md in this directory. The runner picks up each ticket for you and tells you here, so until it does there is nothing to do.`;

const ROLE_BOOTSTRAP: Record<string, (podId: string) => string> = {
  dev: (podId) =>
    `You are the DEV in building pod ${podId}. The Engineering manager sends you your work as slash commands (/start, /code-review, /ship). Wait for it.`,
  qa: (podId) =>
    `You are QA in building pod ${podId}. The Engineering manager sends you /check-ticket and /qa. Wait for it.`,
  'engineering-manager': EM_BOOTSTRAP,
};

/**
 * Start each role's agent: in its window when that's at a shell or held by
 * a pod that ended (kept in its place), else in a new window in its place.
 * A window running this pod's agent, or the project's own, is left as it
 * is. Fresh agents get their opening message; resumed ones are told where
 * they were.
 */
export const startBuildingAgents = async (
  store: PodStore,
  pod: Pod,
  mode: 'fresh' | 'resume'
): Promise<string[]> => {
  // Each role's start: a resume only of a conversation that exists (a role
  // with no id, or one whose first start never got going, starts fresh).
  const kinds = new Map<string, 'fresh' | 'resume'>();
  const started = await BUILDING_ROLES.reduce<Promise<string[]>>(
    async (previous, role) => {
      const done = await previous;

      if (['ours', 'theirs'].includes(roleWindowState(pod, role))) {
        return done;
      }

      const sessionId = pod.sessions[role] ?? randomUUID();
      const kind = startKind(mode, sessionId);
      kinds.set(role, kind);
      await launchAgent({
        pod,
        store,
        agent: role,
        cwd: cwdOf(pod, role),
        mode: { kind, sessionId },
      });

      // launchAgent marks it as the pod's in a shared session.
      return [...done, role];
    },
    Promise.resolve([])
  );

  const fresh = started.filter((role) => kinds.get(role) === 'fresh');

  // Paused: Claude starts, but is told nothing until the pod is resumed.
  if (pod.status === 'paused') {
    if (fresh.length > 0) {
      store.updateBuilding(pod.id, (state) => ({
        ...state,
        unbriefed: [...new Set([...(state.unbriefed ?? []), ...fresh])],
      }));
    }

    return started;
  }

  await briefRoles(store, pod.id, fresh);

  if (mode === 'fresh') {
    return started;
  }

  const run = currentRun(store.readBuilding(pod.id));

  if (started.includes('engineering-manager')) {
    await sendMessage(store, {
      podId: pod.id,
      target: 'engineering-manager',
      command: '',
      text:
        run === null
          ? 'This pod was restarted. No ticket is being built: the runner tells you when it picks up the next one.'
          : `This pod was restarted. Carry on with ${run.id} ${run.title} at ${run.step}, attempt ${run.attempt}: check the dev and qa first.`,
      mode: 'note',
      from: 'system',
    });
  }

  return started;
};

/**
 * The building commands the dev and qa run (each step's, and
 * `design-system-setup`), written into the checkout's
 * `.claude/commands/` and kept out of git by that folder's own ignore. A
 * command the project has is left as it is, except one of Lambda's quality
 * steps, which must be Lambda's own.
 */
export const writeBuildingInstructions = (
  pod: Pick<Pod, 'id' | 'devCwd' | 'managerCwd'>,
  owner: string
): void => {
  const root = pod.devCwd;
  const commandsDir = path.join(root, COMMANDS_DIR);
  // Lambda's earlier copies (this pod's last build, or a --workdir planning
  // pod's) are passed over when reading, so a command is Lambda's default
  // again rather than its own stale owner-filled copy.
  const ours = ourCommandFiles(root);
  const passOver = ours.map((file) => path.join(commandsDir, file));
  const filled = (name: string): string =>
    fillOwner(
      withAddendum(
        root,
        'building',
        name,
        fs.readFileSync(
          resolveInstructions(root, 'building', name, passOver),
          'utf8'
        )
      ),
      owner
    );
  // The steps' commands, and the ones a step runs in their place (the setup
  // ticket's dev gets /design-system-setup instead of /start).
  const names = [
    ...buildingSteps(root).flatMap((step) =>
      step.command === undefined ? [] : [step.command]
    ),
    ...INNER_COMMANDS.building,
  ];
  const theirs = (name: string): boolean =>
    fs.existsSync(path.join(commandsDir, `${name}.md`)) &&
    !ours.includes(`${name}.md`);
  // Every refusal before anything is written: a file written ahead of one
  // would be taken for the project's own on the next try, and never ignored.
  // lambda.json `building.ownCommands`: the project runs its own copy.
  const configFile = path.join(root, PROJECT_CONFIG_FILE);
  const own = fs.existsSync(configFile)
    ? readConfigFile(configFile, ProjectConfigSchema).building?.ownCommands ??
      []
    : [];
  const hiding = names.find(
    (name) =>
      theirs(name) &&
      isLockedInstruction('building', name) &&
      !own.includes(name)
  );

  if (hiding !== undefined) {
    throw new Error(
      `${path.join(
        commandsDir,
        `${hiding}.md`
      )} would hide Lambda's own /${hiding} from the building pod. Move it out of .claude/commands/ and start building again.`
    );
  }

  fs.writeFileSync(path.join(pod.managerCwd, 'CLAUDE.md'), filled('manager'));
  fs.mkdirSync(commandsDir, { recursive: true });
  const written = names.flatMap((name) => {
    if (theirs(name)) {
      return [];
    }

    fs.writeFileSync(path.join(commandsDir, `${name}.md`), filled(name));

    return [`${name}.md`];
  });
  // Under this pod's own section: a --workdir planning pod here keeps its own.
  writeCommandsIgnore(root, pod.id, written);
};

/** How many ids a new pod draws before giving up on finding a free one. */
const POD_ID_ATTEMPTS = 20;

/**
 * `<prefix>-<4 hex>`, drawn again while the store already has a pod by
 * that id: writing one over another would lose it.
 */
export const freshPodId = (
  store: Pick<PodStore, 'readPod'>,
  prefix: string,
  randomHex: () => string = () => randomBytes(2).toString('hex'),
  attempt = 1
): string => {
  if (attempt > POD_ID_ATTEMPTS) {
    throw new Error(
      `No free ${prefix} pod id after ${POD_ID_ATTEMPTS} tries. Delete some done pods and try again.`
    );
  }

  const id = `${prefix}-${randomHex()}`;

  return store.readPod(id) === null
    ? id
    : freshPodId(store, prefix, randomHex, attempt + 1);
};

export interface BuildDeps {
  projectRoot: string;
  /** This computer, as its Lambda knows it. */
  runner: { id: string; computer: string };
  print: (line: string) => void;
  /** The pod id's random part (default: 4 random hex digits). */
  randomHex?: () => string;
}

const defaultBuildDeps = (): BuildDeps => {
  const project = loadProjectConfig(process.cwd());

  if (project === null) {
    throw new Error('No codebase here: run lambda init first.');
  }

  const id = loadMachineConfig()?.runner?.id;

  if (id === undefined) {
    throw new Error(
      "This computer isn't part of a Lambda yet. Run lambda start (or lambda join) first."
    );
  }

  return {
    projectRoot: project.root,
    runner: { id, computer: readRunnerInfo()?.name ?? computerName() },
    print: (line) => console.log(line),
  };
};

/**
 * `paused`: the pod is made paused, so it takes no ticket until someone
 * resumes it. How Lambda makes the one it keeps on every computer.
 */
export const runBuild = async (
  options: { projectId?: string; launch?: boolean; paused?: boolean },
  deps: BuildDeps = defaultBuildDeps()
): Promise<string> => {
  const project = loadProjectConfig(deps.projectRoot);

  if (project === null) {
    throw new Error('No codebase here: run lambda init first.');
  }

  const projectName = project.config.name ?? path.basename(project.root);

  // A mirror can claim nothing, so its pod would only keep agents waiting.
  if (project.config.tickets?.readOnly === true) {
    throw new Error(
      `${projectName} is read-only: it mirrors its tracker, so nothing is built from it.`
    );
  }

  const alreadyBuilding = (busy: BuildingRecord): Error =>
    new Error(
      `${deps.runner.computer} is already building ${busy.project}. Add another computer to build two tickets at once.`
    );
  const busy = buildingOnThisComputer();

  if (busy !== null) {
    throw alreadyBuilding(busy);
  }

  const podsRoot = resolvePodsRoot(project);
  fs.mkdirSync(podsRoot, { recursive: true });
  const store = createPodStore(podsRoot);
  const id = freshPodId(store, 'build', deps.randomHex);
  writeLambdaGitignore(project.root);
  const managerCwd = prepareManagerFolder(project.root, id);
  const tmuxSession = explicitSession(project.root);
  const pod: Pod = {
    id,
    slug: 'build',
    title: projectName,
    createdAt: nowIso(),
    status: options.paused === true ? 'paused' : 'active',
    phase: 1,
    completedCheckpoints: [],
    worktreePath: project.root,
    ownsWorktree: false,
    managerCwd,
    devCwd: project.root,
    agentCommand: 'claude',
    sessions: Object.fromEntries(
      [...BUILDING_ROLES, 'product-manager'].map((role) => [role, randomUUID()])
    ),
    kind: 'building',
    runnerId: deps.runner.id,
    ...(options.projectId === undefined
      ? {}
      : { projectId: options.projectId }),
    ...(tmuxSession === undefined ? {} : { tmuxSession }),
  };

  // Written before the pod exists: a refusal (the project's own command
  // would hide a locked step) must leave no pod for the runner to tick.
  try {
    writeBuildingInstructions(pod, ownerForAgent());
  } catch (error) {
    fs.rmSync(managerCwd, { recursive: true, force: true });

    throw error;
  }
  store.writePod(pod);
  store.writeBuilding(id, { runs: [], upNext: [] });
  // No `pods.deny`: it is for planning pods only, since a building Dev runs
  // the project's ship command and its fixes itself.
  writePodSettings(store, id, {
    projectRoot: project.root,
    cli: project.config.cli,
  });
  const record = `${JSON.stringify({
    podId: id,
    podsRoot,
    project: projectName,
  })}\n`;

  const giveUp = (error: Error): never => {
    fs.rmSync(store.podDir(id), { recursive: true, force: true });
    fs.rmSync(managerCwd, { recursive: true, force: true });

    throw error;
  };

  // Created, never overwritten: of two starts that both passed the check
  // above, only the first gets the computer. A record left by a pod that's
  // gone is stale, and replaced under a lock, checked again once held: two
  // starts that both found it stale would otherwise both replace it.
  if (!createdExclusively(recordFile(), record)) {
    const lock = `${recordFile()}.lock`;

    if (!createdExclusively(lock, '')) {
      giveUp(
        new Error(
          `Another lambda pod build is starting on this computer. Try again in a moment (or remove ${lock} if none is).`
        )
      );
    }

    try {
      const other = buildingOnThisComputer();

      if (other !== null) {
        giveUp(alreadyBuilding(other));
      }

      fs.writeFileSync(recordFile(), record);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
  deps.print(
    `Created Lambda ${id}${
      options.paused === true
        ? ' (paused: it takes no ticket until resumed)'
        : ''
    }`
  );

  if (options.launch === false) {
    return id;
  }

  const started = await startBuildingAgents(store, pod, 'fresh');
  const kept = BUILDING_ROLES.filter((role) => !started.includes(role));
  deps.print(
    `  tmux:     ${podSessionOf(pod)} (windows: ${BUILDING_AGENT_WINDOWS.join(
      ', '
    )}${
      kept.length === 0
        ? ''
        : `; already there: ${kept
            .map((role) => agentWindow(pod, role))
            .join(', ')}`
    })`
  );
  // Nothing is started in a window running something of the project's own.
  kept.forEach((role) =>
    deps.print(
      `  ⚠ No agent was started in ${agentWindow(
        pod,
        role
      )}: something of the project's runs there. Run Claude in it, or ${
        role === 'engineering-manager'
          ? 'nothing runs the build loop'
          : `the Engineering manager has no ${role} to work with`
      }.`
    )
  );

  return id;
};
