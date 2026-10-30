import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { toSendKeysCalls } from '../app/server/keys';
import { refreshStaleCards } from '../app/server/liveCards';
import { madeHere } from '../app/server/prototypes';
import { buildPodDetail, buildState } from '../app/server/state';
import { createBudget } from '../app/server/tts/budget';
import { loadTtsConfig } from '../app/server/tts/config';
import {
  renderWithTimestamps,
  streamSpeech,
} from '../app/server/tts/elevenlabs';
import { type ForkKokoro, createKokoro } from '../app/server/tts/kokoro';
import { createRenderer } from '../app/server/tts/renderer';
import { createWatchdogRunner } from '../app/server/watchdogRunner';
import { currentRun } from '../app/shared/building';
import { podName } from '../app/shared/podName';
import { podNumber } from '../app/shared/podOrder';
import type {
  PodActivity,
  PodIntake,
  PodSnapshot,
} from '../app/shared/snapshot';
import { itemSections, sectionParts } from '../app/shared/speech';
import type {
  AppState,
  InboxEntry,
  OtherWindow,
  Panes,
  TimeSummary,
  TtsStatus,
} from '../app/shared/types';
import {
  POD_WINDOW_FORMAT,
  POD_WINDOW_OPTION,
  podWindowsOf,
} from '../building/windows';
import { lambdaHome } from '../config/machineConfig';
import {
  SCRATCH_WINDOW,
  loadProjectConfig,
  resolvePodsRoot,
} from '../config/projectConfig';
import { isMidTurn } from '../mothership/computers';
import {
  type PodStore,
  type RenderMachine,
  createPodStore,
} from '../pod-store';
import { agentWindowOf, sessionName } from '../pod/context';
import { RESUME_ALL_TIMEOUT_MS } from './budgets';
import { computerName } from './hostRunner';
import { readRunnerInfo } from './localFiles';
import { reportedMachineDesign } from './machineDesign';
import {
  type PodFileAnswer,
  type PodFileRequest,
  servePodFile,
} from './podFiles';
import { buildingDetail } from './podPage';
import { SYSTEM_SESSION } from './processes';

/**
 * One project folder's pods, on the runner that holds it: the pod store,
 * the watchdog, the audio, and every action — each through `lambda pod`.
 * The mothership asks; this answers.
 */

export type LambdaCli = (
  args: string[],
  options: { cwd: string; timeoutMs?: number }
) => Promise<string>;

export type Tmux = (args: string[]) => string;

export interface PodHostDeps {
  folder: string;
  lambda: LambdaCli;
  /** Start `lambda pod new` and answer once it prints the new pod's id. */
  spawnLambda: (args: string[], cwd: string) => ChildProcess;
  tmux: Tmux;
  /** Something changed: push the snapshots. */
  onChange: () => void;
  log: (line: string) => void;
  /**
   * Is this computer on this project? Off it, the pods' sessions were
   * stopped on purpose: the watchdog must not nudge them back.
   */
  isCurrent: () => boolean;
  /** This computer's name, for a building pod's page. */
  computer?: string;
  /** For `~/.lambda/` (the machine's one audio budget). */
  env?: Record<string, string | undefined>;
  /**
   * Whether this computer can use Claude Design, as the runner reports it
   * with its status: the workflow view's render mode and Full switch.
   */
  machine?: () => RenderMachine;
  now?: () => number;
  /** For tests: starting Kokoro's model process. */
  forkKokoro?: ForkKokoro;
  /** For tests: watching the pods folder. */
  watch?: (root: string, onChange: (name: string | null) => void) => Watcher;
}

/** What the host needs of an `fs.watch` watcher. */
interface Watcher {
  on: (event: 'error', listener: (error: Error) => void) => unknown;
  close: () => void;
}

const watchPods = (
  root: string,
  onChange: (name: string | null) => void
): fs.FSWatcher =>
  fs.watch(root, { recursive: true }, (_event, name) =>
    onChange(name === null ? null : String(name))
  );

export interface PodHost {
  folder: string;
  store: PodStore;
  snapshots: () => { pods: PodSnapshot[]; tts: TtsStatus };
  handle: (
    action: string,
    podId: string | undefined,
    body: Record<string, unknown>
  ) => Promise<unknown>;
  newPod: (intake: PodIntake, projectId?: string) => Promise<string>;
  termRead: (
    podId: string,
    window: string
  ) => { screen: string; cols: number; rows: number };
  termKeys: (podId: string, window: string, hex: unknown[]) => string;
  /** `pod-file`: one file of a pod's screenshots, designs, shots or prototype. */
  podFile: (request: PodFileRequest) => PodFileAnswer | null;
  /** Every active pod's worktree: where events can be written. */
  worktrees: () => { podId: string; path: string }[];
  dispose: () => void;
}

const str = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];

  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing "${key}"`);
  }

  return value;
};

const optStr = (
  body: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = body[key];

  return typeof value === 'string' && value !== '' ? value : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// The mothership is ours: a shape check on the top-level keys is enough.
const isTimeSummary = (value: unknown): value is TimeSummary =>
  isRecord(value) && isRecord(value.days) && isRecord(value.pods);

const timeOf = (body: Record<string, unknown>): TimeSummary => {
  const { time } = body;

  if (!isTimeSummary(time)) {
    throw new Error('Missing "time"');
  }

  return time;
};

/** A file's bytes for the mothership to serve, or null. */
const fileResult = (
  file: string | null,
  headers: Record<string, string> = {}
): { base64: string; headers: Record<string, string> } | null =>
  file === null || !fs.existsSync(file)
    ? null
    : { base64: fs.readFileSync(file).toString('base64'), headers };

/** The pod's agents, from its `turns/` folder (manager, dev, forks). */
const agentsOf = (store: PodStore, podId: string): string[] => {
  const dir = store.file(podId, 'turns');

  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
    : ['manager', 'dev'];
};

const ms = (iso: string | undefined): number => {
  const parsed = iso === undefined ? NaN : Date.parse(iso);

  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * What the idle switch reads about one pod. `since` is when this computer
 * arrived on the project: a pod it just resumed or made has had no turn yet,
 * and must not read as idle for ever.
 */
export const podActivity = (
  store: PodStore,
  podId: string,
  since = 0
): PodActivity => {
  const turns = agentsOf(store, podId).map((agent) =>
    store.readTurn(podId, agent)
  );
  const requests = store.listRequests(podId);
  // A building pod on a ticket is busy between turns too; with nothing
  // Ready it's idle, like any pod no one is working in.
  const building =
    store.readPod(podId)?.kind === 'building' &&
    currentRun(store.readBuilding(podId)) !== null;

  return {
    midTurn: building || turns.some(isMidTurn),
    openRequest: requests.some((request) => request.status !== 'done'),
    lastActivityAt: Math.max(
      since,
      ...turns.map((turn) => ms(turn.endedAt)),
      ...requests.flatMap((request) => [
        ms(request.createdAt),
        ms(request.startedAt),
        ms(request.doneAt),
      ])
    ),
  };
};

/** Today's POST table, as `lambda pod` arguments. */
export const podActionArgs = (
  action: string,
  body: Record<string, unknown>
): string[] | null => {
  const podId = (): string => str(body, 'podId');
  const about = optStr(body, 'about');
  const aboutArgs = about === undefined ? [] : ['--about', about];

  switch (action) {
    case 'answer':
      return [
        'answer',
        podId(),
        str(body, 'qid'),
        ...(body.acceptRec === true
          ? ['--accept-rec']
          : ['--text', str(body, 'text')]),
      ];
    case 'checkpoint-complete':
      return [
        'checkpoint',
        'complete',
        podId(),
        '--cp',
        String(body.cp),
        ...(body.keepOne === true ? ['--keep-one'] : []),
      ];
    case 'chat':
      return ['chat', podId(), ...aboutArgs, '--', str(body, 'text')];
    case 'carry-on':
      return ['carry-on', podId()];
    case 'rename':
      return ['rename', podId(), '--', str(body, 'title')];
    case 'render-mode':
      return ['render-mode', podId(), str(body, 'mode')];
    case 'delete':
      return ['delete', podId()];
    case 'nudge':
      return ['nudge', podId()];
    case 'structure':
      return ['structure', podId()];
    case 'skip':
      return ['skip', podId(), str(body, 'stage')];
    case 'pause':
      return ['pause', podId()];
    case 'resume':
      return ['resume', podId()];
    case 'pm-chat':
      return ['pm-chat', podId(), '--', str(body, 'text')];
    case 'chat/send':
      return [
        'fork',
        'chat',
        podId(),
        ...aboutArgs,
        ...(body.hold === true ? ['--hold'] : []),
        '--',
        str(body, 'text'),
      ];
    case 'request/add': {
      const qid = optStr(body, 'qid');

      return [
        'request',
        'add',
        '--pod',
        podId(),
        '--quote',
        str(body, 'quote'),
        ...(qid === undefined ? [] : ['--qid', qid]),
        '--',
        str(body, 'summary'),
      ];
    }
    case 'fork/send':
      return [
        'fork',
        'send',
        podId(),
        str(body, 'qid'),
        '--',
        str(body, 'text'),
      ];
    case 'fork/close': {
      const text = optStr(body, 'text');

      return [
        'fork',
        'close',
        podId(),
        str(body, 'qid'),
        ...(text === undefined ? [] : ['--text', text]),
      ];
    }
    case 'fork/park':
      return ['fork', 'park', podId(), str(body, 'qid')];
    case 'fork/discard':
      return ['fork', 'discard', podId(), str(body, 'qid')];
    default:
      return null;
  }
};

/** Started and left to boot (they take a minute): answered at once. */
export const BACKGROUND_ACTIONS: Record<
  string,
  (body: Record<string, unknown>) => string[]
> = {
  'fork/warm': (body) => [
    'fork',
    'start',
    str(body, 'podId'),
    str(body, 'qid'),
  ],
  'chat/warm': (body) => ['fork', 'chat-warm', str(body, 'podId')],
};

/**
 * Actions slower than the usual 3 minutes. A resume starts a building pod's
 * three agents one after another, each given up to 90 seconds to be ready:
 * cut short, it would leave its start lock behind for 10 minutes.
 */
export const ACTION_TIMEOUTS_MS: Record<string, number> = {
  resume: RESUME_ALL_TIMEOUT_MS,
};

/** How long `lambda pod new` has to say it made the pod. */
export const NEW_POD_TIMEOUT_MS = 3 * 60_000;

/** "Created Lambda <id>" in `lambda pod new`'s output. */
export const CREATED_POD = /Created Lambda ([a-z0-9-]+)/;

/** How many top items also get their next sections rendered ahead. */
const LOOKAHEAD_ITEMS = 3;
const LOOKAHEAD_CLIPS = 3;

export const createPodHost = (deps: PodHostDeps): PodHost => {
  const { folder } = deps;
  const project = loadProjectConfig(folder);

  if (project === null) {
    throw new Error(`There's no lambda.json at ${folder}.`);
  }

  const root = resolvePodsRoot(project);
  fs.mkdirSync(root, { recursive: true });
  const store = createPodStore(root);
  const background = new Set<ChildProcess>();
  // A host is made when the computer arrives on its project.
  const arrivedAt = (deps.now ?? Date.now)();

  /**
   * The pod's own windows. In a project's shared `tmux.session` that's only
   * the ones tagged with its id: the project's `scratchPad` and the rest
   * there are neither the pod's tabs nor a sign it's running.
   */
  const windowsFor = (podId: string): string[] => {
    const session = `=${sessionName(podId, store)}`;

    if (store.readPod(podId)?.tmuxSession !== undefined) {
      return podWindowsOf(
        deps.tmux(['list-windows', '-t', session, '-F', POD_WINDOW_FORMAT]),
        podId
      );
    }

    return deps
      .tmux(['list-windows', '-t', session, '-F', '#{window_name}'])
      .split('\n')
      .filter((name) => name !== '');
  };

  /** A session's windows that are no pod's (untagged), by tmux id. */
  const untaggedWindows = (
    session: string,
    group: OtherWindow['group']
  ): OtherWindow[] =>
    deps
      .tmux([
        'list-windows',
        '-t',
        `=${session}`,
        '-F',
        `#{window_id}\t#{window_name}\t#{${POD_WINDOW_OPTION}}`,
      ])
      .split('\n')
      .flatMap((line) => {
        const [id = '', name = '', tag = ''] = line.split('\t');

        const typable = group === 'project' && name === SCRATCH_WINDOW;

        return /^@\d+$/.test(id) && tag === ''
          ? [{ id, name, group, typable }]
          : [];
      });

  /**
   * What the Agents panel shows besides the pod's agents: the project's own
   * session, then Lambda's. Only these may be read by tmux id, so the panel
   * can never reach any other session on the computer.
   */
  const otherWindows = (): OtherWindow[] => [
    ...untaggedWindows(project.config.tmux.session, 'project'),
    ...untaggedWindows(SYSTEM_SESSION, 'lambda'),
  ];

  /** The tmux target for a panel window: an agent by name, others by id. */
  const paneTarget = (podId: string, window: string): string => {
    if (!window.startsWith('@')) {
      return `=${sessionName(podId, store)}:${agentWindowOf(
        podId,
        window,
        store
      )}`;
    }

    if (!otherWindows().some((other) => other.id === window)) {
      throw new Error(
        `Window ${window} isn't one of this codebase's or Lambda's.`
      );
    }

    return window;
  };

  const panes = (podId: string): Panes => ({
    others: otherWindows(),
    working: windowsFor(podId).filter((window) => {
      try {
        return isMidTurn(store.readTurn(podId, window));
      } catch {
        // A fork's window has no turn file of its own.
        return false;
      }
    }),
  });

  const pod = (args: string[], timeoutMs = 180_000): Promise<string> =>
    deps.lambda(['pod', ...args], { cwd: folder, timeoutMs });

  const inBackground = (args: string[]): void => {
    const child = deps.spawnLambda(['pod', ...args], folder);
    background.add(child);
    // Read, or a child with more to say than a pipe holds blocks for ever;
    // the end of stderr is kept to say why one failed.
    const said = { tail: '' };
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      said.tail = `${said.tail}${chunk.toString('utf8')}`.slice(-1000);
    });
    // `close`, not `exit`: stderr's last words can arrive after the exit.
    child.on('close', (code) => {
      background.delete(child);

      if (code !== null && code !== 0) {
        deps.log(
          `lambda pod ${
            args[0] ?? ''
          } failed (exit ${code}): ${said.tail.trim()}`
        );
      }
    });
    child.on('error', (error) => {
      background.delete(child);
      deps.log(`lambda pod ${args[0] ?? ''} didn't run: ${error.message}`);
    });
  };

  // ── audio (ElevenLabs when a key is set; Kokoro in the Mac app; else off)
  const liveTts = () => loadTtsConfig(root);
  const tts = liveTts();
  // The renderer decides what matters most; Kokoro asks it before every piece.
  const kokoro =
    tts.provider === 'kokoro'
      ? createKokoro(
          tts,
          (text) => renderer.priorityOf(text),
          (event) => deps.log(`tts ${JSON.stringify(event)}`),
          deps.forkKokoro
        )
      : null;
  const budget = createBudget({
    // One budget per computer: the cap is what this machine spends a month.
    file: path.join(lambdaHome(deps.env ?? process.env), 'tts-usage.json'),
    // Local rendering costs nothing, so the budget never refuses it.
    usdPer1kChars: kokoro === null ? tts.usdPer1kChars : 0,
    capUsd: tts.monthlyCapUsd,
  });
  const audioOn = (): boolean =>
    kokoro !== null ||
    (tts.provider === 'elevenlabs' && liveTts().apiKey !== undefined);
  const renderer = createRenderer({
    audioDir: (podId) => store.file(podId, 'audio'),
    render: (text) =>
      kokoro === null
        ? renderWithTimestamps(liveTts(), text)
        : kokoro.render(text),
    cancel: (text) => kokoro?.cancel(text),
    poke: () => kokoro?.poke(),
    budget,
    enabled: audioOn,
    // Part of each clip's cache key, so switching provider never serves the other's audio.
    voiceId: kokoro === null ? tts.voiceId : tts.kokoroVoice,
    modelId:
      kokoro === null ? tts.modelId : `kokoro-82m-${tts.kokoroDtype}-chunked`,
    // Kokoro: every clip, its piece queue picks by live priority.
    concurrency: kokoro === null ? 2 : Number.POSITIVE_INFINITY,
    onChange: () => deps.onChange(),
  });
  // The model loads when audio is first asked for, not at every start.
  const warmed = { done: false };
  const warmKokoro = (): void => {
    if (kokoro === null || warmed.done) {
      return;
    }

    warmed.done = true;
    kokoro.warm();
  };
  const released = new Set<string>();
  const focused: { podId: string | null; key: string | null } = {
    podId: null,
    key: null,
  };

  const watchdog = createWatchdogRunner({
    store,
    windowsFor,
    capture: (podId, agent) =>
      deps.tmux([
        'capture-pane',
        '-p',
        '-t',
        `=${sessionName(podId, store)}:${agent}`,
      ]),
    nudge: (podId) => pod(['nudge', podId]),
    resend: (podId, msgId) => pod(['deliver', podId, msgId]),
    onChange: () => deps.onChange(),
  });

  /**
   * The inbox plus each item's per-section audio. An item enters the inbox
   * once its first clip is ready or failed (so play starts at once); until
   * then its pod reads as Working.
   */
  const stateWithAudio = (): AppState => {
    const state = buildState(store, windowsFor, watchdog.escalated());
    const speechFor = (entry: InboxEntry) => {
      if (entry.kind === 'stalled') {
        return [];
      }

      const summary = state.pods.find(
        (candidate) => candidate.pod.id === entry.podId
      );
      const question =
        entry.qid === undefined
          ? null
          : (state.questions[entry.podId] ?? []).find(
              (candidate) => candidate.id === entry.qid
            ) ?? null;
      const sections = itemSections({
        kind: entry.kind,
        question,
        thread: store.readThread(entry.podId),
        podLabel: summary === undefined ? entry.podId : podName(summary.pod),
        decisions:
          entry.kind === 'checkpoint'
            ? store.readAutonomousDecisions(entry.podId)
            : undefined,
        questions: state.questions[entry.podId] ?? [],
        humanDecisions: store.readHumanDecisions(entry.podId),
        stalledReason: entry.reason,
        structureProposal: summary?.pod.structureProposal,
        pod: summary?.pod,
        podNumber: podNumber(state.pods, state.priority, entry.podId),
      });

      return (sections ?? []).flatMap((section) =>
        sectionParts(section).map((part) => ({
          key: part.key,
          label: section.label,
          text: part.text,
        }))
      );
    };
    const withClips = audioOn()
      ? state.inbox.map((entry) => ({ entry, speech: speechFor(entry) }))
      : state.inbox.map((entry) => ({ entry, speech: [] }));

    if (audioOn()) {
      renderer.prefetch([
        ...withClips.flatMap(({ entry, speech }) =>
          speech.slice(0, 1).map(({ text }) => ({ podId: entry.podId, text }))
        ),
        ...withClips
          .slice(0, LOOKAHEAD_ITEMS)
          .flatMap(({ entry, speech }) =>
            speech
              .slice(1, LOOKAHEAD_CLIPS)
              .map(({ text }) => ({ podId: entry.podId, text }))
          ),
      ]);
    }

    const withAudio = withClips.map(({ entry, speech }) => {
      const clips = Object.fromEntries(
        speech.map(({ key, text }) => [key, renderer.clip(entry.podId, text)])
      );
      const first = speech[0] === undefined ? undefined : clips[speech[0].key];
      const ready =
        first === undefined ||
        first.status === 'ready' ||
        first.status === 'unavailable' ||
        released.has(entry.key);

      return { entry: { ...entry, audio: { clips } }, ready };
    });
    const present = new Set(withClips.map(({ entry }) => entry.key));
    [...released]
      .filter((key) => !present.has(key))
      .forEach((key) => released.delete(key));
    withAudio
      .filter(({ ready }) => ready)
      .forEach(({ entry }) => released.add(entry.key));
    const inbox = withAudio
      .filter(({ ready }) => ready)
      .map(({ entry }) => entry);
    const pods = state.pods.map((summary) => {
      const needsYou = inbox.filter(
        (item) => item.podId === summary.pod.id && item.kind !== 'stalled'
      ).length;

      return {
        ...summary,
        needsYou,
        status:
          summary.status === 'needs-you' && needsYou === 0
            ? 'working'
            : summary.status,
      };
    });
    const usage = budget.status();
    const refused = inbox.some((entry) =>
      Object.values(entry.audio?.clips ?? {}).some(
        (clip) =>
          clip.status === 'unavailable' &&
          (clip.reason === 'over-budget' || clip.reason.includes('quota'))
      )
    );
    const waiting = renderer.queued();

    return {
      ...state,
      pods,
      inbox,
      tts: {
        queue: {
          queued: waiting.length,
          pods: new Set(waiting.map((clip) => clip.podId)).size,
        },
        enabled: audioOn(),
        renderCharsPerSecond: null,
        overBudget: usage.overBudget || refused,
        usd: usage.usd,
        capUsd: usage.capUsd,
      },
    };
  };

  const snapshots = (): { pods: PodSnapshot[]; tts: TtsStatus } => {
    const state = stateWithAudio();

    return {
      pods: state.pods.map((summary) => {
        const rank = state.priority.indexOf(summary.pod.id);

        return {
          podId: summary.pod.id,
          summary,
          inbox: state.inbox.filter((entry) => entry.podId === summary.pod.id),
          questions: state.questions[summary.pod.id] ?? [],
          rank: rank === -1 ? state.priority.length : rank,
          activity: podActivity(store, summary.pod.id, arrivedAt),
        };
      }),
      tts: state.tts ?? {
        queue: { queued: 0, pods: 0 },
        enabled: false,
        overBudget: false,
        usd: 0,
        capUsd: 0,
        renderCharsPerSecond: null,
      },
    };
  };

  // ── live updates ─────────────────────────────────────────────────────────
  const debounced = (() => {
    const state: { timer?: NodeJS.Timeout } = {};

    return () => {
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
      }

      state.timer = setTimeout(() => deps.onChange(), 200);
    };
  })();
  const watcher = (deps.watch ?? watchPods)(root, (name) => {
    if (name !== null && name.startsWith('_time.json')) {
      return;
    }

    debounced();
  });
  // EMFILE, ENOSPC, the folder removed: unheard, an 'error' ends the runner.
  watcher.on('error', (error: Error) =>
    deps.log(
      `Stopped watching the pods for changes: ${error.message}. They're still read every 5 seconds.`
    )
  );

  const refreshTried = new Map<string, number>();
  const refreshing = new Set<string>();
  const mtimeOf = (file: string): number | null => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  };

  const timers = [
    // Tmux windows come and go without file changes.
    setInterval(debounced, 5000),
    // Cards edited like a doc: re-read an open checkpoint's files into it.
    setInterval(() => {
      void refreshStaleCards({
        store,
        mtimeOf,
        tried: refreshTried,
        refreshing,
        refresh: ({ podId, cp }) =>
          pod(['checkpoint', 'refresh', podId, '--cp', String(cp)]),
        log: deps.log,
      });
    }, 2000),
    setInterval(() => {
      if (!deps.isCurrent()) {
        return;
      }

      try {
        watchdog.tick();
      } catch (error) {
        deps.log(`watchdog tick failed: ${String(error)}`);
      }
    }, 15_000),
    setInterval(() => {
      if (!deps.isCurrent()) {
        return;
      }

      pod(['fork', 'watchdog']).catch((error: unknown) =>
        deps.log(`fork watchdog failed: ${String(error)}`)
      );
    }, 30_000),
  ];

  // ── actions and reads ────────────────────────────────────────────────────
  const reads: Record<
    string,
    (podId: string, body: Record<string, unknown>) => unknown | Promise<unknown>
  > = {
    detail: (podId, body) =>
      buildPodDetail(
        store,
        podId,
        windowsFor(podId),
        timeOf(body),
        (deps.machine ?? (() => reportedMachineDesign(deps.env)))()
      ),
    versions: (podId, body) =>
      store.listQuestionVersions(podId, str(body, 'qid')),
    made: (podId) => madeHere(root, podId),
    panes: (podId) => panes(podId),
    'building-detail': (podId) =>
      buildingDetail({
        store,
        podId,
        projectRoot: project.root,
        windows: windowsFor(podId),
        computer: deps.computer ?? readRunnerInfo()?.name ?? computerName(),
      }),
    audio: (podId, body) => {
      const file = str(body, 'file');

      return /^[a-f0-9]{24}\.mp3$/.test(file)
        ? fileResult(path.join(store.file(podId, 'audio'), file), {
            'accept-ranges': 'bytes',
            'cache-control': 'public, max-age=31536000, immutable',
          })
        : null;
    },
    'tts-stream': async (podId, body) => {
      const message = store
        .readThread(podId)
        .find((candidate) => candidate.id === optStr(body, 'msgId'));
      const text = message?.text ?? '';
      const config = liveTts();

      // Kokoro has no streaming endpoint: the whole reply as a cached clip,
      // sent in one go. Never ElevenLabs then, which the budget books at $0.
      if (kokoro !== null) {
        const clip = text === '' ? null : await renderer.renderNow(podId, text);

        return clip?.status === 'ready'
          ? fileResult(
              path.join(
                store.file(podId, 'audio'),
                `${renderer.hashOf(text)}.mp3`
              ),
              { 'cache-control': 'no-store' }
            )
          : null;
      }

      if (
        !audioOn() ||
        config.apiKey === undefined ||
        text === '' ||
        !budget.allows(text.length)
      ) {
        return null;
      }

      const upstream = await streamSpeech(config, text);
      budget.record(text.length);

      return {
        base64: Buffer.from(await upstream.arrayBuffer()).toString('base64'),
      };
    },
    'tts/clip': (podId, body) => {
      const text = str(body, 'text');

      if (store.readPod(podId) === null) {
        throw new Error(`No pod ${podId}`);
      }

      if (text.length > 6_000) {
        throw new Error('Section text too long to render');
      }

      warmKokoro();

      return renderer.renderNow(
        podId,
        text,
        body.need === 'soon' ? 'soon' : 'now'
      );
    },
    focus: (podId, body) => {
      focused.podId = podId;
      focused.key = optStr(body, 'key') ?? null;
      renderer.setFocus(focused.key ?? `pod:${podId}`);
      debounced();

      return 'ok';
    },
    'judgements/keep': (podId, body) => {
      const question = store.requireQuestion(podId, str(body, 'qid'));
      const count = question.checkpoint?.suggestedJudgements?.length ?? 0;
      const kept = Array.isArray(body.kept)
        ? body.kept.filter(
            (index): index is number =>
              typeof index === 'number' &&
              Number.isInteger(index) &&
              index >= 0 &&
              index < count
          )
        : [];

      if (question.checkpoint === undefined || question.status !== 'open') {
        throw new Error('Only an open checkpoint has suggested judgements.');
      }

      store.writeQuestion({
        ...question,
        checkpoint: { ...question.checkpoint, keptJudgements: kept },
      });

      return 'ok';
    },
  };

  const handle = async (
    action: string,
    podId: string | undefined,
    body: Record<string, unknown>
  ): Promise<unknown> => {
    if (action === 'priority') {
      const order = Array.isArray(body.order)
        ? body.order.filter((id): id is string => typeof id === 'string')
        : [];
      store.writeInbox({ priority: order });
      debounced();

      return 'ok';
    }

    const read = reads[action];

    if (read !== undefined) {
      if (podId === undefined) {
        throw new Error('Missing "podId"');
      }

      return read(podId, body);
    }

    const backgroundArgs = BACKGROUND_ACTIONS[action];

    if (backgroundArgs !== undefined) {
      inBackground(backgroundArgs({ ...body, podId }));

      return 'warming';
    }

    const args = podActionArgs(action, { ...body, podId });

    if (args === null) {
      throw new Error(`Unknown pod action "${action}".`);
    }

    return pod(args, ACTION_TIMEOUTS_MS[action]);
  };

  /** Start `lambda pod new` and answer once it prints the new pod's id. */
  const newPod = (intake: PodIntake, projectId?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      if (intake.text.trim() === '') {
        reject(
          new Error('Say what the pod is for — an idea, a ticket or a few.')
        );

        return;
      }

      const child = deps.spawnLambda(
        [
          'pod',
          'new',
          'pod',
          '--text',
          intake.text,
          ...(intake.freeform ? ['--freeform'] : []),
          ...(intake.single ? ['--single'] : []),
        ],
        folder
      );
      const output = { text: '', settled: false };
      background.add(child);
      const timer: { id?: NodeJS.Timeout } = {};
      const settle = (fn: () => void): void => {
        if (!output.settled) {
          output.settled = true;
          clearTimeout(timer.id);
          fn();
        }
      };
      timer.id = setTimeout(() => {
        child.kill();
        settle(() => reject(new Error("lambda pod new didn't answer.")));
      }, NEW_POD_TIMEOUT_MS);
      const onData = (chunk: Buffer): void => {
        output.text += chunk.toString('utf8');
        const id = CREATED_POD.exec(output.text)?.[1];

        if (id !== undefined) {
          if (projectId !== undefined) {
            try {
              store.updatePod(id, (current) => ({ ...current, projectId }));
            } catch (error) {
              // The pod is made all the same; without its project it shows
              // under no project's heading, so say why.
              deps.log(
                `${id}'s codebase wasn't saved to it: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }

          settle(() => resolve(id));
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      // A spawn failure (ENOENT, EMFILE) comes as 'error', not 'exit'.
      child.on('error', (error) => {
        background.delete(child);
        settle(() =>
          reject(new Error(`Couldn't run lambda pod new: ${error.message}`))
        );
      });
      child.on('exit', () => background.delete(child));
      // `close`, not `exit`: the last of its output (the new pod's id, or
      // why it failed) can arrive after the exit. Left open by something it
      // started, the timeout above still ends it.
      child.on('close', (code) => {
        background.delete(child);
        settle(() =>
          reject(
            new Error(
              output.text.trim() || `lambda pod new exited with ${String(code)}`
            )
          )
        );
      });
    });

  const termRead = (podId: string, window: string) => {
    const target = paneTarget(podId, window);
    // The viewer mirrors the pane at its real size; a mismatch makes every
    // redraw wrap and spill into scrollback.
    const [cols, rows] = deps
      .tmux([
        'display-message',
        '-p',
        '-t',
        target,
        '#{pane_width} #{pane_height}',
      ])
      .trim()
      .split(' ')
      .map(Number);

    return {
      screen: deps.tmux(['capture-pane', '-p', '-e', '-t', target]),
      cols: cols !== undefined && Number.isFinite(cols) ? cols : 120,
      rows: rows !== undefined && Number.isFinite(rows) ? rows : 45,
    };
  };

  const termKeys = (podId: string, window: string, hex: unknown[]): string => {
    // Typing reaches an agent or the scratchPad only: a stray key in a
    // server's window could stop it.
    if (
      window.startsWith('@') &&
      !otherWindows().some((other) => other.id === window && other.typable)
    ) {
      throw new Error(
        "That window is read-only here: only an agent's window or the scratchPad takes typing."
      );
    }

    const bytes = hex.filter(
      (byte): byte is string =>
        typeof byte === 'string' && /^[0-9a-f]{2}$/.test(byte)
    );
    const target = paneTarget(podId, window);
    toSendKeysCalls(bytes).forEach((keys) =>
      deps.tmux(['send-keys', '-t', target, ...keys])
    );

    return 'ok';
  };

  return {
    folder,
    store,
    snapshots,
    handle,
    newPod,
    termRead,
    termKeys,
    podFile: (request) => servePodFile(root, request),
    worktrees: () =>
      store
        .listPodIds()
        .map((id) => store.readPod(id))
        .flatMap((current) =>
          current === null || current.status !== 'active'
            ? []
            : [{ podId: current.id, path: current.worktreePath }]
        ),
    dispose: () => {
      timers.forEach((timer) => clearInterval(timer));
      watcher.close();
      background.forEach((child) => child.kill());
      kokoro?.close();
    },
  };
};
