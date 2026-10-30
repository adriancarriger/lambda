import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { tagPodWindow } from '../building/windows';
import { BUILDING_AGENT_WINDOWS } from '../commands/tmux';
import { loadMachineConfig } from '../config/machineConfig';
import { lambdaBin } from '../lambdaBin';
import { type Pod, podKindOf } from '../pod-store/schemas';
import { type PodStore, writeJsonAtomic } from '../pod-store/store';
import { lambdaPackageDir } from '../process/workflow-file';
import { resolveClaude } from '../setup/connectClaude';
import { verdictsDir } from '../verdict/store';
import { agentPath } from './base';
import { trustFolderForClaude } from './claudeTrust';
import { agentWindow, currentProject, podSessionOf, podsRoot } from './context';
import { ownerForAgent } from './owner';
import {
  hasWindow,
  newWindow,
  newWindowInOrder,
  respawnWindow,
  shellQuote,
  sleep,
  waitForAgentReady,
} from './tmux';

/**
 * How a pod agent is started. Every agent gets:
 *   - POD_ID / POD_AGENT / LAMBDA_PODS_ROOT, so `lambda pod …` and the hooks
 *     know whose pod they are in from inside the worktree;
 *   - `--setting-sources user,project` + the pod's own `--settings`. The
 *     PROJECT source is required: without it Claude Code loads none of the
 *     project's skills or commands (`/pod-phase`, `/human-*` all come back
 *     "Unknown command"). `local` is left out: the project's allowlist lives
 *     in the gitignored `.claude/settings.local.json`, so it is copied into
 *     the pod's settings instead.
 *   - `--permission-mode auto`: nobody is watching a pod's pane to answer
 *     prompts. The settings are rewritten at every launch, so a rule added
 *     here reaches existing pods on their next start.
 *
 * Non-Claude agents (`agentCommand` other than `claude`) get the env but none
 * of the Claude flags; session resume and forks are Claude-only.
 */

type LaunchMode =
  | { kind: 'fresh'; sessionId: string }
  | { kind: 'resume'; sessionId: string }
  | { kind: 'fork'; fromSessionId: string };

export const FORK_DENY = [
  'Edit',
  'Write',
  'NotebookEdit',
  // Publishing writes to claude.ai; a fork is read-only. A deny beats the
  // project settings' allow, so the fork cannot publish either way.
  'Artifact',
  'Bash(lambda pod question:*)',
  'Bash(lambda pod checkpoint:*)',
  // Forks inherit `Bash(lambda tickets:*)`; these write the tickets.
  'Bash(lambda tickets create:*)',
  'Bash(lambda tickets update:*)',
  'Bash(lambda tickets comment:*)',
  'Bash(lambda tickets push:*)',
  // A screen's design loop writes rounds, canvases, pictures and prototype
  // versions into the pod, and records whether Claude Design is available.
  // Every `lambda design` command writes except FORK_READ_ONLY_ALLOW's.
  'Bash(lambda design capability:*)',
  'Bash(lambda design canvas:*)',
  'Bash(lambda design render:*)',
  'Bash(lambda design walk:*)',
  'Bash(lambda design snapshot:*)',
  'Bash(lambda design round:*)',
  'Bash(lambda design redesign:*)',
  'Bash(lambda design runtime import:*)',
  'Bash(lambda design system:*)',
  // A photo (`lambda shot <id>`) writes a picture and can't be told apart
  // from `lambda shot search` by prefix, so a fork reads scenario files.
  'Bash(lambda shot:*)',
  // These write the ticket's files.
  'Bash(lambda tickets scenarios push:*)',
  'Bash(lambda tickets attach:*)',
  // QA's visual check records its rounds; a fork never does.
  'Bash(lambda verdict visual record:*)',
];

/** A fork's `lambda design`: only the commands that read. */
const FORK_READ_ONLY_ALLOW = [
  'Bash(lambda design brief:*)',
  'Bash(lambda design runtime status:*)',
];

const POD_ALLOW = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash(lambda pod:*)',
  'Bash(lambda tickets:*)',
  'Bash(lambda knowledge:*)',
  // Claude Design: the ux phase publishes canvases, renders and photographs
  // them, and photographs the project's app through its photo hook.
  'Artifact',
  'Bash(lambda design:*)',
  'Bash(lambda shot:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(find:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(sed -n:*)',
];

export const NEVER_IN_A_POD = [
  // The Workflow tool asks for consent in the pane even under auto mode, and
  // nobody is there to give it. Pods fan out with the Agent tool instead.
  'Workflow',
  'Bash(git commit:*)',
  'Bash(git push:*)',
  // Shipping isn't part of planning.
  'Bash(lambda ship:*)',
  // Deleting a pod is the person's call, never an agent's.
  'Bash(lambda pod delete:*)',
];

/**
 * The planning dev designs from the design system committed on main, and
 * may build it outside its worktree (`lambda design system build --from`,
 * `prepare`), but never writes its manifest: only the ticket that makes the
 * design system does, in a building pod.
 */
const PLANNING_DEV_DENY = [
  ...NEVER_IN_A_POD,
  'Bash(lambda design system manifest:*)',
];

// ── building pods ──────────────────────────────────────────────────────────

/** A building pod's dev ships with `lambda ship`, so that one isn't denied. */
const NEVER_IN_A_BUILDING_POD = NEVER_IN_A_POD.filter(
  (rule) => rule !== 'Bash(lambda ship:*)'
);

/** The Engineering manager runs the loop; it never writes code itself. */
const ENGINEERING_MANAGER_DENY = [
  ...NEVER_IN_A_BUILDING_POD,
  'Edit',
  'Write',
  'NotebookEdit',
  // QA's /check-ticket and /visual-check record verdicts, and pods are the
  // owner's to start; `Bash(lambda:*)` would pre-allow them before the hook
  // is ever asked.
  'Bash(lambda verdict record:*)',
  'Bash(lambda verdict visual record:*)',
  'Bash(lambda pod build:*)',
  // A ticket is done only through lambda ship's gate, and the dev and qa
  // are reached through their windows.
  'Bash(lambda tickets update:*)',
  'Bash(lambda event ship.:*)',
  'Bash(lambda event group.:*)',
  'Bash(lambda pod send:*)',
];

/** The pod's own controls are the Engineering manager's, never the dev's or qa's. */
const POD_CONTROL_DENY = [
  'Bash(lambda pod blocked:*)',
  'Bash(lambda pod skip-ticket:*)',
  'Bash(lambda pod step:*)',
  'Bash(lambda pod build:*)',
  'Bash(lambda pod done:*)',
  'Bash(lambda stop:*)',
];

/**
 * The building dev's design system commands: the setup ticket builds,
 * checks, draws, photographs and records its rounds; every ticket's design
 * check asks the source map. Forks are denied them all (`FORK_DENY`).
 */
export const BUILDING_DEV_ALLOW = [
  'Bash(lambda design system:*)',
  'Bash(lambda design render:*)',
  'Bash(lambda shot:*)',
];

/** The dev ships, but never grades its own work: qa records the verdict. */
const DEV_DENY = [
  ...NEVER_IN_A_BUILDING_POD,
  'Bash(lambda verdict record:*)',
  'Bash(lambda verdict visual record:*)',
  ...POD_CONTROL_DENY,
];

/** qa records the verdict and the screenshots; the dev ships. */
const QA_DENY = [...NEVER_IN_A_POD, ...POD_CONTROL_DENY];

/** qa's visual check: it photographs the app and records each round. */
export const QA_VISUAL_ALLOW = [
  'Bash(lambda shot:*)',
  'Bash(lambda verdict visual record:*)',
];

/**
 * The Product manager reads everything and changes nothing: on top of a
 * fork's denies, no shipping, no ticket writes, no `lambda tmux` or `tmux` at all
 * (a capture and a send can't be told apart by prefix, so captures go
 * through `lambda pod peek`), and none of the building pod's own writes.
 */
export const PRODUCT_MANAGER_DENY = [
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(lambda ship:*)',
  'Bash(lambda tmux:*)',
  // Nor raw tmux: it reads panes through `lambda pod peek`.
  'Bash(tmux:*)',
  'Bash(lambda pod blocked:*)',
  'Bash(lambda pod skip-ticket:*)',
  'Bash(lambda pod step:*)',
  'Bash(lambda pod screenshot:*)',
  'Bash(lambda pod build:*)',
  'Bash(lambda verdict record:*)',
  'Bash(lambda verdict visual record:*)',
  // It reaches the Engineering manager and the dev only through `ask` (a
  // read-only fork) and `relay`, never straight into a pane or the events.
  'Bash(lambda pod send:*)',
  'Bash(lambda pod deliver:*)',
  'Bash(lambda pod interrupt:*)',
  'Bash(lambda event:*)',
  // The pod's own lifecycle and the tickets' order are the owner's, through
  // the app, or the Engineering manager's when relayed.
  'Bash(lambda pod done:*)',
  'Bash(lambda pod pause:*)',
  'Bash(lambda pod resume:*)',
  'Bash(lambda pod delete:*)',
  'Bash(lambda pod rename:*)',
  'Bash(lambda pod nudge:*)',
  'Bash(lambda pod decide:*)',
  'Bash(lambda pod chat:*)',
  'Bash(lambda pod carry-on:*)',
  'Bash(lambda pod skip:*)',
  'Bash(lambda pod phase:*)',
  'Bash(lambda pod fork:*)',
  'Bash(lambda pod request:*)',
  'Bash(lambda pod pm-chat:*)',
  'Bash(lambda pod talk-ticket:*)',
  'Bash(lambda tickets delete:*)',
  'Bash(lambda tickets reorder:*)',
  'Bash(lambda tickets place:*)',
  'Bash(lambda tickets pull:*)',
  'Bash(lambda tickets block:*)',
  'Bash(lambda tickets unblock:*)',
  'Bash(lambda stop:*)',
  // Every other pod and knowledge write: `buildingDenyPin.test.ts` fails on
  // a write subcommand that is on neither this list nor its reads.
  'Bash(lambda pod new:*)',
  'Bash(lambda pod render-mode:*)',
  'Bash(lambda pod structure:*)',
  'Bash(lambda pod propose-structure:*)',
  'Bash(lambda pod tickets:*)',
  'Bash(lambda pod epic:*)',
  'Bash(lambda pod sync:*)',
  'Bash(lambda pod hook:*)',
  'Bash(lambda pod resolve:*)',
  'Bash(lambda pod answer:*)',
  'Bash(lambda pod resolve-conversation:*)',
  'Bash(lambda pod watch-building:*)',
  'Bash(lambda pod resume-all:*)',
  'Bash(lambda knowledge add:*)',
  'Bash(lambda knowledge sync:*)',
  // It never designs: no publishing (Artifact comes with FORK_DENY), no
  // design command, and no scenario download into the checkout.
  'Bash(lambda design:*)',
  'Bash(lambda tickets scenarios pull:*)',
];

export const PRODUCT_MANAGER_ALLOW = [
  'Read',
  'Grep',
  'Glob',
  'Agent',
  'Task',
  'Bash(lambda pod peek:*)',
  'Bash(lambda pod ask:*)',
  'Bash(lambda pod relay:*)',
  'Bash(lambda pod reply:*)',
  'Bash(lambda pod status:*)',
  'Bash(lambda pod list:*)',
  'Bash(lambda tickets get:*)',
  'Bash(lambda tickets list:*)',
  'Bash(lambda tickets next:*)',
  'Bash(lambda building show:*)',
  'Bash(lambda verdict show:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
];

/**
 * What a read-only ask fork may do: read, and nothing else. No `find` or
 * `sed` (`-delete`, `-exec`, `-i` write; Read, Grep and Glob read). It has no auto
 * permission mode either: a fork of the Engineering manager would otherwise
 * keep its allow list, and could ship or message the real dev.
 */
export const ASK_FORK_ALLOW = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
];

/**
 * The ask fork's floor: denied outright, so it holds even when the
 * `ask-guard` hook doesn't run. Claude Code blocks a tool only on a hook's
 * exit code 2; any other failure — or an older `lambda` first on PATH that
 * doesn't know `ask-guard` and exits 0 — lets the call through to these.
 */
const ASK_FORK_DENY = Array.from(
  new Set([
    ...NEVER_IN_A_POD,
    ...FORK_DENY,
    ...PRODUCT_MANAGER_DENY,
    'Bash(lambda pod reply:*)',
    'Bash(lambda pod ask:*)',
    'Bash(lambda pod relay:*)',
    'Bash(lambda tickets delete:*)',
    'Bash(lambda tickets reorder:*)',
    'Bash(lambda tickets place:*)',
    'Bash(lambda tickets pull:*)',
  ])
);

/** The Engineering manager's PermissionRequest hook (a copy ships with Lambda). */
export const permissionHookFile = (): string =>
  path.join(lambdaPackageDir(), 'src', 'building', 'permission-hook.cjs');

/** Each building role's settings file in the pod's folder. */
export const buildingSettingsFile = (agent: string): string => {
  if (agent === 'engineering-manager') {
    return 'em-settings.json';
  }

  if (agent === 'product-manager' || agent.startsWith('pm-')) {
    return 'pm-settings.json';
  }

  if (agent === 'qa') {
    return 'qa-settings.json';
  }

  return agent.startsWith('ask-') ? 'ask-settings.json' : 'settings.json';
};

/**
 * The Product manager's own settings, outside any pod (one-shot summaries).
 * Never auto mode, and its allow list enforced by its guard: a hook's deny
 * beats any other source's allow.
 */
export const PRODUCT_MANAGER_SETTINGS = {
  permissions: {
    allow: PRODUCT_MANAGER_ALLOW,
    deny: [...NEVER_IN_A_POD, ...FORK_DENY, ...PRODUCT_MANAGER_DENY],
    defaultMode: 'default',
  },
  hooks: {
    PreToolUse: [
      { hooks: [{ type: 'command', command: 'lambda pod hook pm-guard' }] },
    ],
  },
};

const writeBuildingSettings = (
  store: PodStore,
  podId: string,
  input: PodSettingsInput
): void => {
  const allow = Array.from(
    new Set([
      ...readRepoAllowlist(input.projectRoot),
      ...POD_ALLOW,
      'Bash(lambda:*)',
      ...(input.cli === undefined ? [] : [`Bash(${input.cli}:*)`]),
    ])
  ).filter((rule) => !NEVER_IN_A_BUILDING_POD.includes(rule));
  const hooks = {
    UserPromptSubmit: hook('lambda pod hook prompt-submit'),
    Stop: hook('lambda pod hook stop'),
  };
  const pmDeny = PRODUCT_MANAGER_SETTINGS.permissions.deny;
  // The ship gate reads the verdict file, so the dev can't write one by hand
  // either. `//` makes the rule an absolute path, not one under this folder.
  // Edit covers every tool that writes a file; a `Write(…)` rule never
  // matches, and Claude Code warned so at every launch.
  const verdicts = verdictsDir(input.projectRoot);
  const devDeny = [...DEV_DENY, `Edit(/${verdicts}/**)`];

  // The dev ships through `lambda ship`, so the project's denies (its own
  // ship command among them) bind it as they bind a planning pod's agents.
  writeTightened(
    store.file(podId, 'settings.json'),
    {
      permissions: {
        allow: Array.from(new Set([...allow, ...BUILDING_DEV_ALLOW])).filter(
          (rule) => !devDeny.includes(rule)
        ),
        deny: devDeny,
      },
      hooks,
    },
    input.deny ?? []
  );
  writeJsonAtomic(store.file(podId, 'qa-settings.json'), {
    permissions: {
      allow: Array.from(new Set([...allow, ...QA_VISUAL_ALLOW])).filter(
        (rule) => !QA_DENY.includes(rule)
      ),
      deny: QA_DENY,
    },
    hooks,
  });
  writeJsonAtomic(store.file(podId, 'em-settings.json'), {
    // The Engineering manager never edits code: denied outright (a deny beats
    // every allow), and never pre-allowed, so no source can grant it. No Bash
    // is pre-allowed either, so every command reaches its permission hook.
    permissions: {
      allow: allow.filter(
        (rule) =>
          !ENGINEERING_MANAGER_DENY.includes(rule) && !rule.startsWith('Bash(')
      ),
      deny: ENGINEERING_MANAGER_DENY,
    },
    hooks: {
      ...hooks,
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `node ${shellQuote(permissionHookFile())}`,
            },
          ],
        },
      ],
      PermissionRequest: hook(`node ${shellQuote(permissionHookFile())}`),
    },
  });
  writeJsonAtomic(store.file(podId, 'pm-settings.json'), {
    permissions: {
      allow: PRODUCT_MANAGER_ALLOW.filter((rule) => !pmDeny.includes(rule)),
      deny: pmDeny,
      defaultMode: 'default',
    },
    hooks: { ...hooks, ...PRODUCT_MANAGER_SETTINGS.hooks },
  });
  writeJsonAtomic(store.file(podId, 'ask-settings.json'), {
    permissions: {
      allow: ASK_FORK_ALLOW,
      deny: ASK_FORK_DENY,
      // Never auto mode, whatever the person's own settings set.
      defaultMode: 'default',
    },
    hooks: {
      ...hooks,
      // Its allow list, enforced: a deny here beats any other source's allow.
      PreToolUse: hook('lambda pod hook ask-guard'),
    },
  });
};

const allowListOf = (value: unknown): string[] => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('permissions' in value) ||
    typeof value.permissions !== 'object' ||
    value.permissions === null ||
    !('allow' in value.permissions) ||
    !Array.isArray(value.permissions.allow)
  ) {
    return [];
  }

  return value.permissions.allow.filter(
    (rule: unknown): rule is string => typeof rule === 'string'
  );
};

/** The project's own allowlist, from the main checkout. */
const readRepoAllowlist = (projectRoot: string): string[] => {
  const file = path.join(projectRoot, '.claude', 'settings.local.json');

  return fs.existsSync(file)
    ? allowListOf(JSON.parse(fs.readFileSync(file, 'utf8')))
    : [];
};

const hook = (command: string) => [{ hooks: [{ type: 'command', command }] }];

export interface PodSettingsInput {
  /** The project's main checkout. */
  projectRoot: string;
  /** lambda.json `cli`, exactly as written. */
  cli: string | undefined;
  /** lambda.json `pods.deny`: denied to every planning pod agent and a building pod's dev (tighten only). */
  deny?: string[];
  /** lambda.json `pods.forkDeny`: denied to a planning pod's forks too. */
  forkDeny?: string[];
}

const currentSettingsInput = (): PodSettingsInput => {
  const project = currentProject();

  return {
    projectRoot: project.root,
    cli: project.config.cli,
    deny: project.config.pods?.deny,
    forkDeny: project.config.pods?.forkDeny,
  };
};

interface AgentSettings {
  permissions: { allow: string[]; deny: string[] } & Record<string, unknown>;
}

/**
 * The project's own denies on top of Lambda's: added to `deny` and taken out
 * of `allow`, so they only ever narrow what an agent may do.
 */
const writeTightened = <T extends AgentSettings>(
  file: string,
  settings: T,
  deny: string[]
): void =>
  writeJsonAtomic(
    file,
    deny.length === 0
      ? settings
      : {
          ...settings,
          permissions: {
            ...settings.permissions,
            allow: settings.permissions.allow.filter(
              (rule) => !deny.includes(rule)
            ),
            deny: Array.from(new Set([...settings.permissions.deny, ...deny])),
          },
        }
  );

/**
 * settings.json (dev + manager) and fork-settings.json (read-only fork).
 * They come from this code only, plus lambda.json's `pods.deny` and
 * `pods.forkDeny`, which can only add denies: lambda.json and workflow.json
 * can't add allows, hooks or env. Denies win over every allow, and each
 * denied rule is also taken out of the allow list, so a project allow can't
 * re-grant it.
 */
export const writePodSettings = (
  store: PodStore,
  podId: string,
  input: PodSettingsInput = currentSettingsInput()
): void => {
  if (store.readPod(podId)?.kind === 'building') {
    writeBuildingSettings(store, podId, input);

    return;
  }

  const allow = Array.from(
    new Set([
      ...readRepoAllowlist(input.projectRoot),
      ...POD_ALLOW,
      ...(input.cli === undefined ? [] : [`Bash(${input.cli}:*)`]),
    ])
  );
  const forkDeny = [...NEVER_IN_A_POD, ...FORK_DENY];

  const hooks = {
    UserPromptSubmit: hook('lambda pod hook prompt-submit'),
    Stop: hook('lambda pod hook stop'),
  };

  writeTightened(
    store.file(podId, 'settings.json'),
    {
      permissions: {
        allow: allow.filter((rule) => !PLANNING_DEV_DENY.includes(rule)),
        deny: PLANNING_DEV_DENY,
      },
      hooks,
    },
    input.deny ?? []
  );

  writeTightened(
    store.file(podId, 'fork-settings.json'),
    {
      permissions: {
        allow: [
          ...allow.filter(
            (rule) =>
              !forkDeny.includes(rule) && rule !== 'Bash(lambda design:*)'
          ),
          ...FORK_READ_ONLY_ALLOW,
        ],
        deny: forkDeny,
      },
      hooks,
    },
    [...(input.deny ?? []), ...(input.forkDeny ?? [])]
  );
};

/**
 * Read by the agent's own shell at launch, from `~/.lambda/config.json`: the
 * token itself never goes in the command string tmux gets (that would put it
 * in `ps` and tmux's history). The `lambda` running now, by absolute path:
 * that shell's PATH may have none (and the substitution runs before `env`
 * sets one). Inside the app it is Electron's binary, Node only with
 * ELECTRON_RUN_AS_NODE. No token stops the launch, never an empty one.
 */
export const claudeTokenShell = (
  cli: string[] = [shellQuote(process.execPath), shellQuote(lambdaBin())]
): { read: string } => ({
  // Exported, so `env` inherits it: as an `env` argument it shows in `ps`.
  read: `CLAUDE_CODE_OAUTH_TOKEN="$(ELECTRON_RUN_AS_NODE=1 ${cli.join(
    ' '
  )} internal claude-token)"; : "\${CLAUDE_CODE_OAUTH_TOKEN:?Lambda could not read its Claude token}"; export CLAUDE_CODE_OAUTH_TOKEN;`,
});

/**
 * With Claude connected (`lambda connect claude`, or setup), agents sign in
 * with that token and run the `claude` setup found or installed. Without it,
 * `claude` from PATH with its own sign-in, as before.
 */
const connectedClaude = (): { token: string; path: string } | null => {
  const token = loadMachineConfig()?.tokens?.claude?.value;

  return token === undefined || token === ''
    ? null
    : { token, path: resolveClaude(process.env, os.homedir()) ?? 'claude' };
};

const claudeLaunch = (): {
  read: string[];
  command: string;
} => {
  const connected = connectedClaude();

  if (connected === null) {
    return { read: [], command: 'claude' };
  }

  return {
    read: [claudeTokenShell().read],
    command: shellQuote(connected.path),
  };
};

export const agentCommandLine = (
  pod: Pod,
  store: PodStore,
  agent: string,
  mode: LaunchMode
): string => {
  const root = podsRoot();
  const env = [
    `POD_ID=${shellQuote(pod.id)}`,
    `POD_AGENT=${shellQuote(agent)}`,
    `LAMBDA_PODS_ROOT=${shellQuote(root)}`,
    // No greyed-out "next prompt" suggestions: on a captured screen they read
    // as text typed into the box, and an agent could take one for stray input.
    'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false',
    // The planner's `lambda` first, when there is one (see base.ts), else the
    // `lambda` running now: hooks and `lambda pod …` then run that copy.
    `PATH=${shellQuote(agentPath(root))}`,
  ];

  if (pod.agentCommand !== 'claude') {
    return `env ${env.join(' ')} ${pod.agentCommand}`;
  }

  const building = podKindOf(pod) === 'building';
  // Every fork in a building pod is read-only, whatever its window is called
  // (an ask fork, or a fork for a question): the ask fork's settings.
  const buildingFile =
    mode.kind === 'fork' ? 'ask-settings.json' : buildingSettingsFile(agent);
  const settingsFile = store.file(
    pod.id,
    building
      ? buildingFile
      : mode.kind === 'fork'
      ? 'fork-settings.json'
      : 'settings.json'
  );
  // An ask fork and the Product manager get no auto mode, and not the
  // person's own settings: their allow lists are all they may do.
  const readOnly =
    building &&
    (buildingFile === 'ask-settings.json' ||
      buildingFile === 'pm-settings.json');
  const permissionMode = readOnly
    ? ['--permission-mode', 'default']
    : ['--permission-mode', 'auto'];
  const settingSources = readOnly ? 'project' : 'user,project';
  // They share the dev's checkout and only read it: a `git status` that took
  // `.git/index.lock` there could fail the dev's commit.
  const gitLocks = readOnly ? ['GIT_OPTIONAL_LOCKS=0'] : [];

  const sessionFlags =
    mode.kind === 'fresh'
      ? ['--session-id', mode.sessionId]
      : mode.kind === 'resume'
      ? ['--resume', mode.sessionId]
      : ['--resume', mode.fromSessionId, '--fork-session'];

  const claude = claudeLaunch();

  return [
    ...claude.read,
    'env',
    ...env,
    ...gitLocks,
    claude.command,
    ...sessionFlags,
    '--setting-sources',
    settingSources,
    '--settings',
    shellQuote(settingsFile),
    ...permissionMode,
    // No MCP servers in a pod. Each worktree is a new project to Claude Code,
    // so a project's .mcp.json stops the agent at a "New MCP server found"
    // prompt nobody sees, and `lambda pod new` would wait on it forever.
    '--strict-mcp-config',
  ].join(' ');
};

/**
 * Start one agent window in the pod's tmux session and wait until it can take
 * input. `cwd` matters for resumes and forks: `--resume` looks a session up
 * under the launch directory's project, so the wrong cwd is "session not found".
 */
export const launchAgent = async (args: {
  pod: Pod;
  store: PodStore;
  agent: string;
  cwd: string;
  mode: LaunchMode;
}): Promise<boolean> => {
  writePodSettings(args.store, args.pod.id);

  // Before it starts: an untrusted folder stops it at a prompt nobody sees.
  if (args.pod.agentCommand === 'claude') {
    trustFolderForClaude(args.cwd);
  }

  const session = podSessionOf(args.pod);
  const window = agentWindow(args.pod, args.agent);
  const building = podKindOf(args.pod) === 'building';
  const placed = {
    session,
    window,
    cwd: args.cwd,
    command: agentCommandLine(args.pod, args.store, args.agent, args.mode),
  };

  // A building pod's windows are always there (manager, qa, dev, first in
  // their session): one that's open is started in place, keeping its spot;
  // one that isn't is opened in that spot.
  if (building && hasWindow(session, window)) {
    respawnWindow(placed);
  } else if (building) {
    newWindowInOrder({ ...placed, order: BUILDING_AGENT_WINDOWS });
  } else {
    newWindow(placed);
  }

  // In a project's shared session: marked as the pod's (the Product manager
  // and ask forks too), so stop closes it and never the project's.
  if (building && args.pod.tmuxSession !== undefined) {
    tagPodWindow(session, window, args.pod.id);
  }

  // Readiness detection knows Claude Code's prompt; other agent CLIs just get
  // a moment to start.
  if (args.pod.agentCommand !== 'claude') {
    await sleep(1500);

    return true;
  }

  return waitForAgentReady(`${session}:${window}`);
};

/**
 * `devInstructions`: the planning dev instructions this project uses (an
 * absolute path). They name the owner `{owner}`.
 */
export const DEV_BOOTSTRAP = (
  podId: string,
  devInstructions: string,
  owner: string = ownerForAgent(),
  projectAddendum?: string
): string =>
  `You are the DEV in planning pod ${podId}. Read ${devInstructions} now${
    projectAddendum === undefined
      ? ''
      : `, then the codebase's additions to it in ${projectAddendum},`
  } and follow it for the rest of this session; where it says {owner}, that is ${owner}. Your pod's state is under $LAMBDA_PODS_ROOT/${podId}/. Do not start any phase work until the manager or ${owner} asks you to.`;

export const MANAGER_BOOTSTRAP = (podId: string): string =>
  `You are the PLANNING MANAGER for pod ${podId}. Your instructions are CLAUDE.md in this directory. Start the pipeline now: run \`lambda pod status ${podId}\` and continue from the phase it reports (a FREEFORM pod has nothing to run until \`/pod-structured\`).`;

/**
 * A one-shot, non-interactive Claude run (a ticket's summary): started like
 * every pod agent, from here, so a rule added for agents reaches it too.
 * Its settings decide what it may do; it gets no auto mode, and nothing of a
 * pod's identity (no POD_ID, so it can't act as one of its agents).
 */
export const oneShotLaunch = (input: {
  prompt: string;
  settingsFile: string;
  env?: NodeJS.ProcessEnv;
}): { command: string; args: string[]; env: NodeJS.ProcessEnv } => {
  // Connected Claude: the token in the child's own env (never its arguments),
  // and the claude setup found or installed (not on PATH inside the app).
  const connected = connectedClaude();

  return {
    command: connected === null ? 'claude' : connected.path,
    args: [
      '-p',
      input.prompt,
      '--settings',
      input.settingsFile,
      // Not the person's own settings: their allow list would merge in.
      '--setting-sources',
      'project',
      // It only reads: its prompt carries the tracker's text verbatim, so no
      // project allow rule may hand it a shell or an edit.
      '--disallowedTools',
      'Bash,Edit,Write,NotebookEdit',
      // As in a pod: a project's MCP servers would stop it at a prompt.
      '--strict-mcp-config',
    ],
    env: {
      ...Object.fromEntries(
        Object.entries(input.env ?? process.env).filter(
          ([key]) => key !== 'POD_ID' && key !== 'POD_AGENT'
        )
      ),
      ...(connected === null
        ? {}
        : { CLAUDE_CODE_OAUTH_TOKEN: connected.token }),
    },
  };
};
