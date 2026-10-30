import * as os from 'os';
import type { z } from 'zod';

import { runInit } from '../commands/init';
import { loadMachineConfig } from '../config/machineConfig';
import { loadProjectConfig } from '../config/projectConfig';
import { json, readBody } from '../mothership/http';
import { type Alias, aliasOf } from '../mothership/owner';
import { HttpError } from '../mothership/relay';
import type { Route } from '../mothership/routes';
import {
  type BrowserState,
  type ChromiumInstaller,
  createChromiumInstaller,
  spawnPlaywrightInstall,
} from './chromium';
import {
  type ClaudeConnector,
  type ClaudeRun,
  createClaudeConnector,
  realSpawnPty,
} from './connectClaude';
import {
  type ProjectDeps,
  currentProject,
  projectGit,
  setupProject,
  stepsDone,
} from './firstRun';
import { listFolders } from './folders';
import {
  ClaudeCodeBody,
  ClaudeStartBody,
  ProjectBody,
  TicketsBody,
  YouBody,
} from './schemas';
import {
  JIRA_SITE_HTTPS,
  KEY_DIDNT_WORK,
  type TrackerLogin,
  connectTickets,
} from './tickets';
import { expiresOn } from './tokenExpiry';

/**
 * First run, as pages of the Lambda app at `/setup`. The work runs here, in
 * the mothership, behind the same sign-in gate, Origin and JSON rules as
 * every other route; the Mac app's window shows the same pages and adds only
 * the native folder picker.
 *
 * Setup is for the person who owns this mothership. Lambda has one person, so
 * every signed-in session is that owner and nothing more is checked here.
 */

type Env = Record<string, string | undefined>;

/** What the page reads: step states, the expiry date, the ticket source. Never a token or key. */
export interface SetupState {
  steps: {
    claude: { done: boolean; run: ClaudeRun };
    project: { done: boolean };
    tickets: { done: boolean };
    browser: BrowserState;
  };
  claudeExpiresOn: string | null;
  ticketSource: 'markdown' | 'linear' | 'jira' | null;
}

export interface SetupRouteOptions {
  /** The person's home folder: every folder setup uses is inside it. */
  home: string;
  env: Env;
  broadcast: () => void;
  connector?: ClaudeConnector;
  chromium?: ChromiumInstaller;
  project?: Partial<ProjectDeps>;
  fetch?: typeof fetch;
  /**
   * The owner's tracker logins (the mothership's aliases): a computer takes
   * only tickets the owner reported, so connecting asks whether the key's
   * login is the owner's. Left out, nothing is asked.
   */
  you?: {
    /** The email the owner signs in with, offered as theirs. */
    email: () => string | null;
    isYou: (login: TrackerLogin) => boolean;
    claim: (alias: Alias) => void;
  };
}

const parse = async <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  request: Parameters<typeof readBody>[0]
): Promise<T> => {
  const result = schema.safeParse(await readBody(request));

  if (!result.success) {
    throw new HttpError(400, result.error.issues[0]?.message ?? 'Bad request.');
  }

  return result.data;
};

const ticketSourceOf = (root: string | null): SetupState['ticketSource'] => {
  if (root === null) {
    return null;
  }

  try {
    return loadProjectConfig(root)?.config.tickets.source ?? null;
  } catch {
    return null;
  }
};

export const createSetupRoutes = (options: SetupRouteOptions): Route[] => {
  const { env, home } = options;
  const connector =
    options.connector ??
    createClaudeConnector({
      spawn: realSpawnPty,
      home,
      env,
      onChange: options.broadcast,
    });
  const chromium =
    options.chromium ??
    createChromiumInstaller({
      env,
      home,
      spawnInstaller: spawnPlaywrightInstall,
      onChange: options.broadcast,
    });
  const projectDeps: ProjectDeps = {
    home,
    env,
    git: projectGit(env),
    init: (cwd) => runInit({ cwd, env }),
    ...options.project,
  };

  const state = (): SetupState => {
    const config = loadMachineConfig(env);
    const done = stepsDone(config, env);
    const createdAt = config?.tokens?.claude?.createdAt;

    return {
      steps: {
        claude: { done: done.claude, run: connector.state() },
        project: { done: done.project },
        tickets: { done: done.tickets },
        browser: chromium.state(),
      },
      claudeExpiresOn:
        done.claude && createdAt !== undefined ? expiresOn(createdAt) : null,
      ticketSource: ticketSourceOf(currentProject(config)),
    };
  };

  return [
    {
      method: 'GET',
      path: '/api/setup/state',
      sample: '/api/setup/state',
      handle: async ({ response, url }) => {
        // The browser's download starts when setup first opens; the page's
        // Retry asks again after a failure.
        if (url.searchParams.get('retry') === 'browser') {
          chromium.retry();
        } else {
          chromium.start();
        }

        json(response, 200, state());
      },
    },
    {
      method: 'POST',
      path: '/api/setup/claude',
      sample: '/api/setup/claude',
      handle: async ({ request, response }) => {
        await parse(ClaudeStartBody, request);

        if (connector.start() === 'busy') {
          throw new HttpError(409, 'Claude is already connecting.');
        }

        json(response, 200, { ok: true, result: state() });
      },
    },
    {
      method: 'POST',
      path: '/api/setup/claude/code',
      sample: '/api/setup/claude/code',
      handle: async ({ request, response }) => {
        const { code } = await parse(ClaudeCodeBody, request);

        if (!connector.sendCode(code)) {
          throw new HttpError(409, 'Nothing is waiting for a code.');
        }

        json(response, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/setup/folders',
      sample: '/api/setup/folders',
      handle: async ({ response, url }) => {
        json(response, 200, {
          ok: true,
          result: listFolders(url.searchParams.get('path') ?? '', home),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/setup/project',
      sample: '/api/setup/project',
      handle: async ({ request, response }) => {
        const body = await parse(ProjectBody, request);
        const { root } = await setupProject(
          body.folder !== undefined
            ? { folder: body.folder }
            : { name: body.name ?? '' },
          projectDeps
        );
        options.broadcast();
        json(response, 200, { ok: true, result: { folder: root } });
      },
    },
    {
      method: 'POST',
      path: '/api/setup/tickets',
      sample: '/api/setup/tickets',
      handle: async ({ request, response }) => {
        const body = await parse(TicketsBody, request);
        const root = currentProject(loadMachineConfig(env));

        if (root === null) {
          throw new HttpError(409, 'Pick a codebase first.');
        }

        const outcome = await connectTickets(root, body, {
          env,
          fetch: options.fetch,
        });

        if (!outcome.ok) {
          throw new HttpError(
            outcome.error === KEY_DIDNT_WORK ||
            outcome.error === JIRA_SITE_HTTPS
              ? 400
              : 502,
            outcome.error
          );
        }

        options.broadcast();
        const { login } = outcome;
        json(response, 200, {
          ok: true,
          result: {
            connectedAs: outcome.connectedAs,
            // Asked only when it isn't already: a build computer's own login
            // gets No, the owner's own gets Yes once.
            askWho:
              login === null ||
              options.you === undefined ||
              options.you.isYou(login)
                ? null
                : { login, yourEmail: options.you.email() },
          },
        });
      },
    },
    {
      method: 'POST',
      path: '/api/setup/tickets/you',
      sample: '/api/setup/tickets/you',
      handle: async ({ request, response }) => {
        const { login } = await parse(YouBody, request);
        const alias = aliasOf(login);

        if (options.you === undefined) {
          throw new HttpError(409, 'This Lambda keeps no logins.');
        }

        if (alias === null) {
          throw new HttpError(400, 'Give an email or a name.');
        }

        options.you.claim(alias);
        json(response, 200, { ok: true, result: { counts: alias.value } });
      },
    },
  ];
};

/** The real options, for the mothership. */
export const realSetupOptions = (broadcast: () => void): SetupRouteOptions => ({
  home: os.homedir(),
  env: process.env,
  broadcast,
});
